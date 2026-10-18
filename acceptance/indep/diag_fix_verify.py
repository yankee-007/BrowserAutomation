"""Verify BUG-003 fix: large SCAN results must survive the bridge.

Logs the ACTUAL inbound frame size (UTF-8 bytes) of every RESPONSE the
extension sends, so the measured byte figure in the report is the real wire
size rather than a re-serialization estimate.

Run:  python diag_fix_verify.py
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

import protocol as P  # noqa: E402
from pagesense import PageSenseClient  # noqa: E402
import server as server_mod  # noqa: E402
from server import ControllerServer  # noqa: E402

WS_PORT = int(os.environ.get("INDEP_WS_PORT", "8765"))
AGENT_PORT = int(os.environ.get("INDEP_AGENT_PORT", "8799"))
TOKEN = os.environ.get("INDEP_TOKEN", "TESTTOKEN12345678")

EVENTS: list[dict] = []
FRAME_SIZES: list[dict] = []


def agent(path: str, **params):
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}{path}{qs}", timeout=180) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"__error": f"{type(e).__name__}: {e}"}


def note(event, **kw):
    rec = {"t": round(time.time(), 2), "event": event, **kw}
    EVENTS.append(rec)
    print("  " + json.dumps(rec, ensure_ascii=False)[:260])


def main() -> int:
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                              request_timeout=30.0)

    orig_on_frame = server._on_frame

    async def traced(frame):
        if isinstance(frame, str):
            size = len(frame.encode("utf-8"))
            if size > 100_000:
                FRAME_SIZES.append({"bytes": size, "head": frame[:60]})
        return await orig_on_frame(frame)

    server._on_frame = traced
    server.start()
    client = PageSenseClient.from_server(server)
    print("waiting for extension:", server.wait_for_extension(timeout=60))
    print("server max_size =", server_mod.MAX_MESSAGE_SIZE)

    cases = [
        ("1000", "n=1000"),
        ("1500 pad100 (was FAIL)", "n=1500&pad=100"),
        ("2560 (was OK)", "n=2560"),
        ("2600 (was FAIL)", "n=2600"),
        ("3000 (was FAIL)", "n=3000"),
        ("5000 (was FAIL)", "n=5000"),
    ]
    for label, qs in cases:
        agent("/c/activate", url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?{qs}", setDemo=1)
        time.sleep(1.0)
        before = len(FRAME_SIZES)
        t0 = time.time()
        try:
            s = client.scan()
            wire = FRAME_SIZES[before]["bytes"] if len(FRAME_SIZES) > before else None
            note("scan", label=label, ok=True, ms=round((time.time() - t0) * 1000, 1),
                 total=s["stats"]["total"], wire_frame_bytes=wire)
        except Exception as exc:  # noqa: BLE001
            note("scan", label=label, ok=False, ms=round((time.time() - t0) * 1000, 1),
                 code=getattr(exc, "code", type(exc).__name__))
            server.wait_for_extension(timeout=30)
        time.sleep(0.4)

    out = os.path.join(ROOT, "acceptance", "evidence-v2-independent",
                       "bug003-fix-verify.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"events": EVENTS, "largeFrames": FRAME_SIZES},
                  fh, ensure_ascii=False, indent=2)
    print("\nwrote " + out)
    print("large frames seen: " + json.dumps(FRAME_SIZES, ensure_ascii=False))
    server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
