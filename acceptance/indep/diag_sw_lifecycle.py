"""Diagnostic: does the extension reconnect after the Controller was down long
enough for the browser to recycle the MV3 Service Worker?

Measured separately for:
  A. short gap (Controller restarted immediately)          -> known good
  B. long gap, no interaction with the browser            -> suspected broken
  C. same long gap, but the Service Worker is woken       -> which events work?

Run:  python diag_sw_lifecycle.py
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


def agent(path, **params):
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}{path}{qs}", timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"__error": f"{type(e).__name__}: {e}"}


def note(event, **kw):
    rec = {"t": round(time.time(), 2), "event": event, **kw}
    EVENTS.append(rec)
    print("  " + json.dumps(rec, ensure_ascii=False)[:260])


def new_controller():
    s = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN, request_timeout=20.0)
    s.start()
    return s


def ext_state():
    b = agent("/c/bridge")
    return b.get("state"), b.get("lastError")


def scenario(label: str, down_seconds: float, wake: str | None) -> bool:
    print(f"\n=== {label} (down {down_seconds:g}s, wake={wake}) ===")
    srv = new_controller()
    if not srv.wait_for_extension(timeout=90):
        note("setup_failed", label=label)
        srv.stop()
        return False
    note("connected", label=label)

    srv.stop()
    time.sleep(2)
    note("controller_stopped", label=label, ext_state=ext_state()[0])

    time.sleep(down_seconds)

    srv = new_controller()
    t0 = time.time()
    reconnected = srv.wait_for_extension(timeout=25)   # 25s WITHOUT any wake-up
    note("probe_no_wake", label=label, reconnected=reconnected,
         waited=round(time.time() - t0, 1), ext_state=ext_state()[0])

    if not reconnected and wake:
        if wake == "popup":
            agent("/c/popup-focus-read", wait=1200)
        elif wake == "demo-tab":
            # Waking via a normal page navigation instead of the popup.
            agent("/c/activate-demo")
        elif wake == "agent-ping":
            agent("/c/ping")
        t1 = time.time()
        reconnected = srv.wait_for_extension(timeout=40)
        note("after_wake", label=label, wake=wake, reconnected=reconnected,
             waited=round(time.time() - t1, 1), ext_state=ext_state()[0])

    if reconnected:
        agent("/c/demo")
        time.sleep(0.5)
        c = PageSenseClient.from_server(srv)
        try:
            s = c.scan()
            note("scan_after_recovery", label=label, total=s["stats"]["total"])
        except Exception as exc:  # noqa: BLE001
            note("scan_after_recovery", label=label,
                 error=getattr(exc, "code", type(exc).__name__))

    srv.stop()
    return reconnected


def main() -> int:
    a = scenario("A. 短间隔重启（立即恢复）", 0, None)
    b = scenario("B. 长间隔（45s）+ 无任何唤醒", 45, None)
    c = scenario("C. 长间隔（45s）+ 开 Popup 唤醒", 45, "popup")
    d = scenario("D. 长间隔（45s）+ 切到 demo 标签页唤醒", 45, "demo-tab")

    out = os.path.join(ROOT, "acceptance", "evidence-v2-independent",
                       "sw-lifecycle.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(EVENTS, fh, ensure_ascii=False, indent=2)
    print("\nwrote " + out)
    print(f"A(short gap)={a}  B(long gap, no wake)={b}  C(wake=popup)={c}  D(wake=tab)={d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
