/*
 * PageSense - content/scanner.js
 * Framework-free DOM scanner. Finds interactive elements, filters out the
 * obviously invisible ones, and serializes the rest into plain JSON-ready
 * objects. Runs inside the page's Content Script isolated world.
 */
(function (global) {
  "use strict";

  if (global.__PAGESENSE_SCANNER_LOADED__) {
    return;
  }
  global.__PAGESENSE_SCANNER_LOADED__ = true;

  var PS = global.PAGESENSE;
  var MAX_TEXT_LENGTH = PS.MAX_TEXT_LENGTH;
  var scanIds = new WeakMap();
  var nextId = 1;
  var visibilityCache = null;
  var TEXT_BLOCKS = "h1,h2,h3,h4,h5,h6,p,blockquote,pre,code,li,dt,dd,td,th,caption,figcaption,label,legend,address";
  var SKIP = "script,style,noscript,template,head,meta,link";

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function ownText(element) {
    return normalizeText(Array.prototype.map.call(element.childNodes, function (node) {
      return node.nodeType === 3 ? node.nodeValue : "";
    }).join(" "));
  }

  function attributesOf(element) {
    var out = Object.create(null);
    Array.prototype.forEach.call(element.attributes, function (attribute) {
      if (attribute.name === PS.PAGE_SENSE_ID_ATTR || attribute.name === PS.OVERLAY_ATTR) return;
      out[attribute.name] = element.type === "password" && attribute.name === "value"
        ? "[密码已隐藏]" : attribute.value;
    });
    return out;
  }

  function ancestryVisible(element) {
    if (!element || element.nodeType !== 1) return true;
    if (visibilityCache && visibilityCache.has(element)) return visibilityCache.get(element);
    var style = global.getComputedStyle(element);
    var visible = !element.hidden && style.display !== "none" && style.opacity !== "0" &&
      ancestryVisible(element.parentElement);
    if (visibilityCache) visibilityCache.set(element, visible);
    return visible;
  }

  /**
   * Core box/style visibility check.
   * Note: elements outside the current scroll viewport still pass here;
   * "visible" is intentionally different from "inViewport".
   */
  function hasRenderedBox(element) {
    var rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    var style = global.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" && ancestryVisible(element)
    );
  }

  /**
   * Decide whether an element is visibly rendered.
   * Enhanced beyond the base spec with:
   *  - must still be connected to the DOM
   *  - the HTML `hidden` attribute
   *  - <option> elements report zero-size rects while the <select> is closed,
   *    so their visibility is derived from the owning <select>.
   */
  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }
    if (element.hidden === true) {
      return false;
    }

    if (element.tagName === "OPTION") {
      var select = typeof element.closest === "function" ? element.closest("select") : null;
      return select ? isVisible(select) : hasRenderedBox(element);
    }

    return hasRenderedBox(element);
  }

  /**
   * Viewport intersection test using getBoundingClientRect() viewport coords.
   * A partially intersecting element counts as in the viewport.
   */
  function isInViewport(rect) {
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < global.innerHeight &&
      rect.left < global.innerWidth
    );
  }

  function pickString(value) {
    if (typeof value === "string") {
      var trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    // SVG className etc. are not plain strings; ignore them.
    return null;
  }

  function attr(element, name) {
    var value = element.getAttribute(name);
    return value === null || value === undefined ? null : String(value);
  }

  /**
   * Extract human-readable text using a priority chain:
   * innerText -> value -> aria-label -> placeholder -> title -> alt.
   * Result is whitespace-normalized, trimmed and capped to MAX_TEXT_LENGTH.
   */
  function getElementText(element) {
    if (element.type === "password") return element.value ? "[密码已隐藏]" : (attr(element, "placeholder") || "");
    var candidates = [
      element.innerText,
      element.value,
      attr(element, "aria-label"),
      attr(element, "placeholder"),
      attr(element, "title"),
      attr(element, "alt")
    ];

    for (var i = 0; i < candidates.length; i++) {
      var candidate = pickString(candidates[i]);
      if (candidate !== null) {
        var normalized = candidate.replace(/\s+/g, " ").trim();
        return normalized.length > MAX_TEXT_LENGTH
          ? normalized.slice(0, MAX_TEXT_LENGTH)
          : normalized;
      }
    }
    return "";
  }

  function round(value) {
    return Math.round(value);
  }

  /** Serialize one element into the PageSense data model. */
  function serializeElement(element, elementId) {
    var tag = element.tagName.toLowerCase();
    var rect = element.getBoundingClientRect();

    // Closed <option> elements report zero-size rects; when they are
    // considered visible via the owning <select>, borrow the select's rect
    // so position and inViewport stay meaningful and consistent.
    if (tag === "option" && rect.width === 0) {
      var ownerSelect = typeof element.closest === "function"
        ? element.closest("select")
        : null;
      if (ownerSelect) {
        rect = ownerSelect.getBoundingClientRect();
      }
    }

    var className = null;
    if (typeof element.className === "string") {
      className = element.className.trim() ? element.className : null;
    } else if (element.classList && element.classList.length) {
      className = Array.prototype.join.call(element.classList, " ");
    }

    var href = null;
    if (tag === "a") {
      // element.href is the resolved absolute URL; fall back to raw attribute.
      href = element.href || attr(element, "href");
    }

    var interactive = element.matches(PS.INTERACTIVE_SELECTOR);
    var text = getElementText(element);
    var record = {
      elementId: elementId,
      pageId: pageId,
      tag: tag,
      text: text,
      ownText: ownText(element),
      interactive: interactive,
      attributes: attributesOf(element),
      alt: attr(element, "alt"),
      value: element.type === "password" ? "[密码已隐藏]" :
        (typeof element.value === "string" ? element.value : null),
      id: element.id ? element.id : null,
      className: className,
      name: attr(element, "name"),
      type: attr(element, "type"),
      role: attr(element, "role"),
      href: href,
      placeholder: attr(element, "placeholder"),
      ariaLabel: attr(element, "aria-label"),
      title: attr(element, "title"),
      disabled: Boolean(element.disabled) || element.hasAttribute("disabled"),
      contentEditable: Boolean(element.isContentEditable),
      visible: isVisible(element),
      inViewport: isInViewport(rect),
      position: {
        x: round(rect.x),
        y: round(rect.y),
        pageX: round(rect.left + global.scrollX),
        pageY: round(rect.top + global.scrollY),
        width: round(rect.width),
        height: round(rect.height),
        top: round(rect.top),
        right: round(rect.right),
        bottom: round(rect.bottom),
        left: round(rect.left)
      }
    };
    record.category = PS.elementKind(record);
    record.clickable = interactive && typeof element.click === "function" &&
      !PS.isTextEntryElement(record) && record.category !== "select";
    if (record.category === "text" && !interactive && record.ownText) record.text = record.ownText.slice(0, MAX_TEXT_LENGTH);
    // Structural ancestors carry a preview, rather than indexing their entire
    // subtree repeatedly. Paragraphs retain searchable text beyond the card cap.
    var structure = PS.matchesFilter(record, "structure");
    var searchable = element.type === "password" ? record.text :
      (structure || record.category === "text" ? record.ownText : normalizeText(element.innerText || element.textContent || record.text));
    if (!searchable && !structure && record.category !== "text") searchable = record.text;
    record.searchText = searchable.slice(0, 20000);
    record.textLength = searchable.length;
    record.textTruncated = searchable.length > 20000;
    return record;
  }

  function includeContent(element) {
    if (element.matches(PS.INTERACTIVE_SELECTOR)) return true;
    var kind = PS.elementKind({ tag: element.localName, role: element.getAttribute("role"), text: ownText(element) });
    if (kind !== "text" && kind !== "other") return true;
    if (!ownText(element)) return false;
    var parent = element.parentElement;
    // Aggregate ordinary inline text in its semantic text block once.
    return !parent || !parent.closest(TEXT_BLOCKS + "," + PS.INTERACTIVE_SELECTOR);
  }

  function cssEscape(value) {
    if (global.CSS && global.CSS.escape) return global.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\" + c.codePointAt(0).toString(16) + " ";
    }).replace(/^([0-9])/, function (c) { return "\\3" + c + " "; });
  }

  function cssPath(element, context) {
    var ctx = context || { ids: new Map(), paths: new WeakMap(), siblings: new WeakMap() };
    if (!context) {
      global.document.querySelectorAll("[id]").forEach(function (node) {
        ctx.ids.set(node.id, (ctx.ids.get(node.id) || 0) + 1);
      });
    }
    if (ctx.paths.has(element)) return ctx.paths.get(element);
    var path;
    if (element.id && ctx.ids.get(element.id) === 1) {
      path = "#" + cssEscape(element.id);
    } else {
      var parent = element.parentElement;
      var part = cssEscape(element.localName);
      if (parent) {
        if (!ctx.siblings.has(parent)) {
          var counts = Object.create(null), indices = new WeakMap();
          Array.prototype.forEach.call(parent.children, function (child) {
            counts[child.localName] = (counts[child.localName] || 0) + 1;
            indices.set(child, counts[child.localName]);
          });
          ctx.siblings.set(parent, indices);
        }
        part += ":nth-of-type(" + ctx.siblings.get(parent).get(element) + ")";
        path = cssPath(parent, ctx) + " > " + part;
      } else path = part;
    }
    ctx.paths.set(element, path);
    return path;
  }


  // Document identity is independent of tab IDs and changes after navigation.
  var pageId = global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() :
    Date.now().toString(36) + Math.random().toString(36).slice(2);

  function locatorCandidates(element) {
    var candidates = [];
    function add(label, selector, stability) {
      if (candidates.some(function (item) { return item.selector === selector; })) return;
      var matches = global.document.querySelectorAll(selector).length;
      candidates.push({ label: label, selector: selector, matches: matches,
        unique: matches === 1, stability: stability });
    }
    function quoted(value) {
      return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        .replace(/[\n\r\f]/g, function (c) { return "\\" + c.charCodeAt(0).toString(16) + " "; }) + '"';
    }
    ["data-testid", "data-test", "data-qa"].forEach(function (name) {
      if (element.getAttribute(name)) add(name, "[" + name + "=" + quoted(element.getAttribute(name)) + "]", "attribute");
    });
    if (element.id) add("ID", "#" + cssEscape(element.id), "attribute");
    ["name", "aria-label", "placeholder", "title"].forEach(function (name) {
      if (element.getAttribute(name)) add(name, cssEscape(element.localName) + "[" + name + "=" + quoted(element.getAttribute(name)) + "]", "attribute");
    });
    add("DOM 路径", cssPath(element), "structure");
    return candidates;
  }

  function resolveElement(selector) {
    if (typeof selector !== "string" || !selector.trim()) return { ok: false, error: "INVALID_SELECTOR", message: "请提供非空 CSS 选择器。" };
    var nodes;
    try { nodes = global.document.querySelectorAll(selector); }
    catch (error) { return { ok: false, error: "INVALID_SELECTOR", message: error.message }; }
    var matches = Array.prototype.filter.call(nodes, function (node) { return !node.closest("[" + PS.OVERLAY_ATTR + "]"); });
    if (matches.length !== 1) return { ok: false, error: matches.length ? "AMBIGUOUS_SELECTOR" : "ELEMENT_NOT_FOUND",
      message: "CSS 匹配 " + matches.length + " 个元素，需要唯一匹配：" + selector };
    return inspectTarget(matches[0]);
  }

  function inspectElement(elementId) {
    if (!global.PageSenseElementMap.isValidId(elementId)) return { ok: false, error: "INVALID_ELEMENT_ID", message: "elementId 必须为正整数。" };
    var element = global.PageSenseElementMap.getElementById(elementId);
    if (!element) return { ok: false, error: "ELEMENT_NOT_FOUND", message: "元素已移除，请重新扫描。" };
    var selector = cssPath(element);
    var locators = locatorCandidates(element);
    var clone = element.cloneNode(true);
    [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*"))).forEach(function (node) {
      node.removeAttribute(PS.PAGE_SENSE_ID_ATTR);
      if (node.type === "password") node.removeAttribute("value");
    });
    clone.querySelectorAll("script,style,[" + PS.OVERLAY_ATTR + "]").forEach(function (node) { node.remove(); });
    var html = clone.outerHTML;
    var text = element.type === "password" ? "[密码已隐藏]" :
      String(element.innerText || element.textContent || element.value || "");
    function contextNode(node) {
      return { tag: node.localName, id: node.id || null,
        className: node.getAttribute("class"), elementId: Number(node.getAttribute(PS.PAGE_SENSE_ID_ATTR)) || null };
    }
    var ancestors = [], parent = element.parentElement;
    while (parent && ancestors.length < 8) { ancestors.push(contextNode(parent)); parent = parent.parentElement; }
    return { ok: true, data: {
      pageId: pageId, page: { url: global.location.href, title: global.document.title },
      inspectedAt: new Date().toISOString(),
      locators: locators, locator: locators.find(function (item) { return item.unique; }),
      element: serializeElement(element, Number(elementId)),
      selector: selector, selectorMatches: global.document.querySelectorAll(selector).length,
      text: text.slice(0, 20000), textLength: text.length, textTruncated: text.length > 20000,
      html: html.slice(0, 20000), htmlLength: html.length, htmlTruncated: html.length > 20000,
      ancestors: ancestors, children: Array.prototype.slice.call(element.children, 0, 20).map(contextNode),
      childrenCount: element.children.length
    } };
  }

  /** Explicit point selection can inspect a node outside the scanned scope. */
  function inspectTarget(element) {
    if (!element || element.nodeType !== 1 || element.ownerDocument !== global.document || !element.isConnected ||
        element.closest("[" + PS.OVERLAY_ATTR + "]")) {
      return { ok: false, error: "ELEMENT_NOT_FOUND", message: "所选元素已不存在。" };
    }
    var elementId = scanIds.get(element);
    if (!elementId) {
      elementId = nextId++;
      scanIds.set(element, elementId);
    }
    // Page code can clone an earlier mapping attribute. An explicit selection
    // must resolve to the chosen node, rather than the first such clone.
    global.document.querySelectorAll("[" + PS.PAGE_SENSE_ID_ATTR + '="' + elementId + '"]').forEach(function (node) {
      if (node !== element) node.removeAttribute(PS.PAGE_SENSE_ID_ATTR);
    });
    global.PageSenseElementMap.assignId(element, elementId);
    return inspectElement(elementId);
  }

  /**
   * Scan the current document.
   * @return {{page: Object, stats: Object, elements: Array, scannedAt: string}}
   */
  function scanPage(options) {
    var scope = options && options.scope || PS.SCAN_SCOPES.INTERACTIVE;
    if (Object.values(PS.SCAN_SCOPES).indexOf(scope) === -1) throw new Error("INVALID_SCAN_SCOPE");
    // Live updates keep surviving nodes' IDs and never recycle removed IDs.
    // An explicit scan without a live subscriber keeps the original numbering.
    if (!options || !options.preserveIds) {
      scanIds = new WeakMap();
      nextId = 1;
    }
    // Rescan starts from a clean mapping: stale mapping attributes
    // must never survive into the new scan.
    global.PageSenseElementMap.clearMappings();

    var candidates = Array.prototype.slice.call(global.document.querySelectorAll(
      scope === PS.SCAN_SCOPES.INTERACTIVE ? PS.INTERACTIVE_SELECTOR : "body,body *"
    ));
    var nodes = candidates.filter(function (node) {
      if (node.closest(SKIP + ",[" + PS.OVERLAY_ATTR + "]")) return false;
      return scope !== PS.SCAN_SCOPES.CONTENT || includeContent(node);
    });
    var selectorContext = { ids: new Map(), paths: new WeakMap(), siblings: new WeakMap() };
    global.document.querySelectorAll("[id]").forEach(function (node) {
      selectorContext.ids.set(node.id, (selectorContext.ids.get(node.id) || 0) + 1);
    });
    visibilityCache = new WeakMap();

    var elements = [];
    var inViewportCount = 0;

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!isVisible(node)) {
        continue;
      }
      var elementId = scanIds.get(node);
      if (!elementId) {
        elementId = nextId++;
        scanIds.set(node, elementId);
      }
      var serialized = serializeElement(node, elementId);
      serialized.selector = cssPath(node, selectorContext);
      // Materialize elementId -> real DOM mapping on the page element.
      global.PageSenseElementMap.assignId(node, elementId);
      if (serialized.inViewport) {
        inViewportCount++;
      }
      elements.push(serialized);
    }
    visibilityCache = null;
    var categories = {};
    elements.forEach(function (element) { categories[element.category] = (categories[element.category] || 0) + 1; });

    return {
      schemaVersion: 1,
      pageId: pageId,
      scope: scope,
      scannedAt: new Date().toISOString(),
      page: {
        title: global.document.title || "",
        url: global.location.href,
        domain: global.location.hostname,
        dimensions: { width: Math.max(global.innerWidth, global.document.documentElement.scrollWidth),
          height: Math.max(global.innerHeight, global.document.documentElement.scrollHeight) },
        viewport: {
          width: global.innerWidth,
          height: global.innerHeight
        },
        scroll: {
          x: round(global.scrollX),
          y: round(global.scrollY)
        }
      },
      stats: {
        matched: nodes.length,
        total: elements.length,
        hidden: nodes.length - elements.length,
        inViewport: inViewportCount,
        categories: categories,
        interactive: elements.filter(function (element) { return element.interactive; }).length,
        textTruncated: elements.filter(function (element) { return element.textTruncated; }).length
      },
      elements: elements
    };
  }

  /* Exposed for content.js (and for manual debugging on the page). */
  global.PageSenseScanner = {
    scanPage: scanPage,
    pageId: pageId,
    resolveElement: resolveElement,
    isVisible: isVisible,
    isInViewport: isInViewport,
    getElementText: getElementText,
    serializeElement: serializeElement,
    inspectElement: inspectElement,
    inspectTarget: inspectTarget,
    cssPath: cssPath
  };
})(typeof window !== "undefined" ? window : globalThis);
