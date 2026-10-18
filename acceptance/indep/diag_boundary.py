"""Diagnostic: locate the SCAN failure boundary in bytes.

Sweeps the text padding at a fixed element count (1500) and the element count
at zero padding, so both boundaries can be expressed in the same unit
(serialized payload bytes) and compared.

Run:  python diag_boundary.py
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

ROWS: list[dict] = []
# Bytes per extra padded character, measured from the pad=0 / pad=50 pair.
BYTES_PER_PAD_CHAR = (912237 - 689893) / (50 * 1500)


def agent(path: str, **params):
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}{path}{qs}", timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"__error": f"{type(e).__name__}: {e}"}


def attempt(n: int, pad: int, base_bytes: dict):
    agent("/c/activate",
          url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?n={n}&pad={pad}", setDemo=1)
    time.sleep(1.0)
    t0 = time.time()
    try:
        s = client_ref[0].scan()
        nb = len(json.dumps(s, ensure_ascii=False).encode("utf-8"))
        base_bytes[(n, pad)] = nb
        row = {"n": n, "pad": pad, "ok": True, "bytes": nb,
               "ms": round((time.time() - t0) * 1000, 1)}
    except Exception as exc:  # noqa: BLE001
        # Payload size cannot be measured on a failed scan; estimate it from a
        # measured smaller configuration of the same shape.
        est = None
        ref = base_bytes.get((n, 0))
        if ref is not None:
            est = int(ref + pad * n * BYTES_PER_PAD_CHAR)
        row = {"n": n, "pad": pad, "ok": False, "bytes_est": est,
               "ms": round((time.time() - t0) * 1000, 1),
               "code": getattr(exc, "code", type(exc).__name__)}
        client_ref[0].server.wait_for_extension(timeout=30)
    ROWS.append(row)
    print("  " + json.dumps(row, ensure_ascii=False))
    time.sleep(0.4)


client_ref: list = []


def main() -> int:
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                              request_timeout=20.0)
    server.start()
    client_ref.append(PageSenseClient.from_server(server))
    print("waiting for extension:", server.wait_for_extension(timeout=60))

    base: dict = {}
    print("\n=== pad sweep at n=1500 ===")
    for pad in (0, 50, 70, 80, 90, 100):
        attempt(1500, pad, base)

    print("\n=== count sweep at pad=0 ===")
    for n in (2500, 2550, 2560, 2570, 2580, 2600):
        attempt(n, 0, base)

    out = os.path.join(ROOT, "acceptance", "evidence-v2-independent",
                       "scan-boundary.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"rows": ROWS, "bytesPerPadChar": BYTES_PER_PAD_CHAR},
                  fh, ensure_ascii=False, indent=2)
    print("\nwrote " + out)
    server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
