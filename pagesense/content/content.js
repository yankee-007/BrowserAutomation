/*
 * PageSense - content/content.js
 * Thin message bridge between the Popup and the DOM Scanner / Mapper /
 * Highlighter. Injected on demand via chrome.scripting.executeScript
 * (activeTab + scripting), so there is no static content_scripts entry.
 */
(function (global) {
  "use strict";

  // Guard against duplicate listener registration when re-injected.
  if (global.__PAGESENSE_CONTENT_LOADED__) {
    return;
  }
  global.__PAGESENSE_CONTENT_LOADED__ = true;

  var ACTIONS = global.PAGESENSE.ACTIONS;
  var PS = global.PAGESENSE;
  var livePorts = new Set();
  var observer = null;
  var scanTimer = null;
  var scanScope = PS.SCAN_SCOPES.INTERACTIVE;

  function scan() {
    try {
      // IDs survive same-document rescans and scope changes; a stale card must
      // never silently target a different node after a Controller scan.
      if (!livePorts.size) global.PageSenseHighlighter.clearHighlight();
      var result = global.PageSenseScanner.scanPage({ preserveIds: true, scope: scanScope });
      // V2.0: the search index lives and dies with the scan it was built
      // from, so a stale elementId can never be returned by a search.
      global.PageSenseElementSearch.buildIndex(result.elements, result.scannedAt);
      return { ok: true, data: result };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) ? err.message : String(err)
      };
    }
  }

  function broadcast(result) {
    livePorts.forEach(function (port) {
      try { port.postMessage(result); } catch (err) { removePort(port); }
    });
  }

  function handleScan(message, sendResponse) {
    if (message.scope && Object.values(PS.SCAN_SCOPES).indexOf(message.scope) === -1) {
      sendResponse({ ok: false, error: "INVALID_PARAMS", message: "scope 必须为 interactive、content 或 all。" });
      return;
    }
    if (message.scope) scanScope = message.scope;
    var result = scan();
    sendResponse(result);
    // Controller/manual scans also refresh the subscribed panel and its IDs.
    broadcast(result);
  }

  function isOverlay(node) {
    var element = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(element && element.closest("[" + PS.OVERLAY_ATTR + "]"));
  }

  function isPageMutation(record) {
    if (isOverlay(record.target)) return false;
    if (record.type === "attributes") {
      return record.attributeName !== PS.PAGE_SENSE_ID_ATTR &&
        record.attributeName !== PS.OVERLAY_ATTR;
    }
    if (record.type === "childList") {
      return Array.prototype.some.call(record.addedNodes, function (node) {
        return !isOverlay(node);
      }) || Array.prototype.some.call(record.removedNodes, function (node) {
        return !isOverlay(node);
      });
    }
    return true;
  }

  // A fixed trailing window coalesces bursts without starving continuous input.
  function scheduleScan() {
    if (!livePorts.size || scanTimer !== null) return;
    scanTimer = global.setTimeout(function () {
      scanTimer = null;
      if (livePorts.size) broadcast(scan());
    }, PS.LIVE_SCAN.THROTTLE_MS);
  }

  function stopWatching() {
    if (observer) observer.disconnect();
    observer = null;
    global.clearTimeout(scanTimer);
    scanTimer = null;
    ["input", "change", "scroll", "resize"].forEach(function (event) {
      global.removeEventListener(event, scheduleScan, true);
    });
  }

  function removePort(port) {
    livePorts.delete(port);
    if (!livePorts.size) stopWatching();
  }

  if (global.chrome.runtime.onConnect) {
    global.chrome.runtime.onConnect.addListener(function (port) {
      if (port.name === PS.PICKER.PORT_NAME) {
        global.PageSenseElementPicker.start(port);
        return;
      }
      if (port.name !== PS.LIVE_SCAN.PORT_NAME) return;
      livePorts.add(port);
      port.onDisconnect.addListener(function () { removePort(port); });
      port.onMessage.addListener(function (message) {
        if (!message || !message.scope) return;
        scanScope = message.scope;
        broadcast(scan());
      });
      if (!observer) {
        observer = new global.MutationObserver(function (records) {
          if (records.some(isPageMutation)) scheduleScan();
        });
        observer.observe(global.document, {
          subtree: true, childList: true, characterData: true, attributes: true
        });
        ["input", "change", "scroll", "resize"].forEach(function (event) {
          global.addEventListener(event, scheduleScan, true);
        });
      }
    });
  }

  /**
   * V2.0 SEARCH_ELEMENTS. Searches the index built by the last SCAN_PAGE;
   * Keyword/attribute search uses the snapshot; optional CSS selectors match
   * current DOM nodes intersected with that snapshot's existing Element Map.
   */
  function handleSearch(message, sendResponse) {
    try {
      var options = {};
      ["limit", "offset", "type", "tag", "className", "id", "attributes", "inViewport", "includeIds"].forEach(function (key) {
        if (message[key] !== undefined) options[key] = message[key];
      });
      var domMatches = null;
      if (message.selector) {
        var nodes;
        try { nodes = global.document.querySelectorAll(message.selector); }
        catch (error) {
          sendResponse({ ok: false, error: "INVALID_SELECTOR", message: "CSS 选择器语法无效：" + error.message });
          return;
        }
        domMatches = nodes.length;
        options.elementIds = Array.prototype.map.call(nodes, function (node) {
          var id = Number(node.getAttribute(PS.PAGE_SENSE_ID_ATTR));
          return global.PageSenseElementMap.getElementById(id) === node ? id : null;
        }).filter(Boolean);
      }
      var outcome = global.PageSenseElementSearch.search(message.query, options);
      outcome.pageId = global.PageSenseScanner.pageId;
      if (domMatches !== null) outcome.domMatches = domMatches;
      if (!outcome.ok) {
        sendResponse({
          ok: false,
          error: outcome.error.code,
          message: outcome.error.message
        });
        return;
      }
      sendResponse({ ok: true, data: outcome });
    } catch (err) {
      sendResponse({
        ok: false,
        error: "INTERNAL_ERROR",
        message: (err && err.message) ? err.message : String(err)
      });
    }
  }

  function safeCall(method, args, sendResponse) {
    try {
      sendResponse(method.apply(null, args));
    } catch (err) {
      sendResponse({
        success: false,
        actionId: "act_" + Date.now().toString(36),
        timestamp: Date.now(),
        error: {
          code: "INTERNAL_ERROR",
          message: (err && err.message) ? err.message : String(err)
        }
      });
    }
  }

  global.chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.action) {
      return false;
    }

    if (message.pageId !== undefined && message.pageId !== global.PageSenseScanner.pageId) {
      sendResponse({ ok: false, success: false, message: "页面已变化，请重新定位元素。", error: { code: "STALE_PAGE", message: "页面已变化，请重新定位元素。" } });
      return false;
    }
    if (message.referenceId !== undefined) {
      if (typeof message.pageId !== "string" || !message.pageId) {
        sendResponse({ ok: false, success: false, error: { code: "INVALID_PARAMS", message: "节点引用必须包含 pageId。" } });
        return false;
      }
      try { message.elementId = global.PageSenseScanner.resolveReference(message.referenceId); }
      catch (error) {
        sendResponse({ ok: false, success: false, error: { code: error.code || "ELEMENT_NOT_FOUND", message: error.message } });
        return false;
      }
    }
    switch (message.action) {
      case ACTIONS.FIND_ELEMENTS:
      case ACTIONS.READ_ELEMENT:
      case ACTIONS.READ_ELEMENTS:
        try {
          var method = message.action === ACTIONS.FIND_ELEMENTS ? "findElements" :
            message.action === ACTIONS.READ_ELEMENT ? "readElement" : "readElements";
          sendResponse({ ok: true, data: global.PageSenseScanner[method](message) });
        } catch (error) { sendResponse({ ok: false, error: error.code || "INTERNAL_ERROR", message: error.message }); }
        return false;
      case ACTIONS.RESOLVE_ELEMENT:
        try { sendResponse(global.PageSenseScanner.resolveElement(message.selector, message.by)); }
        catch (error) { sendResponse({ ok: false, error: "INTERNAL_ERROR", message: error.message }); }
        return false;
      case ACTIONS.SCAN_PAGE:
        // scanPage() is synchronous in V1.x; if it becomes async later,
        // return true and call sendResponse after the promise settles.
        handleScan(message, sendResponse);
        return false;

      case ACTIONS.GET_ELEMENT_DETAILS:
        try { sendResponse(global.PageSenseScanner.inspectElement(message.elementId)); }
        catch (error) { sendResponse({ ok: false, error: "INTERNAL_ERROR", message: error.message }); }
        return false;

      case ACTIONS.SEARCH_ELEMENTS:
        handleSearch(message, sendResponse);
        return false;

      case ACTIONS.LOCATE_ELEMENT:
        safeCall(global.PageSenseHighlighter.locateElement, [message.elementId], sendResponse);
        return false;

      case ACTIONS.HIGHLIGHT_ELEMENT:
        safeCall(global.PageSenseHighlighter.highlightElement, [message.elementId], sendResponse);
        return false;

      case ACTIONS.CLEAR_HIGHLIGHT:
        safeCall(function () { return global.PageSenseHighlighter.clearHighlight(); }, [], sendResponse);
        return false;

      case ACTIONS.CLICK_ELEMENT:
        safeCall(global.PageSenseActionExecutor.click, [message.elementId], sendResponse);
        return false;

      case ACTIONS.INPUT_ELEMENT:
        safeCall(
          global.PageSenseActionExecutor.input,
          [message.elementId, message.value],
          sendResponse
        );
        return false;

      case ACTIONS.CLEAR_ELEMENT:
        safeCall(global.PageSenseActionExecutor.clear, [message.elementId], sendResponse);
        return false;

      case ACTIONS.KEYPRESS_ELEMENT:
        safeCall(
          global.PageSenseActionExecutor.keypress,
          [message.elementId, message.key],
          sendResponse
        );
        return false;

      case ACTIONS.SCROLL_PAGE:
        safeCall(
          global.PageSenseActionExecutor.scrollPage,
          [message.direction, message.amount],
          sendResponse
        );
        return false;

      default:
        return false; // message not for PageSense; let other listeners handle it
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
