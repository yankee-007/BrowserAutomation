"""PageSense Controller - high level client API.

Default client for the browser-owned native bridge; mode="server" retains the
legacy ControllerServer transport. The
API deliberately names nothing about any particular website: it is a generic
browser runtime surface that a future agent layer can drive.
"""

from __future__ import annotations

from typing import Any

import protocol as P
from server import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_REQUEST_TIMEOUT,
    ControllerServer,
)


class PageSenseClient:
    """High level, synchronous PageSense API.

    Example::

        client = PageSenseClient().start()
        state = client.scan()
        results = client.search("搜索职位")
        client.input(results["results"][0]["elementId"], "AI应用工程师")
    """

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        token: str | None = None,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
        *, mode: str = "native", runtime_dir=None, extension_id=None, session_id=None,
    ):
        if mode == "native":
            if token is not None or port != DEFAULT_PORT or host != DEFAULT_HOST:
                raise ValueError("默认自动连接无需 host/port/token；旧脚本请显式设置 mode='server'。")
            from native_client import NativeClientTransport
            self.server = NativeClientTransport(request_timeout, directory=runtime_dir,
                                                extension_id=extension_id, session_id=session_id)
        elif mode == "server":
            self.server = ControllerServer(host=host, port=port, token=token, request_timeout=request_timeout)
        else:
            raise ValueError("mode 必须为 native 或 server。")
        self.request_timeout = request_timeout

    @classmethod
    def from_server(cls, server: ControllerServer) -> "PageSenseClient":
        """Wrap an already-running server (used by the CLI entry point)."""
        client = cls.__new__(cls)
        client.server = server
        client.request_timeout = server.request_timeout
        return client

    # ---- lifecycle -----------------------------------------------------

    def start(self) -> "PageSenseClient":
        self.server.start()
        return self

    def stop(self) -> None:
        self.server.stop()

    def __enter__(self) -> "PageSenseClient":
        return self.start()

    def __exit__(self, *_exc) -> None:
        self.stop()

    @property
    def token(self) -> str:
        return self.server.token

    @property
    def endpoint(self) -> str:
        return self.server.endpoint

    @property
    def connected(self) -> bool:
        return self.server.connected

    def wait_for_extension(self, timeout: float | None = None) -> bool:
        return self.server.wait_for_extension(timeout)

    # ---- raw call ------------------------------------------------------

    def call(self, method: str, timeout: float | None = None, **params) -> Any:
        """Send any protocol method. Raises :class:`protocol.PageSenseError`."""
        cleaned = {k: v for k, v in params.items() if v is not None}
        return self.server.request_sync(method, cleaned, timeout)

    # ---- methods (PS.METHODS) ------------------------------------------

    def ping(self, timeout: float | None = None) -> dict:
        return self.call("PING", timeout=timeout)

    def get_status(self, timeout: float | None = None) -> dict:
        return self.call("GET_STATUS", timeout=timeout)

    def scan(self, timeout: float | None = None, *, scope: str | None = None) -> dict:
        """Scan the active tab. Returns page/stats/elements plus tabId/url/title."""
        return self.call("SCAN_PAGE", scope=scope, timeout=timeout)

    def clear_highlight(self, timeout: float | None = None) -> dict:
        return self.call("CLEAR_HIGHLIGHT", timeout=timeout)

    # ---- Element Search ------------------------------------------------

    def search(self, query: str, limit: int | None = None,
               timeout: float | None = None, *, offset: int = 0,
               category: str | None = None, tag: str | None = None,
               class_name: str | None = None, dom_id: str | None = None,
               attrs: dict | None = None, selector: str | None = None,
               in_viewport: bool | None = None) -> dict:
        """Search the last scan. An empty query returns every scanned element."""
        return self.call("SEARCH_ELEMENTS", query=query, limit=limit, timeout=timeout,
                         offset=offset, type=category, tag=tag, className=class_name,
                         id=dom_id, attributes=attrs, selector=selector,
                         inViewport=in_viewport)

    def wait_for_export(self, timeout: float | None = 60) -> dict:
        """Wait for selected elements or a complete snapshot sent from the panel."""
        return self.server.wait_for_export(timeout)

    def locator(self, selector: str) -> "Element":
        """Resolve native CSS before each operation; exactly one match required."""
        if not isinstance(selector, str) or not selector.strip():
            raise ValueError("selector 必须为非空 CSS。")
        return Element(self, selector=selector)

    @staticmethod
    def _query_params(by, selector):
        aliases = {"css_position": "css_position", "css_positon": "css_position",
                   "css": "css_position", "css_selector": "css_position",
                   "xpath_position": "xpath_position", "xpath": "xpath_position"}
        if not isinstance(by, str) or by not in aliases:
            raise ValueError("by 必须为 css_position 或 xpath_position。")
        if not isinstance(selector, str) or not selector.strip():
            raise ValueError("selector 必须为非空字符串。")
        return {"by": aliases[by], "selector": selector}

    def _find(self, by, selector, *, multiple, strict=True, scope=None, timeout=None):
        if type(strict) is not bool:
            raise ValueError("strict 必须为布尔值。")
        params = self._query_params(by, selector)
        params.update(multiple=multiple, strict=strict)
        if scope is not None:
            params.update(scope=scope, pageId=scope["pageId"])
        result = self.call("FIND_ELEMENTS", timeout=timeout, **params)
        return [self.element(handle) for handle in result["elements"]]

    def find(self, by, selector, timeout=None, *, strict=True) -> "Element":
        """Find now, without a scan. The returned handle pins the actual node."""
        return self._find(by, selector, multiple=False, strict=strict, timeout=timeout)[0]

    def findall(self, by, selector, timeout=None) -> list["Element"]:
        """Return a DOM-order snapshot of node handles, or [] for no matches."""
        return self._find(by, selector, multiple=True, timeout=timeout)

    find_all = findall

    def css_position(self, selector, timeout=None) -> "Element":
        return self.find("css_position", selector, timeout)

    def xpath_position(self, selector, timeout=None) -> "Element":
        return self.find("xpath_position", selector, timeout)

    @staticmethod
    def _read_value(result):
        if result.get("truncated"):
            raise P.PageSenseError("TEXT_TRUNCATED", "读取结果超过 20000 字符；请缩小容器，或使用 get_all() 查看长度与截断标志。")
        return result["value"]

    def get_all_texts(self, selector, by="css_position", timeout=None) -> list[str]:
        params = self._query_params(by, selector)
        result = self.call("READ_ELEMENTS", timeout=timeout, **params)
        return [self._read_value(item) for item in result["items"]]

    def element(self, handle: dict) -> "Element":
        """Bind a snapshot element to its original document (pageId required)."""
        self._element_params(handle)
        return Element(self, handle=dict(handle))

    @staticmethod
    def _element_params(element_id: int | dict) -> dict:
        if isinstance(element_id, dict):
            page_id, node_id = element_id.get("pageId"), element_id.get("elementId")
            if not isinstance(page_id, str) or not page_id or type(node_id) is not int or node_id < 1:
                raise ValueError("元素句柄必须包含正整数 elementId 和非空 pageId。")
            params = {"elementId": node_id, "pageId": page_id}
            if "referenceId" in element_id:
                reference_id = element_id["referenceId"]
                if not isinstance(reference_id, str) or not reference_id:
                    raise ValueError("referenceId 必须为非空字符串。")
                params["referenceId"] = reference_id
            return params
        return {"elementId": element_id}

    def _element_call(self, method, element_id, timeout=None, **params):
        return self.call(method, timeout=timeout, **self._element_params(element_id), **params)

    def inspect(self, element_id: int | dict, timeout: float | None = None) -> dict:
        return self._element_call("GET_ELEMENT_DETAILS", element_id, timeout)

    def read_text(self, element_id: int | dict, timeout: float | None = None) -> str:
        """Read text into Python (up to 20000 characters); does not use OS clipboard."""
        return self.inspect(element_id, timeout)["text"]

    def locate(self, element_id: int | dict, timeout: float | None = None) -> dict:
        return self._element_call("LOCATE_ELEMENT", element_id, timeout)

    def highlight(self, element_id: int | dict, timeout: float | None = None) -> dict:
        return self._element_call("HIGHLIGHT_ELEMENT", element_id, timeout)

    def click(self, element_id: int | dict, timeout: float | None = None) -> dict:
        return self._element_call("CLICK_ELEMENT", element_id, timeout)

    def input(self, element_id: int | dict, value: str, timeout: float | None = None) -> dict:
        return self._element_call("INPUT_ELEMENT", element_id, timeout, value=value)

    def clear(self, element_id: int | dict, timeout: float | None = None) -> dict:
        return self._element_call("CLEAR_ELEMENT", element_id, timeout)

    def keypress(self, element_id: int | dict, key: str, timeout: float | None = None) -> dict:
        return self._element_call("KEYPRESS_ELEMENT", element_id, timeout, key=key)

    def scroll(self, direction: str = "down", amount: int = 500,
               timeout: float | None = None) -> dict:
        return self.call("SCROLL_PAGE", direction=direction, amount=amount,
                         timeout=timeout)


class Element:
    """A CSS locator, or a page-scoped snapshot handle. No implicit retries."""

    def __init__(self, client, *, selector=None, handle=None):
        self.client, self.selector, self.handle = client, selector, handle

    def _target(self, timeout):
        if self.handle is not None:
            return self.handle
        detail = self.client.call("RESOLVE_ELEMENT", selector=self.selector, timeout=timeout)
        return {"elementId": detail["element"]["elementId"], "pageId": detail["pageId"]}

    def inspect(self, timeout=None):
        return self.client.inspect(self._target(timeout), timeout)

    def text(self, timeout=None):
        return self.inspect(timeout)["text"]

    def get_text(self, timeout=None):
        return self._read("text", timeout=timeout)

    def _read(self, mode, name=None, timeout=None):
        target = self._target(timeout)
        result = self.client.call("READ_ELEMENT", timeout=timeout, **target, mode=mode, name=name)
        return self.client._read_value(result)

    def get_attribute(self, name, timeout=None):
        return self._read("attribute", name, timeout)

    def get_property(self, name, timeout=None):
        return self._read("property", name, timeout)

    def get(self, name, timeout=None):
        """'text' reads text; other names read raw HTML attributes (missing: None)."""
        return self.get_text(timeout) if name == "text" else self.get_attribute(name, timeout)

    def get_all(self, timeout=None):
        """Return existing detail data, including explicit text/HTML truncation flags."""
        return self.inspect(timeout)

    def find(self, by, selector, timeout=None, *, strict=True):
        return self.client._find(by, selector, multiple=False, strict=strict,
                                 scope=self._target(timeout), timeout=timeout)[0]

    def findall(self, by, selector, timeout=None):
        return self.client._find(by, selector, multiple=True,
                                 scope=self._target(timeout), timeout=timeout)

    find_all = findall

    def get_all_texts(self, selector, by="css_position", timeout=None):
        params = self.client._query_params(by, selector)
        scope = self._target(timeout)
        result = self.client.call("READ_ELEMENTS", timeout=timeout, **params,
                                  scope=scope, pageId=scope["pageId"])
        return [self.client._read_value(item) for item in result["items"]]

    def click(self, timeout=None):
        return self.client.click(self._target(timeout), timeout)

    def input(self, value, timeout=None):
        return self.client.input(self._target(timeout), value, timeout)

    def clear(self, timeout=None):
        return self.client.clear(self._target(timeout), timeout)

    def keypress(self, key, timeout=None):
        return self.client.keypress(self._target(timeout), key, timeout)

    def locate(self, timeout=None):
        return self.client.locate(self._target(timeout), timeout)

    def highlight(self, timeout=None):
        return self.client.highlight(self._target(timeout), timeout)


__all__ = ["PageSenseClient", "Element", "P"]
