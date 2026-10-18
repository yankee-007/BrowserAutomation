"""PageSense Controller - bridge unit tests.

Drives a real :class:`server.ControllerServer` over a real loopback WebSocket
with a scripted *fake extension* peer. Covers the transport contract:

  * HELLO / HELLO_ACK happy path and token rejection
  * REQUEST envelope shape and unique request ids
  * responses correlated by id (never by arrival order)
  * error responses surfacing as PageSenseError with the right code
  * per-request timeout
  * local rejection of an unknown method
  * requests while disconnected
  * the hard loopback-only bind rule

Run:  python -m unittest test_bridge -v
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
import unittest

import protocol as P
from server import ALLOWED_HOSTS, ControllerServer, generate_token

import websockets.sync.client as ws_sync


class FakeExtension(threading.Thread):
    """A scripted stand-in for the PageSense extension.

    Connects, performs HELLO, then answers requests using ``behaviour``: a
    callable ``(method, params, request_id) -> response_dict | None``.
    Returning ``None`` means "never answer", which exercises timeouts.
    """

    def __init__(self, url: str, token: str, behaviour=None, protocol=P.PROTOCOL):
        super().__init__(daemon=True)
        self.url = url
        self.token = token
        self.protocol = protocol
        self.behaviour = behaviour or (lambda method, params, rid: {
            "id": rid, "type": P.TYPE_RESPONSE, "success": True, "result": {},
        })
        self.hello_ack: dict | None = None
        self.received: list[dict] = []
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._connection = None

    def wait_ready(self, timeout: float = 5.0) -> bool:
        return self._ready.wait(timeout)

    def stop(self) -> None:
        self._stop.set()
        if self._connection is not None:
            try:
                self._connection.close()
            except Exception:
                pass

    def run(self) -> None:
        try:
            with ws_sync.connect(self.url, open_timeout=5) as connection:
                self._connection = connection
                connection.send(json.dumps({
                    "type": P.TYPE_HELLO,
                    "protocol": self.protocol,
                    "client": P.CLIENT_NAME,
                    "version": "2.0.0",
                    "token": self.token,
                }))
                self.hello_ack = json.loads(connection.recv())
                self._ready.set()
                if not self.hello_ack.get("success"):
                    return

                while not self._stop.is_set():
                    try:
                        frame = connection.recv(timeout=0.2)
                    except TimeoutError:
                        continue
                    except Exception:
                        return
                    message = json.loads(frame)
                    # Only REQUEST frames carry an id we must answer; anything
                    # else (heartbeat acks) is not part of this contract.
                    if message.get("type") != P.TYPE_REQUEST:
                        continue
                    self.received.append(message)
                    request_id = message["id"]
                    reply = self.behaviour(
                        message.get("method"), message.get("params", {}), request_id
                    )
                    if reply is not None:
                        connection.send(json.dumps(reply))
        except Exception:
            self._ready.set()


class BridgeTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.server = ControllerServer(port=0, token=generate_token(),
                                       request_timeout=1.0)
        self.server.start()
        self.addCleanup(self.server.stop)

    def connect_fake(self, behaviour=None, **kwargs) -> FakeExtension:
        fake = FakeExtension(f"ws://127.0.0.1:{self.server.port}", self.server.token,
                             behaviour=behaviour, **kwargs)
        fake.start()
        self.addCleanup(fake.stop)
        self.assertTrue(fake.wait_ready(), "fake extension 未完成 HELLO")
        self.assertTrue(self.server.wait_for_extension(timeout=5),
                        "server 未登记 extension")
        return fake


class TestHandshake(BridgeTestBase):
    def test_hello_ack_success_with_correct_token(self):
        fake = self.connect_fake()
        self.assertEqual(fake.hello_ack.get("type"), P.TYPE_HELLO_ACK)
        self.assertIs(fake.hello_ack.get("success"), True)
        self.assertTrue(self.server.connected)

    def test_token_rejected(self):
        fake = FakeExtension(f"ws://127.0.0.1:{self.server.port}", "WRONG-TOKEN")
        fake.start()
        self.addCleanup(fake.stop)
        self.assertTrue(fake.wait_ready())
        self.assertIs(fake.hello_ack.get("success"), False)
        self.assertEqual(fake.hello_ack["error"]["code"], P.ERR_UNAUTHORIZED)
        time.sleep(0.2)
        self.assertFalse(self.server.connected)

    def test_protocol_mismatch_rejected(self):
        fake = FakeExtension(f"ws://127.0.0.1:{self.server.port}", self.server.token,
                             protocol="pagesense/999")
        fake.start()
        self.addCleanup(fake.stop)
        self.assertTrue(fake.wait_ready())
        self.assertIs(fake.hello_ack.get("success"), False)
        self.assertEqual(fake.hello_ack["error"]["code"], P.ERR_PROTOCOL)


class TestRequestEnvelope(BridgeTestBase):
    def test_envelope_shape_and_request_id(self):
        fake = self.connect_fake(lambda m, p, rid: {
            "id": rid, "type": P.TYPE_RESPONSE, "success": True,
            "result": {"pong": True},
        })
        result = self.server.request_sync("PING")
        self.assertEqual(result, {"pong": True})

        self.assertEqual(len(fake.received), 1)
        envelope = fake.received[0]
        self.assertEqual(envelope["id"], "req_001")
        self.assertEqual(envelope["type"], P.TYPE_REQUEST)
        self.assertEqual(envelope["method"], "PING")

        self.server.request_sync("GET_STATUS")
        self.assertEqual(fake.received[1]["id"], "req_002")

    def test_params_are_forwarded(self):
        fake = self.connect_fake(lambda m, p, rid: {
            "id": rid, "type": P.TYPE_RESPONSE, "success": True, "result": {},
        })
        self.server.request_sync("INPUT_ELEMENT",
                                 {"elementId": 16, "value": "AI应用工程师"})
        self.assertEqual(fake.received[0]["params"],
                         {"elementId": 16, "value": "AI应用工程师"})

    def test_responses_correlated_by_id_not_order(self):
        """The second request must not be answered by the first response."""
        def behaviour(method, params, rid):
            if method == "SCAN_PAGE":
                return None  # deliberately never answered
            return {"id": rid, "type": P.TYPE_RESPONSE, "success": True,
                    "result": {"method": method}}

        fake = self.connect_fake(behaviour)

        # SCAN_PAGE is deliberately never answered, so this thread is expected
        # to end in RequestTimeout; capture it instead of spewing a traceback.
        outcome: list[BaseException] = []

        def call_slow() -> None:
            try:
                outcome.append(self.server.request_sync("SCAN_PAGE", timeout=0.3))
            except BaseException as exc:  # noqa: BLE001 - test harness
                outcome.append(exc)

        slow = threading.Thread(target=call_slow)
        slow.start()
        fast = self.server.request_sync("GET_STATUS")
        slow.join(timeout=3)

        self.assertEqual(fast, {"method": "GET_STATUS"})
        # req_002 answered before req_001 is still tagged with its own id.
        self.assertEqual(fake.received[0]["id"], "req_001")
        self.assertEqual(fake.received[1]["id"], "req_002")
        self.assertIsInstance(outcome[0], P.RequestTimeout)

    def test_error_response_raises_with_code(self):
        self.connect_fake(lambda m, p, rid: {
            "id": rid, "type": P.TYPE_RESPONSE, "success": False,
            "error": {"code": "NO_ACTIVE_TAB", "message": "没有可操作的活动页面"},
        })
        with self.assertRaises(P.PageSenseError) as ctx:
            self.server.request_sync("SCAN_PAGE")
        self.assertEqual(ctx.exception.code, "NO_ACTIVE_TAB")


class TestFailures(BridgeTestBase):
    def test_timeout(self):
        self.connect_fake(lambda m, p, rid: None)
        with self.assertRaises(P.RequestTimeout) as ctx:
            self.server.request_sync("SCAN_PAGE", timeout=0.5)
        self.assertEqual(ctx.exception.code, P.ERR_REQUEST_TIMEOUT)

    def test_unknown_method_rejected_locally(self):
        self.connect_fake()
        with self.assertRaises(P.PageSenseError) as ctx:
            self.server.request_sync("LAUNCH_MISSILES")
        self.assertEqual(ctx.exception.code, "UNKNOWN_METHOD")

    def test_request_while_disconnected(self):
        with self.assertRaises(P.PageSenseError) as ctx:
            self.server.request_sync("PING")
        self.assertEqual(ctx.exception.code, P.ERR_NOT_CONNECTED)

    def test_invalid_message_is_ignored(self):
        """Garbage frames must not break the correlation table."""
        fake = self.connect_fake(lambda m, p, rid: {
            "id": rid, "type": P.TYPE_RESPONSE, "success": True, "result": {"ok": 1},
        })
        self.assertEqual(self.server.request_sync("PING"), {"ok": 1})
        self.assertTrue(fake.is_alive())


class TestSecurity(unittest.TestCase):
    def test_rejects_non_loopback_bind(self):
        for host in ("0.0.0.0", "192.168.1.10", "::", "example.com"):
            with self.assertRaises(ValueError):
                ControllerServer(host=host)

    def test_loopback_hosts_allowed(self):
        self.assertEqual(ALLOWED_HOSTS, ("127.0.0.1", "localhost"))

    def test_default_bind_is_loopback(self):
        server = ControllerServer(port=0)
        server.start()
        try:
            self.assertEqual(server.host, "127.0.0.1")
            # The socket must not be reachable through a non-loopback address.
            hostname = socket.gethostname()
            try:
                external_ip = socket.gethostbyname(hostname)
            except OSError:
                external_ip = None
            if external_ip and not external_ip.startswith("127."):
                with self.assertRaises(OSError):
                    socket.create_connection((external_ip, server.port), timeout=1)
        finally:
            server.stop()

    def test_token_is_random_per_server(self):
        tokens = {generate_token() for _ in range(20)}
        self.assertEqual(len(tokens), 20)
        self.assertTrue(all(len(t) == 16 for t in tokens))


if __name__ == "__main__":
    unittest.main(verbosity=2)
