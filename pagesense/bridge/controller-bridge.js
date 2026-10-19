/*
 * PageSense - bridge/controller-bridge.js
 * V2.0 Controller Bridge.
 *
 * Owns the single long-lived WebSocket to the Python Controller. It lives in
 * the Service Worker because the Popup's lifetime is far too short to hold a
 * socket (MV3 also forbids WebSocket servers in extensions, so the Python
 * side is always the server and PageSense is always the client).
 *
 * The bridge is TRANSPORT ONLY. It never touches the DOM and never calls
 * element.click() / input dispatch itself: every method is translated into
 * the existing V1.x Content Script action and executed by the same
 * Scanner / Highlighter / Action Executor the Popup uses.
 */
(function (global) {
  "use strict";

  if (global.__PAGESENSE_BRIDGE_LOADED__) {
    return;
  }
  global.__PAGESENSE_BRIDGE_LOADED__ = true;

  var PS = global.PAGESENSE;
  var EC = PS.ERROR_CODES;
  var STATES = PS.BRIDGE_STATES;
  var TYPES = PS.BRIDGE_TYPES;

  /**
   * Content Script files in dependency order. element-search.js sits right
   * after scanner.js because it consumes the scan result.
   */
  var CONTENT_FILES = [
    "shared/constants.js",
    "content/element-map.js",
    "content/scanner.js",
    "content/element-search.js",
    "content/highlighter.js",
    "content/action-executor.js",
    "content/element-picker.js",
    "content/content.js"
  ];

  /* ---- State ---------------------------------------------------------- */

  var connectionState = STATES.DISCONNECTED;
  var socket = null;
  var reconnectTimer = null;
  var heartbeatTimer = null;
  var helloTimer = null;
  var reconnectAttempt = 0;
  /** Set while the user explicitly asked for a disconnect: no auto-reconnect. */
  var manualStop = true;
  var connectedSince = null;
  var lastError = null;

  /** In-memory only: page content is never persisted to storage. */
  var requestLog = [];

  var config = {
    host: PS.BRIDGE.DEFAULT_HOST,
    port: PS.BRIDGE.DEFAULT_PORT,
    token: "",
    autoconnect: false
  };

  function bridgeError(code, message) {
    var err = new Error(message || code);
    err.code = code;
    return err;
  }

  function nowStamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, "0"); }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function setState(next, error) {
    connectionState = next;
    lastError = error === undefined ? null : error;
  }

  /* ---- Request log ---------------------------------------------------- */

  /** Short human summary of what a method did, for the Popup log line. */
  function summarize(method, result, error) {
    if (error) {
      return error.code || "error";
    }
    if (method === PS.METHODS.SCAN_PAGE) {
      return (result && result.stats ? result.stats.total : 0) + " elements";
    }
    if (method === PS.METHODS.SEARCH_ELEMENTS) {
      return (result ? result.total : 0) + " results";
    }
    if (method === PS.METHODS.GET_STATUS) {
      return "status";
    }
    if (result && result.elementId != null) {
      return "#" + result.elementId;
    }
    return "ok";
  }

  function addLogEntry(method, success, summary) {
    requestLog.push({
      time: nowStamp(),
      method: method,
      success: success,
      summary: summary
    });
    if (requestLog.length > PS.BRIDGE.REQUEST_LOG_LIMIT) {
      requestLog = requestLog.slice(requestLog.length - PS.BRIDGE.REQUEST_LOG_LIMIT);
    }
  }

  function getRequestLog() {
    return requestLog.slice();
  }

  /* ---- Configuration --------------------------------------------------- */

  /** Only loopback hosts are ever accepted; no remote Controller in V2. */
  function normalizeHost(host) {
    var value = String(host || "").trim().toLowerCase();
    if (PS.BRIDGE.ALLOWED_HOSTS.indexOf(value) === -1) {
      return null;
    }
    return value;
  }

  function normalizePort(port) {
    var num = Number(port);
    if (!Number.isInteger(num) || num < PS.BRIDGE.MIN_PORT || num > PS.BRIDGE.MAX_PORT) {
      return null;
    }
    return num;
  }

  function loadConfig() {
    return chrome.storage.local.get([
      PS.BRIDGE_STORAGE_KEYS.HOST,
      PS.BRIDGE_STORAGE_KEYS.PORT,
      PS.BRIDGE_STORAGE_KEYS.TOKEN,
      PS.BRIDGE_STORAGE_KEYS.AUTOCONNECT
    ]).then(function (stored) {
      var host = normalizeHost(stored[PS.BRIDGE_STORAGE_KEYS.HOST]);
      var port = normalizePort(stored[PS.BRIDGE_STORAGE_KEYS.PORT]);
      config.host = host || PS.BRIDGE.DEFAULT_HOST;
      config.port = port || PS.BRIDGE.DEFAULT_PORT;
      config.token = typeof stored[PS.BRIDGE_STORAGE_KEYS.TOKEN] === "string"
        ? stored[PS.BRIDGE_STORAGE_KEYS.TOKEN]
        : "";
      config.autoconnect = stored[PS.BRIDGE_STORAGE_KEYS.AUTOCONNECT] === true;
      return config;
    });
  }

  /**
   * Persist a partial configuration update. The token is only ever what the
   * user typed: it is never hardcoded in the extension source.
   */
  function saveConfig(partial) {
    var patch = {};
    if (partial.host !== undefined) {
      var host = normalizeHost(partial.host);
      if (!host) {
        return Promise.reject(bridgeError(
          EC.INVALID_PARAMS,
          "host 只允许 127.0.0.1 或 localhost（V2 不支持远程 Controller）。"
        ));
      }
      patch[PS.BRIDGE_STORAGE_KEYS.HOST] = host;
    }
    if (partial.port !== undefined) {
      var port = normalizePort(partial.port);
      if (!port) {
        return Promise.reject(bridgeError(
          EC.INVALID_PARAMS,
          "port 必须是 " + PS.BRIDGE.MIN_PORT + "-" + PS.BRIDGE.MAX_PORT + " 之间的整数。"
        ));
      }
      patch[PS.BRIDGE_STORAGE_KEYS.PORT] = port;
    }
    if (partial.token !== undefined) {
      patch[PS.BRIDGE_STORAGE_KEYS.TOKEN] = String(partial.token);
    }
    if (partial.autoconnect !== undefined) {
      patch[PS.BRIDGE_STORAGE_KEYS.AUTOCONNECT] = partial.autoconnect === true;
    }

    return chrome.storage.local.set(patch).then(loadConfig);
  }

  /* ---- Socket plumbing -------------------------------------------------- */

  function wsUrl() {
    return "ws://" + config.host + ":" + config.port;
  }

  function sendJson(payload) {
    if (!socket || socket.readyState !== 1 /* OPEN */) {
      return false;
    }
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearTimers() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
  }

  function startHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    // Application-level traffic keeps the MV3 worker from being reaped
    // while a Controller session is open.
    heartbeatTimer = setInterval(function () {
      sendJson({ type: TYPES.HEARTBEAT, ts: Date.now() });
    }, PS.BRIDGE.HEARTBEAT_INTERVAL_MS);
  }

  /** Exponential backoff with a 30s ceiling; never a tight reconnect loop. */
  function scheduleReconnect() {
    if (manualStop || reconnectTimer) {
      return;
    }
    var delays = PS.BRIDGE.RECONNECT_DELAYS_MS;
    var index = Math.min(reconnectAttempt, delays.length - 1);
    var delay = delays[index];
    reconnectAttempt++;

    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  function rejectExports() {
    if (!pendingExports) return;
    pendingExports.forEach(function (pending) {
      clearTimeout(pending.timer);
      pending.reject(bridgeError("TRANSPORT_ERROR", "连接已中断，无法确认收件，请检查 Python。"));
    });
    pendingExports.clear();
  }

  function closeSocket() {
    rejectExports();
    if (!socket) {
      return;
    }
    var dying = socket;
    socket = null;
    try {
      dying.onopen = null;
      dying.onmessage = null;
      dying.onerror = null;
      dying.onclose = null;
      dying.close();
    } catch (e) { /* already gone */ }
  }

  function openSocket() {
    if (socket) {
      return;
    }
    setState(STATES.CONNECTING);

    var ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      setState(STATES.ERROR, { code: EC.BRIDGE_ERROR, message: String(e && e.message || e) });
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = function () {
      if (socket !== ws) {
        return;
      }
      // HELLO is the only unauthenticated message the server accepts.
      sendJson({
        type: TYPES.HELLO,
        protocol: PS.BRIDGE.PROTOCOL,
        client: "extension",
        version: chrome.runtime.getManifest().version,
        token: config.token
      });

      helloTimer = setTimeout(function () {
        helloTimer = null;
        if (socket === ws && connectionState !== STATES.CONNECTED) {
          setState(STATES.ERROR, {
            code: EC.REQUEST_TIMEOUT,
            message: "等待 HELLO_ACK 超时。"
          });
          closeSocket();
          scheduleReconnect();
        }
      }, PS.BRIDGE.HELLO_TIMEOUT_MS);
    };

    ws.onmessage = function (event) {
      if (socket !== ws) {
        return;
      }
      handleServerMessage(event.data);
    };

    ws.onerror = function () {
      if (socket !== ws) {
        return;
      }
      // onclose always follows; state transition happens there.
      lastError = { code: EC.BRIDGE_ERROR, message: "WebSocket 连接错误。" };
    };

    ws.onclose = function () {
      if (socket !== ws) {
        return;
      }
      socket = null;
      rejectExports();
      clearTimers();
      connectedSince = null;
      setState(manualStop ? STATES.DISCONNECTED : STATES.ERROR, lastError);
      scheduleReconnect();
    };
  }

  /* ---- Server message handling ------------------------------------------ */

  var pendingExports = new Map();
  function sendExport(data) {
    if (connectionState !== STATES.CONNECTED) return Promise.reject(bridgeError("NOT_CONNECTED", "请先连接 Python。"));
    if (!data || !Array.isArray(data.elements) || !data.pageId) return Promise.reject(bridgeError("INVALID_PARAMS", "导出内容缺少页面或元素。"));
    var id = "export_" + crypto.randomUUID();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pendingExports.delete(id);
        reject(bridgeError("EXPORT_TIMEOUT", "Python 未确认收件；可检查 wait_for_export()，勿假定未收到。"));
      }, 8000);
      pendingExports.set(id, { resolve: resolve, reject: reject, timer: timer });
      if (!sendJson({ type: TYPES.EXPORT, id: id, data: data })) {
        clearTimeout(timer); pendingExports.delete(id);
        reject(bridgeError("TRANSPORT_ERROR", "发送失败，请检查 Python 连接。"));
      }
    });
  }

  function handleServerMessage(raw) {
    var message;
    try {
      message = JSON.parse(raw);
    } catch (e) {
      return; // not ours to interpret
    }
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === TYPES.EXPORT_ACK) {
      var pending = pendingExports.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); pendingExports.delete(message.id);
      if (message.success) pending.resolve({ id: message.id, received: true });
      else pending.reject(bridgeError("EXPORT_REJECTED", (message.error || {}).message || "Python 拒绝收件。"));
      return;
    }
    if (message.type === TYPES.HELLO_ACK) {
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      if (message.success === true) {
        reconnectAttempt = 0;
        connectedSince = Date.now();
        setState(STATES.CONNECTED);
        startHeartbeat();
      } else {
        var code = (message.error && message.error.code) || EC.UNAUTHORIZED;
        setState(STATES.ERROR, {
          code: code,
          message: (message.error && message.error.message) || "Controller 拒绝了连接。"
        });
        closeSocket();
        scheduleReconnect();
      }
      return;
    }

    if (message.type === TYPES.HEARTBEAT_ACK) {
      return;
    }

    if (message.type === TYPES.REQUEST) {
      handleRequest(message);
    }
  }

  /** Reply on the same request id; never rely on message ordering. */
  function reply(id, success, payload) {
    var envelope = { id: id, type: TYPES.RESPONSE, success: success };
    if (success) {
      envelope.result = payload;
    } else {
      envelope.error = payload;
    }
    sendJson(envelope);
  }

  function handleRequest(message) {
    var id = message.id;
    var method = message.method;
    var params = message.params || {};

    if (!PS.METHOD_TO_ACTION[method] &&
        method !== PS.METHODS.PING &&
        method !== PS.METHODS.GET_STATUS) {
      reply(id, false, {
        code: EC.UNKNOWN_METHOD,
        message: "未知方法：" + String(method)
      });
      addLogEntry(String(method), false, EC.UNKNOWN_METHOD);
      return;
    }

    dispatch(method, params).then(function (result) {
      reply(id, true, result);
      addLogEntry(method, true, summarize(method, result, null));
    }).catch(function (err) {
      var code = err && err.code ? err.code : EC.BRIDGE_ERROR;
      reply(id, false, {
        code: code,
        message: err && err.message ? err.message : String(err)
      });
      addLogEntry(method, false, summarize(method, null, { code: code }));
    });
  }

  /* ---- Tab resolution & Content Script preparation ---------------------- */

  /**
   * The active tab of the current window is the implicit target of every
   * Controller request. Restricted pages (browser internals, web stores)
   * are rejected before any injection is attempted.
   * @return {Promise<{tab: Object, url: string}>}
   */
  function resolveActiveTab() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      if (!tabs || tabs.length === 0 || typeof tabs[0].id !== "number") {
        throw bridgeError(EC.NO_ACTIVE_TAB, "没有可操作的活动页面。");
      }
      var tab = tabs[0];
      // tab.url is empty for pages the extension has no host permission for
      // (edge://, chrome://, the web stores), which is exactly the set of
      // pages we must refuse.
      var url = tab.url || "";
      var inspection = PS.inspectUrl(url);
      if (inspection.restricted) {
        throw bridgeError(
          EC.RESTRICTED_PAGE,
          "当前页面不允许扩展注入（" + inspection.reason + "）。"
        );
      }
      return { tab: tab, url: url };
    });
  }

  function injectContentScripts(tabId) {
    return chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: CONTENT_FILES
    }).catch(function (err) {
      throw bridgeError(
        EC.INJECTION_FAILED,
        "无法注入 Content Script：" + (err && err.message ? err.message : String(err))
      );
    });
  }

  /**
   * Send one Content Script action, injecting on demand the first time.
   * The Content Script's duplicate-listener guard makes re-injection safe,
   * so this can never produce two responses for one request.
   */
  function sendToTab(tabId, message) {
    return chrome.tabs.sendMessage(tabId, message).catch(function () {
      return injectContentScripts(tabId).then(function () {
        return chrome.tabs.sendMessage(tabId, message);
      });
    });
  }

  /* ---- Method dispatch -------------------------------------------------- */

  /** Bridge method -> the V1.x Content Script action message. */
  function buildActionMessage(method, params) {
    var A = PS.ACTIONS;
    switch (method) {
      case PS.METHODS.RESOLVE_ELEMENT:
        return { action: A.RESOLVE_ELEMENT, selector: params.selector };
      case PS.METHODS.SCAN_PAGE:
        return { action: A.SCAN_PAGE, scope: params.scope };
      case PS.METHODS.SEARCH_ELEMENTS:
        var message = { action: A.SEARCH_ELEMENTS, query: params.query };
        ["limit", "offset", "type", "tag", "className", "id", "attributes", "selector", "inViewport"].forEach(function (key) {
          if (params[key] !== undefined) message[key] = params[key];
        });
        return message;
      case PS.METHODS.GET_ELEMENT_DETAILS:
        return { action: A.GET_ELEMENT_DETAILS, elementId: params.elementId };
      case PS.METHODS.LOCATE_ELEMENT:
        return { action: A.LOCATE_ELEMENT, elementId: params.elementId };
      case PS.METHODS.HIGHLIGHT_ELEMENT:
        return { action: A.HIGHLIGHT_ELEMENT, elementId: params.elementId };
      case PS.METHODS.CLEAR_HIGHLIGHT:
        return { action: A.CLEAR_HIGHLIGHT };
      case PS.METHODS.CLICK_ELEMENT:
        return { action: A.CLICK_ELEMENT, elementId: params.elementId };
      case PS.METHODS.INPUT_ELEMENT:
        return { action: A.INPUT_ELEMENT, elementId: params.elementId, value: params.value };
      case PS.METHODS.CLEAR_ELEMENT:
        return { action: A.CLEAR_ELEMENT, elementId: params.elementId };
      case PS.METHODS.KEYPRESS_ELEMENT:
        return { action: A.KEYPRESS_ELEMENT, elementId: params.elementId, key: params.key };
      case PS.METHODS.SCROLL_PAGE:
        return { action: A.SCROLL_PAGE, direction: params.direction, amount: params.amount };
      default:
        return null;
    }
  }

  function tabSummary(tab, url) {
    return {
      tabId: tab.id,
      url: url || tab.url || "",
      title: tab.title || ""
    };
  }

  /**
   * Normalize a Content Script response into a bridge result.
   * SCAN_PAGE / SEARCH_ELEMENTS use the {ok, data} shape; the V1.2 action
   * envelope is passed through untouched so the Controller sees exactly the
   * same contract the Popup does.
   */
  function normalizeResult(method, tabInfo, response) {
    if (!response) {
      throw bridgeError(EC.BRIDGE_ERROR, "Content Script 未返回任何内容。");
    }

    if (method === PS.METHODS.SCAN_PAGE) {
      if (!response.ok) {
        throw bridgeError(response.error || EC.BRIDGE_ERROR, response.message || "扫描失败。");
      }
      var scan = response.data;
      var out = tabSummary(tabInfo.tab, tabInfo.url);
      out.schemaVersion = scan.schemaVersion;
      out.pageId = scan.pageId;
      out.scannedAt = scan.scannedAt;
      out.scope = scan.scope;
      out.page = scan.page;
      out.stats = scan.stats;
      out.elements = scan.elements;
      return out;
    }

    if (method === PS.METHODS.GET_ELEMENT_DETAILS || method === PS.METHODS.RESOLVE_ELEMENT) {
      if (!response.ok) throw bridgeError(response.error || EC.BRIDGE_ERROR, response.message || "读取详情失败。");
      return response.data;
    }

    if (method === PS.METHODS.SEARCH_ELEMENTS) {
      if (!response.ok) {
        throw bridgeError(response.error || EC.BRIDGE_ERROR, response.message || "搜索失败。");
      }
      var found = response.data;
      return {
        pageId: found.pageId,
        query: found.query,
        normalizedQuery: found.normalizedQuery,
        keywords: found.keywords,
        limit: found.limit,
        offset: found.offset,
        total: found.total,
        returned: found.returned,
        truncated: found.truncated,
        durationMs: found.durationMs,
        indexSize: found.indexSize,
        domMatches: found.domMatches,
        results: found.results
      };
    }

    // V1.2 action envelope: failure travels back as a bridge error so the
    // Controller sees one consistent success/error shape.
    if (response.success !== true) {
      throw bridgeError(
        (response.error && response.error.code) || EC.ACTION_FAILED,
        (response.error && response.error.message) || "Action 失败。"
      );
    }
    return response;
  }

  function dispatch(method, params) {
    if (method === PS.METHODS.PING) {
      return Promise.resolve({
        pong: true,
        timestamp: Date.now(),
        version: chrome.runtime.getManifest().version
      });
    }

    if (method === PS.METHODS.GET_STATUS) {
      return resolveActiveTab().then(function (info) {
        return {
          connected: connectionState === STATES.CONNECTED,
          state: connectionState,
          host: config.host,
          port: config.port,
          protocol: PS.BRIDGE.PROTOCOL,
          version: chrome.runtime.getManifest().version,
          activeTab: tabSummary(info.tab, info.url)
        };
      }).catch(function (err) {
        // GET_STATUS must always answer, even with no usable active tab.
        return {
          connected: connectionState === STATES.CONNECTED,
          state: connectionState,
          host: config.host,
          port: config.port,
          protocol: PS.BRIDGE.PROTOCOL,
          version: chrome.runtime.getManifest().version,
          activeTab: null,
          activeTabError: err && err.code ? err.code : EC.NO_ACTIVE_TAB
        };
      });
    }

    var message = buildActionMessage(method, params);
    if (message && params.pageId !== undefined) message.pageId = params.pageId;
    if (!message) {
      return Promise.reject(bridgeError(EC.UNKNOWN_METHOD, "未知方法：" + String(method)));
    }

    return resolveActiveTab().then(function (info) {
      return sendToTab(info.tab.id, message).then(function (response) {
        if (response && response.error && response.error.code === "STALE_PAGE") {
          throw bridgeError("STALE_PAGE", response.error.message);
        }
        return normalizeResult(method, info, response);
      });
    });
  }

  /* ---- Public control API (used by the Popup / Service Worker) ---------- */

  function connect(options) {
    var updates = options || {};
    manualStop = false;
    reconnectAttempt = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    return saveConfig(updates).then(function () {
      closeSocket();
      setState(STATES.CONNECTING);
      openSocket();
      return getStatus();
    });
  }

  function disconnect() {
    manualStop = true;
    reconnectAttempt = 0;
    clearTimers();
    closeSocket();
    setState(STATES.DISCONNECTED);
    return Promise.resolve(getStatus());
  }

  function getStatus() {
    return {
      state: connectionState,
      connected: connectionState === STATES.CONNECTED,
      host: config.host,
      port: config.port,
      hasToken: config.token.length > 0,
      autoconnect: config.autoconnect,
      protocol: PS.BRIDGE.PROTOCOL,
      version: chrome.runtime.getManifest().version,
      connectedSince: connectedSince,
      lastError: lastError,
      recentRequests: getRequestLog()
    };
  }

  /**
   * Called once per Service Worker start. A worker restart drops the socket,
   * so an auto-connect configuration reconnects without needing the browser
   * to be restarted.
   */
  function init() {
    return loadConfig().then(function (cfg) {
      if (cfg.autoconnect && cfg.token) {
        return connect({});
      }
      return getStatus();
    });
  }

  global.PageSenseBridge = {
    CONTENT_FILES: CONTENT_FILES,
    init: init,
    connect: connect,
    disconnect: disconnect,
    getStatus: getStatus,
    saveConfig: saveConfig,
    loadConfig: loadConfig,
    sendExport: sendExport,
    dispatch: dispatch,
    buildActionMessage: buildActionMessage,
    normalizeHost: normalizeHost,
    normalizePort: normalizePort
  };
})(typeof window !== "undefined" ? window : globalThis);
