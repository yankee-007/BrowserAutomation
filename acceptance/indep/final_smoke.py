"""PageSense V2.0 - INDEPENDENT final smoke test.

The single end-to-end flow required at the end of acceptance:

    fresh Controller -> fresh Extension -> CONNECT -> SCAN -> SEARCH ->
    HIGHLIGHT -> INPUT -> CLICK -> KEYPRESS -> SCROLL -> SCAN ->
    verify the final real DOM -> stop Controller -> DISCONNECTED ->
    restart Controller -> auto CONNECTED -> SCAN again

No mocks, no jsdom, no jsdom DOM, and no assertion on `success` alone: every
step is confirmed against the live DOM through the browser agent.

The Controller is started by this process; the browser agent must already be
running and will reconnect on its own (same host/port/token).

Run:  python final_smoke.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "controller"))

from pagesense import PageSenseClient  # noqa: E402
from server import ControllerServer  # noqa: E402

WS_PORT = int(os.environ.get("INDEP_WS_PORT", "8765"))
AGENT_PORT = int(os.environ.get("INDEP_AGENT_PORT", "8799"))
TOKEN = os.environ.get("INDEP_TOKEN", "TESTTOKEN12345678")
EVIDENCE = os.path.join(ROOT, "acceptance", "evidence-v2-independent")

STEPS: list[tuple[str, bool, str]] = []


def step(name: str, ok: bool, detail: str = "") -> bool:
    STEPS.append((name, bool(ok), detail))
    stamp = time.strftime("%H:%M:%S")
    print(f"[{stamp}] {'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  -> {detail}"))
    return bool(ok)


def agent(path, **params):
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}{path}{qs}", timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"__error": f"{type(e).__name__}: {e}"}


def dom_index():
    return agent("/c/dom-index") or {}


def by_dom():
    return {v.get("domId"): int(k) for k, v in dom_index().items() if v.get("domId")}


def main() -> int:
    print("=== PageSense V2.0 INDEPENDENT final smoke test ===")
    if agent("/c/ping").get("ok") is not True:
        print("FATAL: browser agent not reachable on", AGENT_PORT)
        return 2

    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                              request_timeout=20.0)
    server.start()
    client = PageSenseClient.from_server(server)
    print(f"controller listening on {server.endpoint}")

    # ---- 1. fresh Controller -------------------------------------------------
    step("1. 全新 Controller 启动", server._thread is not None and not server.connected,
         f"connected={server.connected}")

    # ---- 2. fresh Extension --------------------------------------------------
    # A real chrome.runtime.reload(): the Service Worker is torn down and comes
    # back with no socket, so reaching CONNECTED again proves the whole
    # storage -> autoconnect -> HELLO path works from scratch.
    agent("/c/console-reset")
    agent("/c/reload-extension")
    t0 = time.time()
    connected = server.wait_for_extension(timeout=90)
    step("2. 重新加载扩展后自动 CONNECTED", connected,
         f"waited {time.time() - t0:.1f}s")
    if not connected:
        server.stop()
        return 1

    st = agent("/c/bridge") or {}
    step("3. CONNECT：桥接状态与版本", st.get("state") == "CONNECTED"
         and st.get("version") == "2.0.0", json.dumps(st, ensure_ascii=False)[:160])

    # ---- demo page ----------------------------------------------------------
    agent("/c/demo")
    time.sleep(0.6)
    active = agent("/c/active-tab") or {}
    step("4. 活动页面为 demo.html", "test/demo.html" in (active.get("url") or ""),
         json.dumps(active, ensure_ascii=False))

    # ---- 5. SCAN ------------------------------------------------------------
    scan = client.scan()
    step("5. SCAN 返回真实 DOM 数据",
         scan["stats"]["total"] > 0 and scan["stats"]["total"] == len(scan["elements"]),
         json.dumps(scan["stats"]))
    live = dom_index()
    step("6. SCAN 的元素与真实 DOM 映射一致",
         len(live) == scan["stats"]["total"],
         f"mapped={len(live)} stats={scan['stats']['total']}")

    # ---- 7. SEARCH ----------------------------------------------------------
    found = client.search("立即沟通")
    hit_id = found["results"][0]["elementId"] if found.get("results") else None
    node = live.get(str(hit_id)) if hit_id else None
    step("7. SEARCH 命中且 elementId 指向真实节点",
         found.get("total", 0) >= 1 and node is not None and node.get("text") == "立即沟通",
         f"total={found.get('total')} node={json.dumps(node, ensure_ascii=False)[:120]}")

    ids = by_dom()
    input_id, click_id = ids.get("actionInput"), ids.get("clickTestBtn")
    step("8. 取得 input/click 元素的 elementId",
         isinstance(input_id, int) and isinstance(click_id, int),
         f"input={input_id} click={click_id}")

    # ---- 9. HIGHLIGHT -------------------------------------------------------
    agent("/c/eval", js="(function(){window.scrollTo(0,0);return 1;})()")
    time.sleep(0.3)
    client.highlight(click_id)
    time.sleep(1.3)
    ov = agent("/c/overlay-vs", id=click_id)
    same = False
    if ov.get("overlay") and ov.get("target"):
        same = all(abs(ov["overlay"][k] - ov["target"][k]) <= 3 for k in ("x", "y", "w", "h"))
    step("9. HIGHLIGHT 产生 1 个 overlay 且矩形贴合目标",
         ov.get("overlayCount") == 1 and same,
         json.dumps(ov, ensure_ascii=False)[:220])
    agent("/c/screenshot", name="final-smoke-highlight")

    # ---- 10. INPUT ----------------------------------------------------------
    r = client.input(input_id, "AI应用工程师")
    time.sleep(0.3)
    val = (dom_index().get(str(input_id)) or {}).get("value")
    step("10. INPUT 后真实 DOM value 正确",
         val == "AI应用工程师" and r.get("success") is True, f"value={val!r}")

    # ---- 11. CLICK ----------------------------------------------------------
    before = int((agent("/c/state") or {}).get("clickCount") or 0)
    client.click(click_id)
    time.sleep(0.3)
    after = int((agent("/c/state") or {}).get("clickCount") or 0)
    step("11. CLICK 使真实计数器 +1", after == before + 1, f"{before} -> {after}")

    # ---- 12. KEYPRESS -------------------------------------------------------
    agent("/c/eval", js="(function(){document.getElementById('lastKey').textContent='';return 1;})()")
    client.keypress(input_id, "Enter")
    time.sleep(0.3)
    last = (agent("/c/state") or {}).get("lastKey")
    step("12. KEYPRESS Enter 被真实页面记录", last == "Enter", f"lastKey={last!r}")

    # ---- 13. SCROLL ---------------------------------------------------------
    agent("/c/eval", js="(function(){window.scrollTo(0,0);return 1;})()")
    time.sleep(0.3)
    client.scroll("down", 500)
    time.sleep(0.5)
    y = (agent("/c/state") or {}).get("scrollY")
    step("13. SCROLL down 真实改变 scrollY", isinstance(y, int) and y > 0, f"scrollY={y}")

    # ---- 14. SCAN again + verify the final DOM ------------------------------
    scan2 = client.scan()
    live2 = dom_index()
    val2 = (live2.get(str(input_id)) or {}).get("value")
    step("14. 再次 SCAN 与真实 DOM 一致",
         scan2["stats"]["total"] == len(scan2["elements"]) == len(live2),
         f"stats={scan2['stats']['total']} elements={len(scan2['elements'])} mapped={len(live2)}")
    step("15. 最终 DOM 状态正确（输入保留、无残留 overlay、映射干净）",
         val2 == "AI应用工程师"
         and (agent("/c/state") or {}).get("overlayCount") == 0
         and len(set(live2.keys())) == len(live2),
         f"value={val2!r} overlays={(agent('/c/state') or {}).get('overlayCount')}")

    # ---- 16. stop Controller -> DISCONNECTED --------------------------------
    server.stop()
    state = None
    deadline = time.time() + 25
    while time.time() < deadline:
        state = (agent("/c/bridge") or {}).get("state")
        if state != "CONNECTED":
            break
        time.sleep(0.4)
    step("16. 停止 Controller 后扩展离开 CONNECTED",
         state in ("DISCONNECTED", "ERROR", "CONNECTING"), f"state={state}")
    step("17. 不再显示假连接（不会停在 CONNECTED）", state != "CONNECTED", f"state={state}")

    # ---- 18. restart Controller -> auto CONNECTED ---------------------------
    t0 = time.time()
    server2 = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                               request_timeout=20.0)
    server2.start()
    back = server2.wait_for_extension(timeout=90)
    step("18. 重启 Controller 后自动恢复 CONNECTED", back,
         f"waited {time.time() - t0:.1f}s")
    client2 = PageSenseClient.from_server(server2)
    if back:
        scan3 = client2.scan()
        step("19. 重连后再次 SCAN 正常",
             scan3["stats"]["total"] == len(scan3["elements"]),
             json.dumps(scan3["stats"]))

        # console hygiene across the whole smoke test
        items = (agent("/c/console") or {}).get("items") or []
        bad = [c for c in items if c.get("kind") in ("uncaught", "pageerror")]
        with open(os.path.join(EVIDENCE, "final-smoke-console.log"), "w",
                  encoding="utf-8") as fh:
            for c in items:
                fh.write(f"{c['kind']}\t{c['source']}\t{c['text']}\n")
        step("20. 全流程无未捕获异常 / 未处理 rejection", not bad,
             json.dumps(bad[:3], ensure_ascii=False))

    server2.stop()

    os.makedirs(EVIDENCE, exist_ok=True)
    with open(os.path.join(EVIDENCE, "final-smoke-steps.json"), "w", encoding="utf-8") as fh:
        json.dump([{"step": n, "ok": o, "detail": d} for n, o, d in STEPS], fh,
                  ensure_ascii=False, indent=2)

    fails = [s for s in STEPS if not s[1]]
    print(f"\nFINAL SMOKE TEST: {len(STEPS) - len(fails)} PASS / {len(fails)} FAIL "
          f"({len(STEPS)} steps)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
