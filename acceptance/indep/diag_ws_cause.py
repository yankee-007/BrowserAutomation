"""Diagnostic: which side closes the WebSocket on a large scan?

Instruments the Controller (frame log + exception tracing on _on_frame and
_handler) and the extension's reported lastError, so the close can be
attributed rather than guessed.

Run:  python diag_ws_cause.py
"""

from __future__ import annotations

import asyncio
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
    if len(EVENTS) < 500:
        print("  " + json.dumps(rec, ensure_ascii=False)[:300])


def main() -> int:
    server = ControllerServer(host="127.0.0.1", port=WS_PORT, token=TOKEN,
                              request_timeout=20.0)

    # ---- instrument BEFORE start() so serve() picks up the traced handler ----
    orig_on_frame = server._on_frame
    orig_handler = server._handler

    async def traced_on_frame(frame):
        head = str(frame)[:60] if not isinstance(frame, str) or len(frame) < 60 else str(frame)[:60]
        try:
            msg = json.loads(frame)
            kind = msg.get("type") if isinstance(msg, dict) else type(msg).__name__
        except Exception:
            kind = "UNPARSEABLE"
        note("frame_in", kind=kind, head=head)
        try:
            return await orig_on_frame(frame)
        except Exception as exc:  # noqa: BLE001
            note("on_frame_EXC", exc_type=type(exc).__name__, msg=str(exc)[:200])
            raise

    async def traced_handler(ws):
        note("handler_enter")
        try:
            return await orig_handler(ws)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            note("handler_EXC", exc_type=type(exc).__name__, msg=str(exc)[:300])
            raise
        finally:
            note("handler_exit", connected=server.connected)

    server._on_frame = traced_on_frame
    server._handler = traced_handler
    server.on_state_change = lambda c, v=None: note("controller_state", connected=c, version=v)

    server.start()
    client = PageSenseClient.from_server(server)
    print("waiting for extension:", server.wait_for_extension(timeout=60))

    for label, qs in [("1000 (control)", "n=1000"), ("3000 (fails)", "n=3000"),
                      ("3000 again", "n=3000")]:
        print(f"\n=== {label} ===")
        EVENTS.append({"t": round(time.time(), 2), "kind": "MARK", "label": label})
        agent("/c/activate", url=f"http://127.0.0.1:{AGENT_PORT}/f/perf?{qs}", setDemo=1)
        time.sleep(1.0)
        t0 = time.time()
        try:
            s = client.scan()
            note("scan_ok", label=label, ms=round((time.time() - t0) * 1000, 1),
                 total=s["stats"]["total"])
        except Exception as exc:  # noqa: BLE001
            note("scan_FAIL", label=label, ms=round((time.time() - t0) * 1000, 1),
                 code=getattr(exc, "code", type(exc).__name__))
            back = server.wait_for_extension(timeout=60)
            b = agent("/c/bridge") or {}
            note("after_fail", label=label, recovered=back, ext_state=b.get("state"),
                 ext_last_error=json.dumps(b.get("lastError"), ensure_ascii=False))
            note("ext_log", label=label,
                 entries=json.dumps((b.get("recentRequests") or [])[-4:], ensure_ascii=False))
            cons = agent("/c/console") or {}
            note("ext_console", label=label,
                 items=json.dumps([c for c in (cons.get("items") or [])
                                   if c.get("kind") in ("uncaught", "console.error")][-5:],
                                  ensure_ascii=False)[:600])
        time.sleep(0.5)

    out = os.path.join(ROOT, "acceptance", "evidence-v2-independent",
                       "ws-drop-cause.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(EVENTS, fh, ensure_ascii=False, indent=2)
    print("\nwrote " + out)
    server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
