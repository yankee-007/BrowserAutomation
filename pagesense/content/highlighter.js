/*
 * PageSense - content/highlighter.js
 * Locate & highlight support rendered as a PageSense-owned fixed-position
 * overlay. The page element's own border/outline/style is never modified.
 * Only one active highlight exists at a time; the overlay tracks the
 * element on scroll/resize and disappears if the element is removed.
 */
(function (global) {
  "use strict";

  if (global.__PAGESENSE_HIGHLIGHTER_LOADED__) {
    return;
  }
  global.__PAGESENSE_HIGHLIGHTER_LOADED__ = true;

  var PS = global.PAGESENSE;
  var OVERLAY_ATTR = PS.OVERLAY_ATTR;
  var LABEL_MAX = 48;

  /* Highlight state */
  var activeElement = null;
  var activeId = null;
  var overlay = null;
  var listenersInstalled = false;
  var observerInstalled = false;
  var rafPending = false;

  function notFound(elementId) {
    return {
      success: false,
      error: {
        code: PS.ERROR_CODES.ELEMENT_NOT_FOUND,
        message: "元素已不存在，页面内容可能已变化，请重新扫描页面。"
      },
      elementId: elementId
    };
  }

  function invalidId(elementId) {
    return {
      success: false,
      error: {
        code: PS.ERROR_CODES.INVALID_ELEMENT_ID,
        message: "无效的 elementId。"
      },
      elementId: elementId
    };
  }

  /** Scroll the real element into the middle of the viewport. */
  function scrollToElement(element) {
    try {
      element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    } catch (e) {
      // Older engines / unusual elements: fall back to basic scroll.
      try {
        element.scrollIntoView();
      } catch (e2) { /* ignore: overlay still works */ }
    }
  }

  /** Resolve elementId via the mapping; returns null when missing. */
  function resolveElement(elementId) {
    if (!global.PageSenseElementMap.isValidId(elementId)) {
      return { invalid: true };
    }
    var element = global.PageSenseElementMap.getElementById(elementId);
    return element ? { element: element } : null;
  }

  /* ---- Overlay construction ------------------------------------------ */

  function buildLabel(elementId, element) {
    var tag = element.tagName.toLowerCase();
    var text = global.PageSenseScanner.getElementText(element);
    if (text.length > LABEL_MAX) {
      text = text.slice(0, LABEL_MAX) + "…";
    }
    if (!text) {
      text = "(无文本)";
    }
    return "#" + elementId + " <" + tag + "> " + text;
  }

  function setFixed(style, props) {
    Object.keys(props).forEach(function (k) { style[k] = props[k]; });
  }

  function createOverlay(elementId, element) {
    var doc = global.document;

    var box = doc.createElement("div");
    box.setAttribute(OVERLAY_ATTR, "highlight");
    setFixed(box.style, {
      position: "fixed",
      boxSizing: "border-box",
      pointerEvents: "none",
      zIndex: "2147483647",
      border: "3px solid #2b5fff",
      backgroundColor: "rgba(43, 95, 255, 0.10)",
      borderRadius: "4px",
      left: "0px",
      top: "0px",
      width: "0px",
      height: "0px"
    });

    var label = doc.createElement("div");
    label.setAttribute(OVERLAY_ATTR, "label");
    setFixed(label.style, {
      position: "absolute",
      bottom: "calc(100% + 4px)",
      left: "-3px",
      pointerEvents: "none",
      font: '12px/1.4 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      color: "#ffffff",
      backgroundColor: "#2b5fff",
      padding: "1px 8px",
      borderRadius: "4px",
      whiteSpace: "nowrap",
      maxWidth: "90vw",
      overflow: "hidden",
      textOverflow: "ellipsis"
    });
    label.textContent = buildLabel(elementId, element);
    box.appendChild(label);

    var host = doc.body || doc.documentElement;
    host.appendChild(box);
    return box;
  }

  /** Move the overlay to match the current element rect. */
  function positionOverlay() {
    if (!overlay || !activeElement) {
      return;
    }
    // Element was removed by the page: drop the highlight.
    if (!activeElement.isConnected) {
      clearHighlight();
      return;
    }
    var rect = activeElement.getBoundingClientRect();
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
  }

  /** rAF-throttled update used by scroll/resize (capture phase). */
  function scheduleUpdate() {
    if (rafPending || !overlay) {
      return;
    }
    rafPending = true;
    global.requestAnimationFrame(function () {
      rafPending = false;
      positionOverlay();
      // One trailing frame: if the first update raced with an in-flight
      // reflow (e.g. viewport resize), catch the settled layout too.
      global.requestAnimationFrame(positionOverlay);
    });
  }

  function installListeners() {
    if (listenersInstalled) {
      return;
    }
    listenersInstalled = true;
    // capture: true also catches scrolls inside inner scroll containers.
    global.addEventListener("scroll", scheduleUpdate, true);
    global.addEventListener("resize", scheduleUpdate, true);
  }

  /**
   * Watch DOM mutations: if the highlighted element is removed (or moved),
   * drop or reposition the overlay immediately instead of waiting for the
   * next scroll event.
   */
  function installObserver() {
    if (observerInstalled || typeof global.MutationObserver !== "function") {
      return;
    }
    observerInstalled = true;
    var observer = new global.MutationObserver(function () {
      if (!activeElement) {
        return;
      }
      if (!activeElement.isConnected) {
        clearHighlight();
      } else {
        scheduleUpdate();
      }
    });
    observer.observe(global.document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  /* ---- Public actions ------------------------------------------------ */

  function locateElement(elementId) {
    var resolved = resolveElement(elementId);
    if (resolved && resolved.invalid) {
      return invalidId(elementId);
    }
    if (!resolved || !resolved.element) {
      return notFound(elementId);
    }
    scrollToElement(resolved.element);
    return { success: true, elementId: Number(elementId) };
  }

  function highlightElement(elementId) {
    var resolved = resolveElement(elementId);
    if (resolved && resolved.invalid) {
      return invalidId(elementId);
    }
    if (!resolved || !resolved.element) {
      return notFound(elementId);
    }

    // Single active highlight: replace any existing one.
    removeOverlay();

    activeElement = resolved.element;
    activeId = Number(elementId);
    installListeners();
    installObserver();
    overlay = createOverlay(activeId, activeElement);
    positionOverlay();

    scrollToElement(activeElement);
    // Smooth scrolling moves the element; scroll events will reposition,
    // but schedule a couple of follow-up frames as well.
    scheduleUpdate();

    return { success: true, elementId: activeId };
  }

  function removeOverlay() {
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
    activeElement = null;
    activeId = null;
  }

  /** Always safe, even when nothing is highlighted. */
  function clearHighlight() {
    removeOverlay();
    return { success: true };
  }

  global.PageSenseHighlighter = {
    locateElement: locateElement,
    highlightElement: highlightElement,
    clearHighlight: clearHighlight
  };
})(typeof window !== "undefined" ? window : globalThis);
