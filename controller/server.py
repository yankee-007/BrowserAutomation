"""PageSense Controller - WebSocket server.

PageSense is always the WebSocket *client* and this Controller is always the
*server*: a browser extension cannot accept inbound connections, and MV3
Service Workers are not allowed to listen on a port.

Security posture (V2.0):
  * binds ``127.0.0.1`` only - never ``0.0.0.0``, so nothing is exposed to the LAN
  * a fresh random session token is generated on every start
  * every connection must send ``HELLO`` with the matching token before any
    request is accepted; the token is never hardcoded anywhere

Run it directly::

    python server.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import queue
import secrets
import sys
import threading
from typing import Any

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

import protocol as P

#: Loopback only. This is a hard V2.0 constraint, not a default.
ALLOWED_HOSTS = ("127.0.0.1", "localhost")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_REQUEST_TIMEOUT = 10.0
DEFAULT_HELLO_TIMEOUT = 5.0

#: Maximum size of a single WebSocket message, in bytes.
#:
#: ``websockets.serve()`` defaults ``max_size`` to 1 MiB. A SCAN_PAGE result for
#: a page with roughly 2500 interactive elements already exceeds that, so the
#: server rejected the extension's RESPONSE with close 1009 ("message too big").
#: The extension saw that as an abnormal close (1006), dropped the socket and
#: auto-reconnected, and the in-flight request died with NOT_CONNECTED - making
#: any sufficiently large page un-scannable through the Controller while the
#: Popup (which never uses a WebSocket) handled the same page fine.
#:
#: 64 MiB matches the limit Chrome itself applies to extension messaging, so the
#: bridge is no longer the narrowest pipe in the chain.
MAX_MESSAGE_SIZE = 64 * 1024 * 1024


def generate_token() -> str:
    """A fresh per-session token. Never stored, never hardcoded."""
    return secrets.token_hex(8).upper()


def _token_bytes(value: object) -> bytes:
    """Encode a HELLO token for constant-time comparison.

    ``secrets.compare_digest`` refuses ``str`` arguments containing non-ASCII
    characters (it raises ``TypeError``), which would turn a merely *wrong*
    token into an unhandled exception and an abnormal 1011 close instead of a
    clean ``HELLO_ACK {success: false, UNAUTHORIZED}``. A user pasting a token
    that picked up a non-ASCII character is an ordinary input mistake, so the
    comparison is done on UTF-8 bytes instead. Non-``str`` payloads (a JSON
    object, list, number, ...) can never match a real token.
    """
    if not isinstance(value, str):
        return b""
    return value.encode("utf-8", "replace")


class ControllerServer:
    """Owns the WebSocket endpoint and the request/response correlation table."""

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        token: str | None = None,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
        on_state_change=None,
    ):
        if host not in ALLOWED_HOSTS:
            raise ValueError(
                f"host 只允许 {ALLOWED_HOSTS}（V2.0 不支持远程 Controller），收到 {host!r}"
            )
        # 0 means "let the OS pick a free port" (used by the tests).
        if not (0 <= int(port) <= 65535):
            raise ValueError(f"port 非法：{port!r}")

        self.host = host
        self.port = int(port)
        self.token = token or generate_token()
        self.request_timeout = float(request_timeout)
        self.on_state_change = on_state_change

        self._extension: ServerConnection | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._counter = 0
        self._exports: queue.Queue = queue.Queue(maxsize=8)
        self._export_bytes = 0
        self._export_lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server = None
        self._thread: threading.Thread | None = None
        self._extension_ready = threading.Event()
        self._started = threading.Event()
        self._startup_error: BaseException | None = None

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._extension is not None

    @property
    def endpoint(self) -> str:
        return f"ws://{self.host}:{self.port}"

    def start(self) -> "ControllerServer":
        """Start the event loop + server in a daemon thread and return."""
        self._thread = threading.Thread(
            target=self._run_loop, name="pagesense-controller", daemon=True
        )
        self._thread.start()
        if not self._started.wait(timeout=10):
            raise RuntimeError("Controller 事件循环启动超时。")
        if self._startup_error is not None:
            raise RuntimeError(
                f"Controller 无法监听 {self.host}:{self.port} —— {self._startup_error}"
            ) from self._startup_error
        return self

    def _run_loop(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._serve())
            self._loop.run_forever()
        except Exception as exc:  # bind failure etc. - surfaced by start()
            self._startup_error = exc
            self._started.set()
        finally:
            # run_forever() has returned: drain whatever is still pending so
            # the loop can be closed without "Task was destroyed" noise.
            for step in (self._drain_tasks, self._loop.shutdown_asyncgens):
                try:
                    self._loop.run_until_complete(step())
                except Exception:
                    pass
            try:
                self._loop.close()
            except Exception:
                pass

    async def _drain_tasks(self) -> None:
        current = asyncio.current_task()
        pending = [t for t in asyncio.all_tasks() if t is not current]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _serve(self) -> None:
        self._server = await serve(self._handler, self.host, self.port,
                                   max_size=MAX_MESSAGE_SIZE)
        if self.port == 0:
            # Report the real port so callers/tests can build the endpoint.
            self.port = self._server.sockets[0].getsockname()[1]
        self._started.set()

    async def _shutdown(self) -> None:
        if self._extension is not None:
            try:
                await self._extension.close()
            except Exception:
                pass
            self._extension = None
        if self._server is not None:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:
                pass
        self._fail_pending(P.ERR_NOT_CONNECTED, "Controller 已停止。")

    def stop(self) -> None:
        """Close the listening socket and stop the loop."""
        if self._loop is not None and self._loop.is_running():
            future = asyncio.run_coroutine_threadsafe(self._shutdown(), self._loop)
            try:
                future.result(timeout=5)
            except Exception:
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def wait_for_extension(self, timeout: float | None = None) -> bool:
        """Block until the extension completes HELLO, or until timeout."""
        return self._extension_ready.wait(timeout)

    # ------------------------------------------------------------------
    # connection handling
    # ------------------------------------------------------------------

    async def _handler(self, websocket: ServerConnection) -> None:
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=DEFAULT_HELLO_TIMEOUT)
        except (asyncio.TimeoutError, ConnectionClosed):
            return

        try:
            message = json.loads(raw)
        except (ValueError, TypeError):
            await websocket.send(json.dumps(P.make_hello_ack(False, {
                "code": P.ERR_PROTOCOL, "message": "HELLO 不是合法 JSON。",
            })))
            return

        if not P.is_hello(message):
            await websocket.send(json.dumps(P.make_hello_ack(False, {
                "code": P.ERR_PROTOCOL, "message": "首帧必须是 HELLO。",
            })))
            return

        if not secrets.compare_digest(_token_bytes(message.get("token", "")),
                                      _token_bytes(self.token)):
            await websocket.send(json.dumps(P.make_hello_ack(False, {
                "code": P.ERR_UNAUTHORIZED, "message": "token 校验失败。",
            })))
            return

        if message.get("protocol") != P.PROTOCOL:
            await websocket.send(json.dumps(P.make_hello_ack(False, {
                "code": P.ERR_PROTOCOL,
                "message": f"协议版本不匹配，期望 {P.PROTOCOL}。",
            })))
            return

        await websocket.send(json.dumps(P.make_hello_ack(True)))

        # A second extension (or a stale reconnection race) replaces the old
        # one: only one Controller session is ever active.
        previous = self._extension
        self._extension = websocket
        self._extension_ready.set()
        self._notify(connected=True, version=message.get("version"))
        if previous is not None and previous is not websocket:
            try:
                await previous.close()
            except Exception:
                pass

        try:
            async for frame in websocket:
                await self._on_frame(frame)
        except ConnectionClosed:
            pass
        finally:
            if self._extension is websocket:
                self._extension = None
                self._extension_ready.clear()
                self._fail_pending(P.ERR_NOT_CONNECTED, "PageSense 连接已断开。")
                self._notify(connected=False)

    async def _on_frame(self, frame: str) -> None:
        try:
            message = json.loads(frame)
        except (ValueError, TypeError):
            return

        if isinstance(message, dict) and message.get("type") == P.TYPE_EXPORT:
            export_id, data = message.get("id"), message.get("data")
            valid = (isinstance(export_id, str) and 0 < len(export_id) <= 128
                     and isinstance(data, dict) and isinstance(data.get("elements"), list)
                     and isinstance(data.get("pageId"), str) and bool(data["pageId"]))
            size = len(frame) if isinstance(frame, bytes) else len(frame.encode("utf-8"))
            accepted = False
            if valid:
                with self._export_lock:
                    if not self._exports.full() and self._export_bytes + size <= MAX_MESSAGE_SIZE:
                        self._exports.put_nowait((dict(data, exportId=export_id), size))
                        self._export_bytes += size
                        accepted = True
            await self._send({"type": P.TYPE_EXPORT_ACK, "id": export_id,
                              "success": accepted,
                              **({} if accepted else {"error": {"code": "EXPORT_REJECTED",
                                  "message": "收件箱已满或数据格式无效，请先调用 wait_for_export()。"}})})
            return

        if P.is_response(message):
            request_id = message.get("id")
            future = self._pending.pop(request_id, None)
            if future is None or future.done():
                return
            if message.get("success") is True:
                future.set_result(message.get("result", {}))
            else:
                error = message.get("error") or {}
                future.set_exception(P.PageSenseError(
                    error.get("code", "BRIDGE_ERROR"),
                    error.get("message", ""),
                ))
            return

        if P.is_heartbeat(message):
            # Keeps the MV3 worker alive; answering is the whole point.
            await self._send({"type": P.TYPE_HEARTBEAT_ACK, "ts": message.get("ts")})

    # ------------------------------------------------------------------
    # requests
    # ------------------------------------------------------------------

    async def _send(self, payload: dict) -> None:
        websocket = self._extension
        if websocket is None:
            raise P.PageSenseError(P.ERR_NOT_CONNECTED, "PageSense Extension 未连接。")
        await websocket.send(json.dumps(payload))

    def wait_for_export(self, timeout: float | None = 60) -> dict:
        """Receive a user-sent snapshot; ACK means queued in memory, not executed.

        The inbox holds at most 8 exports and 64 MiB total. No disk persistence.
        """
        try:
            data, size = self._exports.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError("等待侧栏发送元素超时。") from None
        with self._export_lock:
            self._export_bytes -= size
        return data

    def _next_request_id(self) -> str:
        self._counter += 1
        return f"req_{self._counter:03d}"

    async def request(self, method: str, params: dict | None = None,
                      timeout: float | None = None) -> Any:
        """Send one request and await its matching response."""
        if method not in P.METHODS:
            raise P.PageSenseError("UNKNOWN_METHOD", f"未知方法：{method}")
        if self._extension is None:
            raise P.PageSenseError(P.ERR_NOT_CONNECTED, "PageSense Extension 未连接。")

        request_id = self._next_request_id()
        future: asyncio.Future = self._loop.create_future()
        self._pending[request_id] = future

        try:
            await self._send(P.make_request(request_id, method, params))
        except Exception as exc:
            self._pending.pop(request_id, None)
            raise P.PageSenseError(P.ERR_TRANSPORT, str(exc)) from exc

        effective_timeout = self.request_timeout if timeout is None else float(timeout)
        try:
            return await asyncio.wait_for(future, timeout=effective_timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            raise P.RequestTimeout(method, effective_timeout) from None

    def request_sync(self, method: str, params: dict | None = None,
                     timeout: float | None = None) -> Any:
        """Thread-safe blocking request, for callers outside the loop thread."""
        if self._loop is None:
            raise P.PageSenseError(P.ERR_NOT_CONNECTED, "Controller 未启动。")
        future = asyncio.run_coroutine_threadsafe(
            self.request(method, params, timeout), self._loop
        )
        return future.result(timeout=(timeout or self.request_timeout) + 5)

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    def _fail_pending(self, code: str, message: str) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(P.PageSenseError(code, message))
        self._pending.clear()

    def _notify(self, connected: bool, version: str | None = None) -> None:
        if self.on_state_change is not None:
            try:
                self.on_state_change(connected, version)
            except Exception:
                pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="server.py",
        description="PageSense Controller - local WebSocket server for the PageSense extension.",
    )
    parser.add_argument("--host", default=DEFAULT_HOST, choices=ALLOWED_HOSTS,
                        help="绑定地址（V2.0 仅允许回环地址）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"监听端口（默认 {DEFAULT_PORT}）")
    parser.add_argument("--token", default=None,
                        help="固定 token（默认每次启动随机生成）")
    parser.add_argument("--timeout", type=float, default=DEFAULT_REQUEST_TIMEOUT,
                        help=f"单请求超时秒数（默认 {DEFAULT_REQUEST_TIMEOUT:g}）")
    parser.add_argument("--no-cli", action="store_true",
                        help="只启动服务，不进入交互式 CLI")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        server = ControllerServer(
            host=args.host, port=args.port, token=args.token,
            request_timeout=args.timeout,
        )
    except ValueError as exc:
        print(f"启动失败：{exc}", file=sys.stderr)
        return 2

    def on_state(connected: bool, version: str | None) -> None:
        if connected:
            print(f"\nPageSense connected\nversion={version or 'unknown'}")
        else:
            print("\nPageSense disconnected")

    server.on_state_change = on_state
    server.start()

    print("PageSense Controller")
    print(f"Listening: {server.host}:{server.port}")
    print(f"Token: {server.token}")
    print()
    print("Waiting for extension...")

    if args.no_cli:
        try:
            while True:
                threading.Event().wait(1.0)
        except KeyboardInterrupt:
            print("\nShutting down.")
        finally:
            server.stop()
        return 0

    from cli import run_repl  # imported here so --no-cli stays dependency-light

    try:
        run_repl(server)
    finally:
        server.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
