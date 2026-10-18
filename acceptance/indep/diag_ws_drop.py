"""Diagnostic: why does the WebSocket drop on large pages?

Separates the two candidate causes:
  A. number of interactive elements on the page
  B. size of the serialized scan payload

and detects a Service Worker RESTART (which would explain an abrupt socket
close) by watching the extension's in-memory request log and the CDP Service
Worker target id.

Run:  python diag_ws_drop.py
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

EVENTS: list[dict] = []


def agent(path: str, **params):
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}{path}{qs}", timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"__error": f"{type(e).__name__}: {e}"}


def note(kind, **kw):
    rec = {"t": round(time.time(), 2), "kind": kind, **kw}
    EVENTS.append(rec)
    if len(EVENTS) < 400:
        print("  " + json.dumps(rec, ensure_ascii=False)[:400])


def sw_state():
    """Snapshot that reveals a Service Worker restart."""
    bridge = agent("/c/bridge") or {}
    sw = agent("/c/sw-info") or {}
    ours = [t for t in (sw.get("swTargets") or []) if "service-worker.js" in t.get("url", "")]
    return {
        "log_len": len(bridge.get("recentRequests") or []),
        "connected_since": bridge.get("connectedSince"),
        "sw_target": ours[0].get("targetId") if ours else None,
        "sw_count": len(ours),
        "state": bridge.get("state"),
    }


def main() -> int:
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                              request_timeout=20.0)
    server.start()
    client = PageSenseClient.from_server(server)
    print("waiting for extension:", server.wait_for_extension(timeout=60))

    for label, qs in [
        ("3000 long text", "n=3000"),
        ("3000 short text", "n=3000&short=1"),
        ("6000 short text", "n=6000&short=1"),
        ("1500 long text", "n=1500"),
        ("2500 long text", "n=2500"),
    ]:
        print(f"\n=== {label} ({qs}) ===")
        agent("/c/activate", url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?{qs}", setDemo=1)
        time.sleep(1.0)
        agent("/c/console-reset")
        before = sw_state()
        note("before", label=label, **before)

        # Dry-run the scan body in the page to measure the response size the
        # content script would produce, without touching the bridge.
        size = agent("/c/eval", js=(
            "(function(){var n=document.querySelectorAll('a,button,input,textarea,select,"
            "[role=\"button\"],[role=\"link\"],[role=\"textbox\"],[contenteditable=\"true\"]').length;"
            "return n;})()")).get("value")

        t0 = time.time()
        try:
            s = client.scan()
            ms = (time.time() - t0) * 1000
            approx = len(json.dumps(s, ensure_ascii=False).encode("utf-8"))
            note("scan_ok", label=label, ms=round(ms, 1), total=s["stats"]["total"],
                 payload_bytes=approx, matched=size)
        except Exception as exc:  # noqa: BLE001
            ms = (time.time() - t0) * 1000
            note("scan_FAIL", label=label, ms=round(ms, 1),
                 code=getattr(exc, "code", type(exc).__name__), matched=size)
            back = server.wait_for_extension(timeout=60)
            after = sw_state()
            note("after_fail", label=label, recovered=back, **after)
            note("sw_restarted", label=label,
                 restarted=(after["log_len"] < before["log_len"]
                            or after["sw_target"] != before["sw_target"]
                            or after["connected_since"] != before["connected_since"]))
        time.sleep(0.5)

    out = os.path.join(ROOT, "acceptance", "evidence-v2-independent",
                       "ws-drop-diagnostic.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(EVENTS, fh, ensure_ascii=False, indent=2)
    print("\nwrote " + out)

    fails = [e for e in EVENTS if e["kind"] == "scan_FAIL"]
    ok = [e for e in EVENTS if e["kind"] == "scan_ok"]
    print(f"\nscans ok={len(ok)} failed={len(fails)}")
    for e in EVENTS:
        if e["kind"] in ("scan_ok", "scan_FAIL"):
            print("  " + json.dumps(e, ensure_ascii=False)[:220])
    server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
