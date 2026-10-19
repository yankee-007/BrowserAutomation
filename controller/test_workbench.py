"""Boundary tests for the panel inbox and page-scoped Python handles."""
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

from pagesense import PageSenseClient
from server import ControllerServer


class ExportInboxTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.server = ControllerServer(port=0)
        self.server._send = AsyncMock()

    async def send(self, data=None, binary=False):
        message = json.dumps({"type": "EXPORT", "id": "fixture-export",
                              "data": data if data is not None else {
                                  "pageId": "fixture-page", "elements": [{"elementId": 1}],
                                  "page": {"url": "https://fixture.test"}}})
        await self.server._on_frame(message.encode() if binary else message)
        return self.server._send.call_args.args[0]

    async def test_receipt_and_binary_frames(self):
        self.assertTrue((await self.send(binary=True))["success"])
        snapshot = self.server.wait_for_export(timeout=0)
        self.assertEqual(snapshot["exportId"], "fixture-export")
        self.assertEqual(snapshot["pageId"], "fixture-page")
        self.assertEqual(self.server._export_bytes, 0)
        with self.assertRaises(TimeoutError):
            self.server.wait_for_export(timeout=0)

    async def test_inbox_pressure_does_not_drop_existing_exports(self):
        for _ in range(8):
            self.assertTrue((await self.send())["success"])
        self.assertFalse((await self.send())["success"])
        self.server.wait_for_export(timeout=0)
        self.assertTrue((await self.send())["success"])
        self.assertEqual(self.server._exports.qsize(), 8)

    async def test_total_memory_budget_recovers_after_consume(self):
        with patch("server.MAX_MESSAGE_SIZE", 250):
            self.assertTrue((await self.send())["success"])
            self.assertFalse((await self.send())["success"])
            self.server.wait_for_export(timeout=0)
            self.assertTrue((await self.send())["success"])

    async def test_malformed_exports_do_not_enter_inbox(self):
        for data in ({}, {"pageId": "", "elements": []}, {"pageId": 1, "elements": []},
                     {"pageId": "fixture", "elements": "invalid"}):
            self.assertFalse((await self.send(data))["success"])
        self.assertEqual(self.server._exports.qsize(), 0)
        await self.server._on_frame("[]")
        await self.server._on_frame("not json")


class HandleTests(unittest.TestCase):
    def setUp(self):
        self.server = Mock(request_timeout=10)
        self.client = PageSenseClient.from_server(self.server)

    def test_incomplete_handles_are_rejected_locally(self):
        for handle in ({"elementId": 1}, {"elementId": True, "pageId": "fixture"},
                       {"elementId": 0, "pageId": "fixture"}, {"elementId": 1, "pageId": ""}):
            with self.assertRaises(ValueError):
                self.client.element(handle)
        self.server.request_sync.assert_not_called()

    def test_exported_handle_keeps_original_page_identity(self):
        handle = {"elementId": 7, "pageId": "original-page"}
        target = self.client.element(handle)
        handle["pageId"] = "changed-outside"
        target.click()
        self.assertEqual(self.server.request_sync.call_args.args[1], {
            "elementId": 7, "pageId": "original-page"})

    def test_locator_re_resolves_before_each_action_and_pins_document(self):
        self.server.request_sync.side_effect = [
            {"pageId": "page-a", "element": {"elementId": 7}}, {"success": True},
            {"pageId": "page-b", "element": {"elementId": 8}}, {"success": True}]
        target = self.client.locator("#target")
        target.click()
        target.input("test")
        calls = self.server.request_sync.call_args_list
        self.assertEqual(calls[0].args[:2], ("RESOLVE_ELEMENT", {"selector": "#target"}))
        self.assertEqual(calls[1].args[1], {"elementId": 7, "pageId": "page-a"})
        self.assertEqual(calls[3].args[1], {"elementId": 8, "pageId": "page-b", "value": "test"})


if __name__ == "__main__":
    unittest.main()
