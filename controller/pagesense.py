"""PageSense Controller - high level client API.

Thin, transport-agnostic wrapper over :class:`server.ControllerServer`. The
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

        client = PageSenseClient(token="ABC123").start()
        client.wait_for_extension(timeout=60)
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
    ):
        self.server = ControllerServer(
            host=host, port=port, token=token, request_timeout=request_timeout
        )
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

    def inspect(self, element_id: int, timeout: float | None = None) -> dict:
        """Read current attributes, selectors, text, HTML and tree context."""
        return self.call("GET_ELEMENT_DETAILS", elementId=element_id, timeout=timeout)

    # ---- per-element actions -------------------------------------------

    def locate(self, element_id: int, timeout: float | None = None) -> dict:
        return self.call("LOCATE_ELEMENT", elementId=element_id, timeout=timeout)

    def highlight(self, element_id: int, timeout: float | None = None) -> dict:
        return self.call("HIGHLIGHT_ELEMENT", elementId=element_id, timeout=timeout)

    def click(self, element_id: int, timeout: float | None = None) -> dict:
        return self.call("CLICK_ELEMENT", elementId=element_id, timeout=timeout)

    def input(self, element_id: int, value: str,
              timeout: float | None = None) -> dict:
        return self.call("INPUT_ELEMENT", elementId=element_id, value=value,
                         timeout=timeout)

    def clear(self, element_id: int, timeout: float | None = None) -> dict:
        return self.call("CLEAR_ELEMENT", elementId=element_id, timeout=timeout)

    def keypress(self, element_id: int, key: str,
                 timeout: float | None = None) -> dict:
        return self.call("KEYPRESS_ELEMENT", elementId=element_id, key=key,
                         timeout=timeout)

    def scroll(self, direction: str = "down", amount: int = 500,
               timeout: float | None = None) -> dict:
        return self.call("SCROLL_PAGE", direction=direction, amount=amount,
                         timeout=timeout)


__all__ = ["PageSenseClient", "P"]
