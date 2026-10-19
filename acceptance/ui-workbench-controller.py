"""Synthetic browser acceptance driver. Tokens travel only through private stdio."""
import ast
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "controller"))
from pagesense import PageSenseClient

with PageSenseClient(mode="server", port=0) as client:
    print(json.dumps({"port": client.server.port, "token": client.token}), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        method, params = command["method"], command.get("params", {})
        if method == "stop":
            break
        try:
            if method == "compile":
                ast.parse(params["source"])
                result = True
            elif method in ("locator", "element"):
                target = client.locator(params["selector"]) if method == "locator" else client.element(params["handle"])
                action = params["operation"]
                if action not in ("inspect", "text", "click", "input", "clear", "keypress", "locate", "highlight"):
                    raise ValueError("unsupported test action")
                result = getattr(target, action)(**params.get("args", {}))
            elif method in ("scan", "search", "inspect", "click", "wait_for_export"):
                result = getattr(client, method)(**params)
            else:
                raise ValueError("unsupported test method")
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=True), flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "code": getattr(error, "code", ""), "message": str(error)}), flush=True)
