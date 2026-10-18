/*
 * PageSense - popup/popup.js
 * Side panel controller: injects the content scripts on demand, runs the scan,
 * renders element cards, handles search/filter, copy and export.
 * All DOM scanning happens in content/scanner.js; this file only talks to it.
 */
(function () {
  "use strict";

  var PAGESENSE = window.PAGESENSE;

  /* ---- DOM references ------------------------------------------------ */

  var els = {
    currentPageTitle: document.getElementById("currentPageTitle"),
    currentPageUrl: document.getElementById("currentPageUrl"),
    scanBtn: document.getElementById("scanBtn"),
    pickElementBtn: document.getElementById("pickElementBtn"),
    pickStatus: document.getElementById("pickStatus"),
    pickedElementPanel: document.getElementById("pickedElementPanel"),
    pickedElementSummary: document.getElementById("pickedElementSummary"),
    pickedElementDetails: document.getElementById("pickedElementDetails"),
    clearPickedBtn: document.getElementById("clearPickedBtn"),
    copyPickedCssBtn: document.getElementById("copyPickedCssBtn"),
    copyPickedTextBtn: document.getElementById("copyPickedTextBtn"),
    scanScope: document.getElementById("scanScope"),
    liveScanToggle: document.getElementById("liveScanToggle"),
    liveScanStatus: document.getElementById("liveScanStatus"),
    errorBox: document.getElementById("errorBox"),
    devLog: document.getElementById("devLog"),
    resultPanel: document.getElementById("resultPanel"),
    statTotal: document.getElementById("statTotal"),
    statInViewport: document.getElementById("statInViewport"),
    statHidden: document.getElementById("statHidden"),
    detailDomain: document.getElementById("detailDomain"),
    detailViewport: document.getElementById("detailViewport"),
    detailScroll: document.getElementById("detailScroll"),
    searchInput: document.getElementById("searchInput"),
    searchClearBtn: document.getElementById("searchClearBtn"),
    searchStatus: document.getElementById("searchStatus"),
    filterBar: document.getElementById("filterBar"),
    tagFilter: document.getElementById("tagFilter"),
    classFilter: document.getElementById("classFilter"),
    idFilter: document.getElementById("idFilter"),
    cssFilter: document.getElementById("cssFilter"),
    attributeFilter: document.getElementById("attributeFilter"),
    viewportFilter: document.getElementById("viewportFilter"),
    clearFiltersBtn: document.getElementById("clearFiltersBtn"),
    prevPageBtn: document.getElementById("prevPageBtn"),
    nextPageBtn: document.getElementById("nextPageBtn"),
    pageSize: document.getElementById("pageSize"),
    pageStatus: document.getElementById("pageStatus"),
    listMeta: document.getElementById("listMeta"),
    elementList: document.getElementById("elementList"),
    rescanHint: document.getElementById("rescanHint"),
    rescanHintBtn: document.getElementById("rescanHintBtn"),
    scrollControls: document.getElementById("scrollControls"),
    actionLogList: document.getElementById("actionLogList"),
    rawJson: document.getElementById("rawJson"),
    copyBtn: document.getElementById("copyBtn"),
    exportBtn: document.getElementById("exportBtn"),
    clearHighlightBtn: document.getElementById("clearHighlightBtn"),
    toast: document.getElementById("toast"),
    // V2.0 Controller panel
    controllerPanel: document.getElementById("controllerPanel"),
    controllerDot: document.getElementById("controllerDot"),
    controllerStateInline: document.getElementById("controllerStateInline"),
    controllerStateText: document.getElementById("controllerStateText"),
    controllerEndpoint: document.getElementById("controllerEndpoint"),
    controllerPort: document.getElementById("controllerPort"),
    controllerToken: document.getElementById("controllerToken"),
    controllerConnectBtn: document.getElementById("controllerConnectBtn"),
    controllerDisconnectBtn: document.getElementById("controllerDisconnectBtn"),
    controllerError: document.getElementById("controllerError"),
    controllerLog: document.getElementById("controllerLog")
  };

  /**
   * Files injected into the active tab, in dependency order.
   * Must stay in sync with PageSenseBridge.CONTENT_FILES so the Popup and the
   * Controller always drive the exact same Content Script.
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

  var Search = window.PageSenseElementSearch;

  var MESSAGE_TIMEOUT_MS = 8000;

  /* ---- Popup state --------------------------------------------------- */

  var state = {
    tab: null,
    scan: null,
    filter: PAGESENSE.FILTERS.ALL,
    query: "",
    scanning: false,
    liveEnabled: false,
    offset: 0,
    cssMatch: null,
    picked: null,
    // Invalidates pending work when the persistent panel changes pages.
    pageRevision: 0,
    /** Search index built from the most recent scan; null before any scan. */
    searchIndex: null
  };

  // A side panel belongs to its own browser window, even if another is focused.
  var panelWindow = chrome.windows.getCurrent();
  var livePort = null;
  var liveGeneration = 0;
  var liveConnectTimer = null;
  var composingInput = null;
  var pendingLiveScan = null;
  var selectorSequence = 0;
  var selectorTimer = null;
  var detailSequence = 0;
  var pickerPort = null;
  var pickerGeneration = 0;
  var pickerTimer = null;
  var pickerActive = false;

  /* ---- Small utilities ----------------------------------------------- */

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** Local-time stamp for the exported file name: YYYY-MM-DD_HHMMSS. */
  function formatFileTimestamp(date) {
    return (
      date.getFullYear() +
      "-" + pad2(date.getMonth() + 1) +
      "-" + pad2(date.getDate()) +
      "_" + pad2(date.getHours()) +
      pad2(date.getMinutes()) +
      pad2(date.getSeconds())
    );
  }

  var toastTimer = null;
  function showToast(message, kind) {
    els.toast.textContent = message;
    els.toast.className = "toast" + (kind ? " toast-" + kind : "");
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      els.toast.className = "toast hidden";
    }, 2200);
  }

  function showError(devMessage) {
    els.errorBox.classList.remove("hidden");
    els.devLog.textContent = devMessage || "(no detail)";
  }

  function hideError() {
    els.errorBox.classList.add("hidden");
    els.devLog.textContent = "";
  }

  async function getActiveTab() {
    var owner = await panelWindow;
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ active: true, windowId: owner.id }, function (tabs) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!tabs || tabs.length === 0) {
          reject(new Error("NO_ACTIVE_TAB"));
          return;
        }
        resolve(tabs[0]);
      });
    });
  }

  /* ---- Content script injection & messaging -------------------------- */

  function injectContentScripts(tabId) {
    return chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: CONTENT_FILES
    });
  }

  function requestScan(tabId) {
    return new Promise(function (resolve, reject) {
      var settled = false;

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("SCAN_TIMEOUT: content script did not respond within " +
          MESSAGE_TIMEOUT_MS + "ms (page may be loading or refreshing)"));
      }, MESSAGE_TIMEOUT_MS);

      chrome.tabs.sendMessage(
        tabId,
        { action: PAGESENSE.ACTIONS.SCAN_PAGE, scope: els.scanScope.value },
        function (response) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error("EMPTY_RESPONSE: content script returned nothing"));
            return;
          }
          if (!response.ok) {
            reject(new Error("SCAN_ERROR: " + response.error));
            return;
          }
          resolve(response.data);
        }
      );
    });
  }

  /* ---- Locate / Highlight messaging ---------------------------------- */

  /**
   * Send any message to the content script with timeout protection.
   * Resolves with the content-script result envelope.
   */
  function requestMessage(tabId, payload) {
    return new Promise(function (resolve, reject) {
      var settled = false;

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("ACTION_TIMEOUT: content script did not respond"));
      }, MESSAGE_TIMEOUT_MS);

      chrome.tabs.sendMessage(tabId, payload, function (response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("EMPTY_RESPONSE"));
          return;
        }
        resolve(response);
      });
    });
  }

  /* ---- Action Log & rescan hint --------------------------------------- */

  var actionLog = [];
  var LOG_LIMIT = 20;

  function logTime(date) {
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) +
      ":" + pad2(date.getSeconds());
  }

  /** Short human description of an action request. */
  function describeAction(payload) {
    var a = payload.action;
    if (a === PAGESENSE.ACTIONS.SCROLL_PAGE) {
      return "SCROLL " + payload.direction + " " + payload.amount;
    }
    var map = {};
    map[PAGESENSE.ACTIONS.CLICK_ELEMENT] = "CLICK";
    map[PAGESENSE.ACTIONS.INPUT_ELEMENT] = "INPUT";
    map[PAGESENSE.ACTIONS.CLEAR_ELEMENT] = "CLEAR";
    map[PAGESENSE.ACTIONS.KEYPRESS_ELEMENT] = "KEY";
    map[PAGESENSE.ACTIONS.LOCATE_ELEMENT] = "LOCATE";
    map[PAGESENSE.ACTIONS.HIGHLIGHT_ELEMENT] = "HIGHLIGHT";
    map[PAGESENSE.ACTIONS.CLEAR_HIGHLIGHT] = "CLEAR_HL";
    var name = map[a] || a;
    var detail = "";
    if (payload.elementId != null) {
      detail = "#" + payload.elementId;
    }
    if (a === PAGESENSE.ACTIONS.INPUT_ELEMENT) {
      detail += ' "' + payload.value + '"';
    }
    if (a === PAGESENSE.ACTIONS.KEYPRESS_ELEMENT) {
      detail += " " + (payload.key === " " ? "Space" : payload.key);
    }
    return name + (detail ? " " + detail : "");
  }

  function addLogEntry(payload, result) {
    actionLog.push({
      time: logTime(new Date()),
      text: describeAction(payload),
      success: Boolean(result && result.success),
      errorCode: result && result.error ? result.error.code : null
    });
    if (actionLog.length > LOG_LIMIT) {
      actionLog = actionLog.slice(actionLog.length - LOG_LIMIT);
    }
    renderActionLog();
  }

  function renderActionLog() {
    if (actionLog.length === 0) {
      els.actionLogList.innerHTML =
        '<div class="action-log-empty">（暂无 Action）</div>';
      return;
    }
    els.actionLogList.innerHTML = actionLog.map(function (entry) {
      var status = entry.success
        ? '<span class="log-status log-ok">success</span>'
        : '<span class="log-status log-fail">' +
          escapeHtml(entry.errorCode || "failed") + "</span>";
      return (
        '<div class="action-log-item">' +
          '<span class="log-time">' + entry.time + "</span>" +
          "<span> " + escapeHtml(entry.text) + " → </span>" +
          status +
        "</div>"
      );
    }).join("");
  }

  function showRescanHint(show) {
    els.rescanHint.classList.toggle("hidden", !show);
  }

  /* ---- Rendering ----------------------------------------------------- */

  function renderPageHeader(tab) {
    els.currentPageTitle.textContent = tab.title || tab.url || "(未知页面)";
    els.currentPageUrl.textContent = tab.url || "";
    els.currentPageUrl.title = tab.url || "";
  }

  /** A persistent panel must never retain actionable results from another page. */
  function resetPage(tab, preserveControls) {
    stopPicking();
    clearPickedElement();
    els.pickStatus.textContent = "点击按钮后，到网页中选择元素；Esc 取消。";
    stopLiveScan();
    if (state.liveEnabled) els.liveScanStatus.textContent = "等待页面就绪…";
    state.pageRevision++;
    state.tab = tab;
    state.scan = null;
    state.cssMatch = null;
    selectorSequence++;
    detailSequence++;
    clearTimeout(selectorTimer);
    state.searchIndex = null;
    Search.clearIndex();
    if (!preserveControls) {
      state.query = "";
      state.filter = PAGESENSE.FILTERS.ALL;
      els.searchInput.value = "";
      [els.tagFilter, els.classFilter, els.idFilter, els.cssFilter, els.attributeFilter].forEach(function (input) { input.value = ""; });
      els.viewportFilter.checked = false;
      state.offset = 0;
    }
    syncSearchClear();
    els.filterBar.querySelectorAll(".filter-chip").forEach(function (chip) {
      chip.classList.toggle("active", chip.getAttribute("data-filter") === state.filter);
    });
    els.resultPanel.classList.add("hidden");
    els.elementList.innerHTML = "";
    els.rawJson.textContent = "";
    els.searchStatus.textContent = "";
    els.pageStatus.textContent = "";
    els.elementList.classList.remove("is-query-pending");
    els.copyBtn.disabled = true;
    els.exportBtn.disabled = true;
    els.clearHighlightBtn.disabled = true;
    if (!preserveControls) {
      actionLog = [];
      renderActionLog();
    }
    hideError();
    showRescanHint(false);
    if (toastTimer) clearTimeout(toastTimer);
    els.toast.className = "toast hidden";
    setScanning(false);
    renderPageHeader(tab || { title: "读取中…" });
  }

  function refreshActiveTab() {
    var revision = state.pageRevision;
    return getActiveTab().then(function (tab) {
      if (revision !== state.pageRevision) return;
      state.tab = tab;
      renderPageHeader(tab);
      if (state.liveEnabled) startLiveScan();
    }).catch(function (e) {
      if (revision !== state.pageRevision) return;
      els.currentPageTitle.textContent = "(无法读取当前标签页)";
      els.currentPageUrl.textContent = e.message;
    });
  }

  function renderScan(scan, preserveDrafts) {
    var drafts = [];
    var listScroll = els.elementList.scrollTop;
    var main = document.querySelector(".app-main");
    var mainScroll = main.scrollTop;
    var openDetails = preserveDrafts ? Array.prototype.map.call(
      els.elementList.querySelectorAll(".element-inspector[open]"), function (node) { return node.dataset.inspectId; }
    ) : [];
    if (preserveDrafts) {
      els.elementList.querySelectorAll("[data-input-for]").forEach(function (input) {
        drafts.push({
          selector: '[data-input-for="' + input.getAttribute("data-input-for") + '"]',
          value: input.value,
          focused: document.activeElement === input,
          start: input.selectionStart, end: input.selectionEnd
        });
      });
    }
    var stats = scan.stats;
    els.statTotal.textContent = String(stats.total);
    els.statInViewport.textContent = String(stats.inViewport);
    els.statHidden.textContent = String(stats.hidden);

    els.detailDomain.textContent = scan.page.domain || "(unknown)";
    els.detailViewport.textContent =
      scan.page.viewport.width + " × " + scan.page.viewport.height;
    els.detailScroll.textContent =
      "x: " + scan.page.scroll.x + ", y: " + scan.page.scroll.y;

    els.rawJson.textContent = JSON.stringify(scan, null, 2);

    // V2.0: the search index is rebuilt from scratch on every scan, exactly
    // like the Content Script does, so results can never reference elements
    // from a previous DOM state.
    state.searchIndex = Search.buildIndex(scan.elements, scan.scannedAt);
    renderElementList();
    drafts.forEach(function (draft) {
      var input = els.elementList.querySelector(draft.selector);
      if (!input) return;
      input.value = draft.value;
      if (draft.focused) {
        input.focus({ preventScroll: true });
        if (draft.start !== null && typeof input.setSelectionRange === "function") {
          input.setSelectionRange(draft.start, draft.end);
        }
      }
    });
    if (preserveDrafts) {
      els.elementList.scrollTop = listScroll;
      main.scrollTop = mainScroll;
    }
    openDetails.forEach(function (id) {
      var details = els.elementList.querySelector('[data-inspect-id="' + id + '"]');
      if (details) details.open = true;
    });
  }

  function acceptScan(scan, live) {
    // Replacing an IME's input node aborts its uncommitted composition.
    // Keep only the latest update and apply it after composition finishes.
    if (live && composingInput && composingInput.isConnected) {
      pendingLiveScan = scan;
      return false;
    }
    pendingLiveScan = null;
    state.scan = scan;
    els.resultPanel.classList.remove("hidden");
    els.copyBtn.disabled = false;
    els.exportBtn.disabled = false;
    els.clearHighlightBtn.disabled = false;
    renderScan(scan, live);
    showRescanHint(false);
    return true;
  }

  /* ---- Live subscription (the content port owns observer lifetime) ---- */

  function stopLiveScan() {
    liveGeneration++;
    pendingLiveScan = null;
    composingInput = null;
    clearTimeout(liveConnectTimer);
    liveConnectTimer = null;
    var port = livePort;
    livePort = null;
    if (port) port.disconnect();
  }

  async function startLiveScan() {
    stopLiveScan();
    if (!state.liveEnabled) return;
    var generation = liveGeneration;
    var revision = state.pageRevision;
    function current() {
      return state.liveEnabled && generation === liveGeneration && revision === state.pageRevision;
    }
    els.liveScanStatus.textContent = "正在连接…";
    try {
      var tab = await getActiveTab();
      if (!current()) return;
      state.tab = tab;
      renderPageHeader(tab);
      if (tab.status === "loading") {
        els.liveScanStatus.textContent = "等待页面就绪…";
        return;
      }
      var inspection = PAGESENSE.inspectUrl(tab.url);
      if (inspection.restricted) {
        els.liveScanStatus.textContent = "此页面不支持扫描，切换网页后继续";
        return;
      }
      await injectContentScripts(tab.id);
      if (!current()) return;
      var port = chrome.tabs.connect(tab.id, { name: PAGESENSE.LIVE_SCAN.PORT_NAME });
      livePort = port;
      els.liveScanStatus.textContent = "正在扫描…";
      // Bound the first response just like a manual scan.
      liveConnectTimer = setTimeout(function () {
        if (!current() || livePort !== port) return;
        stopLiveScan();
        els.liveScanStatus.textContent = "连接超时，点击扫描重试";
      }, MESSAGE_TIMEOUT_MS);
      port.onMessage.addListener(function (response) {
        if (!current() || livePort !== port) return;
        if (response.ok && response.data.scope && response.data.scope !== els.scanScope.value) return;
        clearTimeout(liveConnectTimer);
        liveConnectTimer = null;
        if (!response.ok) {
          stopLiveScan();
          els.liveScanStatus.textContent = "扫描失败，点击扫描重试";
          showError("Live scan failed: " + response.error);
          return;
        }
        hideError();
        var rendered = acceptScan(response.data, true);
        els.liveScanStatus.textContent = rendered
          ? "监听中 · 更新于 " + logTime(new Date(response.data.scannedAt))
          : "输入中 · 完成后更新";
      });
      port.onDisconnect.addListener(function () {
        var error = chrome.runtime.lastError;
        if (!current() || livePort !== port) return;
        stopLiveScan();
        els.liveScanStatus.textContent = "连接中断，点击扫描重试";
        if (error) showError("Live scan disconnected: " + error.message);
      });
      port.postMessage({ scope: els.scanScope.value });
    } catch (error) {
      if (!current()) return;
      stopLiveScan();
      els.liveScanStatus.textContent = "无法连接，点击扫描重试";
      showError("Live scan failed: " + error.message);
    }
  }

  /**
   * @param {Object} el serialized element
   * @param {(number|null)=} score search relevance, null when not searching
   * @param {Array<string>=} matchedFields fields the query matched
   */
  function elementCardHtml(el, score, matchedFields) {
    var classes = ["element-card"];
    if (el.disabled) {
      classes.push("is-disabled");
    }
    var badges = [];
    badges.push('<span class="badge">' + escapeHtml(PAGESENSE.FILTER_LABELS[el.category] || el.category || "") + "</span>");
    if (el.inViewport) {
      badges.push('<span class="badge badge-viewport">视口内</span>');
    } else {
      badges.push('<span class="badge badge-offscreen">视口外</span>');
    }
    if (el.disabled) {
      badges.push('<span class="badge badge-disabled">disabled</span>');
    }

    var textHtml = el.text
      ? escapeHtml(el.text)
      : '<span style="color:var(--ps-text-muted)">(无文本)</span>';

    var sub = [];
    sub.push(
      '<span class="element-coords">x: ' + el.position.x +
      ' y: ' + el.position.y +
      ' &nbsp;·&nbsp; ' + el.position.width +
      ' × ' + el.position.height + '</span>'
    );
    if (el.id) sub.push("id: " + escapeHtml(el.id));
    if (el.className) sub.push("class: " + escapeHtml(el.className));
    if (el.name) sub.push("name: " + escapeHtml(el.name));
    if (el.type) sub.push("type: " + escapeHtml(el.type));
    if (el.placeholder) sub.push("placeholder: " + escapeHtml(el.placeholder));
    if (el.ariaLabel) sub.push("aria-label: " + escapeHtml(el.ariaLabel));
    if (el.title) sub.push("title: " + escapeHtml(el.title));
    if (el.href) sub.push("href: " + escapeHtml(el.href));
    if (el.alt) sub.push("alt: " + escapeHtml(el.alt));
    if (el.selector) sub.push('<code class="element-selector">' + escapeHtml(el.selector) + "</code>");
    if (el.textLength > PAGESENSE.MAX_TEXT_LENGTH) sub.push("文本 " + el.textLength + " 字符（卡片为预览）");

    var actionButtons = [];
    actionButtons.push(
      '<button type="button" class="element-action-btn" data-card-action="locate" ' +
        'data-element-id="' + el.elementId + '">定位</button>',
      '<button type="button" class="element-action-btn" data-card-action="highlight" ' +
        'data-element-id="' + el.elementId + '">高亮</button>'
    );
    if (PAGESENSE.isClickableElement(el)) {
      actionButtons.push(
        '<button type="button" class="element-action-btn element-action-primary" ' +
          'data-card-action="click" data-element-id="' + el.elementId + '">点击</button>'
      );
    }
    actionButtons.push(
      '<button type="button" class="element-action-btn" data-card-action="copy-selector" data-element-id="' +
      el.elementId + '">复制 CSS</button>',
      '<button type="button" class="element-action-btn" data-card-action="copy-text" data-element-id="' +
      el.elementId + '">复制文本</button>'
    );

    var textEntry = "";
    if (PAGESENSE.isTextEntryElement(el)) {
      textEntry =
        '<div class="card-input-row">' +
          '<input type="text" class="card-text-input" data-input-for="' +
            el.elementId + '" placeholder="输入内容…" autocomplete="off" />' +
          '<button type="button" class="element-action-btn" data-card-action="input" ' +
            'data-element-id="' + el.elementId + '">输入</button>' +
          '<button type="button" class="element-action-btn" data-card-action="clear" ' +
            'data-element-id="' + el.elementId + '">清空</button>' +
          '<button type="button" class="element-action-btn" data-card-action="keypress" ' +
            'data-key="Enter" data-element-id="' + el.elementId + '">Enter</button>' +
        "</div>";
    }

    var matchHtml = "";
    if (score !== null && score !== undefined) {
      matchHtml =
        '<div class="element-match">匹配：' +
          escapeHtml((matchedFields && matchedFields.length)
            ? matchedFields.join(", ")
            : "(空查询)") +
          ' &nbsp;·&nbsp; score: <span class="match-score">' +
          escapeHtml(score) + "</span></div>";
    }

    return (
      '<div class="' + classes.join(" ") + '" data-record-id="' + el.elementId + '">' +
        '<div class="element-card-head">' +
          '<span class="element-id">#' + el.elementId + '</span>' +
          '<span class="element-tag">' + escapeHtml(el.tag) + "</span>" +
          '<span class="element-badges">' + badges.join("") + "</span>" +
        "</div>" +
        '<div class="element-text">' + textHtml + "</div>" +
        '<div class="element-sub">' + sub.join("<br />") + "</div>" +
        matchHtml +
        '<div class="element-actions">' + actionButtons.join("") + "</div>" +
        textEntry +
        '<details class="element-inspector" data-inspect-id="' + el.elementId + '">' +
          '<summary>元素详情 · 属性 / 层级 / HTML</summary>' +
          '<div class="inspector-body">展开后读取当前元素</div>' +
        "</details>" +
      "</div>"
    );
  }

  /**
   * Render the element list for the current query + type filter.
   *
   * The query goes through the same element-search module the Content Script
   * uses for SEARCH_ELEMENTS, so the Popup and the Controller can never
   * disagree about what "搜索" matches or how results are ranked.
   * Query and type filter combine with AND.
   */
  function resolveCss(selector) {
    var scan = state.scan, revision = state.pageRevision;
    var sequence = ++selectorSequence;
    state.cssMatch = { scan: scan, selector: selector, pending: true };
    clearTimeout(selectorTimer);
    selectorTimer = setTimeout(async function () {
      try {
        var response = await requestMessage(state.tab.id, {
          action: PAGESENSE.ACTIONS.SEARCH_ELEMENTS, selector: selector,
          query: "", includeIds: true, limit: 1
        });
        if (sequence !== selectorSequence || revision !== state.pageRevision || scan !== state.scan) return;
        state.cssMatch = { scan: scan, selector: selector,
          ids: response.ok ? response.data.matchingIds : [],
          domMatches: response.ok ? response.data.domMatches : 0,
          error: response.ok ? null : (response.message || response.error) };
      } catch (error) {
        if (sequence !== selectorSequence || revision !== state.pageRevision || scan !== state.scan) return;
        state.cssMatch = { scan: scan, selector: selector, ids: [], error: error.message };
      }
      renderScan(state.scan, true);
    }, 160);
  }

  function renderElementList() {
    if (!state.scan) return;
    var query = state.query.trim(), selector = els.cssFilter.value.trim();
    els.filterBar.querySelectorAll(".filter-chip").forEach(function (chip) {
      var filter = chip.dataset.filter;
      var count = state.scan.elements.filter(function (element) {
        return PAGESENSE.matchesFilter(element, filter);
      }).length;
      chip.textContent = (PAGESENSE.FILTER_LABELS[filter] || filter) + " " + count;
      chip.classList.toggle("active", state.filter === filter);
      chip.setAttribute("aria-pressed", String(state.filter === filter));
    });
    var options = {
      limit: Number(els.pageSize.value), offset: state.offset, type: state.filter,
      tag: els.tagFilter.value.trim(), className: els.classFilter.value.trim(),
      id: els.idFilter.value.trim(), inViewport: els.viewportFilter.checked
    };
    var error;
    try {
      if (els.attributeFilter.value.trim()) options.attributes = JSON.parse(els.attributeFilter.value);
    } catch (e) { error = "属性 JSON 格式无效：" + e.message; }
    if (selector && !error) {
      var match = state.cssMatch;
      if (!match || match.scan !== state.scan || match.selector !== selector) {
        resolveCss(selector);
        match = state.cssMatch;
      }
      if (match.pending) {
        els.listMeta.textContent = "正在匹配 CSS 选择器…";
        els.elementList.classList.add("is-query-pending");
        return;
      }
      error = match.error;
      options.elementIds = match.ids;
    }
    els.elementList.classList.remove("is-query-pending");
    if (error) {
      els.listMeta.textContent = error;
      els.searchStatus.textContent = "查询条件有误";
      els.elementList.innerHTML = "";
      els.prevPageBtn.disabled = els.nextPageBtn.disabled = true;
      els.pageStatus.textContent = "";
      return;
    }
    var outcome = Search.search(query, options);
    if (!outcome.ok) {
      els.listMeta.textContent = outcome.error.message;
      els.searchStatus.textContent = "查询条件有误";
      els.pageStatus.textContent = "";
      els.elementList.innerHTML = '<div class="empty-list">搜索索引不可用或查询条件有误</div>';
      els.prevPageBtn.disabled = els.nextPageBtn.disabled = true;
      return;
    }
    if (outcome.total && state.offset >= outcome.total) {
      state.offset = Math.floor((outcome.total - 1) / options.limit) * options.limit;
      options.offset = state.offset;
      outcome = Search.search(query, options);
    }
    if (!outcome.total) state.offset = 0;
    var from = outcome.total ? state.offset + 1 : 0;
    var to = state.offset + outcome.returned;
    els.listMeta.textContent = (query ? "搜索 “" + query + "”" : "分类 " +
      (PAGESENSE.FILTER_LABELS[state.filter] || state.filter)) +
      "：" + outcome.total + " 个结果 · 显示 " + from + "–" + to +
      (selector ? " · CSS 在 DOM 中匹配 " + state.cssMatch.domMatches + " 个（与扫描范围取交集）" : "");
    els.searchStatus.innerHTML = "扫描元素：<strong>" + state.scan.elements.length +
      "</strong> 个 · 搜索结果：<strong>" + outcome.total + "</strong> 个" +
      (!query && state.filter === "all" && !selector && outcome.total <= options.limit ? " · 当前显示全部" : "");
    els.pageStatus.textContent = (outcome.total ? Math.floor(state.offset / options.limit) + 1 : 0) +
      " / " + Math.ceil(outcome.total / options.limit);
    els.prevPageBtn.disabled = state.offset === 0;
    els.nextPageBtn.disabled = !outcome.truncated;
    var byId = {};
    state.scan.elements.forEach(function (element) { byId[element.elementId] = element; });
    els.elementList.innerHTML = outcome.results.length ? outcome.results.map(function (result) {
      return elementCardHtml(byId[result.elementId] || result.element,
        query ? result.score : null, result.matchedFields);
    }).join("") : '<div class="empty-list">没有匹配的元素</div>';
  }

  /* ---- Copy / Export ------------------------------------------------- */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function exportJson(scan) {
    var json = JSON.stringify(scan, null, 2);
    var blob = new Blob([json], { type: "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob);

    var domain = PAGESENSE.sanitizeFilePart(scan.page.domain) || "page";
    var date = scan.scannedAt ? new Date(scan.scannedAt) : new Date();
    var fileName = "pagesense_" + domain + "_" + formatFileTimestamp(date) + ".json";

    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);

    return fileName;
  }

  /* ---- Scan orchestration -------------------------------------------- */

  function setScanning(scanning) {
    state.scanning = scanning;
    els.scanBtn.disabled = scanning;
    els.scanScope.disabled = scanning;
    els.pickElementBtn.disabled = scanning;
    els.scanBtn.textContent = scanning ? "扫描中…" : "扫描当前页面";
  }

  async function runScan() {
    if (state.scanning) return;
    var revision = state.pageRevision;
    hideError();
    showRescanHint(false);
    setScanning(true);

    var tab;
    var inspection;
    try {
      tab = await getActiveTab();
      if (revision !== state.pageRevision) return;
      resetPage(tab, state.tab && state.tab.id === tab.id && state.tab.url === tab.url);
      revision = state.pageRevision;
      setScanning(true);
      renderPageHeader(tab);

      if (typeof tab.id !== "number") {
        throw new Error("Active tab has no numeric id");
      }

      inspection = PAGESENSE.inspectUrl(tab.url);
      if (inspection.restricted) {
        throw new Error("URL pre-check blocked injection: " + inspection.reason);
      }

      await injectContentScripts(tab.id);
      if (revision !== state.pageRevision) return;
      var scan = await requestScan(tab.id);
      if (revision !== state.pageRevision) return;

      acceptScan(scan, false);
      showToast("扫描完成：" + scan.stats.total + " 个元素", "success");
      if (state.liveEnabled) startLiveScan();
    } catch (e) {
      if (revision !== state.pageRevision) return;
      var detail = "URL: " + (tab ? tab.url : "(unavailable)") +
        "\nURL check: " + JSON.stringify(inspection) +
        "\nError: " + e.message;
      if (inspection && inspection.reason === "FILE_URL_MAY_NEED_ACCESS_TOGGLE") {
        detail += "\nHint: enable 'Allow access to file URLs' for PageSense " +
          "on the extensions page.";
      }
      showError(detail);
      showToast("扫描失败", "error");
      if (state.liveEnabled) els.liveScanStatus.textContent = "扫描失败，点击扫描重试";
    } finally {
      if (revision === state.pageRevision) setScanning(false);
    }
  }

  /* ---- Event wiring -------------------------------------------------- */

  els.scanBtn.addEventListener("click", function () {
    runScan();
  });

  els.scanScope.addEventListener("change", function () {
    if (state.scanning) return;
    if (state.liveEnabled) {
      resetPage(state.tab, true);
      startLiveScan();
    } else if (state.scan) runScan();
  });

  els.liveScanToggle.addEventListener("change", function () {
    state.liveEnabled = els.liveScanToggle.checked;
    if (state.liveEnabled) {
      startLiveScan();
    } else {
      stopLiveScan();
      els.liveScanStatus.textContent = "已暂停 · 保留最近结果";
    }
  });

  window.addEventListener("pagehide", stopLiveScan);
  window.addEventListener("pagehide", stopPicking);
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !pickerActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopPicking();
    els.pickStatus.textContent = "已取消页面选择。";
  }, true);

  /* ---- Point-and-inspect, independent of the scan/search result list -- */

  function stopPicking() {
    pickerGeneration++;
    pickerActive = false;
    clearTimeout(pickerTimer);
    pickerTimer = null;
    var port = pickerPort;
    pickerPort = null;
    if (port) port.disconnect();
    els.pickElementBtn.textContent = "在页面选择元素";
    els.pickElementBtn.setAttribute("aria-pressed", "false");
  }

  function clearPickedElement() {
    state.picked = null;
    els.pickedElementPanel.classList.add("hidden");
    els.pickedElementSummary.textContent = "";
    els.pickedElementDetails.textContent = "";
  }

  async function startPicking() {
    stopPicking();
    clearPickedElement();
    pickerActive = true;
    var generation = pickerGeneration, revision = state.pageRevision;
    function current() {
      return pickerActive && generation === pickerGeneration && revision === state.pageRevision;
    }
    els.pickElementBtn.textContent = "取消选择";
    els.pickElementBtn.setAttribute("aria-pressed", "true");
    els.pickStatus.textContent = "正在准备页面选择…";
    hideError();
    try {
      var tab = await getActiveTab();
      if (!current()) return;
      state.tab = tab;
      renderPageHeader(tab);
      if (PAGESENSE.inspectUrl(tab.url).restricted) {
        stopPicking();
        els.pickStatus.textContent = "此页面不支持选择元素，请切换到普通网页。";
        return;
      }
      if (tab.status === "loading") {
        stopPicking();
        els.pickStatus.textContent = "页面正在加载，请就绪后重新选择。";
        return;
      }
      await injectContentScripts(tab.id);
      if (!current()) return;
      var port = chrome.tabs.connect(tab.id, { name: PAGESENSE.PICKER.PORT_NAME });
      pickerPort = port;
      pickerTimer = setTimeout(function () {
        if (!current() || pickerPort !== port) return;
        stopPicking();
        els.pickStatus.textContent = "页面选择连接超时，请点击按钮重试。";
      }, MESSAGE_TIMEOUT_MS);
      port.onMessage.addListener(function (message) {
        if (!current() || pickerPort !== port) return;
        clearTimeout(pickerTimer);
        pickerTimer = null;
        if (message.type === "started") {
          els.pickStatus.textContent = "请到网页悬停并点击元素；Esc 或再次点击按钮取消。";
        } else if (message.type === "selected") {
          var data = message.data;
          stopPicking();
          state.picked = data;
          var element = data.element, rect = element.position;
          els.pickedElementSummary.textContent = "<" + element.tag + "> · #" + element.elementId +
            " · " + (PAGESENSE.FILTER_LABELS[element.category] || element.category) +
            " · x: " + rect.x + ", y: " + rect.y + " · " + rect.width + " × " + rect.height;
          els.pickedElementDetails.innerHTML = inspectorHtml(data, false);
          els.pickedElementPanel.classList.remove("hidden");
          els.pickedElementPanel.scrollIntoView({ block: "start" });
          els.pickStatus.textContent = "已选中 <" + element.tag + ">，信息已显示。";
        } else if (message.type === "cancelled") {
          stopPicking();
          els.pickStatus.textContent = "已取消页面选择。";
        } else if (message.type === "error") {
          stopPicking();
          els.pickStatus.textContent = "选择失败：" + message.error;
        }
      });
      port.onDisconnect.addListener(function () {
        var error = chrome.runtime.lastError;
        if (!current() || pickerPort !== port) return;
        stopPicking();
        els.pickStatus.textContent = "页面选择已断开，请重试。";
        if (error) showError(error.message);
      });
    } catch (error) {
      if (!current()) return;
      stopPicking();
      els.pickStatus.textContent = "无法开启页面选择，请重试。";
      showError(error.message);
    }
  }

  els.pickElementBtn.addEventListener("click", function () {
    if (pickerActive) {
      stopPicking();
      els.pickStatus.textContent = "已取消页面选择。";
    } else startPicking();
  });
  els.clearPickedBtn.addEventListener("click", function () {
    clearPickedElement();
    els.pickStatus.textContent = "已清除选择，可重新选择其他元素。";
  });
  [els.copyPickedCssBtn, els.copyPickedTextBtn].forEach(function (button) {
    button.addEventListener("click", async function () {
      var picked = state.picked;
      if (!picked) return;
      var copied = await copyText(button === els.copyPickedCssBtn ? picked.selector : picked.text);
      if (picked === state.picked) showToast(copied ? "已复制" : "复制失败", copied ? "success" : "error");
    });
  });

  els.elementList.addEventListener("compositionstart", function (event) {
    if (event.target.matches(".card-text-input")) composingInput = event.target;
  });

  els.elementList.addEventListener("compositionend", function () {
    composingInput = null;
    if (!pendingLiveScan) return;
    var scan = pendingLiveScan;
    acceptScan(scan, true);
    els.liveScanStatus.textContent = "监听中 · 更新于 " + logTime(new Date(scan.scannedAt));
  });

  /** Keep the × affordance in sync with the current query. */
  function syncSearchClear() {
    els.searchClearBtn.classList.toggle("hidden", state.query.length === 0);
  }

  els.searchInput.addEventListener("input", function () {
    state.query = els.searchInput.value;
    state.offset = 0;
    syncSearchClear();
    if (state.scan) {
      renderElementList();
    }
  });

  /** Clear the query and fall back to the full scanned element list. */
  function clearSearch() {
    els.searchInput.value = "";
    state.query = "";
    state.offset = 0;
    syncSearchClear();
    if (state.scan) {
      renderElementList();
    }
    els.searchInput.focus();
  }

  els.searchClearBtn.addEventListener("click", clearSearch);

  // Ctrl+K focuses the search box. The Popup document is focused whenever the
  // Popup is open, so the shortcut works without a global command.
  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if (event.key === "Escape" && document.activeElement === els.searchInput) {
      clearSearch();
    }
  });

  els.filterBar.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest(".filter-chip") : null;
    if (!button) return;

    state.filter = button.getAttribute("data-filter");
    state.offset = 0;
    var chips = els.filterBar.querySelectorAll(".filter-chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle("active", chips[i] === button);
    }
    if (state.scan) {
      renderElementList();
    }
  });

  [els.tagFilter, els.classFilter, els.idFilter, els.cssFilter, els.attributeFilter, els.viewportFilter].forEach(function (input) {
    input.addEventListener(input.type === "checkbox" ? "change" : "input", function () {
      state.offset = 0;
      if (state.scan) renderElementList();
    });
  });

  els.clearFiltersBtn.addEventListener("click", function () {
    [els.tagFilter, els.classFilter, els.idFilter, els.cssFilter, els.attributeFilter].forEach(function (input) { input.value = ""; });
    els.viewportFilter.checked = false;
    state.filter = "all";
    state.cssMatch = null;
    selectorSequence++;
    clearSearch();
  });
  els.prevPageBtn.addEventListener("click", function () {
    state.offset = Math.max(0, state.offset - Number(els.pageSize.value));
    renderElementList();
    els.elementList.scrollTop = 0;
  });
  els.nextPageBtn.addEventListener("click", function () {
    state.offset += Number(els.pageSize.value);
    renderElementList();
    els.elementList.scrollTop = 0;
  });
  els.pageSize.addEventListener("change", function () {
    state.offset = 0;
    if (state.scan) renderElementList();
  });

  function contextHtml(nodes, links) {
    return nodes.map(function (node) {
      var label = node.tag + (node.id ? "#" + node.id : "") +
        (node.className ? "." + node.className.trim().split(/\s+/).join(".") : "");
      return links !== false && node.elementId ? '<button type="button" class="context-link" data-card-action="locate" data-element-id="' +
        node.elementId + '">' + escapeHtml(label) + "</button>" : escapeHtml(label);
    }).join(" → ") || "无";
  }

  function inspectorHtml(data, links) {
    return "<strong>CSS 选择器（当前匹配 " + data.selectorMatches + " 个）</strong><pre>" + escapeHtml(data.selector) + "</pre>" +
      "<strong>全部属性</strong><pre>" + escapeHtml(JSON.stringify(data.element.attributes, null, 2)) + "</pre>" +
      "<strong>父级（由近到远，最多 8 层）</strong><div class='context-path'>" + contextHtml(data.ancestors, links) + "</div>" +
      "<strong>直接子元素 " + data.childrenCount + " 个（最多显示 20 个）</strong><div class='context-path'>" +
        contextHtml(data.children, links) + "</div>" +
      "<strong>文本 " + data.textLength + " 字符" + (data.textTruncated ? "（显示前 20000）" : "") + "</strong><pre>" +
        escapeHtml(data.text) + "</pre>" +
      "<strong>HTML" + (data.htmlTruncated ? "（显示前 20000 字符）" : "") + "</strong><pre>" + escapeHtml(data.html) + "</pre>";
  }

  els.elementList.addEventListener("toggle", async function (event) {
    var details = event.target;
    if (!details.matches(".element-inspector") || !details.open || details.dataset.loading) return;
    var revision = state.pageRevision;
    var requestId = String(++detailSequence);
    details.dataset.loading = requestId;
    var body = details.querySelector(".inspector-body");
    body.textContent = "读取元素详情…";
    try {
      var response = await requestMessage(state.tab.id, {
        action: PAGESENSE.ACTIONS.GET_ELEMENT_DETAILS, elementId: Number(details.dataset.inspectId)
      });
      if (revision !== state.pageRevision || !details.isConnected || details.dataset.loading !== requestId) return;
      if (!response.ok) throw new Error(response.message || response.error);
      var data = response.data;
      body.innerHTML = inspectorHtml(data, true);
    } catch (error) {
      if (details.isConnected) body.textContent = "详情读取失败：" + error.message;
    } finally {
      delete details.dataset.loading;
    }
  }, true);

  els.copyBtn.addEventListener("click", function () {
    if (!state.scan) return;
    var json = JSON.stringify(state.scan, null, 2);
    copyText(json).then(function (ok) {
      if (ok) {
        showToast("JSON 已复制到剪贴板", "success");
      } else {
        showToast("复制失败，请手动从 Raw Data 复制", "error");
      }
    });
  });

  els.exportBtn.addEventListener("click", function () {
    if (!state.scan) return;
    try {
      var fileName = exportJson(state.scan);
      showToast("已导出：" + fileName, "success");
    } catch (e) {
      showError("Export failed: " + e.message);
      showToast("导出失败", "error");
    }
  });

  /* ---- Locate / Highlight UI (event delegation) ---------------------- */

  /**
   * Handle clicks on dynamically rendered card buttons. One listener on the
   * list container instead of one listener per button.
   */
  async function handleElementAction(event) {
    var button = event.target.closest
      ? event.target.closest("[data-card-action]")
      : null;
    if (!button) return;

    var actionName = button.getAttribute("data-card-action");
    var elementId = Number(button.getAttribute("data-element-id"));
    if (!state.tab || !state.scan || !Number.isInteger(elementId)) return;
    var revision = state.pageRevision;

    if (actionName === "copy-selector" || actionName === "copy-text") {
      var record = state.scan.elements.find(function (element) { return element.elementId === elementId; });
      if (!record) return;
      var text = record.selector || "";
      if (actionName === "copy-text") {
        try {
          var details = await requestMessage(state.tab.id, {
            action: PAGESENSE.ACTIONS.GET_ELEMENT_DETAILS, elementId: elementId
          });
          if (revision !== state.pageRevision) return;
          if (!details.ok) throw new Error(details.message || details.error);
          text = details.data.text;
        } catch (error) {
          if (revision === state.pageRevision) showToast("读取文本失败：" + error.message, "error");
          return;
        }
      }
      var copied = await copyText(text);
      if (revision === state.pageRevision) showToast(copied ? "已复制" : "复制失败", copied ? "success" : "error");
      return;
    }

    var payload;
    var label;
    switch (actionName) {
      case "locate":
        payload = { action: PAGESENSE.ACTIONS.LOCATE_ELEMENT, elementId: elementId };
        label = "定位";
        break;
      case "highlight":
        payload = { action: PAGESENSE.ACTIONS.HIGHLIGHT_ELEMENT, elementId: elementId };
        label = "高亮";
        break;
      case "click":
        payload = { action: PAGESENSE.ACTIONS.CLICK_ELEMENT, elementId: elementId };
        label = "点击";
        break;
      case "input": {
        var textInput = els.elementList.querySelector(
          '.card-text-input[data-input-for="' + elementId + '"]'
        );
        var value = textInput ? textInput.value : "";
        payload = {
          action: PAGESENSE.ACTIONS.INPUT_ELEMENT,
          elementId: elementId,
          value: value
        };
        label = "输入";
        break;
      }
      case "clear":
        payload = { action: PAGESENSE.ACTIONS.CLEAR_ELEMENT, elementId: elementId };
        label = "清空";
        break;
      case "keypress":
        payload = {
          action: PAGESENSE.ACTIONS.KEYPRESS_ELEMENT,
          elementId: elementId,
          key: button.getAttribute("data-key") || "Enter"
        };
        label = "按键";
        break;
      default:
        return;
    }

    button.disabled = true;
    try {
      var result = await requestMessage(state.tab.id, payload);
      if (revision !== state.pageRevision) return;
      addLogEntry(payload, result);

      if (result.success) {
        showToast(label + " #" + elementId + " 成功", "success");
        if (result.rescanRecommended) {
          showRescanHint(true);
        }
      } else {
        var code = result.error ? result.error.code : "UNKNOWN";
        showToast(label + "失败：" + code, "error");
      }
    } catch (e) {
      if (revision !== state.pageRevision) return;
      showError("Element action failed: " + e.message);
      showToast(label + "失败", "error");
    } finally {
      button.disabled = false;
    }
  }

  els.elementList.addEventListener("click", handleElementAction);

  /* ---- Global scroll controls ----------------------------------------- */

  els.scrollControls.addEventListener("click", async function (event) {
    var button = event.target.closest
      ? event.target.closest("[data-scroll-direction]")
      : null;
    if (!button || !state.tab || !state.scan) return;
    var revision = state.pageRevision;

    var direction = button.getAttribute("data-scroll-direction");
    var payload = {
      action: PAGESENSE.ACTIONS.SCROLL_PAGE,
      direction: direction,
      amount: 500
    };
    button.disabled = true;
    try {
      var result = await requestMessage(state.tab.id, payload);
      if (revision !== state.pageRevision) return;
      addLogEntry(payload, result);
      if (result.success) {
        showToast(result.moved
          ? "已向" + (direction === "up" ? "上" : "下") + "滚动"
          : "已到达滚动边界", result.moved ? "success" : "error");
      } else {
        showToast("滚动失败：" + (result.error ? result.error.code : ""), "error");
      }
    } catch (e) {
      if (revision !== state.pageRevision) return;
      showError("Scroll failed: " + e.message);
      showToast("滚动失败", "error");
    } finally {
      button.disabled = false;
    }
  });

  /* ---- Rescan hint button --------------------------------------------- */

  els.rescanHintBtn.addEventListener("click", function () {
    showRescanHint(false);
    runScan();
  });

  els.clearHighlightBtn.addEventListener("click", async function () {
    if (!state.tab || !state.scan) return;
    var revision = state.pageRevision;
    var payload = { action: PAGESENSE.ACTIONS.CLEAR_HIGHLIGHT };
    try {
      var result = await requestMessage(state.tab.id, payload);
      if (revision !== state.pageRevision) return;
      addLogEntry(payload, result);
      if (result.success) {
        showToast("已取消高亮", "success");
      } else {
        showToast("取消高亮失败", "error");
      }
    } catch (e) {
      if (revision !== state.pageRevision) return;
      showError("Clear highlight failed: " + e.message);
      showToast("取消高亮失败", "error");
    }
  });

  /* ---- V2.0 Controller panel ------------------------------------------ */

  var bridgePollTimer = null;

  /** Ask the Service Worker for the current bridge status. */
  function requestBridgeStatus() {
    return new Promise(function (resolve) {
      if (!chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage(
          { type: PAGESENSE.BRIDGE_MESSAGES.GET_STATUS },
          function (status) {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(status || null);
          }
        );
      } catch (e) {
        resolve(null);
      }
    });
  }

  function sendBridgeMessage(payload) {
    return new Promise(function (resolve) {
      if (!chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
        resolve({ ok: false, error: { message: "Service Worker 不可用。" } });
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, function (response) {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              error: { message: chrome.runtime.lastError.message }
            });
            return;
          }
          resolve(response || { ok: false, error: { message: "无响应" } });
        });
      } catch (e) {
        resolve({ ok: false, error: { message: e.message } });
      }
    });
  }

  var STATE_LABELS = {};
  STATE_LABELS[PAGESENSE.BRIDGE_STATES.DISCONNECTED] = "○ 未连接";
  STATE_LABELS[PAGESENSE.BRIDGE_STATES.CONNECTING] = "◌ 连接中…";
  STATE_LABELS[PAGESENSE.BRIDGE_STATES.CONNECTED] = "● 已连接";
  STATE_LABELS[PAGESENSE.BRIDGE_STATES.ERROR] = "● 连接异常";

  function renderBridgeStatus(status) {
    if (!status) {
      els.controllerStateText.textContent = "Service Worker 未响应";
      els.controllerStateInline.textContent = "不可用";
      els.controllerDot.className = "controller-dot is-error";
      return;
    }

    var state = status.state || PAGESENSE.BRIDGE_STATES.DISCONNECTED;
    els.controllerStateText.textContent = STATE_LABELS[state] || state;
    els.controllerStateInline.textContent = STATE_LABELS[state] || state;
    els.controllerEndpoint.textContent = status.host + ":" + status.port;
    els.controllerPort.value = String(status.port);

    var dotClass = "controller-dot";
    if (state === PAGESENSE.BRIDGE_STATES.CONNECTED) {
      dotClass += " is-connected";
    } else if (state === PAGESENSE.BRIDGE_STATES.CONNECTING) {
      dotClass += " is-connecting";
    } else if (state === PAGESENSE.BRIDGE_STATES.ERROR) {
      dotClass += " is-error";
    }
    els.controllerDot.className = dotClass;

    if (status.lastError && state !== PAGESENSE.BRIDGE_STATES.CONNECTED) {
      els.controllerError.classList.remove("hidden");
      els.controllerError.textContent =
        (status.lastError.code ? status.lastError.code + ": " : "") +
        (status.lastError.message || "");
    } else {
      els.controllerError.classList.add("hidden");
      els.controllerError.textContent = "";
    }

    renderControllerLog(status.recentRequests || []);
  }

  function renderControllerLog(entries) {
    if (!entries.length) {
      els.controllerLog.innerHTML =
        '<div class="controller-log-empty">（暂无请求）</div>';
      return;
    }
    els.controllerLog.innerHTML = entries.slice().reverse().map(function (entry) {
      return (
        '<div class="controller-log-item">' +
          '<span class="log-time">' + escapeHtml(entry.time) + "</span>" +
          "<span>" + escapeHtml(entry.method) + "</span>" +
          '<span class="' + (entry.success ? "log-status-ok" : "log-status-fail") +
            '">' + (entry.success ? "success" : "failed") + "</span>" +
          "<span>" + escapeHtml(entry.summary || "") + "</span>" +
        "</div>"
      );
    }).join("");
  }

  function refreshBridgeStatus() {
    return requestBridgeStatus().then(function (status) {
      renderBridgeStatus(status);
      return status;
    });
  }

  /** Poll only while the panel is expanded, so a closed popup stays idle. */
  function startBridgePolling() {
    if (bridgePollTimer) return;
    refreshBridgeStatus();
    bridgePollTimer = setInterval(refreshBridgeStatus, 2000);
  }

  function stopBridgePolling() {
    if (bridgePollTimer) {
      clearInterval(bridgePollTimer);
      bridgePollTimer = null;
    }
  }

  els.controllerPanel.addEventListener("toggle", function () {
    if (els.controllerPanel.open) {
      startBridgePolling();
    } else {
      stopBridgePolling();
    }
  });

  els.controllerConnectBtn.addEventListener("click", async function () {
    var port = Number(els.controllerPort.value);
    var token = els.controllerToken.value;
    els.controllerConnectBtn.disabled = true;
    try {
      var response = await sendBridgeMessage({
        type: PAGESENSE.BRIDGE_MESSAGES.CONNECT,
        host: PAGESENSE.BRIDGE.DEFAULT_HOST,
        port: port,
        token: token
      });
      if (response.status) {
        renderBridgeStatus(response.status);
      }
      if (!response.ok && response.error) {
        showToast("连接失败：" + response.error.message, "error");
      } else {
        showToast("正在连接 " + PAGESENSE.BRIDGE.DEFAULT_HOST + ":" + port, "success");
      }
      startBridgePolling();
    } finally {
      els.controllerConnectBtn.disabled = false;
    }
  });

  els.controllerDisconnectBtn.addEventListener("click", async function () {
    els.controllerDisconnectBtn.disabled = true;
    try {
      var response = await sendBridgeMessage({
        type: PAGESENSE.BRIDGE_MESSAGES.DISCONNECT
      });
      if (response.status) {
        renderBridgeStatus(response.status);
      }
      showToast("已断开 Controller", "success");
    } finally {
      els.controllerDisconnectBtn.disabled = false;
    }
  });

  // Show the connection state even before the panel is expanded.
  refreshBridgeStatus();

  /* ---- Keep the persistent panel in sync with its browser window ----- */

  chrome.tabs.onActivated.addListener(function (info) {
    panelWindow.then(function (owner) {
      if (info.windowId !== owner.id) return;
      resetPage(null);
      refreshActiveTab();
    });
  });

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (!state.tab || state.tab.id !== tabId) return;
    if (changeInfo.status === "loading" || changeInfo.url) {
      resetPage(tab);
    } else {
      state.tab = tab;
      renderPageHeader(tab);
    }
    if (state.liveEnabled && tab.status !== "loading" && !livePort) startLiveScan();
  });

  chrome.tabs.onRemoved.addListener(function (tabId) {
    if (!state.tab || state.tab.id !== tabId) return;
    resetPage(null);
    refreshActiveTab();
  });

  refreshActiveTab();
})();
