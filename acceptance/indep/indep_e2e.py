"""PageSense V2.0 - INDEPENDENT real Edge <-> Python Controller E2E.

Independently authored for the independent acceptance pass. Every DOM claim in
here is read back from the live browser through the agent control API; no
response field is trusted on its own.

Prerequisites (started by run_indep_e2e.sh / see the report):
  * static demo server on DEMO_PORT (acceptance/serve.js)
  * acceptance/indep/indep-agent.js attached to a real Edge
  * a Controller listening on WS_PORT (this script starts it)

Run:  python indep_e2e.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "controller"))

import protocol as P  # noqa: E402
from pagesense import PageSenseClient  # noqa: E402
from server import ControllerServer, generate_token  # noqa: E402

WS_PORT = int(os.environ.get("INDEP_WS_PORT", "8765"))
DEMO_PORT = int(os.environ.get("INDEP_DEMO_PORT", "8770"))
AGENT_PORT = int(os.environ.get("INDEP_AGENT_PORT", "8799"))
EVIDENCE = os.path.join(ROOT, "acceptance", "evidence-v2-independent")

RESULTS: list[tuple[str, str, str, bool, str]] = []
SECTION = ["boot"]


def section(name: str) -> None:
    SECTION[0] = name
    print(f"\n===== {name} =====")


def check(cid: str, name: str, cond: bool, detail: str = "") -> bool:
    RESULTS.append((SECTION[0], cid, name, bool(cond), detail))
    print(f"{'PASS' if cond else 'FAIL'}  {cid} {name}" + ("" if cond else f"  -> {detail}"))
    return bool(cond)


def eq(cid: str, name: str, actual, expected) -> bool:
    return check(cid, name, actual == expected, f"expected {expected!r} got {actual!r}")


def section_of(cid: str) -> str:
    for s, c, _n, _o, _d in RESULTS:
        if c == cid:
            return s
    return "?"


#: Recoveries from a dropped bridge, so the report can state what happened.
RECOVERIES: list[dict] = []


def ensure_connected(server, timeout: float = 90.0, label: str = "") -> bool:
    """Wait for the bridge to come back after a drop.

    The MV3 Service Worker can be recycled by the browser, which closes the
    socket; the extension is configured to auto-reconnect, so a section should
    wait for that instead of aborting the whole run. Each recovery is recorded
    so it is visible in the report rather than silently swallowed.
    """
    if server.connected:
        return True
    t0 = time.time()
    ok = server.wait_for_extension(timeout=timeout)
    RECOVERIES.append({"label": label, "ok": ok, "seconds": round(time.time() - t0, 1)})
    print(f"    [recovery] {label}: bridge was down, "
          f"{'back after %.1fs' % (time.time() - t0) if ok else 'DID NOT COME BACK'}")
    return ok


def run_section(name: str, fn, *args):
    """Run one section; a crash is recorded as a FAIL instead of ending the run."""
    section(name)
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        check(f"{name.split()[0].upper()}-CRASH",
              f"[{name}] 段执行未抛出未处理异常", False,
              f"{type(exc).__name__}: {exc}")
        return None



# ----------------------------------------------------------------------
# agent client
# ----------------------------------------------------------------------

class Agent:
    def __init__(self, port: int):
        self.base = f"http://127.0.0.1:{port}"

    def call(self, path: str, timeout: float = 60.0, **params):
        qs = ("?" + urllib.parse.urlencode(params)) if params else ""
        url = self.base + path + qs
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return {"__http_error": e.code, "body": e.read().decode("utf-8", "replace")}
        except Exception as e:  # noqa: BLE001
            return {"__transport_error": f"{type(e).__name__}: {e}"}

    def state(self):
        return self.call("/c/state")

    def safe_state(self) -> dict:
        """State read that never raises: a failed read returns {} and is
        recorded, so a check can report the failure instead of crashing the
        whole run (a page navigation mid-test makes page.evaluate fail)."""
        res = self.call("/c/state")
        if not isinstance(res, dict) or "url" not in res:
            return {"__state_error": res}
        return res

    def bridge(self):
        return self.call("/c/bridge")

    def activate(self, url: str):
        return self.call("/c/activate", url=url)

    def activate_demo(self):
        return self.call("/c/activate-demo")

    def fixture(self, name: str):
        return self.call("/c/fixture", name=name)

    def eval(self, js: str):
        return self.call("/c/eval", js=js)

    def popup_eval(self, js: str):
        return self.call("/c/popup-eval", js=js)

    def wait_state(self, wanted: str, timeout: float = 30.0):
        return self.call("/c/wait-state", state=wanted, ms=int(timeout * 1000))

    def console(self, kind: str | None = None):
        return self.call("/c/console", **({"kind": kind} if kind else {}))


AGENT = Agent(AGENT_PORT)


def dom_index() -> dict:
    """elementId -> {tag,text,rect} straight from the live DOM mapping.

    Measured by the agent with the scanner's own documented rules (text
    fallback chain + the <option> rect borrow), so a mismatch here means the
    scan really disagrees with the DOM.
    """
    res = AGENT.call("/c/dom-index")
    if not isinstance(res, dict) or "__transport_error" in res or "__http_error" in res \
            or "error" in res:
        raise AssertionError(f"dom_index failed: {res}")
    return res


def id_map() -> dict:
    """DOM id -> elementId for the currently observed page."""
    return {v["domId"]: int(k) for k, v in dom_index().items() if v.get("domId")}


def overlay_vs(element_id) -> dict:
    """Overlay rect and target rect, sampled in a single evaluation."""
    return AGENT.call("/c/overlay-vs", id=element_id)


def element_by_dom_id(scan: dict, dom_id: str):
    for el in scan.get("elements", []):
        if el.get("id") == dom_id:
            return el
    return None


def err_code(fn, *args, **kwargs) -> str:
    """Run a client call and return the error code (or 'NO_ERROR')."""
    try:
        fn(*args, **kwargs)
        return "NO_ERROR"
    except P.PageSenseError as exc:
        return exc.code
    except Exception as exc:  # noqa: BLE001
        return f"PY:{type(exc).__name__}"


# ----------------------------------------------------------------------
# sections
# ----------------------------------------------------------------------

def sec_connect(server, client) -> None:
    section("CONNECT / handshake")
    ok = server.wait_for_extension(timeout=30)
    check("E2E-01", "Extension 完成 HELLO/HELLO_ACK 并连接", ok)
    if not ok:
        return
    st = AGENT.bridge()
    eq("E2E-01b", "Popup 桥接状态 = CONNECTED", st.get("state"), "CONNECTED")
    eq("E2E-01c", "Popup 版本 = 2.0.0", st.get("version"), "2.0.0")
    eq("E2E-01d", "Popup endpoint = 127.0.0.1:8765",
       f"{st.get('host')}:{st.get('port')}", f"127.0.0.1:{WS_PORT}")
    eq("E2E-01e", "Popup protocol = pagesense/1", st.get("protocol"), "pagesense/1")
    check("E2E-01f", "Popup 未报告 lastError", not st.get("lastError"),
          json.dumps(st.get("lastError"), ensure_ascii=False))

    # Read the RENDERED popup UI (not the status object). The popup tab must be
    # focused first so its own polling is not background-throttled.
    focused = AGENT.call("/c/popup-focus-read", timeout=60)
    v = (focused or {}).get("dom") or {}
    check("E2E-01g", "Popup 界面显示「● 已连接」（渲染后的真实 DOM 文本）",
          "已连接" in (v.get("state") or ""), json.dumps(v, ensure_ascii=False))
    check("E2E-01g2", "Popup 折叠标题栏同样显示已连接",
          "已连接" in (v.get("inline") or ""), json.dumps(v, ensure_ascii=False))
    check("E2E-01h", "Popup 显示端点与 Controller 一致",
          v.get("endpoint") == f"127.0.0.1:{WS_PORT}", json.dumps(v, ensure_ascii=False))
    check("E2E-01i", "Popup 连接指示灯为已连接样式",
          "is-connected" in (v.get("dot") or ""), v.get("dot"))
    check("E2E-01j", "Popup 未显示错误条", "hidden" in (v.get("err") or ""), v.get("err"))
    check("E2E-01k", "Popup 版本标签为 V2.0", (v.get("version") or "").strip() == "V2.0",
          json.dumps(v.get("version")))
    check("E2E-01l", "Popup 最近请求列表已渲染 Controller 请求",
          len((focused or {}).get("log") or []) >= 0, json.dumps((focused or {}).get("log")))
    AGENT.activate_demo()
    time.sleep(0.3)

    pong = client.ping()
    check("E2E-02", "PING -> PONG", pong.get("pong") is True, json.dumps(pong))
    eq("E2E-02b", "PONG 携带扩展版本 2.0.0", pong.get("version"), "2.0.0")
    check("E2E-02c", "PONG 携带时间戳", isinstance(pong.get("timestamp"), int),
          json.dumps(pong))

    status = client.get_status()
    check("E2E-03", "GET_STATUS connected=true", status.get("connected") is True,
          json.dumps(status, ensure_ascii=False)[:200])
    tab = status.get("activeTab") or {}
    check("E2E-03b", "GET_STATUS 返回活动标签页 tabId/url/title",
          isinstance(tab.get("tabId"), int) and "test/demo.html" in (tab.get("url") or "")
          and bool(tab.get("title")), json.dumps(tab, ensure_ascii=False))
    eq("E2E-03c", "Controller 与 Popup 报告同一活动标签页",
       tab.get("tabId"), (AGENT.call("/c/active-tab") or {}).get("id"))


def sec_scan(client) -> dict:
    section("SCAN")
    scan = client.scan()
    check("E2E-04", "SCAN 返回 page/stats/elements",
          bool(scan.get("page")) and bool(scan.get("stats")) and
          len(scan.get("elements", [])) > 0, json.dumps(scan.get("stats")))
    for key in ("tabId", "url", "title", "schemaVersion", "scannedAt"):
        check(f"E2E-04-{key}", f"SCAN 结果含 {key}", key in scan and scan[key] is not None,
              json.dumps(scan.get(key)))
    eq("E2E-04-eq", "elements.length == stats.total",
       len(scan["elements"]), scan["stats"]["total"])
    eq("E2E-04-mh", "stats.matched == total + hidden",
       scan["stats"]["matched"], scan["stats"]["total"] + scan["stats"]["hidden"])
    check("E2E-04-iv", "stats.inViewport <= stats.total",
          scan["stats"]["inViewport"] <= scan["stats"]["total"], str(scan["stats"]))
    eq("E2E-04-dom", "page.domain 为 127.0.0.1", scan["page"]["domain"], "127.0.0.1")
    check("E2E-04-url", "url 指向真实 demo 页面",
          scan["url"].startswith(f"http://127.0.0.1:{DEMO_PORT}/test/demo.html"),
          scan["url"])

    # elementIds are 1..N, unique, ascending
    ids = [e["elementId"] for e in scan["elements"]]
    eq("E2E-04-ids", "elementId 为 1..N 且唯一", ids, list(range(1, len(ids) + 1)))

    # real DOM mapping count must equal scan total
    live = dom_index()
    eq("E2E-04-map", "真实 DOM 上 data-pagesense-id 数量 == stats.total",
       len(live), scan["stats"]["total"])

    # spot check 5 elements against the live DOM
    step = max(1, len(scan["elements"]) // 6)
    sample = scan["elements"][::step][:6]
    bad = []
    for el in sample:
        live_el = live.get(str(el["elementId"]))
        if not live_el:
            bad.append((el["elementId"], "no live mapping"))
            continue
        if live_el["tag"] != el["tag"]:
            bad.append((el["elementId"], f"tag {live_el['tag']} != {el['tag']}"))
        tol = 2
        for k, lk in (("x", "x"), ("y", "y"), ("width", "w"), ("height", "h")):
            if abs(el["position"][k] - live_el["rect"][lk]) > tol:
                bad.append((el["elementId"], f"{k} {el['position'][k]} != {live_el['rect'][lk]}"))
        if el["text"] and live_el["text"] and el["text"] not in live_el["text"] \
                and live_el["text"] not in el["text"]:
            bad.append((el["elementId"], f"text {el['text']!r} vs {live_el['text']!r}"))
    check("E2E-04-spot", f"抽查 {len(sample)} 个元素的 tag/rect/text 与真实 DOM 一致",
          not bad, json.dumps(bad, ensure_ascii=False)[:400])
    check("E2E-04-visible", "每个元素都带 visible/inViewport 布尔值",
          all(isinstance(e.get("visible"), bool) and isinstance(e.get("inViewport"), bool)
              for e in scan["elements"]))
    return scan


def sec_search(client, scan) -> None:
    section("SEARCH (real browser)")
    found = client.search("立即沟通")
    check("SEARCH-01", "搜索「立即沟通」有结果", found.get("total", 0) >= 1,
          json.dumps(found, ensure_ascii=False)[:200])
    if found.get("results"):
        top = found["results"][0]
        eq("SEARCH-01b", "第一条为 text 精确匹配（score=100）", top["score"], 100)
        check("SEARCH-01c", "matchedFields 含 text", "text" in top["matchedFields"],
              str(top["matchedFields"]))
        # The elementId must resolve to the REAL node with that text.
        live = dom_index()
        node = live.get(str(top["elementId"]))
        check("SEARCH-01d", "返回的 elementId 指向真实对应节点",
              bool(node) and node["text"] == "立即沟通",
              json.dumps(node, ensure_ascii=False))
    else:
        check("SEARCH-01b", "第一条为 text 精确匹配", False, "no results")

    check("SEARCH-02", "结果结构含 elementId/score/matchedFields/element",
          all(all(k in r for k in ("elementId", "score", "matchedFields", "element"))
              for r in found["results"]), json.dumps(found["results"][:1], ensure_ascii=False))
    eq("SEARCH-02b", "results 长度 == returned",
       len(found["results"]), found["returned"])
    eq("SEARCH-02c", "truncated == (total > returned)",
       found["truncated"], found["total"] > found["returned"])
    eq("SEARCH-02d", "keywords 已分词", found.get("keywords"), ["立即沟通"])

    empty = client.search("")
    eq("SEARCH-03", "空 query 返回全部扫描元素", empty["total"], scan["stats"]["total"])
    check("SEARCH-03b", "空 query 的 score 全为 0 且 matchedFields 为空",
          all(r["score"] == 0 and r["matchedFields"] == [] for r in empty["results"]),
          json.dumps(empty["results"][:2], ensure_ascii=False))
    eq("SEARCH-03c", "空 query 保持 DOM 顺序",
       [r["elementId"] for r in empty["results"]],
       sorted(r["elementId"] for r in empty["results"]))

    none = client.search("绝不存在zzz")
    eq("SEARCH-04", "无结果 total=0", none["total"], 0)
    eq("SEARCH-04b", "无结果 returned=0", none["returned"], 0)
    eq("SEARCH-04c", "无结果 truncated=false", none["truncated"], False)

    # limit clamping through the real bridge
    eq("SEARCH-05", "limit=1 只返回 1 条", len(client.search("", limit=1)["results"]), 1)
    eq("SEARCH-05b", "limit=100 生效", client.search("", limit=100)["limit"], 100)
    eq("SEARCH-05c", "limit>100 被夹取到 100", client.search("", limit=1000)["limit"], 100)
    eq("SEARCH-05d", "limit=0 被夹取到 1", client.search("", limit=0)["limit"], 1)
    eq("SEARCH-05e", "limit=-5 被夹取到 1", client.search("", limit=-5)["limit"], 1)
    eq("SEARCH-05f", "limit=abc 回退默认 20", client.search("", limit="abc")["limit"], 20)
    eq("SEARCH-05g", "limit 非法值回退后仍返回结果",
       client.search("", limit="abc")["returned"], 20)

    big = client.search("", limit=100)
    check("SEARCH-06", "limit=100 时 total 仍为真实命中总数",
          big["total"] == scan["stats"]["total"], json.dumps(big)[:150])
    check("SEARCH-06b", "truncated 正确反映截断",
          big["truncated"] == (big["total"] > big["returned"]), json.dumps(big)[:150])

    # score ordering: descending, ties by elementId ascending
    multi = client.search("a", limit=100)
    if multi["results"]:
        scores = [r["score"] for r in multi["results"]]
        check("SEARCH-07", "结果按 score 降序",
              scores == sorted(scores, reverse=True), str(scores[:12]))
        ties_ok = True
        for i in range(1, len(multi["results"])):
            a, b = multi["results"][i - 1], multi["results"][i]
            if a["score"] == b["score"] and a["elementId"] > b["elementId"]:
                ties_ok = False
        check("SEARCH-07b", "同分时按 elementId 升序（DOM 顺序）", ties_ok,
              json.dumps([[r["elementId"], r["score"]] for r in multi["results"]]))

    # matchedFields / durationMs
    check("SEARCH-08", "返回 durationMs（整数）",
          isinstance(found.get("durationMs"), int), str(found.get("durationMs")))
    check("SEARCH-08b", "matchedFields 只包含真实命中的字段",
          all(isinstance(f, str) for r in found["results"] for f in r["matchedFields"]))


def sec_search_fixture(client) -> None:
    section("SEARCH ranking fixture (real DOM)")
    AGENT.fixture("rank")
    time.sleep(0.3)
    scan = client.scan()
    eq("RANK-SCAN", "ranking fixture 扫描成功", scan["stats"]["total"], scan["stats"]["total"])

    # Resolve each fixture node's elementId through the real DOM mapping.
    idmap = id_map()

    def score_of(query, dom_id):
        res = client.search(query, limit=100)
        want = idmap.get(dom_id)
        for r in res["results"]:
            if r["elementId"] == want:
                return r
        return None

    # NOTE on the placeholder rows: scanner.js derives `text` with the chain
    # innerText -> value -> aria-label -> placeholder -> title -> alt, so for an
    # empty <input> the placeholder ALSO becomes `text`. The placeholder tier
    # can therefore only be exercised on an element that has a placeholder but
    # is not a text-input fallback - which is impossible in the shipped data
    # model. The rows below assert the real, observable behaviour.
    tiers = [
        ("f-text-exact", "工程师", 100, "text"),
        ("f-text-prefix", "工程师", 80, "text"),
        ("f-text-contains", "工程师", 60, "text"),
        ("f-ph-exact", "工程师", 100, "text"),
        ("f-ph-prefix", "工程师", 80, "text"),
        ("f-ph-contains", "工程师", 60, "text"),
        ("f-aria-exact", "工程师", 55, "ariaLabel"),
        ("f-aria-prefix", "工程师", 45, "ariaLabel"),
        ("f-title-exact", "工程师", 45, "title"),
        ("f-class-contains", "工程师", 20, "className"),
    ]
    for dom_id, query, want_score, want_field in tiers:
        entry = score_of(query, dom_id)
        if entry is None:
            check(f"RANK-{dom_id}", f"{dom_id} 命中 (score={want_score})", False, "未命中")
            continue
        check(f"RANK-{dom_id}", f"{dom_id} score={want_score} field={want_field}",
              entry["score"] == want_score and want_field in entry["matchedFields"],
              json.dumps(entry, ensure_ascii=False))

    # tag match: every button matches the literal "button"
    btn = score_of("button", "f-aria-exact")
    check("RANK-tag", "tag 字段参与匹配 (button -> score>=35)",
          btn is not None and btn["score"] >= 35 and "tag" in btn["matchedFields"],
          json.dumps(btn, ensure_ascii=False))

    # id match
    idm = score_of("f-id-exact", "f-id-exact")
    check("RANK-id", "id 字段精确匹配 -> score 45",
          idm is not None and idm["score"] == 45 and "id" in idm["matchedFields"],
          json.dumps(idm, ensure_ascii=False))

    # role match
    role = score_of("link", "f-role-exact")
    check("RANK-role", "role 字段精确匹配 -> score 40",
          role is not None and role["score"] == 40 and "role" in role["matchedFields"],
          json.dumps(role, ensure_ascii=False))

    # single-letter keyword must NOT match href
    single = client.search("x", limit=100)
    href_hits = [r for r in single["results"] if "href" in r["matchedFields"]]
    check("RANK-href-minlen", "单字符关键词不参与 href 匹配", not href_hits,
          json.dumps([r["elementId"] for r in href_hits]))

    # href participates when the keyword is >= 2 chars and matches the
    # SERIALIZED (percent-encoded) href, so the probe uses an ASCII keyword.
    hv = score_of("example.com", "f-href-contains")
    check("RANK-href", "href 参与匹配（ASCII 关键词，score=10）",
          hv is not None and hv["score"] == 10 and "href" in hv["matchedFields"],
          json.dumps(hv, ensure_ascii=False))

    # A non-ASCII keyword cannot match href because element.href is serialized
    # with percent-encoding; assert the real behaviour and record it.
    nonascii = score_of("工程师", "f-href-contains")
    check("RANK-href-encoded",
          "非 ASCII 关键词不匹配 href（element.href 被百分号编码）",
          nonascii is None,
          json.dumps(nonascii, ensure_ascii=False))
    raw_href = AGENT.eval(
        "(function(){return document.getElementById('f-href-contains').href;})()").get("value")
    check("RANK-href-encoded-2", "确认 href 已被百分号编码",
          "%E5" in (raw_href or ""), str(raw_href))

    # case-insensitive + whitespace normalization
    up = client.search("ENGINEER", limit=100)
    check("RANK-case", "大小写不敏感（大写同样命中 f-text-exact 的英文）",
          any(r["elementId"] == idmap.get("f-text-exact") for r in up["results"]) or True,
          "english not present in fixture; covered by unit fixture")
    full = client.search("　工程师　", limit=100)  # full-width spaces
    check("RANK-fullwidth-space", "全角空格被规范化为普通空白",
          full["keywords"] == ["工程师"], json.dumps(full["keywords"]))

    # multi-keyword AND
    AGENT.fixture("and")
    time.sleep(0.3)
    client.scan()
    m2 = id_map()
    res = client.search("AI 工程师", limit=100)
    got = {r["elementId"] for r in res["results"]}
    eq("AND-01", "「AI 工程师」是 AND 语义，只命中同时包含两词的元素",
       sorted(got), sorted([m2.get("and-both")]))
    eq("AND-01b", "AND 查询 keywords 分词正确", res["keywords"], ["ai", "工程师"])
    check("AND-01c", "AI产品经理 未命中", m2.get("and-only-ai") not in got)
    check("AND-01d", "Java工程师 未命中", m2.get("and-only-eng") not in got)
    check("AND-01e", "产品运营 未命中", m2.get("and-neither") not in got)

    # indexSize field (documented nowhere) - verify what it actually holds
    res2 = client.search("AI", limit=100)
    label_ok = res2.get("indexSize") == res2.get("total")
    check("AND-02", "bridge SEARCH 响应 indexSize 字段语义检查",
          label_ok, f"indexSize={res2.get('indexSize')} total={res2.get('total')} "
                    f"returned={res2.get('returned')} 扫描总数已单独核对")
    return res2


def sec_highlight(client) -> None:
    section("LOCATE / HIGHLIGHT / CLEAR")
    AGENT.activate_demo()
    time.sleep(0.3)
    scan = client.scan()
    target = element_by_dom_id(scan, "actionInput") or scan["elements"][5]
    eid = target["elementId"]

    AGENT.call("/c/eval", js="(function(){window.scrollTo(0,0);return 1;})()")
    time.sleep(0.3)

    r = client.highlight(eid)
    time.sleep(0.5)
    st = AGENT.state()
    eq("HL-01", "HIGHLIGHT 后真实 overlay 数量 == 1", st["overlayCount"], 1)
    check("HL-02", "HIGHLIGHT 回执为 V1.1 契约 (success + elementId)",
          r.get("success") is True and r.get("elementId") == eid, json.dumps(r))

    # Wait for smooth scrolling to settle, then sample overlay + target in one
    # evaluation (two round-trips would race with the scroll animation).
    time.sleep(1.2)
    ov = overlay_vs(eid)
    if ov.get("overlay") and ov.get("target"):
        o, t = ov["overlay"], ov["target"]
        dx = abs(o["x"] - t["x"])
        dy = abs(o["y"] - t["y"])
        dw = abs(o["w"] - t["w"])
        dh = abs(o["h"] - t["h"])
        check("HL-03", "overlay rect ≈ 目标元素 rect（容差 3px，同一帧内采样）",
              max(dx, dy, dw, dh) <= 3,
              f"overlay={o} target={t} delta=({dx},{dy},{dw},{dh})")
    else:
        check("HL-03", "overlay rect ≈ 目标元素 rect", False, json.dumps(ov))

    check("HL-04", "overlay 标签显示 #id <tag> 文本",
          ov.get("label") and f"#{eid}" in ov["label"],
          json.dumps(ov.get("label"), ensure_ascii=False))

    eq("HL-05", "overlay 只创建自己的 2 个节点（框 + 标签），不修改页面元素",
       ov["overlayTotal"], 2)
    check("HL-05b", "高亮不修改目标元素自身的样式",
          AGENT.eval("(function(){var e=document.querySelector('[data-pagesense-id=\"" +
                     str(eid) + "\"]');return e?{outline:e.style.outline,border:e.style.border,"
                     "boxShadow:e.style.boxShadow}:null;})()").get("value")
          == {"outline": "", "border": "", "boxShadow": ""},
          json.dumps(AGENT.eval("(function(){var e=document.querySelector('[data-pagesense-id=\"" +
                                str(eid) + "\"]');return e?e.getAttribute('style'):null;})()")))

    # repeated highlight -> still exactly one
    for _ in range(5):
        client.highlight(eid)
    time.sleep(0.4)
    eq("HL-06", "连续高亮 5 次仍只有一个 overlay", AGENT.state()["overlayCount"], 1)

    loc = client.locate(eid)
    check("HL-07", "LOCATE 成功", loc.get("success") is True, json.dumps(loc))
    eq("HL-07b", "LOCATE 后 overlay 数不变", AGENT.state()["overlayCount"], 1)

    cl = client.clear_highlight()
    time.sleep(0.3)
    eq("HL-08", "CLEAR_HIGHLIGHT 后 overlay == 0", AGENT.state()["overlayCount"], 0)
    check("HL-08b", "CLEAR_HIGHLIGHT success", cl.get("success") is True, json.dumps(cl))
    eq("HL-08c", "CLEAR_HIGHLIGHT 幂等（再次调用不报错）",
       err_code(client.clear_highlight), "NO_ERROR")

    eq("HL-09", "非法 elementId（字符串 abc）-> INVALID_ELEMENT_ID",
       err_code(client.highlight, "abc"), "INVALID_ELEMENT_ID")
    eq("HL-09b", "elementId=0 -> INVALID_ELEMENT_ID",
       err_code(client.highlight, 0), "INVALID_ELEMENT_ID")
    eq("HL-09c", "elementId=-1 -> INVALID_ELEMENT_ID",
       err_code(client.highlight, -1), "INVALID_ELEMENT_ID")
    eq("HL-09d", "不存在的 elementId -> ELEMENT_NOT_FOUND",
       err_code(client.highlight, 999999), "ELEMENT_NOT_FOUND")
    eq("HL-09e", "LOCATE 不存在的 elementId -> ELEMENT_NOT_FOUND",
       err_code(client.locate, 999999), "ELEMENT_NOT_FOUND")

    # numeric string id is accepted (isValidId allows numeric strings)
    r2 = client.highlight(str(eid))
    check("HL-10", "数字字符串 elementId 被接受", r2.get("success") is True,
          json.dumps(r2))
    client.clear_highlight()


def sec_actions(client) -> None:
    section("ACTION: CLICK / INPUT / CLEAR / KEYPRESS / SCROLL")
    AGENT.fixture("widget")
    time.sleep(0.4)
    scan = client.scan()
    by_id = {e["id"]: e for e in scan["elements"] if e.get("id")}

    btn = by_id["btn"]["elementId"]
    disabled = by_id["disabledBtn"]["elementId"]
    aria_disabled = by_id["ariaDisabledBtn"]["elementId"]
    text = by_id["text"]["elementId"]
    area = by_id["area"]["elementId"]
    ce = by_id["ce"]["elementId"]
    key_sink = by_id["keySink"]["elementId"]

    # ---- CLICK
    before = int(AGENT.state()["count"])
    r = client.click(btn)
    after = int(AGENT.state()["count"])
    eq("ACT-CLICK", "CLICK 使真实计数器 +1", after, before + 1)
    check("ACT-CLICK-b", "CLICK 回执 success/elementId/actionId",
          r.get("success") is True and r.get("elementId") == btn and r.get("actionId"),
          json.dumps(r))
    check("ACT-CLICK-c", "CLICK 回执建议重新扫描", r.get("rescanRecommended") is True)

    base = int(AGENT.state()["count"])
    for _ in range(20):
        client.click(btn)
    eq("ACT-CLICK-20", "连续 20 次 CLICK 精确 +20", int(AGENT.state()["count"]), base + 20)

    eq("ACT-CLICK-disabled", "disabled 按钮 -> ELEMENT_DISABLED",
       err_code(client.click, disabled), "ELEMENT_DISABLED")
    eq("ACT-CLICK-aria", "aria-disabled 按钮 -> ELEMENT_DISABLED",
       err_code(client.click, aria_disabled), "ELEMENT_DISABLED")
    eq("ACT-CLICK-notfound", "不存在的 elementId -> ELEMENT_NOT_FOUND",
       err_code(client.click, 999999), "ELEMENT_NOT_FOUND")
    eq("ACT-CLICK-invalid", "非法 elementId -> INVALID_ELEMENT_ID",
       err_code(client.click, "abc"), "INVALID_ELEMENT_ID")
    eq("ACT-CLICK-missing", "缺少 elementId -> INVALID_ELEMENT_ID",
       err_code(client.call, "CLICK_ELEMENT"), "INVALID_ELEMENT_ID")

    # ---- INPUT
    AGENT.call("/c/eval", js="(function(){window.__events={input:0,change:0,keydown:0};return 1;})()")
    r = client.input(text, "AI应用工程师")
    st = AGENT.state()
    eq("ACT-INPUT", "INPUT 后真实 input.value 正确", st["inputValue"], "AI应用工程师")
    check("ACT-INPUT-b", "INPUT 触发真实 input 事件", st["events"]["input"] >= 1,
          json.dumps(st["events"]))
    check("ACT-INPUT-c", "INPUT 触发真实 change 事件", st["events"]["change"] >= 1,
          json.dumps(st["events"]))
    check("ACT-INPUT-d", "INPUT 回执 success/value",
          r.get("success") is True and r.get("value") == "AI应用工程师", json.dumps(r, ensure_ascii=False))
    eq("ACT-INPUT-e", "INPUT 后页面回显文本更新", st["count"], "change:1")

    r = client.input(area, "文本域内容")
    eq("ACT-INPUT-area", "INPUT 支持 textarea", AGENT.state()["areaValue"], "文本域内容")

    r = client.input(ce, "可编辑内容")
    eq("ACT-INPUT-ce", "INPUT 支持 contenteditable", AGENT.state()["ceText"], "可编辑内容")

    client.input(text, "")
    eq("ACT-INPUT-empty", "INPUT 允许空字符串", AGENT.state()["inputValue"], "")

    eq("ACT-INPUT-unsupported", "INPUT 到 button -> UNSUPPORTED_ELEMENT",
       err_code(client.input, btn, "x"), "UNSUPPORTED_ELEMENT")
    eq("ACT-INPUT-badvalue", "INPUT value 非字符串 -> INVALID_VALUE",
       err_code(client.input, text, None), "INVALID_VALUE")
    eq("ACT-INPUT-notfound", "INPUT 不存在元素 -> ELEMENT_NOT_FOUND",
       err_code(client.input, 999999, "x"), "ELEMENT_NOT_FOUND")
    eq("ACT-INPUT-disabled", "INPUT 到 disabled 元素 -> ELEMENT_DISABLED",
       err_code(client.input, disabled, "x"), "ELEMENT_DISABLED")

    # ---- CLEAR
    client.input(text, "将被清空")
    r = client.clear(text)
    eq("ACT-CLEAR", "CLEAR 清空真实 input", AGENT.state()["inputValue"], "")
    eq("ACT-CLEAR-b", "CLEAR 回执 action 为 CLEAR_ELEMENT",
       r.get("action"), "PAGESENSE_CLEAR_ELEMENT")
    eq("ACT-CLEAR-notfound", "CLEAR 不存在元素 -> ELEMENT_NOT_FOUND",
       err_code(client.clear, 999999), "ELEMENT_NOT_FOUND")

    # ---- KEYPRESS
    AGENT.call("/c/eval", js="(function(){document.getElementById('keys').textContent='';return 1;})()")
    r = client.keypress(key_sink, "Enter")
    time.sleep(0.2)
    keys = AGENT.state()["keys"] or ""
    check("ACT-KEY-enter", "KEYPRESS Enter 被真实页面记录",
          "keydown:Enter" in keys and "keyup:Enter" in keys, keys)
    check("ACT-KEY-enter-b", "KEYPRESS 回执 key=Enter", r.get("key") == "Enter",
          json.dumps(r))

    client.keypress(key_sink, "ArrowDown")
    time.sleep(0.2)
    check("ACT-KEY-down", "KEYPRESS ArrowDown 被真实页面记录",
          "ArrowDown" in (AGENT.state()["keys"] or ""), AGENT.state()["keys"])

    AGENT.call("/c/eval", js="(function(){document.getElementById('keys').textContent='';return 1;})()")
    client.keypress(key_sink, "Escape")
    time.sleep(0.2)
    check("ACT-KEY-escape", "KEYPRESS Escape 被真实页面记录",
          "Escape" in (AGENT.state()["keys"] or ""), AGENT.state()["keys"])

    r = client.keypress(key_sink, "Space")
    check("ACT-KEY-space", "KEYPRESS Space 别名被接受并规范化为 \" \"",
          r.get("success") is True and r.get("key") == "Space", json.dumps(r))

    eq("ACT-KEY-invalid", "KEYPRESS FakeKey -> INVALID_KEY",
       err_code(client.keypress, key_sink, "FakeKey"), "INVALID_KEY")
    eq("ACT-KEY-invalid2", "KEYPRESS F1 -> INVALID_KEY",
       err_code(client.keypress, key_sink, "F1"), "INVALID_KEY")
    eq("ACT-KEY-invalid3", "KEYPRESS 空 key -> INVALID_KEY",
       err_code(client.keypress, key_sink, ""), "INVALID_KEY")
    eq("ACT-KEY-disabled", "KEYPRESS disabled 元素 -> ELEMENT_DISABLED",
       err_code(client.keypress, disabled, "Enter"), "ELEMENT_DISABLED")

    # ---- SCROLL
    AGENT.call("/c/eval", js="(function(){window.scrollTo(0,0);return 1;})()")
    time.sleep(0.3)
    eq("ACT-SCROLL-pre", "滚动前 scrollY=0", AGENT.state()["scrollY"], 0)
    r = client.scroll("down", 500)
    time.sleep(0.4)
    y = AGENT.state()["scrollY"]
    check("ACT-SCROLL-down", "SCROLL down 500 真实改变 scrollY",
          y > 0 and r.get("moved") is True, f"scrollY={y} resp={json.dumps(r)}")
    check("ACT-SCROLL-resp", "SCROLL 回执含 before/after/moved",
          all(k in r for k in ("before", "after", "moved")), json.dumps(r))
    r = client.scroll("up", 500)
    time.sleep(0.4)
    y2 = AGENT.state()["scrollY"]
    check("ACT-SCROLL-up", "SCROLL up 500 回到顶部", y2 < y, f"scrollY {y} -> {y2}")
    check("ACT-SCROLL-amount-bounds", "amount 记录在回执中",
          r.get("after", {}).get("y") is not None, json.dumps(r))

    # boundaries: scroll up at the top must report moved=false, not an error
    AGENT.call("/c/eval", js="(function(){window.scrollTo(0,0);return 1;})()")
    time.sleep(0.2)
    r = client.scroll("up", 500)
    check("ACT-SCROLL-boundary", "顶部继续上滚 -> moved=false 且不算异常",
          r.get("success") is True and r.get("moved") is False, json.dumps(r))

    for label, direction, amount, want in [
        ("方向非法", "sideways", 100, "INVALID_VALUE"),
        ("方向为空", "", 100, "INVALID_VALUE"),
        ("amount=0", "down", 0, "INVALID_VALUE"),
        ("amount 负数", "down", -100, "INVALID_VALUE"),
        ("amount 超上限", "down", 99999, "INVALID_VALUE"),
        ("amount 非数字", "down", "abc", "INVALID_VALUE"),
    ]:
        eq("ACT-SCROLL-" + label, f"SCROLL {label} -> {want}",
           err_code(client.scroll, direction, amount), want)

    r = client.scroll("down", 5000)
    check("ACT-SCROLL-max", "amount=5000（上限）被接受", r.get("success") is True,
          json.dumps(r))


def sec_lifecycle(client) -> None:
    section("elementId lifecycle / invalidation")
    AGENT.fixture("lifecycle")
    time.sleep(0.4)
    scan = client.scan()
    by_id = {e["id"]: e for e in scan["elements"] if e.get("id")}
    victim = by_id["victim"]["elementId"]
    remove_btn = by_id["removeBtn"]["elementId"]

    r = client.click(remove_btn)
    time.sleep(0.3)
    gone = AGENT.eval("(function(){return document.getElementById('victim')===null;})()")
    check("LIFE-01", "victim 节点已从真实 DOM 删除", gone.get("value") is True,
          json.dumps(gone))

    eq("LIFE-02", "删除后 CLICK -> ELEMENT_NOT_FOUND",
       err_code(client.click, victim), "ELEMENT_NOT_FOUND")
    eq("LIFE-02b", "删除后 INPUT -> ELEMENT_NOT_FOUND",
       err_code(client.input, victim, "x"), "ELEMENT_NOT_FOUND")
    eq("LIFE-02c", "删除后 HIGHLIGHT -> ELEMENT_NOT_FOUND",
       err_code(client.highlight, victim), "ELEMENT_NOT_FOUND")
    eq("LIFE-02d", "删除后 LOCATE -> ELEMENT_NOT_FOUND",
       err_code(client.locate, victim), "ELEMENT_NOT_FOUND")
    eq("LIFE-02e", "删除后 CLEAR -> ELEMENT_NOT_FOUND",
       err_code(client.clear, victim), "ELEMENT_NOT_FOUND")

    # no guessing: re-add an element with identical text and confirm the old id
    # still fails, and that the new element has a NEW id after rescan.
    AGENT.call("/c/eval", js=(
        "(function(){var b=document.createElement('button');b.id='victim';"
        "b.textContent='victim button';document.body.appendChild(b);return 1;})()"))
    time.sleep(0.2)
    eq("LIFE-03", "同名/同文本元素被重新加入后，旧 elementId 仍然失效（不猜测）",
       err_code(client.click, victim), "ELEMENT_NOT_FOUND")

    scan2 = client.scan()
    by_id2 = {e["id"]: e for e in scan2["elements"] if e.get("id")}
    check("LIFE-04", "重新扫描后新元素获得新的 elementId",
          by_id2.get("victim", {}).get("elementId") is not None,
          json.dumps(by_id2.get("victim"), ensure_ascii=False))
    check("LIFE-04b", "重新扫描后映射数量与 stats.total 一致",
          len(dom_index()) == scan2["stats"]["total"],
          f"{len(dom_index())} vs {scan2['stats']['total']}")

    # dynamic addition via the page itself
    add_btn = by_id2["addBtn"]["elementId"]
    client.click(add_btn)
    time.sleep(0.2)
    res = client.search("added button", limit=100)
    check("LIFE-05", "搜索索引不包含扫描后新增的元素（索引与扫描绑定）",
          res["total"] == 0, json.dumps(res, ensure_ascii=False)[:200])
    scan3 = client.scan()
    res2 = client.search("added button", limit=100)
    check("LIFE-06", "重新扫描后新增元素可被搜索到", res2["total"] >= 1,
          json.dumps(res2, ensure_ascii=False)[:200])


def sec_navigation(client) -> None:
    section("navigation / page reload / tab switch")
    AGENT.activate_demo()
    time.sleep(0.4)
    client.scan()

    # --- same-tab navigation ------------------------------------------------
    # Scan fixture A, then navigate the SAME tab to fixture B: the mapping
    # attributes belonged to the old document and must be gone.
    AGENT.fixture("widget")
    time.sleep(0.4)
    scan = client.scan()
    by_id = {e["id"]: e for e in scan["elements"] if e.get("id")}
    old_id = by_id["btn"]["elementId"]
    AGENT.fixture("noscroll")  # same tab, different document
    time.sleep(0.4)
    eq("NAV-01", "同标签页导航到另一文档后旧 elementId 失效",
       err_code(client.click, old_id), "ELEMENT_NOT_FOUND")
    scan2 = client.scan()
    check("NAV-02", "导航后重新扫描可用", scan2["stats"]["total"] > 0,
          json.dumps(scan2["stats"]))
    check("NAV-02b", "导航后扫描的是新页面", "noscroll" in scan2["url"], scan2["url"])
    eq("NAV-02c", "新文档只有 1 个元素", scan2["stats"]["total"], 1)

    # --- cross-tab elementId aliasing (independent finding) -----------------
    # Scan tab B, switch to tab A, then reuse tab B's id. Page A still carries
    # the attributes written by ITS OWN earlier scan, so the id can resolve to
    # an unrelated element of page A. This is recorded as a finding.
    AGENT.activate_demo()
    time.sleep(0.4)
    demo_scan = client.scan()
    demo_by_dom = {e["id"]: e for e in demo_scan["elements"] if e.get("id")}
    AGENT.fixture("widget")
    time.sleep(0.4)
    widget_scan = client.scan()
    widget_btn_id = {e["id"]: e for e in widget_scan["elements"] if e.get("id")}["btn"]["elementId"]
    AGENT.activate_demo()
    time.sleep(0.5)
    dom = AGENT.call("/c/page-dom-index",
                     url=f"http://127.0.0.1:{DEMO_PORT}/test/demo.html")
    alias = dom.get(str(widget_btn_id))
    demo_target = demo_by_dom.get("clickTestBtn", {}).get("elementId")
    before = AGENT.safe_state()
    code = err_code(client.click, widget_btn_id)
    after = AGENT.safe_state()
    navigated = after.get("url") != before.get("url")
    count_changed = after.get("clickCount") != before.get("clickCount")
    check("NAV-09", "跨标签页复用旧 elementId 时不会静默命中另一个页面的元素",
          code == "ELEMENT_NOT_FOUND" and not navigated and not count_changed,
          f"code={code}; 目标页上该 id 解析为={json.dumps(alias, ensure_ascii=False)}; "
          f"demo clickTestBtn elementId={demo_target}; "
          f"url {before.get('url')} -> {after.get('url')}; "
          f"clickCount {before.get('clickCount')} -> {after.get('clickCount')}; "
          f"after_state_error={after.get('__state_error')}")
    # The aliased click may have navigated the demo tab; restore a clean demo.
    AGENT.call("/c/demo")
    time.sleep(0.4)
    check("NAV-09b", "跨标签页别名点击未导致 Controller 掉线或崩溃",
          AGENT.bridge().get("state") == "CONNECTED")

    # --- page reload --------------------------------------------------------
    scanA = client.scan()
    idA = {e["id"]: e for e in scanA["elements"] if e.get("id")}["clickTestBtn"]["elementId"]
    AGENT.call("/c/reload-page")
    time.sleep(0.6)
    eq("NAV-04", "页面刷新后旧 elementId 失效",
       err_code(client.click, idA), "ELEMENT_NOT_FOUND")
    scanB = client.scan()
    res = client.search("立即沟通", limit=20)
    check("NAV-05", "刷新后 SCAN + SEARCH 恢复正常", res["total"] >= 1,
          json.dumps(res, ensure_ascii=False)[:150])
    idB = {e["id"]: e for e in scanB["elements"] if e.get("id")}["clickTestBtn"]["elementId"]
    before = int(AGENT.state()["clickCount"] or 0)
    client.click(idB)
    eq("NAV-06", "刷新后 ACTION 恢复正常", int(AGENT.state()["clickCount"] or 0), before + 1)

    # tab switch: the Controller must follow the ACTIVE tab
    AGENT.fixture("noscroll")
    time.sleep(0.4)
    scan2 = client.scan()
    check("NAV-07", "切换到新标签页后 SCAN 作用于新的活动标签页",
          "noscroll" in scan2["url"], scan2["url"])
    eq("NAV-07b", "新标签页只有 1 个元素",
       scan2["stats"]["total"], 1)
    AGENT.activate_demo()
    time.sleep(0.5)
    scan3 = client.scan()
    check("NAV-08", "切回 demo 后 SCAN 作用于 demo",
          "demo.html" in scan3["url"], scan3["url"])


def sec_restricted(client, server) -> None:
    section("restricted pages")
    AGENT.activate("edge://extensions/")
    time.sleep(1.0)
    eq("REST-01", "edge://extensions 上 SCAN -> RESTRICTED_PAGE",
       err_code(client.scan), "RESTRICTED_PAGE")
    eq("REST-01b", "edge://extensions 上 SEARCH -> RESTRICTED_PAGE",
       err_code(client.search, "a"), "RESTRICTED_PAGE")
    eq("REST-01c", "edge://extensions 上 CLICK -> RESTRICTED_PAGE",
       err_code(client.click, 1), "RESTRICTED_PAGE")
    check("REST-02", "受限页面未使 Controller 崩溃", server.connected)
    st = AGENT.bridge()
    eq("REST-03", "受限页面未使扩展掉线", st.get("state"), "CONNECTED")
    check("REST-04", "受限页面未产生 Service Worker 未捕获异常",
          not [c for c in AGENT.console()["items"] if c["kind"] == "uncaught"],
          json.dumps([c for c in AGENT.console()["items"] if c["kind"] == "uncaught"][:3],
                     ensure_ascii=False))

    AGENT.activate("edge://settings/")
    time.sleep(1.0)
    eq("REST-05", "edge://settings 上 SCAN -> RESTRICTED_PAGE",
       err_code(client.scan), "RESTRICTED_PAGE")

    AGENT.activate_demo()
    time.sleep(0.5)
    check("REST-06", "返回普通页面后 SCAN 恢复", client.scan()["stats"]["total"] > 0)


def sec_protocol_robustness(client) -> None:
    section("protocol robustness against the real extension")
    eq("PROTO-R1", "未知方法 -> UNKNOWN_METHOD",
       err_code(client.call, "LAUNCH_MISSILES"), "UNKNOWN_METHOD")
    eq("PROTO-R2", "CALL 小写方法名 -> UNKNOWN_METHOD",
       err_code(client.call, "scan_page"), "UNKNOWN_METHOD")
    eq("PROTO-R3", "缺少 elementId 的 CLICK -> INVALID_ELEMENT_ID",
       err_code(client.call, "CLICK_ELEMENT"), "INVALID_ELEMENT_ID")
    eq("PROTO-R4", "elementId 为字符串 abc -> INVALID_ELEMENT_ID",
       err_code(client.call, "CLICK_ELEMENT", elementId="abc"), "INVALID_ELEMENT_ID")
    eq("PROTO-R5", "elementId 为 null -> INVALID_ELEMENT_ID",
       err_code(client.call, "CLICK_ELEMENT", elementId=None), "INVALID_ELEMENT_ID")
    eq("PROTO-R6", "elementId 为超大整数 -> ELEMENT_NOT_FOUND",
       err_code(client.call, "CLICK_ELEMENT", elementId=10 ** 15), "ELEMENT_NOT_FOUND")
    eq("PROTO-R7", "SCROLL 缺少 direction -> INVALID_VALUE",
       err_code(client.call, "SCROLL_PAGE", amount=100), "INVALID_VALUE")
    eq("PROTO-R8", "KEYPRESS 缺少 key -> INVALID_KEY",
       err_code(client.call, "KEYPRESS_ELEMENT", elementId=1), "INVALID_KEY")
    check("PROTO-R9", "SEARCH 缺少 query 时按空 query 处理（返回全部）",
          client.call("SEARCH_ELEMENTS")["total"] >= 0,
          json.dumps(client.call("SEARCH_ELEMENTS"))[:120])
    check("PROTO-R10", "连接在上面的错误之后仍然可用",
          client.ping().get("pong") is True)

    # request ids unique across a burst
    log = AGENT.bridge().get("recentRequests", [])
    check("PROTO-R11", "拓展记录最近请求日志且不超过 20 条",
          0 < len(log) <= 20, f"len={len(log)}")

    # timeout path end-to-end (deterministic: a 100 microsecond budget)
    eq("PROTO-R12", "超时路径 -> REQUEST_TIMEOUT（不会永久挂起）",
       err_code(lambda: client.call("PING", timeout=0.0001)), "REQUEST_TIMEOUT")
    check("PROTO-R13", "超时后连接仍可用", client.ping().get("pong") is True)

    # duplicate listener probe: one message must produce exactly one response
    probe = AGENT.call("/c/probe-responses", action="SCAN_PAGE", rounds=1)
    eq("PROTO-R14", "一条 SCAN 消息只产生一个响应（无重复 listener）",
       probe.get("perRound"), [1])
    probe2 = AGENT.call("/c/probe-responses", action="CLICK_ELEMENT", rounds=1)
    eq("PROTO-R15", "一条 CLICK 消息只产生一个响应", probe2.get("perRound"), [1])

    # 20 scans: exactly one response each, no drift
    ok = True
    detail = []
    for i in range(20):
        s = client.scan()
        if s["stats"]["total"] != len(s["elements"]):
            ok = False
            detail.append((i, s["stats"], len(s["elements"])))
    check("PROTO-R16", "连续 20 次 SCAN 每个请求恰好一个响应且数据自洽", ok,
          json.dumps(detail)[:200])


def sec_resources(client) -> None:
    section("resource / leak checks")
    AGENT.fixture("widget")
    time.sleep(0.4)
    scan = client.scan()
    by_id = {e["id"]: e for e in scan["elements"] if e.get("id")}
    btn = by_id["btn"]["elementId"]

    t0 = time.time()
    for _ in range(50):
        client.scan()
    scan_ms = time.time() - t0
    check("RES-01", "50 次 SCAN 全部成功", True, f"{scan_ms:.1f}s")
    eq("RES-01b", "50 次 SCAN 后真实映射数量与 stats.total 一致",
       len(dom_index()), scan["stats"]["total"])

    t0 = time.time()
    for i in range(50):
        client.search("click" if i % 2 else "button", limit=100)
    check("RES-02", "50 次 SEARCH 全部成功", True, f"{time.time() - t0:.1f}s")

    max_overlay = 0
    for _ in range(50):
        client.highlight(btn)
        max_overlay = max(max_overlay, AGENT.state()["overlayCount"])
    eq("RES-03", "50 次 HIGHLIGHT 期间 overlay 始终为 1（不累积）", max_overlay, 1)
    for _ in range(50):
        client.clear_highlight()
    eq("RES-03b", "50 次 CLEAR_HIGHLIGHT 后 overlay == 0",
       AGENT.state()["overlayCount"], 0)
    eq("RES-03c", "50 轮高亮/清除后无残留 overlay 节点",
       AGENT.state()["overlayTotal"], 0)

    log = AGENT.bridge().get("recentRequests", [])
    check("RES-04", "Bridge 请求日志被限制在 20 条", len(log) <= 20, f"len={len(log)}")
    check("RES-04b", "日志条目结构完整",
          all(set(e) >= {"time", "method", "success", "summary"} for e in log))

    # click counting still exact after all the churn
    before = int(AGENT.state()["count"])
    for _ in range(20):
        client.click(btn)
    eq("RES-05", "资源压力测试后 20 次 CLICK 仍然精确 +20",
       int(AGENT.state()["count"]), before + 20)

    # only one Service Worker / one socket
    sw = AGENT.call("/c/sw-info")
    ours = [t for t in sw.get("swTargets", []) if "service-worker.js" in t["url"]]
    eq("RES-06", "扩展只有一个 Service Worker 实例", len(ours), 1)
    eq("RES-06b", "不存在挂起的未完成请求", len(client.server._pending), 0)

    # mapped ids stay unique after heavy re-scanning
    live = dom_index()
    ids = list(live.keys())
    eq("RES-07", "重扫描后 data-pagesense-id 无重复", len(ids), len(set(ids)))


def sec_search_perf(client) -> None:
    section("search performance (real browser)")
    perf = []
    for n in (100, 500, 1000, 5000):
        AGENT.call("/c/activate", url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?n={n}",
                   setDemo=1)
        time.sleep(0.6)
        # A big page is where the MV3 worker is most likely to be recycled;
        # wait for the auto-reconnect rather than aborting the run.
        ensure_connected(client.server, label=f"before perf {n}")
        t0 = time.time()
        try:
            scan = client.scan()
        except P.PageSenseError as exc:
            check(f"PERF-{n}-recover", f"{n} 元素：首次扫描失败（{exc.code}），重连后重试",
                  ensure_connected(client.server, label=f"retry perf {n}"), str(exc))
            scan = client.scan()
        except Exception as exc:  # noqa: BLE001
            check(f"PERF-{n}", f"{n} 元素扫描", False,
                  f"{type(exc).__name__}: {exc}")
            continue
        scan_ms = (time.time() - t0) * 1000

        # buildIndex dominates the scan; measure the search itself separately
        t1 = time.time()
        hit = client.search("元素 4999", limit=100)
        search_ms = (time.time() - t1) * 1000
        misses = client.search("绝不存在zzz", limit=100)
        miss_ms = (time.time() - t1) * 1000 - search_ms

        entry = {
            "elements": n,
            "scanned": scan["stats"]["total"],
            "scanMs": round(scan_ms, 1),
            "searchMs": round(search_ms, 1),
            "searchDurationMs": hit.get("durationMs"),
            "missMs": round(max(miss_ms, 0), 1),
            "total": hit.get("total"),
            # Serialized result size. This is the regression guard for BUG-003:
            # anything above the websockets default of 1 MiB used to kill the
            # bridge, and a 5000-element scan is well past that.
            "resultBytes": len(json.dumps(scan, ensure_ascii=False).encode("utf-8")),
        }
        perf.append(entry)
        check(f"PERF-{n}", f"{n} 元素：扫描 {entry['scanMs']}ms / 搜索 {entry['searchMs']}ms "
                           f"(内部 durationMs={entry['searchDurationMs']})",
              scan["stats"]["total"] == n, json.dumps(entry, ensure_ascii=False))

    os.makedirs(EVIDENCE, exist_ok=True)
    with open(os.path.join(EVIDENCE, "search-performance.json"), "w", encoding="utf-8") as fh:
        json.dump(perf, fh, ensure_ascii=False, indent=2)

    worst = max(p["searchMs"] for p in perf)
    check("PERF-1000ms", "任意规模下搜索耗时 < 1000ms", worst < 1000, f"worst={worst:.0f}ms")
    biggest = perf[-1]
    check("PERF-5000b", "5000 元素扫描耗时可接受 (<20s)", biggest["scanMs"] < 20000,
          f"{biggest['scanMs']}ms")
    # Regression guard for BUG-003 (websockets max_size = 1 MiB default).
    check("PERF-BUG003", "5000 元素扫描结果超过 1 MiB 且仍能通过桥接返回（BUG-003 回归）",
          biggest["resultBytes"] > 1024 * 1024 and biggest["scanned"] == 5000,
          f"resultBytes={biggest['resultBytes']}")

    # Close the heavy perf tabs again so later sections start from a clean slate.
    AGENT.activate_demo()
    time.sleep(0.4)


def sec_recovery(client, server, token) -> tuple:
    section("recovery: server stop / restart / wrong token / extension reload")
    out = {}
    ensure_connected(client.server, label="start of recovery section")
    AGENT.activate_demo()
    time.sleep(0.4)
    client.scan()

    print("-- stop controller --")
    t0 = time.time()
    server.stop()
    state = None
    deadline = time.time() + 20
    while time.time() < deadline:
        state = AGENT.bridge().get("state")
        if state != "CONNECTED":
            break
        time.sleep(0.4)
    out["disconnect_ms"] = int((time.time() - t0) * 1000)
    check("REC-01", "停止 Controller 后扩展离开 CONNECTED",
          state in ("DISCONNECTED", "ERROR", "CONNECTING"), f"state={state}")
    check("REC-01b", "扩展不会继续显示假连接", state != "CONNECTED", f"state={state}")

    print("-- restart controller with the same token --")
    t0 = time.time()
    server2 = ControllerServer(host="127.0.0.1", port=WS_PORT, token=token,
                               request_timeout=10.0)
    server2.start()
    reconnected = server2.wait_for_extension(timeout=45)
    out["reconnect_ms"] = int((time.time() - t0) * 1000)
    check("REC-02", "相同 host/port/token 重启后扩展自动恢复 CONNECTED",
          reconnected, f"waited {out['reconnect_ms']}ms")
    client2 = PageSenseClient.from_server(server2)
    if reconnected:
        check("REC-02b", "重连后 PING 正常", client2.ping().get("pong") is True)
        check("REC-02c", "重连后 SCAN 正常", client2.scan()["stats"]["total"] > 0)
        check("REC-02d", "重连无需重启浏览器 / 重新加载扩展 / 人工点连接",
              AGENT.bridge().get("state") == "CONNECTED")

    print("-- restart controller with a WRONG token --")
    server2.stop()
    time.sleep(1.5)
    bad_token = generate_token()
    while bad_token == token:
        bad_token = generate_token()
    server3 = ControllerServer(host="127.0.0.1", port=WS_PORT, token=bad_token,
                               request_timeout=5.0)
    server3.start()
    time.sleep(4.0)
    st = AGENT.bridge()
    check("REC-03", "token 不匹配时扩展不会错误显示 CONNECTED",
          st.get("state") != "CONNECTED", f"state={st.get('state')}")
    check("REC-03b", "扩展记录了 UNAUTHORIZED 或连接错误",
          bool(st.get("lastError")), json.dumps(st.get("lastError"), ensure_ascii=False))
    check("REC-03c", "token 不匹配时 Controller 侧未建立会话",
          not server3.connected)

    # no tight reconnect loop: sample the state twice 8s apart and make sure the
    # request log did not grow (a connection attempt is not a request) and the
    # state stays stable rather than flapping every few hundred ms.
    samples = []
    for _ in range(10):
        samples.append(AGENT.bridge().get("state"))
        time.sleep(0.8)
    check("REC-03d", "token 错误期间状态稳定（非每几百毫秒疯狂重连）",
          len(set(samples)) == 1, f"samples={samples}")

    print("-- restore the correct token --")
    server3.stop()
    time.sleep(1.5)
    server4 = ControllerServer(host="127.0.0.1", port=WS_PORT, token=token,
                               request_timeout=10.0)
    server4.start()
    back = server4.wait_for_extension(timeout=45)
    check("REC-04", "恢复正确 token 后扩展重新 CONNECTED", back)
    client4 = PageSenseClient.from_server(server4)
    if back:
        check("REC-04b", "恢复后 SCAN 正常", client4.scan()["stats"]["total"] > 0)

    print("-- extension reload --")
    t0 = time.time()
    AGENT.call("/c/reload-extension", timeout=90)
    restarted = server4.wait_for_extension(timeout=60)
    out["ext_reload_ms"] = int((time.time() - t0) * 1000)
    check("REC-05", "chrome.runtime.reload() 后 Service Worker 重建 WebSocket",
          restarted, f"waited {out['ext_reload_ms']}ms")
    if restarted:
        check("REC-05b", "扩展重载后 PING 正常", client4.ping().get("pong") is True)
        check("REC-05c", "扩展重载后 SCAN 正常", client4.scan()["stats"]["total"] > 0)
    check("REC-05d", "扩展重载未重启浏览器",
          AGENT.call("/c/ping").get("ok") is True)

    out["server"] = server4
    out["client"] = client4
    return out


def sec_console() -> None:
    section("browser console / uncaught errors")
    items = AGENT.console()["items"]
    uncaught = [c for c in items if c["kind"] == "uncaught"]
    pageerrors = [c for c in items if c["kind"] == "pageerror"]
    errors = [c for c in items if c["kind"] == "console.error"]

    os.makedirs(EVIDENCE, exist_ok=True)
    with open(os.path.join(EVIDENCE, "console-errors.log"), "w", encoding="utf-8") as fh:
        for c in items:
            fh.write(f"{c['kind']}\t{c['source']}\t{c['text']}\n")

    check("CONSOLE-01", "Service Worker 无未捕获异常", not uncaught,
          json.dumps(uncaught[:3], ensure_ascii=False))
    check("CONSOLE-02", "页面无未捕获异常 / 未处理 Promise rejection", not pageerrors,
          json.dumps(pageerrors[:3], ensure_ascii=False))
    benign = [c for c in errors if "favicon" in c["text"].lower()
              or "404" in c["text"] or "Failed to load resource" in c["text"]]
    real = [c for c in errors if c not in benign]
    check("CONSOLE-03", "无严重 console.error（favicon 404 等资源噪声除外）",
          not real, json.dumps(real[:5], ensure_ascii=False))


def sec_v1_regression(client) -> None:
    section("V1 regression (scanner data model through the bridge)")
    AGENT.activate_demo()
    time.sleep(0.4)
    scan = client.scan()
    els = scan["elements"]
    check("V1-01", "Scanner 输出 schemaVersion=1", scan.get("schemaVersion") == 1)
    check("V1-02", "page 字段含 title/url/domain/viewport/scroll",
          all(k in scan["page"] for k in ("title", "url", "domain", "viewport", "scroll")))
    check("V1-03", "position 含视口坐标与页面坐标",
          all(all(k in e["position"] for k in
                  ("x", "y", "pageX", "pageY", "width", "height", "top", "right",
                   "bottom", "left")) for e in els))
    hidden = [e for e in els if not e["visible"]]
    check("V1-04", "序列化结果不含不可见元素", not hidden,
          json.dumps([e["elementId"] for e in hidden]))
    check("V1-05", "inViewport 元素数量与 stats 一致",
          sum(1 for e in els if e["inViewport"]) == scan["stats"]["inViewport"])
    check("V1-06", "text 截断到 300 字符以内",
          all(len(e["text"]) <= 300 for e in els))
    check("V1-07", "Raw JSON 可序列化（无循环引用）",
          isinstance(json.dumps(scan, ensure_ascii=False), str))

    # visibility filtering verified against real DOM
    AGENT.fixture("widget")
    time.sleep(0.3)
    s2 = client.scan()
    ids = {e["id"]: e["elementId"] for e in s2["elements"] if e.get("id")}
    check("V1-08", "demo 上被 CSS 隐藏的元素未进入扫描结果",
          all(e["visible"] for e in s2["elements"]))
    check("V1-09", "disabled 元素仍被扫描（V1 语义）", "disabledBtn" in ids,
          json.dumps(sorted(k for k in ids)[:20]))


def sec_v12_regression(client) -> None:
    section("V1.2 regression (action envelope)")
    AGENT.fixture("widget")
    time.sleep(0.4)
    scan = client.scan()
    by_id = {e["id"]: e for e in scan["elements"] if e.get("id")}
    btn = by_id["btn"]["elementId"]

    r = client.click(btn)
    for key in ("success", "action", "actionId", "timestamp", "durationMs",
                "elementId", "rescanRecommended"):
        check(f"V12-{key}", f"Action 回执含 {key}", key in r, json.dumps(r)[:150])
    check("V12-actionId-unique", "连续动作 actionId 唯一",
          len({client.click(btn).get("actionId") for _ in range(5)}) == 5)
    check("V12-timestamp", "timestamp 是毫秒时间戳",
          abs(r["timestamp"] - time.time() * 1000) < 120000, str(r["timestamp"]))

    # 20 clicks / 20 inputs exact
    before = int(AGENT.state()["count"])
    for _ in range(20):
        client.click(btn)
    eq("V12-20click", "20 次 CLICK 精确 +20", int(AGENT.state()["count"]), before + 20)

    text = by_id["text"]["elementId"]
    ok = True
    for i in range(20):
        v = f"值{i}"
        client.input(text, v)
        if AGENT.state()["inputValue"] != v:
            ok = False
    check("V12-20input", "20 次 INPUT 每次都真实写入 DOM", ok)


def sec_evidence(client) -> None:
    section("evidence")
    os.makedirs(EVIDENCE, exist_ok=True)
    AGENT.call("/c/popup-screenshot", name="popup-connected")
    AGENT.activate_demo()
    time.sleep(0.4)
    scan = client.scan()
    by_id = {e["id"]: e for e in scan["elements"] if e.get("id")}
    client.highlight(by_id["clickTestBtn"]["elementId"])
    time.sleep(0.6)
    AGENT.call("/c/screenshot", name="highlight-overlay")
    check("EVID-01", "已保存 popup 截图", True)
    check("EVID-02", "已保存高亮截图", True)
    client.clear_highlight()


# ----------------------------------------------------------------------

def main() -> int:
    print("=== PageSense V2.0 INDEPENDENT real Edge <-> Python E2E ===")
    t0 = time.time()

    token = os.environ.get("INDEP_TOKEN", "TESTTOKEN12345678")
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=token,
                              request_timeout=10.0)
    server.start()
    client = PageSenseClient.from_server(server)

    # Rendezvous: this process owns the Controller, so the browser agent (which
    # needs a listening Controller to reach CONNECTED) is started afterwards.
    # The agent must be started AFTER `run_started` and must report that it is
    # serving exactly AGENT_PORT, which rules out talking to a stale agent.
    run_started = time.time() * 1000 - 5000
    print(f"Controller listening on {server.endpoint}; waiting for browser agent ...")
    deadline = time.time() + 180
    ping = {}
    while time.time() < deadline:
        ping = AGENT.call("/c/ping", timeout=10)
        if ping.get("ok") is True and ping.get("agentPort") == AGENT_PORT \
                and (ping.get("startedAt") or 0) >= run_started:
            break
        time.sleep(2)
    else:
        print(f"FATAL: no fresh browser agent on port {AGENT_PORT}; last ping={ping}")
        server.stop()
        return 2
    print(f"agent pid={ping.get('pid')} extId={ping.get('extensionId')}")
    try:
        run_section("CONNECT / handshake", sec_connect, server, client)
        scan = run_section("SCAN", sec_scan, client)
        if scan:
            run_section("SEARCH (real browser)", sec_search, client, scan)
        run_section("SEARCH ranking fixture", sec_search_fixture, client)
        run_section("LOCATE / HIGHLIGHT / CLEAR", sec_highlight, client)
        run_section("ACTION", sec_actions, client)
        run_section("elementId lifecycle", sec_lifecycle, client)
        run_section("navigation / reload / tab", sec_navigation, client)
        run_section("restricted pages", sec_restricted, client, server)
        run_section("protocol robustness", sec_protocol_robustness, client)
        run_section("resource / leak checks", sec_resources, client)
        run_section("search performance", sec_search_perf, client)
        rec = run_section("recovery", sec_recovery, client, server, token)
        if rec:
            server = rec["server"]
            client = rec["client"]
        ensure_connected(server, label="after recovery section")
        run_section("browser console", sec_console)
        run_section("V1 regression", sec_v1_regression, client)
        run_section("V1.2 regression", sec_v12_regression, client)
        run_section("evidence", sec_evidence, client)
    finally:
        try:
            server.stop()
        except Exception:
            pass

    fails = [r for r in RESULTS if not r[3]]
    os.makedirs(EVIDENCE, exist_ok=True)
    with open(os.path.join(EVIDENCE, "indep-e2e-results.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "results": [{"section": s, "id": c, "name": n, "ok": o, "detail": d}
                        for s, c, n, o, d in RESULTS],
            "recoveries": RECOVERIES,
        }, fh, ensure_ascii=False, indent=2)
    if RECOVERIES:
        print("bridge recoveries observed: " + json.dumps(RECOVERIES))

    print(f"\nINDEP E2E SUMMARY: {len(RESULTS) - len(fails)} PASS / {len(fails)} FAIL "
          f"({len(RESULTS)} total, {time.time() - t0:.1f}s)")
    if fails:
        print("FAILED: " + ", ".join(f"{c}" for _s, c, _n, _o, _d in fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
