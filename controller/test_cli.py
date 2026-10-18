"""PageSense Controller - CLI unit tests.

Drives the real ``cli.execute()`` loop against a stub client, so command
parsing, argument handling, output formatting and error paths are covered
deterministically (no browser required). The live end-to-end CLI path is
covered separately by test_e2e.py and the manual transcript in README.md.

Run:  python -m unittest test_cli -v
"""

from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout

import protocol as P
from cli import execute


class StubClient:
    """Records calls and returns canned protocol results."""

    def __init__(self, fail_with: P.PageSenseError | None = None):
        self.calls: list[tuple[str, dict]] = []
        self.fail_with = fail_with
        self.endpoint = "ws://127.0.0.1:8765"

    def _record(self, name, **kwargs):
        if self.fail_with is not None:
            raise self.fail_with
        self.calls.append((name, kwargs))
        return {"success": True, "actionId": "act_test", **kwargs}

    def ping(self, **kw): return self._record("ping", **kw)
    def get_status(self, **kw):
        return {"connected": True, "version": "2.0.0",
                "activeTab": {"tabId": 7, "url": "http://x/test/demo.html"}}
    def scan(self, **kw):
        self.calls.append(("scan", {}))
        return {"stats": {"total": 28}, "elements": []}

    def search(self, query, limit=None, **kw):
        self.calls.append(("search", {"query": query, "limit": limit}))
        return {
            "total": 2, "truncated": False, "limit": 20,
            "results": [
                {"elementId": 53, "score": 100, "matchedFields": ["text"],
                 "element": {"tag": "a", "text": "立即沟通"}},
                {"elementId": 71, "score": 60, "matchedFields": ["text"],
                 "element": {"tag": "button", "text": "继续沟通"}},
            ],
        }

    def locate(self, i, **kw): return self._record("locate", elementId=i)
    def highlight(self, i, **kw): return self._record("highlight", elementId=i)
    def clear_highlight(self, **kw): return self._record("clear_highlight")
    def click(self, i, **kw): return self._record("click", elementId=i)
    def input(self, i, v, **kw): return self._record("input", elementId=i, value=v)
    def clear(self, i, **kw): return self._record("clear", elementId=i)
    def keypress(self, i, k, **kw): return self._record("keypress", elementId=i, key=k)
    def scroll(self, d="down", a=500, **kw): return self._record("scroll", direction=d, amount=a)


def run_line(client, line: str, connected: bool = True):
    """Execute one CLI line and return (still_running, stdout)."""
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        running = execute(client, line, lambda: connected)
    return running, buffer.getvalue()


class CliTestBase(unittest.TestCase):
    def setUp(self):
        self.client = StubClient()

    def out(self, line, connected=True):
        return run_line(self.client, line, connected)


class TestCommands(CliTestBase):
    def test_scan(self):
        _, out = self.out("scan")
        self.assertEqual(out.strip(), "28 elements")
        self.assertEqual(self.client.calls[0][0], "scan")

    def test_search_format(self):
        _, out = self.out("search 立即沟通")
        self.assertEqual(self.client.calls[0],
                         ("search", {"query": "立即沟通", "limit": None}))
        self.assertIn("2 results", out)
        self.assertIn("#53", out)
        self.assertIn("立即沟通", out)
        self.assertIn("score=100", out)
        self.assertIn("matched=text", out)
        self.assertIn("#71", out)

    def test_search_multi_word_query_is_joined(self):
        self.out("search AI 应用 工程师")
        self.assertEqual(self.client.calls[0][1]["query"], "AI 应用 工程师")

    def test_element_actions(self):
        for line, expected in (
            ("locate 53", ("locate", {"elementId": 53})),
            ("highlight 53", ("highlight", {"elementId": 53})),
            ("click 53", ("click", {"elementId": 53})),
            ("clear 53", ("clear", {"elementId": 53})),
            ("input 16 AI应用工程师", ("input", {"elementId": 16,
                                                "value": "AI应用工程师"})),
            ("keypress 16 Enter", ("keypress", {"elementId": 16, "key": "Enter"})),
        ):
            self.setUp()
            _, out = self.out(line)
            self.assertEqual(self.client.calls[0], expected, line)
            self.assertIn("SUCCESS", out, line)

    def test_input_value_with_spaces(self):
        self.out("input 16 Python Controller")
        self.assertEqual(self.client.calls[0][1]["value"], "Python Controller")

    def test_clear_highlight(self):
        self.out("clear-hl")
        self.assertEqual(self.client.calls[0][0], "clear_highlight")

    def test_scroll_default_and_explicit(self):
        self.out("scroll down")
        self.assertEqual(self.client.calls[0], ("scroll", {"direction": "down", "amount": 500}))
        self.setUp()
        self.out("scroll up 120")
        self.assertEqual(self.client.calls[0], ("scroll", {"direction": "up", "amount": 120}))

    def test_status_and_ping_do_not_require_extension(self):
        _, out = self.out("status", connected=False)
        self.assertIn("connected=True", out)
        self.assertIn("active tab", out)
        _, out = self.out("ping", connected=False)
        self.assertIn("PONG", out)

    def test_quit_stops_the_loop(self):
        running, _ = self.out("quit")
        self.assertFalse(running)
        self.assertFalse(self.out("exit")[0])


class TestErrors(CliTestBase):
    def test_unknown_command_does_not_crash(self):
        running, out = self.out("teleport 1")
        self.assertTrue(running)
        self.assertIn("未知命令", out)

    def test_protocol_error_is_reported_not_raised(self):
        self.client = StubClient(fail_with=P.PageSenseError("ELEMENT_NOT_FOUND", "元素已不存在"))
        running, out = self.out("click 999")
        self.assertTrue(running)
        self.assertIn("ERROR ELEMENT_NOT_FOUND", out)

    def test_timeout_is_reported_not_raised(self):
        self.client = StubClient(fail_with=P.RequestTimeout("CLICK_ELEMENT", 10))
        running, out = self.out("click 1")
        self.assertTrue(running)
        self.assertIn("ERROR REQUEST_TIMEOUT", out)

    def test_non_numeric_element_id_is_handled(self):
        running, out = self.out("click abc")
        self.assertTrue(running)
        self.assertIn("参数错误", out)

    def test_missing_arguments_print_usage(self):
        for line in ("search", "locate", "click", "input 16", "keypress 16"):
            running, out = self.out(line)
            self.assertTrue(running, line)
            self.assertIn("用法", out, line)

    def test_actions_require_a_connection(self):
        running, out = self.out("click 53", connected=False)
        self.assertTrue(running)
        self.assertIn("未连接", out)
        self.assertEqual(self.client.calls, [])


class TestNoAutomation(CliTestBase):
    """Section 54: no search-and-click, no LLM, no implicit target choice."""

    def test_click_requires_an_explicit_element_id(self):
        running, out = self.out('click "立即沟通"')
        self.assertTrue(running)
        # A quoted text target is not an elementId and must be rejected,
        # never resolved by searching first.
        self.assertIn("参数错误", out)
        self.assertEqual([c for c in self.client.calls if c[0] == "click"], [])

    def test_click_never_triggers_a_search(self):
        self.out("click 53")
        self.assertEqual([c for c in self.client.calls if c[0] == "search"], [])

    def test_help_documents_the_two_step_flow(self):
        _, out = self.out("help")
        self.assertIn("不提供 search-and-click", out)


class TestNoLlm(unittest.TestCase):
    def test_cli_source_has_no_llm_or_agent_dependency(self):
        import pathlib
        source = pathlib.Path(__file__).with_name("cli.py").read_text(encoding="utf-8")
        for forbidden in ("openai", "deepseek", "qwen", "ollama", "langchain",
                          "langgraph", "anthropic"):
            self.assertNotIn(forbidden, source.lower(), forbidden)

    def test_cli_has_no_auto_selection_of_first_result(self):
        import pathlib
        source = pathlib.Path(__file__).with_name("cli.py").read_text(encoding="utf-8")
        self.assertNotIn("results[0]", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
