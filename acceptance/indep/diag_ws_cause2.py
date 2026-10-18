"""Diagnostic: attribute the WebSocket close on a large scan.

Captures, per attempt:
  * the close code/reason the Controller observes (1000 = clean close by a
    peer, 1006 = abnormal/lost, 1011 = server error, 1001 = going away)
  * the extension's OWN state sampled every 100 ms across the drop, which
    distinguishes "the extension deliberately closed" (DISCONNECTED) from "the
    socket was lost" (ERROR)
  * whether the Service Worker restarted (its in-memory request log would
    reset, and it would get a new CDP target id)

Run:  python diag_ws_cause2.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
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
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}{path}{qs}", timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"__error": f"{type(e).__name__}: {e}"}


def note(event, **kw):
    rec = {"t": round(time.time(), 2), "event": event, **kw}
    EVENTS.append(rec)
    print("  " + json.dumps(rec, ensure_ascii=False)[:300])


def poll_extension(stop: threading.Event, out: list):
    """Sample the extension's own bridge state at 100 ms across the drop."""
    while not stop.is_set():
        b = agent("/c/bridge")
        out.append({"t": round(time.time(), 3), "state": b.get("state"),
                    "lastError": b.get("lastError"),
                    "logLen": len(b.get("recentRequests") or []),
                    "since": b.get("connectedSince")})
        time.sleep(0.1)


def main() -> int:
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                              request_timeout=20.0)

    closes: list[dict] = []
    orig_handler = server._handler

    async def traced_handler(ws):
        try:
            return await orig_handler(ws)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            note("handler_EXC", exc_type=type(exc).__name__, msg=str(exc)[:300])
            raise
        finally:
            closes.append({
                "t": round(time.time(), 3),
                "close_code": getattr(ws, "close_code", None),
                "close_reason": getattr(ws, "close_reason", None),
                "connected_after": server.connected,
            })
            note("handler_exit", close_code=getattr(ws, "close_code", None),
                 close_reason=getattr(ws, "close_reason", None))

    server._handler = traced_handler
    server.start()
    client = PageSenseClient.from_server(server)
    print("waiting for extension:", server.wait_for_extension(timeout=60))

    for label, qs in [("1000 control", "n=1000"), ("3000", "n=3000")]:
        print(f"\n=== {label} ===")
        note("MARK", label=label)
        agent("/c/activate", url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?{qs}", setDemo=1)
        time.sleep(1.0)

        samples: list[dict] = []
        stop = threading.Event()
        th = threading.Thread(target=poll_extension, args=(stop, samples), daemon=True)
        th.start()
        time.sleep(0.4)

        t0 = time.time()
        try:
            s = client.scan()
            note("scan_ok", label=label, ms=round((time.time() - t0) * 1000, 1),
                 total=s["stats"]["total"])
        except Exception as exc:  # noqa: BLE001
            note("scan_FAIL", label=label, ms=round((time.time() - t0) * 1000, 1),
                 code=getattr(exc, "code", type(exc).__name__))
        time.sleep(3.0)
        stop.set()
        th.join(timeout=3)

        # Compress: only transitions of state / lastError / logLen.
        transitions = []
        prev = None
        for smp in samples:
            key = (smp["state"], json.dumps(smp["lastError"], ensure_ascii=False), smp["logLen"])
            if key != prev:
                transitions.append(smp)
                prev = key
        note("extension_timeline", label=label, n_samples=len(samples),
             transitions=json.dumps(transitions, ensure_ascii=False)[:900])
        note("controller_closes", label=label,
             closes=json.dumps(closes[-3:], ensure_ascii=False))
        sw = agent("/c/sw-info") or {}
        note("sw", label=label, targets=json.dumps(
            [t for t in (sw.get("swTargets") or [])
             if "service-worker.js" in t.get("url", "")], ensure_ascii=False))

    out = os.path.join(ROOT, "acceptance", "evidence-v2-independent",
                       "ws-drop-cause2.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"events": EVENTS, "closes": closes}, fh, ensure_ascii=False, indent=2)
    print("\nwrote " + out)
    server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
