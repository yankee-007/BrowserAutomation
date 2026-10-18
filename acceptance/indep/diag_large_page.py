"""Focused diagnostic: does scanning a large page drop the bridge?

Isolated from the main suite because the main suite's crash made the cause
ambiguous. This drives one page size at a time, scans it repeatedly, and
records every connection state transition plus the browser-side Service Worker
target count.

Run:  python diag_large_page.py
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
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}{path}{qs}", timeout=90) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"__error": f"{type(e).__name__}: {e}"}


def main() -> int:
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                              request_timeout=15.0)
    server.start()
    client = PageSenseClient.from_server(server)

    print(f"waiting for extension ... connected={server.wait_for_extension(timeout=60)}")
    events: list[dict] = []

    def note(kind, **kw):
        rec = {"t": round(time.time(), 2), "kind": kind, **kw}
        events.append(rec)
        if len(events) < 300:
            print("  " + json.dumps(rec, ensure_ascii=False))

    # Track connection transitions from the Controller side.
    # NOTE: server._notify calls self.on_state_change, so the hook must NOT
    # call back into _notify - that recurses infinitely.
    def notify(connected, version=None):
        note("controller_state", connected=connected, version=version)

    server.on_state_change = notify

    for n in (1000, 2000, 3000, 5000):
        print(f"\n=== page with {n} buttons ===")
        agent("/c/activate", url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?n={n}", setDemo=1)
        time.sleep(1.0)
        note("page_loaded", n=n)
        for i in range(3):
            t0 = time.time()
            try:
                s = client.scan()
                dt = (time.time() - t0) * 1000
                note("scan_ok", n=n, attempt=i, ms=round(dt, 1),
                     total=s["stats"]["total"], connected=server.connected)
            except Exception as exc:  # noqa: BLE001
                dt = (time.time() - t0) * 1000
                code = getattr(exc, "code", type(exc).__name__)
                note("scan_FAIL", n=n, attempt=i, ms=round(dt, 1), code=code)
                t1 = time.time()
                back = server.wait_for_extension(timeout=60)
                note("reconnected", n=n, attempt=i, ok=back,
                     seconds=round(time.time() - t1, 1))
                if not back:
                    break
        sw = agent("/c/sw-info")
        note("sw_targets", n=n,
             count=len([t for t in (sw.get("swTargets") or [])
                        if "service-worker.js" in t.get("url", "")]))

    out = os.path.join(ROOT, "acceptance", "evidence-v2-independent",
                       "large-page-diagnostic.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(events, fh, ensure_ascii=False, indent=2)
    print("\nwrote " + out)

    fails = [e for e in events if e["kind"] == "scan_FAIL"]
    print(f"scan failures: {len(fails)} / {len([e for e in events if 'scan_' in e['kind']])}")
    server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
