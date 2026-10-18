"""Diagnostic: is the SCAN failure driven by element COUNT or the PAYLOAD SIZE?

Holds the element count fixed at a value that is known to succeed (1500) and
grows only the serialized size by padding each element's text. If a
1500-element page starts failing once it is big enough, the driver is payload
size; if 1500 elements always succeed, the driver is the element count.

Run:  python diag_size_vs_count.py
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
    print("  " + json.dumps(rec, ensure_ascii=False)[:280])


def main() -> int:
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                              request_timeout=20.0)
    server.start()
    client = PageSenseClient.from_server(server)
    print("waiting for extension:", server.wait_for_extension(timeout=60))

    # Fixed count (1500, known-good), growing payload via text padding.
    for pad in (0, 50, 100, 200, 300):
        agent("/c/activate",
              url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?n=1500&pad={pad}", setDemo=1)
        time.sleep(1.0)
        t0 = time.time()
        try:
            s = client.scan()
            note("scan", n=1500, pad=pad, ok=True,
                 ms=round((time.time() - t0) * 1000, 1),
                 payload_bytes=len(json.dumps(s, ensure_ascii=False).encode("utf-8")))
        except Exception as exc:  # noqa: BLE001
            note("scan", n=1500, pad=pad, ok=False,
                 ms=round((time.time() - t0) * 1000, 1),
                 code=getattr(exc, "code", type(exc).__name__))
            server.wait_for_extension(timeout=30)
        time.sleep(0.4)

    # Fixed payload pressure, varying count around the earlier boundary.
    for n in (2500, 2550, 2600):
        agent("/c/activate", url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?n={n}", setDemo=1)
        time.sleep(1.0)
        t0 = time.time()
        try:
            s = client.scan()
            note("scan", n=n, pad=0, ok=True,
                 ms=round((time.time() - t0) * 1000, 1),
                 payload_bytes=len(json.dumps(s, ensure_ascii=False).encode("utf-8")))
        except Exception as exc:  # noqa: BLE001
            note("scan", n=n, pad=0, ok=False,
                 ms=round((time.time() - t0) * 1000, 1),
                 code=getattr(exc, "code", type(exc).__name__))
            server.wait_for_extension(timeout=30)
        time.sleep(0.4)

    out = os.path.join(ROOT, "acceptance", "evidence-v2-independent",
                       "size-vs-count.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(EVENTS, fh, ensure_ascii=False, indent=2)
    print("\nwrote " + out)
    server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
