"""Private stdio driver: connects as a client; never starts the bridge/server."""
import ast
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "controller"))
from pagesense import PageSenseClient

client = None
print(json.dumps({"ready": True}), flush=True)
try:
    for line in sys.stdin:
        command = json.loads(line)
        method, params = command["method"], command.get("params", {})
        try:
            if method == "stop":
                break
            if method == "connect":
                if client:
                    client.stop()
                client = PageSenseClient().start()
                result = {"connected": client.connected, "sessionId": client.server.session_id}
            elif method == "close":
                client.stop()
                client = None
                result = True
            elif method == "compile":
                ast.parse(params["source"])
                result = True
            elif method == "locator":
                target = client.locator(params["selector"])
                result = getattr(target, params["operation"])(**params.get("args", {}))
            elif method == "element":
                result = getattr(client.element(params["handle"]), params["operation"])(**params.get("args", {}))
            elif method in ("ping", "scan", "get_status", "search", "wait_for_export"):
                result = getattr(client, method)(**params)
            else:
                raise ValueError("unsupported test command")
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=True), flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "code": getattr(error, "code", ""), "message": str(error)}), flush=True)
finally:
    if client:
        client.stop()
