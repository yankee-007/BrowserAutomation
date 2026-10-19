"""Python client for the browser-owned local bridge; never opens a server."""
from __future__ import annotations

from concurrent.futures import Future, TimeoutError as FutureTimeout
import json
from pathlib import Path
import threading

from websockets.sync.client import connect

import protocol as P
from native_host import runtime_directory
from server import MAX_MESSAGE_SIZE


class NativeClientTransport:
    def __init__(self, request_timeout=10, *, directory=None, extension_id=None, session_id=None):
        self.request_timeout = request_timeout
        self.directory = Path(directory) if directory else runtime_directory()
        self.extension_id, self.session_id = extension_id, session_id
        self._requested_session = session_id
        self._socket, self._reader, self._context = None, None, None
        self._pending, self._counter = {}, 0
        self._lock, self._send_lock = threading.Lock(), threading.Lock()
        self.port, self.token = None, ""

    @property
    def connected(self):
        return self._socket is not None

    @property
    def endpoint(self):
        return f"ws://127.0.0.1:{self.port}" if self.port else "native://pagesense"

    def start(self):
        if self.connected:
            return self
        if self._context:
            self._context.__exit__(None, None, None)
            self._context = None
        candidates, busy = [], 0
        for file in self.directory.glob("*.json"):
            peer, context = None, None
            try:
                data = json.loads(file.read_text(encoding="utf-8"))
                if (data.get("protocol") != P.PROTOCOL or data.get("host") != "127.0.0.1"
                    or type(data.get("port")) is not int or not 0 < data["port"] < 65536
                    or not isinstance(data.get("token"), str) or not data["token"]):
                    continue
                if self.extension_id and data.get("extensionId") != self.extension_id:
                    continue
                if self._requested_session and data.get("sessionId") != self._requested_session:
                    continue
                context = connect(f'ws://127.0.0.1:{data["port"]}', open_timeout=1, max_size=MAX_MESSAGE_SIZE, proxy=None)
                peer = context.__enter__()
                peer.send(json.dumps({"type": "CLIENT_HELLO", "protocol": P.PROTOCOL, "token": data["token"]}))
                ack = json.loads(peer.recv(timeout=2))
                if ack.get("success") is not True:
                    busy += int((ack.get("error") or {}).get("code") == "CLIENT_IN_USE")
                    context.__exit__(None, None, None)
                    continue
                candidates.append((peer, data, context))
            except Exception:
                # Discovery must tolerate stale records without deleting another process's state.
                if context and peer:
                    context.__exit__(None, None, None)
                continue
        if len(candidates) != 1 or busy:
            for peer, _, context in candidates:
                context.__exit__(None, None, None)
            if len(candidates) + busy > 1:
                sessions = ", ".join(data["sessionId"] for _, data, _ in candidates)
                raise P.PageSenseError("AMBIGUOUS_BROWSER", "多个浏览器桥接可用，请用 session_id 指定会话：" + sessions)
            if busy:
                raise P.PageSenseError("CLIENT_IN_USE", "已有 Python 脚本占用浏览器桥接，请先关闭旧脚本。")
            raise P.PageSenseError("BRIDGE_NOT_RUNNING", "未找到浏览器桥接。请打开 PageSense；首次使用先运行 install_bridge.py，并在插件中重试连接。")
        self._socket, data, self._context = candidates[0]
        self.port, self.token, self.session_id = data["port"], data["token"], data["sessionId"]
        self._reader = threading.Thread(target=self._receive, args=(self._socket,), daemon=True, name="pagesense-client")
        self._reader.start()
        return self

    def _receive(self, peer):
        try:
            for frame in peer:
                message = json.loads(frame)
                with self._lock:
                    future = self._pending.pop(message.get("id"), None)
                if future is None or future.done():
                    continue
                if message.get("success") is True:
                    future.set_result(message.get("result", {}))
                else:
                    error = message.get("error") or {}
                    future.set_exception(P.PageSenseError(error.get("code", "BRIDGE_ERROR"), error.get("message", "")))
        except Exception:
            pass
        finally:
            peer.close()
            if self._socket is peer:
                self._socket = None
            with self._lock:
                pending, self._pending = self._pending, {}
            for future in pending.values():
                if not future.done():
                    future.set_exception(P.PageSenseError("NOT_CONNECTED", "浏览器桥接已断开，请重新连接；命令未自动重发。"))

    def stop(self):
        peer = self._socket
        if self._context:
            self._context.__exit__(None, None, None)
            self._context = None
        elif peer:
            peer.close()
        if self._reader and self._reader is not threading.current_thread():
            self._reader.join(timeout=5)
        self._socket = None

    def wait_for_extension(self, timeout=None):
        return self.connected

    def _request(self, method, params, timeout, *, wait_timeout=None):
        peer = self._socket
        if peer is None:
            raise P.PageSenseError("NOT_CONNECTED", "请先连接浏览器桥接。")
        effective_timeout = self.request_timeout if timeout is None else timeout
        future = Future()
        with self._lock:
            self._counter += 1
            request_id = f"client_{self._counter}"
            self._pending[request_id] = future
        try:
            try:
                with self._send_lock:
                    peer.send(json.dumps({"type": P.TYPE_REQUEST, "id": request_id, "method": method,
                                          "params": params or {}, "timeout": effective_timeout}))
            except Exception as error:
                raise P.PageSenseError("TRANSPORT_ERROR", "发送时连接中断，操作结果未知；请检查页面后重新连接，命令未自动重发。") from error
            return future.result(timeout=wait_timeout if method == "WAIT_FOR_EXPORT" else effective_timeout + 2)
        except FutureTimeout:
            raise P.RequestTimeout(method, effective_timeout) from None
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def request_sync(self, method, params=None, timeout=None):
        if method not in P.METHODS:
            raise P.PageSenseError("UNKNOWN_METHOD", "未知方法：" + str(method))
        return self._request(method, params, timeout)

    def wait_for_export(self, timeout=60):
        try:
            return self._request("WAIT_FOR_EXPORT", {"timeout": timeout}, self.request_timeout,
                                 wait_timeout=timeout + 2 if timeout is not None else None)
        except P.PageSenseError as error:
            if error.code == "EXPORT_TIMEOUT":
                raise TimeoutError("等待侧栏发送元素超时。") from None
            raise
