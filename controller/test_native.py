"""Native framing and real loopback client/broker boundary tests."""
import asyncio
from io import BytesIO
import json
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest

from websockets.sync.client import connect

from native_client import NativeClientTransport
from native_host import NativeBroker, NativePipe, NATIVE_OUT_LIMIT, read_native
from pagesense import PageSenseClient
import protocol as P


class FramingTests(unittest.TestCase):
    def test_exact_utf8_frame(self):
        output = BytesIO()
        asyncio.run(NativePipe(output).send({"text": "中文😀"}))
        output.seek(0)
        self.assertEqual(read_native(output), {"text": "中文😀"})
        self.assertIsNone(read_native(output))

    def test_truncated_and_oversized_frames(self):
        for data in (b"\x01", struct.pack("<I", 100) + b"{}", struct.pack("<I", 65 * 1024 * 1024)):
            with self.assertRaises(ValueError):
                read_native(BytesIO(data))
        with self.assertRaises(P.PageSenseError) as caught:
            asyncio.run(NativePipe(BytesIO()).send({"text": "x" * NATIVE_OUT_LIMIT}))
        self.assertEqual(caught.exception.code, "REQUEST_TOO_LARGE")


class EchoPipe:
    broker = None
    def __init__(self):
        self.messages = []

    async def send(self, payload):
        message = json.loads(payload) if isinstance(payload, str) else payload
        self.messages.append(message)
        if message.get("type") == P.TYPE_REQUEST:
            await self.broker.receive_native({"type": P.TYPE_RESPONSE, "id": message["id"],
                                             "success": True, "result": {"method": message["method"]}})

    async def close(self):
        pass


class NativeClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pagesense-native-unit-")
        self.pipe = EchoPipe()
        self.broker = NativeBroker(self.pipe, self.temp.name, "a" * 32)
        self.pipe.broker = self.broker
        self.broker.start()
        self.call_native({"type": "HELLO", "protocol": P.PROTOCOL})
        self.client = None

    def tearDown(self):
        if self.client:
            self.client.stop()
        self.broker.stop()
        self.assertFalse(self.broker.session_file.exists())
        self.temp.cleanup()

    def call_native(self, message):
        return asyncio.run_coroutine_threadsafe(self.broker.receive_native(message), self.broker._loop).result(3)

    def open_client(self):
        self.client = PageSenseClient(runtime_dir=self.temp.name).start()
        return self.client

    def test_default_client_connects_without_opening_a_server(self):
        client = self.open_client()
        self.assertIsInstance(client.server, NativeClientTransport)
        self.assertTrue(client.connected)
        self.assertEqual(client.ping(), {"method": "PING"})

    def test_export_before_python_connects_and_timeout(self):
        self.call_native({"type": "EXPORT", "id": "snapshot", "data": {"pageId": "fixture", "elements": []}})
        client = self.open_client()
        self.assertEqual(client.wait_for_export(timeout=0)["exportId"], "snapshot")
        with self.assertRaises(TimeoutError):
            client.wait_for_export(timeout=0.01)

    def test_wrong_token_and_browser_origin_are_rejected(self):
        with connect(self.broker.endpoint, proxy=None) as peer:
            peer.send(json.dumps({"type": "CLIENT_HELLO", "protocol": P.PROTOCOL, "token": "wrong"}))
            self.assertFalse(json.loads(peer.recv())["success"])
        with self.assertRaises(Exception):
            connect(self.broker.endpoint, origin="https://fixture.test", proxy=None)

    def test_second_client_cannot_take_over(self):
        self.open_client()
        with self.assertRaises(P.PageSenseError) as caught:
            PageSenseClient(runtime_dir=self.temp.name).start()
        self.assertEqual(caught.exception.code, "CLIENT_IN_USE")
        self.assertTrue(self.client.connected)

    def test_disconnected_waiter_does_not_consume_future_export(self):
        client = self.open_client()
        outcomes = []
        def waiting():
            try:
                client.wait_for_export(timeout=30)
            except P.PageSenseError as error:
                outcomes.append(error.code)
        thread = threading.Thread(target=waiting)
        thread.start()
        time.sleep(0.05)
        client.stop()
        thread.join(3)
        self.assertEqual(outcomes, ["NOT_CONNECTED"])
        self.call_native({"type": "EXPORT", "id": "after-close", "data": {"pageId": "fixture", "elements": []}})
        self.open_client()
        self.assertEqual(self.client.wait_for_export(timeout=1)["exportId"], "after-close")

    def test_stale_discovery_records_do_not_start_a_server(self):
        (Path(self.temp.name) / "invalid.json").write_text('{"host":"example.com","port":80}', encoding="utf-8")
        self.assertEqual(self.open_client().ping()["method"], "PING")

    def test_same_client_can_reconnect_after_native_host_restarts(self):
        client = self.open_client()
        original_session = client.server.session_id
        client.stop()
        self.broker.stop()
        self.pipe = EchoPipe()
        self.broker = NativeBroker(self.pipe, self.temp.name, "a" * 32)
        self.pipe.broker = self.broker
        self.broker.start()
        self.call_native({"type": "HELLO", "protocol": P.PROTOCOL})
        client.start()
        self.assertNotEqual(client.server.session_id, original_session)
        self.assertEqual(client.ping()["method"], "PING")

    def test_multiple_browsers_require_selection(self):
        other_pipe = EchoPipe()
        other = NativeBroker(other_pipe, self.temp.name, "b" * 32)
        other_pipe.broker = other
        other.start()
        try:
            asyncio.run_coroutine_threadsafe(other.receive_native({"type": "HELLO", "protocol": P.PROTOCOL}), other._loop).result(3)
            with self.assertRaises(P.PageSenseError) as caught:
                PageSenseClient(runtime_dir=self.temp.name).start()
            self.assertEqual(caught.exception.code, "AMBIGUOUS_BROWSER")
            # Wait for rejected probes to close before selecting a specific browser.
            for _ in range(100):
                if self.broker.python_peer is None and other.python_peer is None:
                    break
                time.sleep(.01)
            self.client = PageSenseClient(runtime_dir=self.temp.name, extension_id="a" * 32).start()
            self.assertTrue(self.client.connected)
        finally:
            other.stop()


if __name__ == "__main__":
    unittest.main()
