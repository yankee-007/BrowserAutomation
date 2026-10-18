"""PageSense V2.0 - INDEPENDENT CLI acceptance against a real browser.

Drives the SHIPPED ``controller/server.py`` as a real subprocess with a piped
stdin/stdout (no REPL mocking), while the real PageSense extension is attached
via the browser agent. Every command's effect is verified against the live DOM.

Run:  python indep_cli.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CTRL = os.path.join(ROOT, "controller")
sys.path.insert(0, CTRL)

WS_PORT = int(os.environ.get("INDEP_WS_PORT", "8765"))
AGENT_PORT = int(os.environ.get("INDEP_AGENT_PORT", "8799"))
TOKEN = os.environ.get("INDEP_TOKEN", "TESTTOKEN12345678")

RESULTS: list[tuple[str, str, bool, str]] = []


def check(cid, name, cond, detail=""):
    RESULTS.append((cid, name, bool(cond), detail))
    print(f"{'PASS' if cond else 'FAIL'}  {cid} {name}" + ("" if cond else f"  -> {detail}"))
    return bool(cond)


def agent(path, **params):
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}{path}{qs}", timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"__error": f"{type(e).__name__}: {e}"}


def dom_value(element_id) -> object:
    """Live ``element.value`` for a PageSense elementId on the demo page.

    Reads the real DOM through the agent rather than the agent's generic state
    snapshot, whose field names are tailored to a different fixture page.
    """
    dom = agent("/c/dom-index") or {}
    entry = dom.get(str(element_id))
    return entry.get("value") if isinstance(entry, dict) else None


def free_port(port: int) -> None:
    """Kill whatever is listening on `port` so server.py can bind immediately.

    The extension retries with an exponential backoff (1/2/5/10/30 s), so a
    handoff that leaves the port free for a while pushes the reconnect out to
    the 30 s step. Freeing the port right before spawning keeps the gap short.
    """
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             timeout=20).stdout
    except Exception:  # noqa: BLE001
        return
    pids = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[3] == "LISTENING" \
                and parts[1].endswith(":" + str(port)):
            pids.add(parts[4])
    for pid in pids:
        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True)


class Cli:
    """Real server.py subprocess with piped stdin/stdout."""

    def __init__(self):
        free_port(WS_PORT)
        time.sleep(0.5)
        self.proc = subprocess.Popen(
            [sys.executable, "server.py", "--port", str(WS_PORT), "--token", TOKEN],
            cwd=CTRL, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
            bufsize=1,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        self.out: list[str] = []
        self.lock = threading.Lock()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            with self.lock:
                self.out.append(line.rstrip())

    def send(self, line: str, wait: float = 1.0) -> str:
        """Send one command line, wait, and return the output produced."""
        marker = len(self.snapshot())
        assert self.proc.stdin is not None
        try:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
        except Exception as e:  # noqa: BLE001
            return f"__WRITE_FAILED__ {e}"
        time.sleep(wait)
        return "\n".join(self.snapshot()[marker:])

    def snapshot(self) -> list[str]:
        with self.lock:
            return list(self.out)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def close(self):
        try:
            if self.proc.stdin:
                self.proc.stdin.write("quit\n")
                self.proc.stdin.flush()
            self.proc.wait(timeout=6)
        except Exception:  # noqa: BLE001
            self.proc.kill()


def main() -> int:
    print("=== PageSense V2.0 INDEPENDENT CLI acceptance ===")
    agent("/c/demo")
    time.sleep(0.5)

    cli = Cli()
    try:
        # Wait for the extension to attach to this Controller instance. The
        # extension backs off up to 30 s between attempts, so allow for that.
        deadline = time.time() + 90
        connected = False
        t0 = time.time()
        while time.time() < deadline:
            if "PageSense connected" in "\n".join(cli.snapshot()):
                connected = True
                break
            # Sending a character forces the REPL's input() to flush stdout,
            # so buffered server output becomes visible to this reader.
            try:
                cli.proc.stdin.write("\n")
                cli.proc.stdin.flush()
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.5)
        print(f"    (connect wait: {time.time() - t0:.1f}s)")
        check("CLI-01", "server.py 打印监听信息与 token",
              "PageSense Controller" in "\n".join(cli.snapshot())
              and "Listening:" in "\n".join(cli.snapshot()), "")
        check("CLI-02", "扩展自动连上 server.py（真实 CLI 会话）", connected,
              "\n".join(cli.snapshot()[-6:]))
        if not connected:
            return 1

        out = cli.send("status", 1.5)
        check("CLI-03", "status 命令返回连接状态与活动标签页",
              "connected=True" in out and "127.0.0.1" in out, out[:200])

        out = cli.send("ping", 1.0)
        check("CLI-04", "ping 命令返回 PONG", "PONG" in out and "pong" in out, out[:160])

        out = cli.send("scan", 2.0)
        check("CLI-05", "scan 命令返回元素数量", "elements" in out, out[:160])

        out = cli.send("search 立即沟通", 2.0)
        check("CLI-06", "search 支持中文查询并显示结果", "results" in out and "立即沟通" in out,
              out[:300])
        check("CLI-07", "search 输出包含 elementId / score / matched",
              "#" in out and "score=" in out and "matched=" in out, out[:300])

        # Resolve real elementIds from the live DOM mapping.
        dom = agent("/c/dom-index") or {}
        by_dom = {v.get("domId"): int(k) for k, v in dom.items() if v.get("domId")}
        input_id = by_dom.get("actionInput")
        click_id = by_dom.get("clickTestBtn")
        check("CLI-08", "通过真实 DOM 映射取得 actionInput/clickTestBtn 的 elementId",
              isinstance(input_id, int) and isinstance(click_id, int),
              f"input={input_id} click={click_id}")

        out = cli.send(f"input {input_id} AI应用工程师", 1.5)
        time.sleep(0.3)
        value = dom_value(input_id)
        check("CLI-09", "input 命令真实写入 DOM",
              "SUCCESS" in out and value == "AI应用工程师",
              f"out={out[:120]!r} dom.value={value!r}")

        out = cli.send(f'input {input_id} "AI 应用 工程师"', 1.5)
        time.sleep(0.3)
        value = dom_value(input_id)
        check("CLI-10", "input 支持带空格的字符串（引号形式）",
              value == "AI 应用 工程师", f"dom.value={value!r} out={out[:120]!r}")

        out = cli.send(f"input {input_id} AI 应用 工程师", 1.5)
        time.sleep(0.3)
        value = dom_value(input_id)
        check("CLI-11", "input 支持带空格的字符串（无引号形式）",
              value == "AI 应用 工程师", f"dom.value={value!r} out={out[:120]!r}")

        out = cli.send(f"clear {input_id}", 1.5)
        time.sleep(0.3)
        value = dom_value(input_id)
        check("CLI-12", "clear 命令清空真实 DOM 值", value == "", f"dom.value={value!r}")

        before = int((agent("/c/state") or {}).get("clickCount") or 0)
        out = cli.send(f"click {click_id}", 1.5)
        time.sleep(0.3)
        after = int((agent("/c/state") or {}).get("clickCount") or 0)
        check("CLI-13", "click 命令使真实计数器 +1", after == before + 1,
              f"{before} -> {after} out={out[:120]!r}")

        out = cli.send(f"highlight {click_id}", 1.5)
        time.sleep(0.6)
        overlays = (agent("/c/state") or {}).get("overlayCount")
        check("CLI-14", "highlight 命令产生真实 overlay",
              overlays == 1 and "SUCCESS" in out, f"overlays={overlays}")

        out = cli.send("clear-hl", 1.2)
        time.sleep(0.4)
        overlays = (agent("/c/state") or {}).get("overlayCount")
        check("CLI-15", "clear-hl 命令移除 overlay", overlays == 0, f"overlays={overlays}")

        out = cli.send(f"locate {click_id}", 1.2)
        check("CLI-16", "locate 命令成功", "SUCCESS" in out, out[:120])

        out = cli.send(f"keypress {input_id} Enter", 1.2)
        check("CLI-17", "keypress 命令成功", "SUCCESS" in out, out[:140])

        out = cli.send("scroll down 500", 1.5)
        time.sleep(0.4)
        y = (agent("/c/state") or {}).get("scrollY")
        check("CLI-18", "scroll 命令真实改变页面滚动位置", isinstance(y, int) and y > 0,
              f"scrollY={y} out={out[:120]!r}")

        out = cli.send("scroll up 500", 1.2)
        check("CLI-19", "scroll up 命令成功", "SUCCESS" in out, out[:140])

        out = cli.send("help", 1.0)
        check("CLI-20", "help 命令显示命令列表", "scan" in out and "highlight" in out, out[:160])

        # ---- error handling: the CLI must never exit ---------------------
        print("\n-- CLI 错误输入 --")
        errors = [
            ("click abc", "非数字 elementId"),
            ("click -1", "负数 elementId"),
            ("click 999999", "不存在的 elementId"),
            ("click 0", "elementId=0"),
            ("input", "缺少参数"),
            ("input abc hello", "elementId 非数字"),
            ("input 999999 hello", "不存在的元素"),
            ("scroll xxx 500", "非法方向"),
            ("scroll down abc", "非法 amount"),
            ("scroll down -5", "负数 amount"),
            ("scroll", "缺少参数"),
            ("highlight xxx", "非法 elementId"),
            ("highlight 999999", "不存在元素"),
            ("locate 999999", "不存在元素"),
            ("search", "缺少查询"),
            ("keypress 1 FakeKey", "非法按键"),
            ("clear 999999", "不存在元素"),
            ("unknown_command", "未知命令"),
            ("!!!", "无意义输入"),
        ]
        all_alive = True
        for line, desc in errors:
            out = cli.send(line, 0.8)
            if not cli.alive():
                all_alive = False
                check(f"CLI-ERR-{line}", f"{desc}: CLI 不应退出", False, "进程已退出")
                break
            has_feedback = bool(out.strip())
            check(f"CLI-ERR-{line}", f"{desc} -> 有可读反馈且不退出", has_alive_feedback(out),
                  f"alive={cli.alive()} out={out[:140]!r}")
        check("CLI-21", "全部 19 个错误输入之后 CLI 进程仍然存活", all_alive and cli.alive())

        out = cli.send("scan", 2.0)
        check("CLI-22", "错误输入之后 CLI 仍可正常执行 scan", "elements" in out, out[:160])

        # ---- quit --------------------------------------------------------
        cli.send("quit", 1.0)
        time.sleep(0.8)
        check("CLI-23", "quit 命令退出 REPL", not cli.alive(),
              f"alive={cli.alive()}")
    finally:
        cli.close()

    fails = [r for r in RESULTS if not r[2]]
    print(f"\nINDEP CLI SUMMARY: {len(RESULTS) - len(fails)} PASS / {len(fails)} FAIL "
          f"({len(RESULTS)} total)")
    if fails:
        print("FAILED: " + ", ".join(f[0] for f in fails))
    return 1 if fails else 0


def has_alive_feedback(out: str) -> bool:
    if not out.strip():
        return False
    # A bare prompt echo is not feedback; an error/usage/success line is.
    indicators = ("ERROR", "用法", "未知命令", "SUCCESS", "参数错误", "命令解析失败")
    return any(i in out for i in indicators)


if __name__ == "__main__":
    sys.exit(main())
