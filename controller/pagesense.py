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
            return {"elementId": node_id, "pageId": page_id}
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
