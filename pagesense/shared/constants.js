/*
 * PageSense - shared/constants.js
 * Central place for message actions, selectors, filter categories and
 * restricted-URL detection. Loaded as a classic script (no ES modules) so
 * the exact same file works in both the Popup and Content Script worlds.
 */
(function (global) {
  "use strict";

  if (global.__PAGESENSE_CONSTANTS_LOADED__) {
    return;
  }
  global.__PAGESENSE_CONSTANTS_LOADED__ = true;

  var PS = {};

  /** Message protocol actions (never use raw strings at call sites). */
  PS.ACTIONS = {
    SCAN_PAGE: "PAGESENSE_SCAN_PAGE",
    LOCATE_ELEMENT: "PAGESENSE_LOCATE_ELEMENT",
    HIGHLIGHT_ELEMENT: "PAGESENSE_HIGHLIGHT_ELEMENT",
    CLEAR_HIGHLIGHT: "PAGESENSE_CLEAR_HIGHLIGHT",
    // V1.2 Action Layer
    CLICK_ELEMENT: "PAGESENSE_CLICK_ELEMENT",
    INPUT_ELEMENT: "PAGESENSE_INPUT_ELEMENT",
    CLEAR_ELEMENT: "PAGESENSE_CLEAR_ELEMENT",
    KEYPRESS_ELEMENT: "PAGESENSE_KEYPRESS_ELEMENT",
    SCROLL_PAGE: "PAGESENSE_SCROLL_PAGE",
    // V2.0 Element Search
    SEARCH_ELEMENTS: "PAGESENSE_SEARCH_ELEMENTS",
    GET_ELEMENT_DETAILS: "PAGESENSE_GET_ELEMENT_DETAILS",
    RESOLVE_ELEMENT: "PAGESENSE_RESOLVE_ELEMENT"
  };

  /**
   * Attribute written on real page elements to map them to a PageSense
   * elementId. Namespaced to avoid clashing with page business attributes.
   */
  PS.PAGE_SENSE_ID_ATTR = "data-pagesense-id";

  /** Side panel subscription; no background polling when the panel closes. */
  PS.LIVE_SCAN = { PORT_NAME: "pagesense-live-scan", THROTTLE_MS: 300 };
  PS.PICKER = { PORT_NAME: "pagesense-element-picker" };
  PS.SCAN_SCOPES = { INTERACTIVE: "interactive", CONTENT: "content", ALL: "all" };

  /** Attribute marking elements created by PageSense (e.g. highlight overlay). */
  PS.OVERLAY_ATTR = "data-pagesense-overlay";

  /** Structured error codes returned to the Popup / Controller. */
  PS.ERROR_CODES = {
    ELEMENT_NOT_FOUND: "ELEMENT_NOT_FOUND",
    INVALID_ELEMENT_ID: "INVALID_ELEMENT_ID",
    ELEMENT_NOT_INTERACTABLE: "ELEMENT_NOT_INTERACTABLE",
    ELEMENT_DISABLED: "ELEMENT_DISABLED",
    UNSUPPORTED_ELEMENT: "UNSUPPORTED_ELEMENT",
    INVALID_VALUE: "INVALID_VALUE",
    INVALID_KEY: "INVALID_KEY",
    ACTION_FAILED: "ACTION_FAILED",
    // V2.0 Element Search
    NO_SCAN_DATA: "NO_SCAN_DATA",
    INVALID_SELECTOR: "INVALID_SELECTOR",
    // V2.0 Controller Bridge
    NO_ACTIVE_TAB: "NO_ACTIVE_TAB",
    RESTRICTED_PAGE: "RESTRICTED_PAGE",
    INJECTION_FAILED: "INJECTION_FAILED",
    REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
    UNKNOWN_METHOD: "UNKNOWN_METHOD",
    INVALID_PARAMS: "INVALID_PARAMS",
    NOT_CONNECTED: "NOT_CONNECTED",
    UNAUTHORIZED: "UNAUTHORIZED",
    BRIDGE_ERROR: "BRIDGE_ERROR"
  };

  /**
   * Keyboard whitelist for KEYPRESS_ELEMENT: normalized key value ->
   * KeyboardEvent.code. "Space" is accepted as an alias and normalized to
   * the DOM key value " ". Anything not listed returns INVALID_KEY.
   */
  PS.SUPPORTED_KEYS = {
    "Enter": "Enter",
    "Escape": "Escape",
    "Tab": "Tab",
    "ArrowUp": "ArrowUp",
    "ArrowDown": "ArrowDown",
    "ArrowLeft": "ArrowLeft",
    "ArrowRight": "ArrowRight",
    "Backspace": "Backspace",
    "Delete": "Delete",
    " ": "Space"
  };

  /** Alias accepted in messages for the space key. */
  PS.KEY_ALIASES = { "Space": " " };

  /** Scroll directions and safety bounds for SCROLL_PAGE. */
  PS.SCROLL_DIRECTIONS = { UP: "up", DOWN: "down", LEFT: "left", RIGHT: "right" };
  PS.MAX_SCROLL_AMOUNT = 5000;

  /** Maximum length kept for a single element's extracted text. */
  PS.MAX_TEXT_LENGTH = 300;

  /**
   * Interactive element selectors. This is the single source of truth for
   * what PageSense considers an interactive element in V1.
   */
  PS.INTERACTIVE_SELECTORS = [
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "option",
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    "summary", "[onclick]", '[tabindex]:not([tabindex="-1"])',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="combobox"]', '[role="tab"]', '[role="menuitem"]', '[role="slider"]'
  ];

  /** Combined selector, computed once. */
  PS.INTERACTIVE_SELECTOR = PS.INTERACTIVE_SELECTORS.join(",");

  /** Popup filter categories. */
  PS.FILTERS = {
    ALL: "all",
    BUTTON: "button",
    LINK: "link",
    INPUT: "input",
    OTHER: "other"
  };

  PS.FILTER_LABELS = {
    all: "全部",
    interactive: "交互控件", "text-content": "文本内容",
    "media-content": "图片/媒体", structure: "页面结构",
    button: "按钮", link: "链接", input: "输入框", select: "选择框",
    toggle: "勾选/切换", editable: "可编辑", control: "其他控件",
    heading: "标题", paragraph: "段落", label: "标签/说明", text: "普通文本",
    image: "图片", media: "音视频/图形", list: "列表", table: "表格",
    region: "区域", form: "表单", other: "其他"
  };

  PS.CATEGORY_GROUPS = {
    interactive: ["button", "link", "input", "select", "toggle", "editable", "control"],
    "text-content": ["heading", "paragraph", "label", "text"],
    "media-content": ["image", "media"],
    structure: ["list", "table", "region", "form", "other"]
  };

  PS.elementKind = function (el) {
    var tag = (el.tag || "").toLowerCase(), role = el.role || "";
    if (tag === "a" || role === "link") return "link";
    if (tag === "button" || role === "button" || tag === "summary" ||
        (tag === "input" && /^(button|submit|reset|image)$/.test(el.type))) return "button";
    if (/^(checkbox|radio|switch)$/.test(role) ||
        (tag === "input" && /^(checkbox|radio)$/.test(el.type))) return "toggle";
    if (tag === "select" || tag === "option" || role === "combobox") return "select";
    if (el.contentEditable) return "editable";
    if (tag === "input" || tag === "textarea" || role === "textbox") return "input";
    if (el.interactive) return "control";
    if (/^h[1-6]$/.test(tag) || role === "heading") return "heading";
    if (/^(p|blockquote|pre|code|address)$/.test(tag)) return "paragraph";
    if (/^(label|legend|figcaption|caption|dt|dd|time)$/.test(tag)) return "label";
    if (tag === "img" || tag === "picture" || role === "img") return "image";
    if (/^(video|audio|canvas|svg)$/.test(tag)) return "media";
    if (/^(ul|ol|li|dl)$/.test(tag) || /^(list|listitem)$/.test(role)) return "list";
    if (/^(table|thead|tbody|tfoot|tr|th|td)$/.test(tag) || /^(table|row|cell|grid)$/.test(role)) return "table";
    if (tag === "form" || role === "form") return "form";
    if (/^(main|nav|header|footer|aside|section|article|dialog|details)$/.test(tag) ||
        /^(main|navigation|banner|contentinfo|region|dialog)$/.test(role)) return "region";
    return el.text ? "text" : "other";
  };

  PS.matchesFilter = function (el, filter) {
    if (!filter || filter === "all") return true;
    if (filter === "interactive") return el.interactive === true ||
      (!el.category && PS.categorizeElement(el) !== "other");
    var group = PS.CATEGORY_GROUPS[filter];
    if (group) return group.indexOf(el.category || PS.elementKind(el)) !== -1;
    return (el.category || PS.categorizeElement(el)) === filter;
  };

  /**
   * Classify a serialized element into one of the filter categories
   * based on its tag / ARIA role / contenteditable state.
   * @param {Object} el serialized element
   * @return {string} one of PS.FILTERS values
   */
  PS.categorizeElement = function (el) {
    var tag = el.tag;
    var role = el.role;

    if (tag === "a" || role === "link") {
      return PS.FILTERS.LINK;
    }
    if (tag === "button" || role === "button") {
      return PS.FILTERS.BUTTON;
    }
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      tag === "option" ||
      role === "textbox" ||
      el.contentEditable === true
    ) {
      return PS.FILTERS.INPUT;
    }
    return PS.FILTERS.OTHER;
  };

  /** Text-entry input types supported by INPUT_ELEMENT. */
  PS.TEXT_INPUT_TYPES = [
    "text", "email", "search", "password", "url", "tel", "number", ""
  ];

  /**
   * Whether a serialized element accepts text input (INPUT_ELEMENT):
   * text-like <input>, <textarea>, or a contenteditable / role=textbox.
   */
  PS.isTextEntryElement = function (el) {
    if (el.tag === "textarea") {
      return true;
    }
    if (el.contentEditable === true || el.role === "textbox") {
      return true;
    }
    if (el.tag === "input") {
      var type = (el.type || "text").toLowerCase();
      return PS.TEXT_INPUT_TYPES.indexOf(type) !== -1;
    }
    return false;
  };

  /**
   * Whether a serialized element is meaningfully activated by a click:
   * buttons, links, and non-text-entry inputs (e.g. checkbox/radio/submit).
   */
  PS.isClickableElement = function (el) {
    if (typeof el.clickable === "boolean") return el.clickable;
    var category = PS.categorizeElement(el);
    if (category === PS.FILTERS.BUTTON || category === PS.FILTERS.LINK) {
      return true;
    }
    return el.tag === "input" && !PS.isTextEntryElement(el);
  };

  /** URL schemes that never allow content scripts / scripting injection. */
  PS.RESTRICTED_SCHEMES = [
    "chrome:",
    "edge:",
    "about:",
    "devtools:",
    "view-source:",
    "chrome-extension:",
    "extension:",
    "moz-extension:"
  ];

  /** Hosts on which stores/browsers block extension injection. */
  PS.RESTRICTED_HOSTS = [
    "chromewebstore.google.com",
    "chrome.google.com",
    "microsoftedge.microsoft.com",
    "addons.mozilla.org"
  ];

  /**
   * @param {string} url
   * @return {{restricted: boolean, reason?: string}}
   */
  PS.inspectUrl = function (url) {
    if (!url) {
      return { restricted: true, reason: "EMPTY_URL" };
    }

    var lowerUrl = url.toLowerCase();

    for (var i = 0; i < PS.RESTRICTED_SCHEMES.length; i++) {
      if (lowerUrl.indexOf(PS.RESTRICTED_SCHEMES[i]) === 0) {
        return { restricted: true, reason: "RESTRICTED_SCHEME:" + PS.RESTRICTED_SCHEMES[i] };
      }
    }

    try {
      var host = new URL(url).hostname.toLowerCase();
      for (var j = 0; j < PS.RESTRICTED_HOSTS.length; j++) {
        if (host === PS.RESTRICTED_HOSTS[j] || host.indexOf("." + PS.RESTRICTED_HOSTS[j]) !== -1) {
          return { restricted: true, reason: "RESTRICTED_HOST:" + host };
        }
      }
    } catch (e) {
      return { restricted: true, reason: "MALFORMED_URL" };
    }

    // file:// pages only work if the user enabled "Allow access to file URLs".
    if (lowerUrl.indexOf("file:") === 0) {
      return { restricted: false, reason: "FILE_URL_MAY_NEED_ACCESS_TOGGLE" };
    }

    return { restricted: false };
  };

  /* ==================================================================
   * V2.0 - Element Search
   * ================================================================== */

  /**
   * Fields the search index is built from. Order also defines the order in
   * which `matchedFields` is reported back to the caller.
   */
  PS.SEARCH_FIELDS = [
    "text", "value", "placeholder", "ariaLabel", "title", "alt",
    "tag", "role", "id", "className", "href"
  ];

  /** Search result pagination bounds. */
  PS.SEARCH_DEFAULT_LIMIT = 20;
  PS.SEARCH_MAX_LIMIT = 100;

  /**
   * Relevance weights. For every query keyword the best matching tier of the
   * best matching field is used; multi-keyword queries sum their per-keyword
   * scores (AND semantics: every keyword must match somewhere).
   */
  PS.SEARCH_SCORES = {
    text:        { exact: 100, prefix: 80, contains: 60 },
    ariaLabel:   { exact: 55,  prefix: 45, contains: 30 },
    placeholder: { exact: 50,  prefix: 40, contains: 25 },
    title:       { exact: 45,  prefix: 35, contains: 22 },
    value:       { exact: 45,  prefix: 35, contains: 22 },
    alt:         { exact: 40,  prefix: 30, contains: 20 },
    id:          { exact: 45,  prefix: 30, contains: 20 },
    role:        { exact: 40,  prefix: 28, contains: 18 },
    tag:         { exact: 35,  prefix: 25, contains: 18 },
    className:   { exact: 25,  prefix: 22, contains: 20 },
    href:        { exact: 12,  prefix: 11, contains: 10 }
  };

  /**
   * href is only matched for keywords of at least this length. Without it a
   * single letter such as "a" would match every link on the page and drown
   * out the real text matches.
   */
  PS.SEARCH_MIN_HREF_KEYWORD_LENGTH = 2;

  /**
   * Canonical search-text normalization: trim, collapse runs of whitespace
   * (including full-width spaces) to a single ASCII space, then lowercase.
   * CJK text has no case, so lowercasing never alters Chinese/Japanese text.
   * @param {*} text
   * @return {string}
   */
  PS.normalizeSearchText = function (text) {
    if (text === null || text === undefined) {
      return "";
    }
    return String(text)
      .replace(/[\s　]+/g, " ")
      .trim()
      .toLowerCase();
  };

  /**
   * Split a query into keywords on whitespace. An empty query yields [].
   * @param {*} query
   * @return {Array<string>}
   */
  PS.tokenizeSearchQuery = function (query) {
    var normalized = PS.normalizeSearchText(query);
    return normalized.length === 0 ? [] : normalized.split(" ");
  };

  /**
   * Clamp a caller-supplied result limit into [1, SEARCH_MAX_LIMIT].
   * Invalid / missing values fall back to SEARCH_DEFAULT_LIMIT.
   * @param {*} limit
   * @return {number}
   */
  PS.clampSearchLimit = function (limit) {
    if (limit === null || limit === undefined || limit === "") {
      return PS.SEARCH_DEFAULT_LIMIT;
    }
    var num = Number(limit);
    if (!Number.isFinite(num)) {
      return PS.SEARCH_DEFAULT_LIMIT;
    }
    num = Math.floor(num);
    if (num < 1) {
      return 1;
    }
    return num > PS.SEARCH_MAX_LIMIT ? PS.SEARCH_MAX_LIMIT : num;
  };

  /* ==================================================================
   * V2.0 - Controller Bridge (Python <-> Extension WebSocket transport)
   * ================================================================== */

  /** Methods a Controller may invoke over the bridge. */
  PS.METHODS = {
    PING: "PING",
    GET_STATUS: "GET_STATUS",
    SCAN_PAGE: "SCAN_PAGE",
    SEARCH_ELEMENTS: "SEARCH_ELEMENTS",
    GET_ELEMENT_DETAILS: "GET_ELEMENT_DETAILS",
    RESOLVE_ELEMENT: "RESOLVE_ELEMENT",
    LOCATE_ELEMENT: "LOCATE_ELEMENT",
    HIGHLIGHT_ELEMENT: "HIGHLIGHT_ELEMENT",
    CLEAR_HIGHLIGHT: "CLEAR_HIGHLIGHT",
    CLICK_ELEMENT: "CLICK_ELEMENT",
    INPUT_ELEMENT: "INPUT_ELEMENT",
    CLEAR_ELEMENT: "CLEAR_ELEMENT",
    KEYPRESS_ELEMENT: "KEYPRESS_ELEMENT",
    SCROLL_PAGE: "SCROLL_PAGE"
  };

  /** Bridge connection states surfaced in the Popup. */
  PS.BRIDGE_STATES = {
    DISCONNECTED: "DISCONNECTED",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    ERROR: "ERROR"
  };

  /** Envelope types. */
  PS.BRIDGE_TYPES = {
    HELLO: "HELLO",
    HELLO_ACK: "HELLO_ACK",
    REQUEST: "REQUEST",
    RESPONSE: "RESPONSE",
    HEARTBEAT: "HEARTBEAT",
    HEARTBEAT_ACK: "HEARTBEAT_ACK",
    EXPORT: "EXPORT",
    EXPORT_ACK: "EXPORT_ACK"
  };

  PS.NATIVE = { HOST: "com.pagesense.bridge", MODE_KEY: "pagesenseTransportMode" };

  PS.BRIDGE = {
    /** Protocol version string exchanged during HELLO. */
    PROTOCOL: "pagesense/1",
    /** Only loopback is allowed: no remote Controller, no LAN exposure. */
    DEFAULT_HOST: "127.0.0.1",
    ALLOWED_HOSTS: ["127.0.0.1", "localhost"],
    DEFAULT_PORT: 8765,
    MIN_PORT: 1,
    MAX_PORT: 65535,
    /** Exponential-ish backoff; the last value repeats forever. */
    RECONNECT_DELAYS_MS: [1000, 2000, 5000, 10000, 30000],
    /** Application-level heartbeat keeps the MV3 worker alive. */
    HEARTBEAT_INTERVAL_MS: 20000,
    /** How long to wait for HELLO_ACK before treating the socket as failed. */
    HELLO_TIMEOUT_MS: 5000,
    /** In-memory debug log of the most recent Controller requests. */
    REQUEST_LOG_LIMIT: 20,
    /** Per-request timeout applied on the Controller side. */
    DEFAULT_REQUEST_TIMEOUT_S: 10
  };

  /**
   * Bridge method -> Content Script action. The bridge is transport only:
   * DOM work always goes through the existing V1.x Content Script actions,
   * never through a second action implementation.
   * Methods absent from this map (PING / GET_STATUS) are answered by the
   * Service Worker directly and never touch a tab.
   */
  PS.METHOD_TO_ACTION = {
    SCAN_PAGE: "SCAN_PAGE",
    SEARCH_ELEMENTS: "SEARCH_ELEMENTS",
    GET_ELEMENT_DETAILS: "GET_ELEMENT_DETAILS",
    RESOLVE_ELEMENT: "RESOLVE_ELEMENT",
    LOCATE_ELEMENT: "LOCATE_ELEMENT",
    HIGHLIGHT_ELEMENT: "HIGHLIGHT_ELEMENT",
    CLEAR_HIGHLIGHT: "CLEAR_HIGHLIGHT",
    CLICK_ELEMENT: "CLICK_ELEMENT",
    INPUT_ELEMENT: "INPUT_ELEMENT",
    CLEAR_ELEMENT: "CLEAR_ELEMENT",
    KEYPRESS_ELEMENT: "KEYPRESS_ELEMENT",
    SCROLL_PAGE: "SCROLL_PAGE"
  };

  /** Popup <-> Service Worker control messages for the bridge. */
  PS.BRIDGE_MESSAGES = {
    GET_STATUS: "PAGESENSE_BRIDGE_GET_STATUS",
    CONNECT: "PAGESENSE_BRIDGE_CONNECT",
    DISCONNECT: "PAGESENSE_BRIDGE_DISCONNECT",
    SET_CONFIG: "PAGESENSE_BRIDGE_SET_CONFIG",
    SEND_EXPORT: "PAGESENSE_BRIDGE_SEND_EXPORT",
    START_NATIVE: "PAGESENSE_BRIDGE_START_NATIVE"
  };

  /** chrome.storage.local keys holding the bridge configuration. */
  PS.BRIDGE_STORAGE_KEYS = {
    HOST: "pagesenseBridgeHost",
    PORT: "pagesenseBridgePort",
    TOKEN: "pagesenseBridgeToken",
    AUTOCONNECT: "pagesenseBridgeAutoconnect"
  };

  /** Replace every character that is illegal in Windows file names. */
  PS.sanitizeFilePart = function (part) {
    return String(part || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);
  };

  global.PAGESENSE = PS;
})(typeof window !== "undefined" ? window : globalThis);
