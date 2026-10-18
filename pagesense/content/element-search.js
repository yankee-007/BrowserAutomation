/*
 * PageSense - content/element-search.js
 * V2.0 Element Search.
 *
 * Search always runs against the Structured Elements produced by the most
 * recent SCAN, never against the live DOM: the scan result is turned into an
 * in-memory index once, and every query is a pure in-memory lookup. A new
 * scan destroys the old index, so a stale elementId can never be returned.
 *
 * The module is deliberately free of DOM access so the exact same file runs
 * in the Content Script (for SEARCH_ELEMENTS) and in the Popup (for the live
 * search box).
 */
(function (global) {
  "use strict";

  if (global.__PAGESENSE_ELEMENT_SEARCH_LOADED__) {
    return;
  }
  global.__PAGESENSE_ELEMENT_SEARCH_LOADED__ = true;

  var PS = global.PAGESENSE;

  /* ---- Index state ---------------------------------------------------- */

  /** Array of search documents, one per scanned element. */
  var documents = [];
  /** ISO timestamp of the scan this index was built from. */
  var indexedAt = null;
  /** False until buildIndex() runs; a rescan always replaces the index. */
  var indexValid = false;

  /**
   * Build the normalized search document for one serialized element.
   * `haystack` concatenates every field and is only used for the
   * "does this keyword appear at all" (AND) check.
   */
  function buildDocument(element) {
    var fields = {};
    var parts = [];

    for (var i = 0; i < PS.SEARCH_FIELDS.length; i++) {
      var name = PS.SEARCH_FIELDS[i];
      var value = PS.normalizeSearchText(name === "text"
        ? (typeof element.searchText === "string" ? element.searchText : element.text) : element[name]);
      fields[name] = value;
      if (value) {
        parts.push(value);
      }
    }

    return {
      element: element,
      fields: fields,
      haystack: parts.join(" ")
    };
  }

  /**
   * Replace the whole index with a fresh one derived from `elements`.
   * Called on every SCAN_PAGE, so the index can never outlive its scan.
   * @param {Array<Object>} elements serialized elements of the last scan
   * @param {string=} scannedAt ISO timestamp of that scan
   */
  function buildIndex(elements, scannedAt) {
    documents = [];

    var list = Array.isArray(elements) ? elements : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i] === "object") {
        documents.push(buildDocument(list[i]));
      }
    }

    indexedAt = scannedAt || null;
    indexValid = true;
    return documents.length;
  }

  /** Drop the index. The next search() reports NO_SCAN_DATA. */
  function clearIndex() {
    documents = [];
    indexedAt = null;
    indexValid = false;
  }

  /** @return {{valid: boolean, size: number, indexedAt: (string|null)}} */
  function getIndexInfo() {
    return { valid: indexValid, size: documents.length, indexedAt: indexedAt };
  }

  /* ---- Scoring -------------------------------------------------------- */

  /**
   * Best relevance score for a single keyword inside one document.
   * Returns the highest-weight field/tier hit, or null when the keyword
   * does not occur in any searchable field.
   * @return {{score: number, field: string}|null}
   */
  function scoreKeyword(doc, keyword) {
    var best = 0;
    var bestField = null;

    for (var i = 0; i < PS.SEARCH_FIELDS.length; i++) {
      var name = PS.SEARCH_FIELDS[i];
      var weights = PS.SEARCH_SCORES[name];
      var value = doc.fields[name];

      if (!weights || !value) {
        continue;
      }
      // A 1-character keyword must not match every href on the page.
      if (name === "href" && keyword.length < PS.SEARCH_MIN_HREF_KEYWORD_LENGTH) {
        continue;
      }

      var score = 0;
      if (value === keyword) {
        score = weights.exact;
      } else if (value.indexOf(keyword) === 0) {
        score = weights.prefix;
      } else if (value.indexOf(keyword) !== -1) {
        score = weights.contains;
      }

      if (score > best) {
        best = score;
        bestField = name;
      }
    }

    return best > 0 ? { score: best, field: bestField } : null;
  }

  /** Compact element summary embedded in every search result. */
  function summarize(element) {
    return {
      tag: element.tag,
      text: element.text,
      role: element.role === undefined ? null : element.role,
      visible: element.visible === true,
      inViewport: element.inViewport === true
    };
  }

  /* ---- Search --------------------------------------------------------- */

  /**
   * Run a query against the current index.
   *
   * Semantics (fixed by the V2.0 protocol, see README):
   *  - multiple keywords are ANDed: every keyword must match some field
   *  - an empty query returns every scanned element in DOM order with
   *    score 0 and no matchedFields
   *  - results are sorted by score DESC, then by elementId ASC
   *  - `limit` is clamped to [1, PS.SEARCH_MAX_LIMIT], default 20
   *
   * @param {string} query
   * @param {{limit?: number, type?: string}=} options
   * @return {{ok: true, ...}|{ok: false, error: Object}}
   */
  function search(query, options) {
    var start = Date.now();
    var opts = options || {};

    if (!indexValid) {
      return {
        ok: false,
        error: {
          code: PS.ERROR_CODES.NO_SCAN_DATA,
          message: "尚未扫描页面，或搜索索引已失效，请先执行 SCAN_PAGE。"
        }
      };
    }

    var limit = PS.clampSearchLimit(opts.limit);
    var offset = Number.isFinite(Number(opts.offset)) ? Math.max(0, Math.floor(Number(opts.offset))) : 0;
    if (opts.attributes !== undefined && (opts.attributes === null ||
        typeof opts.attributes !== "object" || Array.isArray(opts.attributes) ||
        Object.keys(opts.attributes).some(function (key) {
          return opts.attributes[key] !== null && typeof opts.attributes[key] !== "string";
        }))) {
      return { ok: false, error: { code: "INVALID_PARAMS", message: "属性条件须为 JSON 对象，值为字符串或 null（存在）。" } };
    }
    var tags = (Array.isArray(opts.tag) ? opts.tag : String(opts.tag || "").split(","))
      .map(function (tag) { return String(tag).trim().toLowerCase(); }).filter(Boolean);
    var classes = String(opts.className || "").trim().split(/\s+/).filter(Boolean);
    var allowedIds = opts.elementIds ? new Set(opts.elementIds.map(Number)) : null;
    function matches(element) {
      if (!PS.matchesFilter(element, opts.type)) return false;
      if (tags.length && tags.indexOf(element.tag) === -1) return false;
      if (opts.id && element.id !== opts.id) return false;
      var actualClasses = String(element.className || "").split(/\s+/);
      if (!classes.every(function (token) { return actualClasses.indexOf(token) !== -1; })) return false;
      if (opts.inViewport === true && !element.inViewport) return false;
      if (allowedIds && !allowedIds.has(Number(element.elementId))) return false;
      var attrs = element.attributes || {};
      return Object.keys(opts.attributes || {}).every(function (key) {
        return Object.prototype.hasOwnProperty.call(attrs, key) &&
          (opts.attributes[key] === null || attrs[key] === opts.attributes[key]);
      });
    }
    var keywords = PS.tokenizeSearchQuery(query);
    var normalizedQuery = PS.normalizeSearchText(query);
    // Optional category filter (Popup type chips); ANDed with the query.
    var typeFilter = opts.type && opts.type !== PS.FILTERS.ALL ? opts.type : null;

    var scored = [];

    if (keywords.length === 0) {
      // Empty query == "everything from the last scan".
      for (var i = 0; i < documents.length; i++) {
        var doc = documents[i];
        if (!matches(doc.element)) {
          continue;
        }
        scored.push({ doc: doc, score: 0, matchedFields: [] });
      }
    } else {
      for (var j = 0; j < documents.length; j++) {
        var candidate = documents[j];
        if (!matches(candidate.element)) {
          continue;
        }

        var total = 0;
        var matched = [];
        var allFound = true;

        for (var k = 0; k < keywords.length; k++) {
          var keyword = keywords[k];
          // AND gate: one keyword missing drops the whole element.
          if (candidate.haystack.indexOf(keyword) === -1) {
            allFound = false;
            break;
          }
          var hit = scoreKeyword(candidate, keyword);
          if (!hit) {
            allFound = false;
            break;
          }
          total += hit.score;
          if (matched.indexOf(hit.field) === -1) {
            matched.push(hit.field);
          }
        }

        if (allFound) {
          scored.push({ doc: candidate, score: total, matchedFields: matched });
        }
      }
    }

    // Relevance first, DOM order (elementId) as a stable tie-break.
    if (keywords.length) scored.sort(function (a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (a.doc.element.elementId || 0) - (b.doc.element.elementId || 0);
    });

    var total_matches = scored.length;
    var page = scored.slice(offset, offset + limit);

    var results = page.map(function (entry) {
      return {
        elementId: entry.doc.element.elementId,
        score: entry.score,
        matchedFields: entry.matchedFields,
        element: summarize(entry.doc.element)
      };
    });

    var output = {
      ok: true,
      query: typeof query === "string" ? query : "",
      normalizedQuery: normalizedQuery,
      keywords: keywords,
      limit: limit,
      offset: offset,
      indexSize: documents.length,
      total: total_matches,
      returned: results.length,
      truncated: offset + results.length < total_matches,
      results: results,
      durationMs: Date.now() - start
    };
    if (opts.includeIds) output.matchingIds = scored.map(function (entry) { return entry.doc.element.elementId; });
    return output;
  }

  global.PageSenseElementSearch = {
    buildIndex: buildIndex,
    clearIndex: clearIndex,
    getIndexInfo: getIndexInfo,
    search: search,
    // Exposed for unit tests.
    buildDocument: buildDocument,
    scoreKeyword: scoreKeyword
  };
})(typeof window !== "undefined" ? window : globalThis);
