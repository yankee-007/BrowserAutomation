"""Private stdio driver for the browser acceptance's real local Controller."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "controller"))
from pagesense import PageSenseClient

with PageSenseClient(port=0) as client:
    # Consumed in memory by the browser harness; never written to evidence.
    print(json.dumps({"port": client.server.port, "token": client.token}), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        if command["method"] == "stop":
            break
        try:
            result = getattr(client, command["method"])(**command.get("params", {}))
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=True), flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "code": getattr(error, "code", ""),
                              "message": str(error)}, ensure_ascii=True), flush=True)
