"""Browser-launched Native Messaging host. Never write diagnostics to stdout."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import queue
import secrets
import struct
import sys
import threading

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

import protocol as P
from server import ControllerServer, MAX_MESSAGE_SIZE, _token_bytes

HOST_NAME = "com.pagesense.bridge"
NATIVE_OUT_LIMIT = 1024 * 1024


def runtime_directory() -> Path:
    override = os.environ.get("PAGESENSE_RUNTIME_DIR")
    if override:
        return Path(override).resolve()
    base = os.environ.get("LOCALAPPDATA") if os.name == "nt" else os.environ.get("XDG_RUNTIME_DIR")
    return Path(base or Path.home() / ".local" / "state") / "PageSense" / "runtime"


def read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        part = stream.read(size - len(chunks))
        if not part:
            if not chunks:
                return None
            raise ValueError("Native frame truncated")
        chunks.extend(part)
    return bytes(chunks)


def read_native(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack("<I", header)[0]
    if not 0 < size <= MAX_MESSAGE_SIZE:
        raise ValueError("Native frame exceeds 64 MiB")
    body = read_exact(stream, size)
    if body is None:
        raise ValueError("Native frame missing body")
    message = json.loads(body)
    if not isinstance(message, dict):
        raise ValueError("Native message must be an object")
    return message


class NativePipe:
    def __init__(self, stream):
        self.stream, self.lock = stream, threading.Lock()

    async def send(self, payload):
        data = payload.encode("utf-8") if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(data) > NATIVE_OUT_LIMIT:
            raise P.PageSenseError("REQUEST_TOO_LARGE", "单次发送到插件的命令超过 Native Messaging 的 1 MiB 上限。")
        with self.lock:
            self.stream.write(struct.pack("<I", len(data)) + data)
            self.stream.flush()

    async def close(self):
        pass


class NativeBroker(ControllerServer):
    """Reuse the existing request correlation and bounded export inbox."""
    def __init__(self, pipe, directory, extension_id):
        super().__init__(port=0)
        self.pipe, self.directory, self.extension_id = pipe, Path(directory), extension_id
        self.session_id = secrets.token_hex(12)
        self.session_file = self.directory / (self.session_id + ".json")
        self.export_ready = None
        self.python_peer = None

    async def _serve(self):
        self.export_ready = asyncio.Event()
        # Web pages always send Origin; only native Python clients omit it.
        self._server = await serve(self._handler, "127.0.0.1", 0,
                                   origins=[None], max_size=MAX_MESSAGE_SIZE)
        self.port = self._server.sockets[0].getsockname()[1]
        self._started.set()

    async def attach(self, hello):
        if hello.get("type") != P.TYPE_HELLO or hello.get("protocol") != P.PROTOCOL:
            raise ValueError("Invalid native handshake")
        self._extension = self.pipe
        self._extension_ready.set()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = {"protocol": P.PROTOCOL, "host": "127.0.0.1", "port": self.port,
                "token": self.token, "extensionId": self.extension_id, "sessionId": self.session_id,
                "pid": os.getpid()}
        temporary = self.session_file.with_suffix(".tmp")
        with open(temporary, "x", encoding="utf-8") as file:
            os.chmod(temporary, 0o600)
            json.dump(data, file)
        temporary.replace(self.session_file)
        await self.pipe.send({"type": P.TYPE_HELLO_ACK, "success": True,
                              "sessionId": self.session_id, "pythonConnected": False})

    async def receive_native(self, message):
        if self._extension is None:
            await self.attach(message)
        elif message.get("type") != P.TYPE_HELLO:
            await super()._on_frame(json.dumps(message, ensure_ascii=False))
            if message.get("type") == P.TYPE_EXPORT:
                self.export_ready.set()

    async def take_export(self, timeout):
        if timeout == 0:
            try:
                return self.wait_for_export(timeout=0)
            except TimeoutError:
                raise P.PageSenseError("EXPORT_TIMEOUT", "等待侧栏发送元素超时。") from None
        async def take():
            while True:
                try:
                    data, size = self._exports.get_nowait()
                except queue.Empty:
                    self.export_ready.clear()
                    await self.export_ready.wait()
                else:
                    with self._export_lock:
                        self._export_bytes -= size
                    return data
        try:
            return await asyncio.wait_for(take(), timeout)
        except asyncio.TimeoutError:
            raise P.PageSenseError("EXPORT_TIMEOUT", "等待侧栏发送元素超时。") from None

    async def _client_request(self, peer, message):
        request_id = message.get("id")
        try:
            method, params = message.get("method"), message.get("params") or {}
            if not isinstance(params, dict):
                raise P.PageSenseError("INVALID_PARAMS", "params 必须是对象。")
            if method == "WAIT_FOR_EXPORT":
                timeout = params.get("timeout", 60)
                if timeout is not None and (type(timeout) not in (float, int) or not 0 <= timeout <= 86400):
                    raise P.PageSenseError("INVALID_PARAMS", "收件超时必须在 0–86400 秒内。")
                result = await self.take_export(timeout)
            else:
                timeout = message.get("timeout", self.request_timeout)
                if type(timeout) not in (int, float) or not 0 < timeout <= 3600:
                    raise P.PageSenseError("INVALID_PARAMS", "请求超时必须在 0–3600 秒内。")
                result = await self.request(method, params, timeout)
            reply = {"id": request_id, "type": P.TYPE_RESPONSE, "success": True, "result": result}
        except P.PageSenseError as error:
            reply = {"id": request_id, "type": P.TYPE_RESPONSE, "success": False, "error": error.to_dict()}
        except Exception:
            reply = {"id": request_id, "type": P.TYPE_RESPONSE, "success": False,
                     "error": {"code": "BRIDGE_ERROR", "message": "本地桥接请求失败。"}}
        try:
            await peer.send(json.dumps(reply, ensure_ascii=False))
        except ConnectionClosed:
            pass

    async def _handler(self, peer):
        tasks = set()
        admitted = False
        try:
            try:
                hello = json.loads(await asyncio.wait_for(peer.recv(), 5))
                valid = (isinstance(hello, dict) and hello.get("type") == "CLIENT_HELLO"
                         and hello.get("protocol") == P.PROTOCOL
                         and secrets.compare_digest(_token_bytes(hello.get("token")), _token_bytes(self.token)))
            except (ValueError, TypeError, asyncio.TimeoutError):
                valid = False
            if not valid or self._extension is None:
                await peer.send(json.dumps(P.make_hello_ack(False)))
                return
            if self.python_peer is not None:
                await peer.send(json.dumps(P.make_hello_ack(False, {
                    "code": "CLIENT_IN_USE", "message": "已有 Python 客户端连接，请先关闭旧脚本。"})))
                return
            self.python_peer, admitted = peer, True
            await peer.send(json.dumps({"type": P.TYPE_HELLO_ACK, "success": True, "sessionId": self.session_id}))
            await self.pipe.send({"type": "NATIVE_STATUS", "pythonConnected": True})
            async for frame in peer:
                try:
                    message = json.loads(frame)
                except ValueError:
                    continue
                if not isinstance(message, dict) or message.get("type") != P.TYPE_REQUEST:
                    continue
                if not isinstance(message.get("id"), str) or len(message["id"]) > 128:
                    continue
                if len(tasks) >= 32:
                    await peer.send(json.dumps({"id": message["id"], "type": P.TYPE_RESPONSE, "success": False,
                                                "error": {"code": "BUSY", "message": "并发请求过多。"}}))
                    continue
                task = asyncio.create_task(self._client_request(peer, message))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        except ConnectionClosed:
            pass
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if admitted:
                self.python_peer = None
                if self._extension is not None:
                    try:
                        await self.pipe.send({"type": "NATIVE_STATUS", "pythonConnected": False})
                    except OSError:
                        pass

    def stop(self):
        super().stop()
        self.session_file.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("origin")
    parser.add_argument("extra", nargs="*")
    args, _ = parser.parse_known_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    origin = args.origin.rstrip("/") + "/"
    if origin not in config["allowed_origins"]:
        raise ValueError("Extension origin is not registered")
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    broker = NativeBroker(NativePipe(sys.stdout.buffer), config.get("runtime_directory") or runtime_directory(), origin.split("/")[2])
    try:
        broker.start()
        while True:
            message = read_native(sys.stdin.buffer)
            if message is None:
                break
            asyncio.run_coroutine_threadsafe(broker.receive_native(message), broker._loop).result(timeout=15)
    finally:
        broker.stop()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("PageSense native host:", type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
