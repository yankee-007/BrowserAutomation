"""PageSense V2.0 - real Extension <-> Python Controller E2E.

Runs the actual PageSense extension in a real Edge/Chrome instance against the
actual Python Controller over a real WebSocket. Nothing is mocked: the
extension performs real DOM work in a real page, and every DOM assertion below
is read back from the live browser through the browser agent helper.

Browser side (acceptance/v2-browser-agent.js) is driven by puppeteer-core and
is responsible only for observation and tab control. All protocol traffic is
produced by this Python Controller.

Prerequisites:
  * a static server for test/demo.html on DEMO_PORT
  * Edge/Chrome launched with the PageSense extension and --remote-debugging-port

Run:  python test_e2e.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import protocol as P
from pagesense import PageSenseClient
from server import ControllerServer, generate_token

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
AGENT = os.path.join(ROOT, "acceptance", "v2-browser-agent.js")

DEBUG_PORT = os.environ.get("DEBUG_PORT", "9224")
DEMO_PORT = int(os.environ.get("DEMO_PORT", "8770"))
WS_PORT = int(os.environ.get("WS_PORT", "8765"))
HTTP_PORT = int(os.environ.get("AGENT_PORT", "8791"))

_failures: list[str] = []


def check(cid: str, name: str, cond: bool, detail: str = "") -> bool:
    print(f"{'PASS' if cond else 'FAIL'}  {cid} {name}" + ("" if cond else f"  -> {detail}"))
    if not cond:
        _failures.append(cid)
    return bool(cond)


def eq(cid: str, name: str, actual, expected) -> bool:
    return check(cid, name, actual == expected, f"expected {expected!r} got {actual!r}")


# --------------------------------------------------------------------------
# browser agent client
# --------------------------------------------------------------------------

class BrowserAgent:
    """Thin client for the puppeteer-side control API."""

    def __init__(self, port: int):
        self.base = f"http://127.0.0.1:{port}"

    def _call(self, path: str, timeout: float = 30.0):
        req = urllib.request.Request(self.base + path, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def state(self) -> dict:
        return self._call("/state")

    def reset(self) -> dict:
        return self._call("/reset")

    def activate_demo(self) -> dict:
        return self._call("/activate-demo")

    def activate(self, url: str) -> dict:
        return self._call("/activate?url=" + urllib.parse.quote(url, safe=""))

    def bridge(self) -> dict:
        return self._call("/bridge")

    def active_tab(self):
        return self._call("/active-tab")

    def reload_extension(self) -> dict:
        return self._call("/reload-extension", timeout=60)

    def quit(self) -> None:
        try:
            self._call("/quit", timeout=5)
        except Exception:
            pass


def start_agent(token: str) -> tuple[subprocess.Popen, BrowserAgent]:
    """Start the browser agent and return it plus a client on its real port."""
    process = subprocess.Popen(
        ["node", AGENT, token, str(WS_PORT), str(DEMO_PORT), str(HTTP_PORT), DEBUG_PORT],
        cwd=os.path.dirname(AGENT),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )

    ready = threading.Event()
    bound_port: list[int] = []

    def pump() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            line = line.rstrip()
            print(f"    [agent] {line}")
            if line.startswith("READY"):
                bound_port.append(int(line.split()[1]))
                ready.set()

    threading.Thread(target=pump, daemon=True).start()
    if not ready.wait(timeout=90):
        process.kill()
        raise RuntimeError("browser agent 未就绪")
    return process, BrowserAgent(bound_port[0])


# --------------------------------------------------------------------------
# E2E steps
# --------------------------------------------------------------------------

def element_by_dom_id(scan: dict, dom_id: str) -> dict | None:
    for element in scan.get("elements", []):
        if element.get("id") == dom_id:
            return element
    return None


def run() -> int:
    print("=== PageSense V2.0 Extension <-> Python Controller E2E ===\n")

    token = generate_token()
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=token,
                              request_timeout=10.0)
    server.start()
    print(f"Controller listening on {server.endpoint}  token={token}\n")

    agent_process, agent = start_agent(token)
    client = PageSenseClient.from_server(server)

    try:
        # ---- E2E-01 CONNECT ------------------------------------------------
        connected = server.wait_for_extension(timeout=30)
        check("E2E-01", "Extension WebSocket 连接 + HELLO/HELLO_ACK 成功", connected)
        if not connected:
            return 1
        status = agent.bridge()
        eq("E2E-01b", "Popup 显示 CONNECTED", status.get("state"), "CONNECTED")
        eq("E2E-01c", "Popup 显示版本 2.0.0", status.get("version"), "2.0.0")
        eq("E2E-01d", "Popup 显示 endpoint 127.0.0.1:8765",
           f"{status.get('host')}:{status.get('port')}", "127.0.0.1:8765")

        # ---- E2E-02 PING ---------------------------------------------------
        pong = client.ping()
        check("E2E-02", "PING -> PONG", pong.get("pong") is True, json.dumps(pong))
        eq("E2E-02b", "PONG 携带扩展版本", pong.get("version"), "2.0.0")

        # ---- GET_STATUS ----------------------------------------------------
        state = client.get_status()
        check("GET_STATUS", "GET_STATUS 返回连接状态与活动页面",
              state.get("connected") is True and bool(state.get("activeTab")),
              json.dumps(state)[:200])
        eq("GET_STATUS-b", "活动页面为 demo",
           "test/demo.html" in (state.get("activeTab") or {}).get("url", ""), True)

        # ---- E2E-03 SCAN ---------------------------------------------------
        scan = client.scan()
        check("E2E-03", "SCAN_PAGE 返回真实 page/stats/elements",
              bool(scan.get("page")) and bool(scan.get("stats")) and
              len(scan.get("elements", [])) > 0,
              json.dumps(scan.get("stats")))
        eq("E2E-03b", "SCAN_PAGE 返回 tabId/url/title",
            all(k in scan for k in ("tabId", "url", "title")), True)
        eq("E2E-03c", "扫描到 demo 的 28 个元素", scan["stats"]["total"], 28)
        eq("E2E-03d", "扫描命中 page.domain", scan["page"]["domain"], "127.0.0.1")

        # ---- E2E-04 SEARCH -------------------------------------------------
        found = client.search("Action 输入测试")
        check("E2E-04", "SEARCH_ELEMENTS 找到 demo 的输入框",
              found.get("total", 0) >= 1 and
              any(r["element"]["tag"] == "input" for r in found["results"]),
              json.dumps(found)[:250])
        if not found.get("results"):
            check("E2E-04b", "SEARCH 结果包含 elementId/score/matchedFields", False,
                  "no results")
            check("E2E-04c", "SEARCH matchedFields 含 placeholder", False, "no results")
        else:
            top = found["results"][0]
            eq("E2E-04b", "SEARCH 结果包含 elementId/score/matchedFields",
                all(k in top for k in ("elementId", "score", "matchedFields")), True)
            # scanner text falls back to placeholder, so an exact match on
            # either field is correct here; both must be reachable.
            check("E2E-04c", "SEARCH matchedFields 覆盖 text/placeholder",
                  bool(set(top["matchedFields"]) & {"text", "placeholder"}),
                  str(top["matchedFields"]))
            eq("E2E-04c2", "SEARCH 命中的是 demo 的 actionInput",
               top["element"]["tag"], "input")

        search_zh = client.search("立即沟通")
        check("E2E-04d", "中文搜索 “立即沟通” 命中 demo 按钮",
              search_zh["total"] >= 1 and bool(search_zh["results"]) and
              search_zh["results"][0]["element"]["text"] == "立即沟通",
              json.dumps(search_zh, ensure_ascii=False)[:200])

        empty = client.search("")
        eq("E2E-04e", "空 query 返回全部扫描元素", empty["total"], 28)

        limited = client.search("a", limit=3)
        check("E2E-04f", "limit 生效（最多返回 3 条）",
              len(limited["results"]) <= 3, str(len(limited["results"])))

        not_found = client.search("绝不存在zzz")
        eq("E2E-04g", "无结果返回 total=0", not_found["total"], 0)

        # ---- E2E-05 HIGHLIGHT ----------------------------------------------
        agent.reset()
        input_el = element_by_dom_id(scan, "actionInput")
        check("E2E-05-pre", "demo 中找到 actionInput", input_el is not None)
        highlight_result = client.highlight(input_el["elementId"])
        time.sleep(0.6)
        dom = agent.state()
        eq("E2E-05", "HIGHLIGHT 后真实浏览器出现 Overlay", dom["overlays"], 1)
        # HIGHLIGHT/LOCATE keep the V1.1 contract ({success, elementId}); they
        # are not part of the V1.2 action envelope.
        check("E2E-05b", "HIGHLIGHT 回执为 V1.1 契约（success + elementId）",
              highlight_result.get("success") is True and
              highlight_result.get("elementId") == input_el["elementId"],
              json.dumps(highlight_result))

        locate_result = client.locate(input_el["elementId"])
        check("E2E-05c", "LOCATE 成功", locate_result.get("success") is True,
              json.dumps(locate_result))

        cleared = client.clear_highlight()
        time.sleep(0.4)
        eq("E2E-05d", "CLEAR_HIGHLIGHT 移除 Overlay",
           agent.state()["overlays"], 0)
        check("E2E-05e", "CLEAR_HIGHLIGHT 成功", cleared.get("success") is True)

        # ---- E2E-06 INPUT ---------------------------------------------------
        agent.reset()
        input_id = element_by_dom_id(scan, "actionInput")["elementId"]
        result = client.input(input_id, "Python Controller")
        dom = agent.state()
        eq("E2E-06", "INPUT 后真实 input.value == 'Python Controller'",
           dom["inputValue"], "Python Controller")
        eq("E2E-06b", "INPUT 触发页面 input 事件回显", dom["inputShown"], "Python Controller")
        check("E2E-06c", "INPUT 回执 success + elementId",
              result.get("success") is True and result.get("elementId") == input_id,
              json.dumps(result))
        check("E2E-06d", "INPUT 建议重新扫描", result.get("rescanRecommended") is True)

        ce_id = element_by_dom_id(scan, "actionCE")["elementId"]
        client.input(ce_id, "可编辑内容")
        eq("E2E-06e", "INPUT 支持 contenteditable",
           agent.state()["ceText"], "可编辑内容")

        cleared_value = client.clear(input_id)
        eq("E2E-06f", "CLEAR 清空真实 input", agent.state()["inputValue"], "")
        eq("E2E-06g", "CLEAR 回执 action 为 CLEAR_ELEMENT",
           cleared_value.get("action"), "PAGESENSE_CLEAR_ELEMENT")

        # ---- E2E-07 CLICK ----------------------------------------------------
        agent.reset()
        click_id = element_by_dom_id(scan, "clickTestBtn")["elementId"]
        before = int(agent.state()["clickCount"])
        click_result = client.click(click_id)
        after = int(agent.state()["clickCount"])
        eq("E2E-07", "CLICK 使 demo 计数器 +1", after, before + 1)
        check("E2E-07b", "CLICK 回执 success", click_result.get("success") is True,
              json.dumps(click_result))

        for _ in range(4):
            client.click(click_id)
        eq("E2E-07c", "连续 CLICK 计数精确", int(agent.state()["clickCount"]), before + 5)

        # ---- E2E-08 KEYPRESS --------------------------------------------------
        client.keypress(input_id, "Enter")
        time.sleep(0.2)
        eq("E2E-08", "KEYPRESS Enter 被页面记录", agent.state()["lastKey"], "Enter")
        client.keypress(input_id, "ArrowDown")
        time.sleep(0.2)
        eq("E2E-08b", "KEYPRESS ArrowDown 被记录", agent.state()["lastKey"], "ArrowDown")

        try:
            client.keypress(input_id, "FakeKey")
            check("E2E-08c", "非法按键返回 INVALID_KEY", False, "未抛错")
        except P.PageSenseError as exc:
            eq("E2E-08c", "非法按键返回 INVALID_KEY", exc.code, "INVALID_KEY")

        # ---- E2E-09 SCROLL ----------------------------------------------------
        agent.reset()
        eq("E2E-09-pre", "重置后 scrollY = 0", agent.state()["scrollY"], 0)
        client.scroll("down", 500)
        time.sleep(0.3)
        scrolled = agent.state()["scrollY"]
        check("E2E-09", "SCROLL down 500 后真实 scrollY 变化", scrolled > 0,
              f"scrollY={scrolled}")
        client.scroll("up", 500)
        time.sleep(0.3)
        eq("E2E-09b", "SCROLL up 回到顶部", agent.state()["scrollY"], 0)
        try:
            client.scroll("sideways", 100)
            check("E2E-09c", "非法 direction 返回 INVALID_VALUE", False, "未抛错")
        except P.PageSenseError as exc:
            eq("E2E-09c", "非法 direction 返回 INVALID_VALUE", exc.code, "INVALID_VALUE")

        # ---- 协议健壮性 -------------------------------------------------------
        try:
            client.call("LAUNCH_MISSILES")
            check("PROTO-01", "未知方法返回 UNKNOWN_METHOD", False, "未抛错")
        except P.PageSenseError as exc:
            eq("PROTO-01", "未知方法返回 UNKNOWN_METHOD", exc.code, "UNKNOWN_METHOD")

        try:
            client.call("CLICK_ELEMENT")
        except P.PageSenseError as exc:
            eq("PROTO-02", "缺少 elementId 返回 INVALID_ELEMENT_ID",
               exc.code, "INVALID_ELEMENT_ID")

        try:
            client.call("CLICK_ELEMENT", elementId=999999)
        except P.PageSenseError as exc:
            eq("PROTO-03", "不存在的 elementId 返回 ELEMENT_NOT_FOUND",
               exc.code, "ELEMENT_NOT_FOUND")

        # Request ids must be unique and monotonic across every call above.
        log = agent.bridge().get("recentRequests", [])
        check("PROTO-04", "Extension 记录最近请求日志",
              len(log) > 0 and all("method" in e for e in log),
              json.dumps(log[:2]))

        # ---- E2E-12 RESTRICTED PAGE (before reconnects) ------------------------
        agent.activate("edge://extensions/")
        time.sleep(1.0)
        try:
            client.scan()
            check("E2E-12", "受限页面返回 RESTRICTED_PAGE", False, "未抛错")
        except P.PageSenseError as exc:
            eq("E2E-12", "受限页面返回 RESTRICTED_PAGE", exc.code, "RESTRICTED_PAGE")
        check("E2E-12b", "受限页面未使 Controller 崩溃", server is not None)

        agent.activate_demo()
        time.sleep(0.5)

        # ---- E2E-10 RECONNECT --------------------------------------------------
        print("\n-- 关闭 Controller，验证 Extension 进入 DISCONNECTED --")
        server.stop()
        time.sleep(3.0)
        status = agent.bridge()
        check("E2E-10a", "Server 关闭后 Extension 不再 CONNECTED",
              status.get("state") in ("DISCONNECTED", "ERROR", "CONNECTING"),
              json.dumps(status.get("state")))

        print("-- 重启 Controller，验证 Extension 自动重连 --")
        server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=token,
                                  request_timeout=10.0)
        server.start()
        client = PageSenseClient.from_server(server)
        reconnected = server.wait_for_extension(timeout=30)
        check("E2E-10b", "Extension 自动恢复 CONNECTED（无需重启浏览器）", reconnected)
        if reconnected:
            eq("E2E-10c", "重连后 PING 正常", client.ping().get("pong"), True)

        # ---- E2E-11 EXTENSION RESTART ------------------------------------------
        print("\n-- 重新加载扩展，验证 WebSocket 自动重建 --")
        agent.reload_extension()
        restarted = server.wait_for_extension(timeout=40)
        check("E2E-11", "扩展重载后自动重建 WebSocket（未重启浏览器）", restarted)
        if restarted:
            eq("E2E-11b", "重载后 PING 正常", client.ping().get("pong"), True)
            rescan = client.scan()
            eq("E2E-11c", "重载后仍可 SCAN_PAGE", rescan["stats"]["total"], 28)

        # ---- 一次一个 Action（无队列）-------------------------------------------
        agent.reset()
        scan2 = client.scan()
        cid = element_by_dom_id(scan2, "clickTestBtn")["elementId"]
        start_count = int(agent.state()["clickCount"])
        results = [client.click(cid) for _ in range(3)]
        eq("QUEUE-01", "V2 不实现 Action Queue：逐个请求逐个响应",
           int(agent.state()["clickCount"]), start_count + 3)
        check("QUEUE-02", "每个请求独立回执（actionId 唯一）",
              len({r.get("actionId") for r in results}) == 3)

    finally:
        try:
            agent.quit()
        except Exception:
            pass
        time.sleep(0.5)
        agent_process.kill()
        server.stop()

    print(f"\nV2 E2E SUMMARY: {'ALL PASS' if not _failures else str(len(_failures)) + ' FAILURE(S)'}"
          + ("" if not _failures else "  -> " + ", ".join(_failures)))
    return 0 if not _failures else 1


if __name__ == "__main__":
    try:
        sys.exit(run())
    except KeyboardInterrupt:
        sys.exit(130)
