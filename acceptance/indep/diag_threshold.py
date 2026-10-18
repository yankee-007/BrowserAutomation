"""Diagnostic: exact threshold, and scan-vs-page isolation.

1. On a page with 3000 elements, issue only PING/GET_STATUS (no scan) to see
   whether the mere presence of a large page breaks the socket.
2. Bisect the element count at which SCAN starts dropping the WebSocket.

Run:  python diag_threshold.py
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


def note(event, **kw):
    rec = {"t": round(time.time(), 2), "event": event, **kw}
    EVENTS.append(rec)
    print("  " + json.dumps(rec, ensure_ascii=False)[:260])


def load(n: int):
    agent("/c/activate", url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?n={n}", setDemo=1)
    time.sleep(1.0)


def main() -> int:
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                              request_timeout=20.0)
    server.start()
    client = PageSenseClient.from_server(server)
    print("waiting for extension:", server.wait_for_extension(timeout=60))

    # ---- 1. no-scan control on a large page -----------------------------
    print("\n=== 3000-element page, PING only (no SCAN) ===")
    load(3000)
    ok = 0
    for i in range(10):
        try:
            client.ping()
            ok += 1
        except Exception as exc:  # noqa: BLE001
            note("ping_FAIL", i=i, code=getattr(exc, "code", type(exc).__name__))
            server.wait_for_extension(timeout=30)
    note("ping_only", ok=ok, of=10,
         note="仅 PING 不发 SCAN 时连接是否稳定")

    # ---- 2. bisect ------------------------------------------------------
    print("\n=== threshold bisect ===")
    results = []
    for n in (2000, 2400, 2600, 2800, 2900, 3000, 3200, 4000):
        load(n)
        t0 = time.time()
        try:
            s = client.scan()
            res = {"n": n, "ok": True, "ms": round((time.time() - t0) * 1000, 1),
                   "total": s["stats"]["total"]}
        except Exception as exc:  # noqa: BLE001
            res = {"n": n, "ok": False, "ms": round((time.time() - t0) * 1000, 1),
                   "code": getattr(exc, "code", type(exc).__name__)}
            server.wait_for_extension(timeout=30)
        results.append(res)
        note("scan", **res)
        time.sleep(0.4)

    out = os.path.join(ROOT, "acceptance", "evidence-v2-independent",
                       "scan-threshold.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"events": EVENTS, "bisect": results}, fh, ensure_ascii=False, indent=2)
    print("\nwrote " + out)
    lowest_fail = min([r["n"] for r in results if not r["ok"]], default=None)
    highest_ok = max([r["n"] for r in results if r["ok"]], default=None)
    print(f"highest OK = {highest_ok}, lowest FAIL = {lowest_fail}")
    server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
