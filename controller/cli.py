"""PageSense Controller - interactive CLI.

Deliberately dumb: every command is typed by a human and maps 1:1 onto one
protocol method. There is no natural language parsing, no LLM, no planner and
no automatic follow-up action - in particular there is no ``click "text"``
shortcut, because that would silently pick a target the user never confirmed.
The flow is always::

    search <query>   -> the human reads the results
    click <elementId>  -> the human names the exact element to act on
"""

from __future__ import annotations

import shlex

import protocol as P
from pagesense import PageSenseClient
from server import ControllerServer

PROMPT = "> "

HELP_TEXT = """\
PageSense Controller CLI

  scan                      扫描当前活动页面
  search <query>            在最近一次扫描结果中搜索元素
  locate <elementId>        滚动到元素
  highlight <elementId>     高亮元素
  clear-hl                  取消高亮
  click <elementId>         点击元素
  input <elementId> <value> 输入文本
  clear <elementId>         清空输入
  keypress <elementId> <key> 发送按键（Enter/Escape/Tab/ArrowDown/...）
  scroll <up|down|left|right> [amount]
  status                    连接与活动页面状态
  ping                      连通性检查
  help                      显示本帮助
  quit                      退出

不提供 search-and-click：请先 search，再由你本人指定 elementId 执行动作。
"""


def _print_error(err: P.PageSenseError) -> None:
    print(f"ERROR {err.code}: {err.message}")


def _print_search(result: dict) -> None:
    results = result.get("results", [])
    print(f"{result.get('total', 0)} results\n")
    if not results:
        return
    for item in results:
        element = item.get("element", {}) or {}
        tag = str(element.get("tag") or "?").upper()
        text = element.get("text") or "(无文本)"
        matched = ",".join(item.get("matchedFields") or []) or "-"
        print(f"#{item.get('elementId')} {tag}")
        print(text)
        print(f"score={item.get('score')}")
        print(f"matched={matched}")
        print()
    if result.get("truncated"):
        print(f"(仅显示前 {result.get('limit')} 条，共 {result.get('total')} 条)")


def _describe(result: dict) -> str:
    if result.get("moved") is False:
        return "SUCCESS (already at boundary)"
    if result.get("value") is not None and "value" in result:
        return f'SUCCESS (value="{result.get("value")}")'
    if result.get("key"):
        return f"SUCCESS (key={result.get('key')})"
    if result.get("elementId") is not None:
        return f"SUCCESS (#{result.get('elementId')})"
    return "SUCCESS"


def execute(client, line: str, require_extension) -> bool:
    """Run one command line. Returns False to leave the REPL."""
    try:
        parts = shlex.split(line)
    except ValueError as exc:
        print(f"命令解析失败：{exc}")
        return True

    if not parts:
        return True

    command = parts[0].lower()
    args = parts[1:]

    if command in ("quit", "exit", "q"):
        return False

    if command in ("help", "?", "h"):
        print(HELP_TEXT)
        return True

    def need(count: int, usage: str) -> bool:
        if len(args) < count:
            print(f"用法：{usage}")
            return False
        return True

    if command not in ("ping", "status") and not require_extension():
        print("PageSense Extension 未连接，请先在 Popup 中点击「连接 Controller」。")
        return True

    try:
        if command == "ping":
            print(f"PONG {client.ping()}")

        elif command == "status":
            status = client.get_status()
            print(f"connected={status.get('connected')} "
                  f"version={status.get('version')} "
                  f"endpoint={client.endpoint}")
            active = status.get("activeTab")
            if active:
                print(f"active tab #{active.get('tabId')} {active.get('url')}")
            else:
                print(f"no active tab ({status.get('activeTabError', 'n/a')})")

        elif command == "scan":
            state = client.scan()
            print(f"{state.get('stats', {}).get('total', 0)} elements")

        elif command == "search":
            if not need(1, "search <query>"):
                return True
            _print_search(client.search(" ".join(args)))

        elif command == "locate":
            if not need(1, "locate <elementId>"):
                return True
            print(_describe(client.locate(int(args[0]))))

        elif command == "highlight":
            if not need(1, "highlight <elementId>"):
                return True
            print(_describe(client.highlight(int(args[0]))))

        elif command in ("clear-hl", "clear_highlight"):
            print(_describe(client.clear_highlight()))

        elif command == "click":
            if not need(1, "click <elementId>"):
                return True
            print(_describe(client.click(int(args[0]))))

        elif command == "input":
            if not need(2, "input <elementId> <value>"):
                return True
            print(_describe(client.input(int(args[0]), " ".join(args[1:]))))

        elif command == "clear":
            if not need(1, "clear <elementId>"):
                return True
            print(_describe(client.clear(int(args[0]))))

        elif command == "keypress":
            if not need(2, "keypress <elementId> <key>"):
                return True
            print(_describe(client.keypress(int(args[0]), args[1])))

        elif command == "scroll":
            if not need(1, "scroll <up|down|left|right> [amount]"):
                return True
            amount = int(args[1]) if len(args) > 1 else 500
            print(_describe(client.scroll(args[0], amount)))

        else:
            print(f"未知命令：{command}（输入 help 查看可用命令）")

    except ValueError as exc:
        print(f"参数错误：{exc}")
    except P.PageSenseError as exc:
        _print_error(exc)

    return True


def run_repl(server: ControllerServer) -> None:
    """Read commands from stdin until EOF / quit. No LLM, no automation."""
    # Reuse the already-running server instead of starting a second one.
    client = PageSenseClient.from_server(server)

    def require_extension() -> bool:
        if server.connected:
            return True
        # Give a freshly started Controller a moment to handshake.
        return server.wait_for_extension(timeout=0.1)

    print("\n输入 help 查看命令。\n")
    running = True
    while running:
        try:
            line = input(PROMPT)
        except EOFError:
            break
        except KeyboardInterrupt:
            print()
            break
        running = execute(client, line, require_extension)

    print("Bye.")


def main(argv: list[str] | None = None) -> int:
    """Standalone entry point: starts a Controller and drops into the CLI."""
    import server as server_module

    args = server_module.build_parser().parse_args(argv)
    args.no_cli = False
    return server_module.main(argv)


if __name__ == "__main__":
    # ``python cli.py`` behaves exactly like ``python server.py``.
    raise SystemExit(main())
