"""PageSense Controller - wire protocol.

Single source of truth for the envelope shapes exchanged with the PageSense
extension over WebSocket. Keep this in sync with ``pagesense/shared/constants.js``
(``PS.BRIDGE_TYPES`` / ``PS.METHODS`` / ``PS.ERROR_CODES``).

Envelope shapes
---------------
Extension -> Controller (first frame, unauthenticated)::

    {"type": "HELLO", "protocol": "pagesense/1", "client": "extension",
     "version": "2.0.0", "token": "<session token>"}

Controller -> Extension::

    {"type": "HELLO_ACK", "success": true}

Controller -> Extension (request)::

    {"id": "req_001", "type": "REQUEST", "method": "SCAN_PAGE", "params": {}}

Extension -> Controller (response)::

    {"id": "req_001", "type": "RESPONSE", "success": true, "result": {...}}
    {"id": "req_001", "type": "RESPONSE", "success": false,
     "error": {"code": "NO_ACTIVE_TAB", "message": "..."}}
"""

from __future__ import annotations

PROTOCOL = "pagesense/1"
CLIENT_NAME = "extension"

#: Envelope type tags.
TYPE_HELLO = "HELLO"
TYPE_HELLO_ACK = "HELLO_ACK"
TYPE_REQUEST = "REQUEST"
TYPE_RESPONSE = "RESPONSE"
TYPE_HEARTBEAT = "HEARTBEAT"
TYPE_HEARTBEAT_ACK = "HEARTBEAT_ACK"
TYPE_EXPORT = "EXPORT"
TYPE_EXPORT_ACK = "EXPORT_ACK"

#: Methods the extension understands (see PS.METHODS).
METHODS = (
    "PING",
    "GET_STATUS",
    "SCAN_PAGE",
    "SEARCH_ELEMENTS",
    "GET_ELEMENT_DETAILS",
    "RESOLVE_ELEMENT",
    "LOCATE_ELEMENT",
    "HIGHLIGHT_ELEMENT",
    "CLEAR_HIGHLIGHT",
    "CLICK_ELEMENT",
    "INPUT_ELEMENT",
    "CLEAR_ELEMENT",
    "KEYPRESS_ELEMENT",
    "SCROLL_PAGE",
)

#: Error codes the Controller may raise locally.
ERR_REQUEST_TIMEOUT = "REQUEST_TIMEOUT"
ERR_NOT_CONNECTED = "NOT_CONNECTED"
ERR_UNAUTHORIZED = "UNAUTHORIZED"
ERR_PROTOCOL = "PROTOCOL_ERROR"
ERR_TRANSPORT = "TRANSPORT_ERROR"


def make_request(request_id: str, method: str, params: dict | None = None) -> dict:
    """Build a REQUEST envelope."""
    return {
        "id": request_id,
        "type": TYPE_REQUEST,
        "method": method,
        "params": params or {},
    }


def make_hello_ack(success: bool = True, error: dict | None = None) -> dict:
    """Build a HELLO_ACK envelope."""
    message = {"type": TYPE_HELLO_ACK, "success": bool(success)}
    if not success:
        message["error"] = error or {
            "code": ERR_UNAUTHORIZED,
            "message": "token 校验失败",
        }
    return message


def is_hello(message: dict) -> bool:
    return isinstance(message, dict) and message.get("type") == TYPE_HELLO


def is_response(message: dict) -> bool:
    return isinstance(message, dict) and message.get("type") == TYPE_RESPONSE


def is_heartbeat(message: dict) -> bool:
    return isinstance(message, dict) and message.get("type") == TYPE_HEARTBEAT


class PageSenseError(Exception):
    """An error returned by the extension (or raised locally)."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


class RequestTimeout(PageSenseError):
    """A request did not receive its response within the configured timeout."""

    def __init__(self, method: str, timeout: float):
        super().__init__(
            ERR_REQUEST_TIMEOUT,
            f"{method} 在 {timeout:g}s 内没有响应，已放弃等待。",
        )
        self.method = method
        self.timeout = timeout
