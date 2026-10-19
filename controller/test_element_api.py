"""On-demand element proxies: minimal requests, stable handles and field semantics."""
import unittest
from unittest.mock import Mock

from pagesense import PageSenseClient
from protocol import PageSenseError


class ElementApiTests(unittest.TestCase):
    def setUp(self):
        self.server = Mock(request_timeout=10)
        self.client = PageSenseClient.from_server(self.server)
        self.handle = {"pageId": "doc", "elementId": 3, "referenceId": "node_8"}

    def found(self, handles=None):
        self.server.request_sync.return_value = {"pageId": "doc", "elements": handles if handles is not None else [self.handle]}

    def test_find_is_one_request_without_scan_or_detail(self):
        self.found()
        element = self.client.find("css_position", "#target")
        self.server.request_sync.assert_called_once_with("FIND_ELEMENTS", {
            "by": "css_position", "selector": "#target", "multiple": False, "strict": True}, None)
        self.server.request_sync.reset_mock()
        element.click()
        self.server.request_sync.assert_called_once_with("CLICK_ELEMENT", self.handle, None)

    def test_findall_returns_bound_snapshot_objects(self):
        second = dict(self.handle, elementId=4, referenceId="node_9")
        self.found([self.handle, second])
        elements = self.client.findall("xpath_position", "//a")
        self.assertEqual(len(elements), 2)
        self.server.request_sync.return_value = {"value": "second", "truncated": False}
        self.assertEqual(elements[1].get_text(), "second")
        self.assertEqual(self.server.request_sync.call_args.args[1], dict(second, mode="text"))

    def test_empty_findall_is_empty_list(self):
        self.found([])
        self.assertEqual(self.client.findall("css", ".missing"), [])

    def test_scoped_queries_send_original_reference_and_page(self):
        root = self.client.element(self.handle)
        self.found()
        root.find("xpath", ".//p", strict=False)
        self.server.request_sync.assert_called_once_with("FIND_ELEMENTS", {
            "by": "xpath_position", "selector": ".//p", "multiple": False,
            "strict": False, "scope": self.handle, "pageId": "doc"}, None)

    def test_getters_return_only_requested_value(self):
        element = self.client.element(self.handle)
        self.server.request_sync.return_value = {"value": "../next", "truncated": False}
        self.assertEqual(element.get("href"), "../next")
        self.assertEqual(self.server.request_sync.call_args.args[1], dict(self.handle, mode="attribute", name="href"))
        self.server.request_sync.return_value = {"value": False, "truncated": False}
        self.assertIs(element.get_property("checked"), False)
        self.server.request_sync.return_value = {"value": None, "truncated": False}
        self.assertIsNone(element.get("missing"))

    def test_get_all_uses_existing_details(self):
        self.server.request_sync.return_value = {"htmlTruncated": True}
        self.assertTrue(self.client.element(self.handle).get_all()["htmlTruncated"])
        self.assertEqual(self.server.request_sync.call_args.args[0], "GET_ELEMENT_DETAILS")

    def test_text_truncation_is_not_silently_accepted(self):
        self.server.request_sync.return_value = {"value": "partial", "length": 21000, "truncated": True}
        with self.assertRaises(PageSenseError) as raised:
            self.client.element(self.handle).get_text()
        self.assertEqual(raised.exception.code, "TEXT_TRUNCATED")

    def test_all_texts_is_one_request_and_checks_each_result(self):
        self.server.request_sync.return_value = {"items": [{"value": "A"}, {"value": "B"}]}
        self.assertEqual(self.client.element(self.handle).get_all_texts("p"), ["A", "B"])
        self.server.request_sync.assert_called_once_with("READ_ELEMENTS", {
            "by": "css_position", "selector": "p", "scope": self.handle, "pageId": "doc"}, None)

    def test_input_validation_stays_local(self):
        for by, selector in ((None, "a"), ("unknown", "a"), ("css", ""), ("xpath", None)):
            with self.assertRaises(ValueError):
                self.client.find(by, selector)
        with self.assertRaises(ValueError):
            self.client.element(dict(self.handle, referenceId=""))
        with self.assertRaises(ValueError):
            self.client.find("css", "a", strict="false")
        self.server.request_sync.assert_not_called()

    def test_aliases_and_copied_handles(self):
        self.found()
        element = self.client.find("css_positon", "#target")
        self.handle["referenceId"] = "modified-by-caller"
        self.server.request_sync.return_value = {"value": "text"}
        self.assertEqual(element.get("text"), "text")
        self.assertEqual(self.server.request_sync.call_args.args[1]["referenceId"], "node_8")


if __name__ == "__main__":
    unittest.main()
