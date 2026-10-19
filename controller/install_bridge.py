"""Install the current user's Native Messaging host; no admin or browser profile changes."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys

from native_host import HOST_NAME

BROWSERS = {"edge": r"Software\Microsoft\Edge\NativeMessagingHosts",
            "chrome": r"Software\Google\Chrome\NativeMessagingHosts"}


def discover_extension_ids(extension_path):
    """Read only installed-extension metadata, never history, cookies or tokens."""
    base = Path(os.environ.get("LOCALAPPDATA", ""))
    wanted = os.path.normcase(str(Path(extension_path).resolve()))
    found = set()
    for root in (base / "Microsoft/Edge/User Data", base / "Google/Chrome/User Data"):
        for profile in [root / "Default", *root.glob("Profile *")]:
            for name in ("Secure Preferences", "Preferences"):
                try:
                    settings = json.loads((profile / name).read_text(encoding="utf-8")).get("extensions", {}).get("settings", {})
                    for extension_id, entry in settings.items():
                        installed = entry.get("path", "")
                        if installed and os.path.normcase(str(Path(installed).resolve())) == wanted:
                            found.add(extension_id)
                except (OSError, ValueError, TypeError):
                    continue
    return sorted(found)


def install(extension_ids, *, browsers=("edge", "chrome"), name=HOST_NAME, destination=None, runtime=None):
    if os.name != "nt":
        raise RuntimeError("当前安装器支持 Windows 的 Chrome / Edge。")
    import winreg
    if not re.fullmatch(r"com\.pagesense\.bridge(?:\.[a-z0-9_]+)?", name):
        raise ValueError("Native host name invalid")
    if not extension_ids or any(not re.fullmatch(r"[a-p]{32}", item) for item in extension_ids):
        raise ValueError("请提供已安装 PageSense 的 32 位扩展 ID。")
    destination = Path(destination) if destination else Path(os.environ["LOCALAPPDATA"]) / "PageSense/native-host"
    destination = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    manifest = destination / (name + ".json")
    config_file = destination / (name + ".config.json")
    launcher = destination / (name + ".cmd")
    origins = [f"chrome-extension://{item}/" for item in sorted(set(extension_ids))]
    source = Path(__file__).with_name("native_host.py").resolve()
    # cmd.exe expands percent signs even inside quotes. Reject rather than mislaunch.
    for value in (sys.executable, str(source), str(config_file)):
        if any(c in value for c in ('%', '"', '\r', '\n')):
            raise ValueError("安装路径包含不支持的命令字符。")
    launcher.write_text(f'@echo off\n@chcp 65001 >nul\n"{sys.executable}" -u "{source}" --config "{config_file}" %*\n', encoding="utf-8")
    config = {"allowed_origins": origins}
    if runtime:
        config["runtime_directory"] = str(Path(runtime).resolve())
    config_file.write_text(json.dumps(config), encoding="utf-8")
    manifest.write_text(json.dumps({"name": name, "description": "PageSense local browser bridge",
                                    "path": str(launcher.resolve()), "type": "stdio",
                                    "allowed_origins": origins}, indent=2), encoding="utf-8")
    for browser in browsers:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, BROWSERS[browser] + "\\" + name) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest.resolve()))
    return manifest


def main():
    parser = argparse.ArgumentParser(description="一次安装 PageSense 本地桥接；以后由浏览器自动启动。")
    parser.add_argument("--extension-id", action="append", default=[])
    parser.add_argument("--browser", choices=["edge", "chrome", "both"], default="both")
    parser.add_argument("--extension-path", default=str(Path(__file__).resolve().parents[1] / "pagesense"))
    parser.add_argument("--name", default=HOST_NAME, help=argparse.SUPPRESS)
    parser.add_argument("--destination", help=argparse.SUPPRESS)
    parser.add_argument("--runtime-directory", help=argparse.SUPPRESS)
    args = parser.parse_args()
    ids = args.extension_id or discover_extension_ids(args.extension_path)
    if not ids:
        parser.error("未找到此项目已安装扩展；从插件 Python 对接页复制包含扩展 ID 的安装命令。")
    manifest = install(ids, browsers=tuple(BROWSERS) if args.browser == "both" else (args.browser,),
                       name=args.name, destination=args.destination, runtime=args.runtime_directory)
    print("PageSense 本地桥接已注册。回到插件点击“重试自动连接”，以后无需手动启动服务。")
    print("注册文件：", manifest)


if __name__ == "__main__":
    main()
