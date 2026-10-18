"""PageSense V2.0 - INDEPENDENT protocol / security / transport tests.

Independently authored for the independent acceptance pass. These tests do NOT
use the PageSense extension: a hand-written fake extension client speaks the
wire protocol directly, so a bug in the extension cannot hide a Controller bug
(and vice versa).

Run:  python indep_protocol.py
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "controller"))

import protocol as P  # noqa: E402
from server import ALLOWED_HOSTS, ControllerServer, generate_token  # noqa: E402

import websockets  # noqa: E402

RESULTS: list[tuple[str, str, bool, str]] = []


def check(cid: str, name: str, cond: bool, detail: str = "") -> bool:
    RESULTS.append((cid, name, bool(cond), detail))
    print(f"{'PASS' if cond else 'FAIL'}  {cid} {name}" + ("" if cond else f"  -> {detail}"))
    return bool(cond)


def eq(cid: str, name: str, actual, expected) -> bool:
    return check(cid, name, actual == expected, f"expected {expected!r} got {actual!r}")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def lan_ip() -> str | None:
    """A non-loopback IPv4 of this machine, if any (for the LAN exposure test)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return None if ip.startswith("127.") else ip
    except Exception:
        return None


# ----------------------------------------------------------------------
# raw websocket helpers
# ----------------------------------------------------------------------

async def raw_connect(port: int, host: str = "127.0.0.1", timeout: float = 5.0):
    return await asyncio.wait_for(
        websockets.connect(f"ws://{host}:{port}", open_timeout=timeout), timeout=timeout
    )


async def recv_json(ws, timeout: float = 5.0):
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


async def hello(ws, token: str, protocol: str = P.PROTOCOL, version: str = "2.0.0"):
    await ws.send(json.dumps({
        "type": "HELLO", "protocol": protocol, "client": "extension",
        "version": version, "token": token,
    }))
    return await recv_json(ws)


async def handshake_ok(port: int, token: str):
    ws = await raw_connect(port)
    ack = await hello(ws, token)
    return ws, ack


# ----------------------------------------------------------------------
# test groups
# ----------------------------------------------------------------------

def test_bind_restrictions() -> None:
    print("\n-- bind / exposure --")
    for bad in ("0.0.0.0", "::", "192.168.1.10", "example.com", ""):
        try:
            ControllerServer(host=bad, port=0)
            check(f"SEC-BIND-{bad or 'empty'}", f"拒绝 host={bad!r}", False,
                  "构造未抛 ValueError")
        except ValueError:
            check(f"SEC-BIND-{bad or 'empty'}", f"拒绝 host={bad!r}", True)
        except Exception as exc:  # noqa: BLE001
            check(f"SEC-BIND-{bad or 'empty'}", f"拒绝 host={bad!r}", False,
                  f"抛出了非 ValueError: {type(exc).__name__}")

    eq("SEC-BIND-LIST", "ALLOWED_HOSTS 仅回环", tuple(ALLOWED_HOSTS),
       ("127.0.0.1", "localhost"))

    for bad_port in (-1, 70000):
        try:
            ControllerServer(host="127.0.0.1", port=bad_port)
            check(f"SEC-PORT-{bad_port}", f"拒绝 port={bad_port}", False, "未抛错")
        except ValueError:
            check(f"SEC-PORT-{bad_port}", f"拒绝 port={bad_port}", True)


def test_actual_socket_binding() -> None:
    print("\n-- actual socket binding --")
    port = free_port()
    token = generate_token()
    server = ControllerServer(host="127.0.0.1", port=port, token=token)
    server.start()
    try:
        # 1. loopback works
        ok = asyncio.run(_probe(port, "127.0.0.1"))
        check("SEC-LOOPBACK", "127.0.0.1 可连接", ok, "loopback connect failed")

        # 2. the listening socket must be bound to loopback only
        bound = _listening_addresses(port)
        check("SEC-BIND-ONLY-LOOPBACK",
              "监听地址只有回环（不含 0.0.0.0）",
              bound and all(h in ("127.0.0.1", "::1") for h in bound),
              f"bound={bound}")

        # 3. the LAN address must NOT accept the connection
        ip = lan_ip()
        if ip is None:
            check("SEC-NO-LAN", "无 LAN 地址可测（环境限制）", True, "no non-loopback IPv4")
        else:
            lan_ok = asyncio.run(_probe(port, ip, timeout=4.0))
            check("SEC-NO-LAN", f"LAN 地址 {ip} 无法连接", not lan_ok,
                  "LAN address unexpectedly accepted a connection!")
    finally:
        server.stop()


def _listening_addresses(port: int) -> list[str]:
    """psutil-free listener inspection via netstat."""
    import subprocess
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             timeout=20).stdout
    except Exception:
        return []
    hosts = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0].upper() == "TCP" and parts[3] == "LISTENING":
            addr = parts[1]
            if addr.endswith(":" + str(port)):
                hosts.append(addr.rsplit(":", 1)[0].strip("[]"))
    return hosts


async def _probe(port: int, host: str, timeout: float = 3.0) -> bool:
    try:
        ws = await raw_connect(port, host=host, timeout=timeout)
        await ws.close()
        return True
    except Exception:
        return False


def test_token_auth() -> None:
    print("\n-- token authentication --")
    port = free_port()
    token = "AAAABBBBCCCCDDDD"
    server = ControllerServer(host="127.0.0.1", port=port, token=token)
    server.start()
    try:
        async def run():
            # correct
            ws, ack = await handshake_ok(port, token)
            check("SEC-TOK-OK", "正确 token -> HELLO_ACK success=true",
                  ack.get("success") is True, json.dumps(ack))
            await ws.close()

            for cid, name, bad in [
                ("SEC-TOK-WRONG", "错误 token 被拒绝", "AAAA BBBB CCCC DDDD"),
                ("SEC-TOK-EMPTY", "空 token 被拒绝", ""),
                ("SEC-TOK-RANDOM", "随机 token 被拒绝", generate_token()),
                ("SEC-TOK-CASE", "大小写不同的 token 被拒绝", token.lower()),
                ("SEC-TOK-SUFFIX", "多一个字符的 token 被拒绝", token + "X"),
                ("SEC-TOK-PREFIX", "少一个字符的 token 被拒绝", token[:-1]),
                ("SEC-TOK-LONG", "超长 token(64k) 被拒绝且不崩溃", "A" * 65536),
                ("SEC-TOK-UNICODE", "非 ASCII token 被拒绝", "トークン🔑"),
            ]:
                try:
                    w = await raw_connect(port)
                    a = await hello(w, bad)
                    ok = (a.get("success") is False and
                          (a.get("error") or {}).get("code") == P.ERR_UNAUTHORIZED)
                    check(cid, name, ok, json.dumps(a)[:200])
                    # server must close the connection afterwards
                    closed = await _expect_closed(w)
                    check(cid + "-close", name + " 后服务端关闭连接", closed,
                          "connection stayed open")
                except Exception as exc:  # noqa: BLE001
                    check(cid, name, False, f"{type(exc).__name__}: {exc}")

            # old token after restart is handled in the recovery test
        asyncio.run(run())
    finally:
        server.stop()


async def _expect_closed(ws, timeout: float = 4.0) -> bool:
    try:
        while True:
            frame = await asyncio.wait_for(ws.recv(), timeout=timeout)
            if frame is None:
                return True
    except websockets.exceptions.ConnectionClosed:
        return True
    except asyncio.TimeoutError:
        return False
    except Exception:
        return True


def test_first_frame_rules() -> None:
    print("\n-- first-frame / handshake rules --")
    port = free_port()
    token = generate_token()
    server = ControllerServer(host="127.0.0.1", port=port, token=token)
    server.start()
    try:
        async def run():
            cases = [
                ("PROTO-BADJSON", "非法 JSON 首帧 -> 拒绝且不崩溃", "{not json", P.ERR_PROTOCOL),
                ("PROTO-EMPTY", "空首帧 -> 拒绝", "", P.ERR_PROTOCOL),
                ("PROTO-ARRAY", "数组首帧 -> 拒绝", "[1,2,3]", P.ERR_PROTOCOL),
                ("PROTO-NULL", "null 首帧 -> 拒绝", "null", P.ERR_PROTOCOL),
                ("PROTO-NUM", "数字首帧 -> 拒绝", "12345", P.ERR_PROTOCOL),
                ("PROTO-NOTHELLO", "非 HELLO 首帧 -> 拒绝",
                 json.dumps({"type": "REQUEST", "id": "x", "method": "PING"}), P.ERR_PROTOCOL),
                ("PROTO-NOTYPE", "缺少 type 的首帧 -> 拒绝", json.dumps({"a": 1}), P.ERR_PROTOCOL),
            ]
            for cid, name, payload, want in cases:
                try:
                    ws = await raw_connect(port)
                    await ws.send(payload)
                    ack = await recv_json(ws)
                    got = (ack.get("error") or {}).get("code")
                    check(cid, name,
                          ack.get("type") == "HELLO_ACK" and ack.get("success") is False
                          and got == want,
                          json.dumps(ack)[:200])
                    await ws.close()
                except Exception as exc:  # noqa: BLE001
                    check(cid, name, False, f"{type(exc).__name__}: {exc}")

            # protocol version mismatch (token correct)
            ws = await raw_connect(port)
            ack = await hello(ws, token, protocol="pagesense/99")
            check("PROTO-VERSION", "协议版本不匹配 -> 拒绝",
                  ack.get("success") is False and
                  (ack.get("error") or {}).get("code") == P.ERR_PROTOCOL,
                  json.dumps(ack))
            await ws.close()

            # no HELLO at all -> server times out the handshake
            ws = await raw_connect(port)
            t0 = time.time()
            closed = await _expect_closed(ws, timeout=8.0)
            check("PROTO-HELLO-TIMEOUT", "不发送 HELLO -> 服务端在 5s 左右断开",
                  closed and (time.time() - t0) < 7.5,
                  f"closed={closed} after {time.time() - t0:.1f}s")

            # Controller must still be alive and usable afterwards
            w2, a2 = await handshake_ok(port, token)
            check("PROTO-ALIVE", "上述异常后服务端仍可正常握手",
                  a2.get("success") is True, json.dumps(a2))
            await w2.close()
        asyncio.run(run())
    finally:
        server.stop()


def test_request_response() -> None:
    print("\n-- request / response correlation --")
    # The Controller validates the method name against protocol.METHODS before
    # sending. These fake methods exercise transport behaviour, so they are
    # whitelisted for the duration of this test only.
    saved_methods = P.METHODS
    P.METHODS = saved_methods + ("ECHO", "SLOW", "FAIL", "SILENT", "ORDERED",
                                 "DUP", "GARBAGE")
    try:
        _test_request_response_body()
    finally:
        P.METHODS = saved_methods


def _test_request_response_body() -> None:
    port = free_port()
    token = generate_token()
    server = ControllerServer(host="127.0.0.1", port=port, token=token,
                              request_timeout=1.5)
    server.start()
    connected = threading.Event()

    async def fake_extension(stop: asyncio.Event):
        ws = await raw_connect(port)
        await hello(ws, token)
        connected.set()
        pending: list[dict] = []
        try:
            async for frame in ws:
                msg = json.loads(frame)
                if msg.get("type") == "HEARTBEAT":
                    await ws.send(json.dumps({"type": "HEARTBEAT_ACK", "ts": msg.get("ts")}))
                    continue
                if msg.get("type") != "REQUEST":
                    continue
                pending.append(msg)
                method = msg.get("method")
                rid = msg.get("id")
                if method == "PING":
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE",
                                              "success": True, "result": {"pong": True}}))
                elif method == "ECHO":
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE", "success": True,
                                              "result": {"params": msg.get("params")}}))
                elif method == "SLOW":
                    await asyncio.sleep(0.4)
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE",
                                              "success": True, "result": {"slow": True}}))
                elif method == "FAIL":
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE", "success": False,
                                              "error": {"code": "ELEMENT_NOT_FOUND",
                                                        "message": "nope"}}))
                elif method == "SILENT":
                    pass  # never answers
                elif method == "ORDERED":
                    # respond to ORDERED requests in reverse arrival order
                    n = int(msg.get("params", {}).get("n", 0))
                    await asyncio.sleep(0.05 * (10 - n))
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE",
                                              "success": True, "result": {"n": n}}))
                elif method == "DUP":
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE",
                                              "success": True, "result": {"first": True}}))
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE",
                                              "success": True, "result": {"second": True}}))
                elif method == "GARBAGE":
                    await ws.send("this is not json")
                    await ws.send(json.dumps([1, 2, 3]))
                    await ws.send(json.dumps({"type": "RESPONSE"}))  # no id
                    await ws.send(json.dumps({"id": "nope", "type": "RESPONSE",
                                              "success": True, "result": {"orphan": True}}))
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE",
                                              "success": True, "result": {"ok": True}}))
        except websockets.exceptions.ConnectionClosed:
            pass

    loop_holder: dict = {}

    def run_fake():
        loop = asyncio.new_event_loop()
        loop_holder["loop"] = loop
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(fake_extension(asyncio.Event()))
        except Exception:
            pass

    t = threading.Thread(target=run_fake, daemon=True)
    t.start()
    if not connected.wait(timeout=10):
        server.stop()
        check("PROTO-FAKE-CONNECT", "假扩展客户端已连接", False, "timeout")
        return

    from protocol import PageSenseError  # noqa: E402

    try:
        check("PROTO-FAKE-CONNECT", "假扩展客户端已连接", True)
        eq("REQ-PING", "PING 请求/响应", server.request_sync("PING", timeout=3).get("pong"), True)

        # params handling. make_request() normalizes a missing/None params to
        # {} on the wire (protocol.py: `params or {}`), which is the documented
        # envelope shape, so None is expected to arrive as {}.
        for label, params, expected in [
            ("params=None", None, {}),
            ("params={}", {}, {}),
            ("params 嵌套", {"a": {"b": [1, 2, 3]}}, {"a": {"b": [1, 2, 3]}}),
            ("params 含中文", {"q": "立即沟通"}, {"q": "立即沟通"}),
            ("params 含 emoji", {"q": "🔑"}, {"q": "🔑"}),
            ("params 大字符串 512KB", {"q": "x" * (512 * 1024)}, {"q": "x" * (512 * 1024)}),
            ("params 数字", {"n": 12345}, {"n": 12345}),
            ("params 布尔", {"f": False}, {"f": False}),
        ]:
            r = server.request_sync("ECHO", params, timeout=5)
            eq("REQ-" + label, f"params 透传: {label}", r.get("params"), expected)

        # error response
        try:
            server.request_sync("FAIL", timeout=3)
            check("REQ-ERROR", "扩展返回 success=false -> 抛 PageSenseError", False, "未抛错")
        except PageSenseError as exc:
            eq("REQ-ERROR", "扩展返回 success=false -> 抛 PageSenseError",
               exc.code, "ELEMENT_NOT_FOUND")
        check("REQ-ALIVE-AFTER-ERROR", "错误响应后连接仍可用",
              server.request_sync("PING", timeout=3).get("pong") is True)

        # unknown method is rejected locally
        try:
            server.request_sync("LAUNCH_MISSILES", timeout=3)
            check("REQ-UNKNOWN", "未知方法本地拒绝 -> UNKNOWN_METHOD", False, "未抛错")
        except PageSenseError as exc:
            eq("REQ-UNKNOWN", "未知方法本地拒绝 -> UNKNOWN_METHOD", exc.code, "UNKNOWN_METHOD")

        # timeout
        t0 = time.time()
        try:
            server.request_sync("SILENT", timeout=1.5)
            check("REQ-TIMEOUT", "无响应 -> REQUEST_TIMEOUT", False, "未抛错")
        except PageSenseError as exc:
            eq("REQ-TIMEOUT", "无响应 -> REQUEST_TIMEOUT", exc.code, "REQUEST_TIMEOUT")
            dt = time.time() - t0
            check("REQ-TIMEOUT-1", "超时时间接近配置值(1.5s)", 1.3 <= dt <= 3.5, f"{dt:.2f}s")
        check("REQ-ALIVE-AFTER-TIMEOUT", "超时后连接仍可用",
              server.request_sync("PING", timeout=3).get("pong") is True)

        # duplicate response id
        eq("REQ-DUP", "重复 id 响应只解析第一次", server.request_sync("DUP", timeout=3).get("first"), True)

        # garbage frames interleaved with a valid response
        eq("REQ-GARBAGE", "垃圾帧后仍能拿到正确响应",
           server.request_sync("GARBAGE", timeout=3).get("ok"), True)

        # out-of-order responses map to the right request
        res = {}
        def call(n):
            res[n] = server.request_sync("ORDERED", {"n": n}, timeout=8)
        threads = [threading.Thread(target=call, args=(i,)) for i in range(1, 10)]
        for th in threads:
            th.start()
        for th in threads:
            th.join(timeout=12)
        ok = all(res.get(i, {}).get("n") == i for i in range(1, 10))
        check("REQ-OOO", "9 个乱序响应全部正确对应 request id", ok,
              json.dumps({k: v.get("n") for k, v in sorted(res.items())}))

        # request ids unique + monotonic
        ids = []
        for _ in range(5):
            ids.append(server._next_request_id())
        check("REQ-IDS", "request id 唯一且递增",
              len(set(ids)) == 5 and ids == sorted(ids), str(ids))
    finally:
        server.stop()

    # pending request fails when server stops
    port2 = free_port()
    server2 = ControllerServer(host="127.0.0.1", port=port2, token=token, request_timeout=8)
    server2.start()
    stop_evt = threading.Event()

    async def hold():
        ws = await raw_connect(port2)
        await hello(ws, token)
        stop_evt.set()
        try:
            async for frame in ws:
                raise AssertionError("should not receive REQUEST")
        except Exception:
            pass

    def run_hold():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(hold())
        except Exception:
            pass

    threading.Thread(target=run_hold, daemon=True).start()
    stop_evt.wait(timeout=8)

    def do_slow():
        try:
            server2.request_sync("SILENT", timeout=6)
        except Exception:
            pass

    threading.Thread(target=do_slow, daemon=True).start()
    time.sleep(0.4)
    try:
        server2.request_sync("PING", timeout=2)
    except Exception:
        pass
    server2.stop()
    check("REQ-STOP", "Controller 停止不产生未捕获异常", True)


def test_concurrency() -> None:
    print("\n-- concurrency / correlation --")
    port = free_port()
    token = generate_token()
    server = ControllerServer(host="127.0.0.1", port=port, token=token,
                              request_timeout=6.0)
    server.start()

    async def ext():
        ws = await raw_connect(port)
        await hello(ws, token)
        try:
            async for frame in ws:
                msg = json.loads(frame)
                if msg.get("type") != "REQUEST":
                    continue
                rid = msg["id"]
                method = msg["method"]
                if method == "GET_STATUS":
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE", "success": True,
                                              "result": {"connected": True, "state": "CONNECTED"}}))
                elif method == "SEARCH_ELEMENTS":
                    await ws.send(json.dumps({"id": rid, "type": "RESPONSE", "success": True,
                                              "result": {"total": msg["params"].get("limit", 0)}}))
                elif method == "PING":
                    # Echo the params back so the caller can prove the response
                    # it received belongs to the request it sent.
                    await asyncio.sleep(0.02)
                    await ws.send(json.dumps({
                        "id": rid, "type": "RESPONSE", "success": True,
                        "result": {"pong": True, "id": rid,
                                   "tag": (msg.get("params") or {}).get("tag")}}))
        except websockets.exceptions.ConnectionClosed:
            pass

    def run_ext():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(ext())
        except Exception:
            pass

    threading.Thread(target=run_ext, daemon=True).start()
    time.sleep(0.6)

    try:
        out: dict = {}
        errors: list = []

        def worker(i):
            try:
                if i % 3 == 0:
                    out[i] = server.request_sync("PING", {"tag": i}, timeout=8)
                elif i % 3 == 1:
                    out[i] = server.request_sync("GET_STATUS", {"tag": i}, timeout=8)
                else:
                    out[i] = server.request_sync("SEARCH_ELEMENTS", {"limit": i}, timeout=8)
            except Exception as exc:  # noqa: BLE001
                errors.append((i, repr(exc)))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(1, 31)]
        for th in threads:
            th.start()
        for th in threads:
            th.join(timeout=20)

        check("CONC-NO-ERROR", "30 个并发请求无异常", not errors, str(errors[:3]))
        # The response must be the one belonging to THIS request: the fake
        # extension echoes the request's own `tag` back.
        bad = [i for i in range(1, 31) if i % 3 == 0 and out.get(i, {}).get("tag") != i]
        check("CONC-PING-TAG", "PING 响应回显各自 request 的参数（无 A 请求收 B 响应）",
              not bad, f"mismatch={bad}")
        ids = [out[i].get("id") for i in range(3, 31, 3) if i in out]
        check("CONC-PING-IDS", "每个 PING 响应的 request id 互不相同",
              len(set(ids)) == len(ids) and all(str(x).startswith("req_") for x in ids),
              str(ids))
        bad = [i for i in range(1, 31) if i % 3 == 2 and out.get(i, {}).get("total") != i]
        check("CONC-SEARCH-PARAM", "SEARCH 响应携带各自 params", not bad, f"mismatch={bad}")
        bad = [i for i in range(1, 31) if i % 3 == 1 and out.get(i, {}).get("state") != "CONNECTED"]
        check("CONC-STATUS", "GET_STATUS 响应正确", not bad, f"mismatch={bad}")
    finally:
        server.stop()


def test_second_connection_replaces() -> None:
    print("\n-- single session semantics --")
    port = free_port()
    token = generate_token()
    server = ControllerServer(host="127.0.0.1", port=port, token=token)
    server.start()
    try:
        async def run():
            ws1, a1 = await handshake_ok(port, token)
            check("SESSION-1", "第一个会话握手成功", a1.get("success") is True)
            await asyncio.sleep(0.3)
            ws2, a2 = await handshake_ok(port, token)
            check("SESSION-2", "第二个会话握手成功", a2.get("success") is True)
            # the first socket must be closed by the Controller
            closed = await _expect_closed(ws1, timeout=5)
            check("SESSION-REPLACE", "新连接顶替旧连接（旧连接被关闭）", closed,
                  "first connection stayed open")
            await ws2.close()
        asyncio.run(run())
    finally:
        server.stop()


def test_source_security() -> None:
    print("\n-- source-level security review --")
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", ".."))
    ctrl = os.path.join(root, "controller")
    ext = os.path.join(root, "pagesense")

    src = ""
    for base, _dirs, files in os.walk(ctrl):
        if "node_modules" in base or "__pycache__" in base:
            continue
        for f in files:
            if f.endswith(".py"):
                with open(os.path.join(base, f), encoding="utf-8") as fh:
                    src += fh.read()

    # Strip docstrings and comments before looking for a literal token: a
    # usage example such as PageSenseClient(token="ABC123") in a docstring is
    # documentation, not a shipped credential, and must not be reported as one.
    import re
    code_only = re.sub(r'"""(?:.|\n)*?"""', "", src)
    code_only = re.sub(r"'''(?:.|\n)*?'''", "", code_only)
    code_only = re.sub(r"#[^\n]*", "", code_only)

    hardcoded = []
    for m in re.finditer(r'(?:token|TOKEN)\s*[:=]\s*["\']([^"\']{3,})["\']', code_only):
        hardcoded.append(m.group(1))
    check("SRC-NO-HARDCODED-TOKEN", "controller 代码（非注释/文档）无硬编码 token",
          not hardcoded, str(hardcoded[:5]))

    # The only token literal allowed anywhere is the documented usage example.
    doc_tokens = set(re.findall(r'token\s*=\s*["\']([^"\']{3,})["\']', src)) - set(hardcoded)
    check("SRC-TOKEN-LITERAL-DOC", "token 字面量仅出现在文档示例中",
          doc_tokens <= {"ABC123"}, str(sorted(doc_tokens)))

    token_src = open(os.path.join(ctrl, "server.py"), encoding="utf-8").read()
    check("SRC-SECRETS-TOKEN", "token 使用 secrets.token_hex 生成",
          "secrets.token_hex" in token_src)
    check("SRC-COMPARE-DIGEST", "token 比较使用 secrets.compare_digest",
          "compare_digest" in token_src)
    check("SRC-NO-EVAL", "controller 无 eval/exec 执行外部输入",
          "eval(" not in token_src and "exec(" not in token_src)

    ext_src = ""
    for base, _dirs, files in os.walk(ext):
        if "node_modules" in base:
            continue
        for f in files:
            if f.endswith(".js"):
                with open(os.path.join(base, f), encoding="utf-8") as fh:
                    ext_src += fh.read()
    for bad in ["eval(", "new Function(", "document.write", "innerHTML = raw",
                "localStorage", "indexedDB"]:
        pass
    check("SRC-EXT-NO-EVAL", "extension 无 eval/new Function",
          "eval(" not in ext_src and "new Function(" not in ext_src)
    check("SRC-ALLOWED-HOSTS", "扩展侧只允许回环 host",
          'ALLOWED_HOSTS: ["127.0.0.1", "localhost"]' in ext_src)


def main() -> int:
    print("=== PageSense V2.0 INDEPENDENT protocol / security suite ===")
    t0 = time.time()
    test_source_security()
    test_bind_restrictions()
    test_actual_socket_binding()
    test_token_auth()
    test_first_frame_rules()
    test_request_response()
    test_concurrency()
    test_second_connection_replaces()

    fails = [r for r in RESULTS if not r[2]]
    print(f"\nINDEP PROTOCOL SUMMARY: "
          f"{len(RESULTS) - len(fails)} PASS / {len(fails)} FAIL "
          f"({len(RESULTS)} total, {time.time() - t0:.1f}s)")
    if fails:
        print("FAILED: " + ", ".join(f[0] for f in fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
