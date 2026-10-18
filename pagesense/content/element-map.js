/*
 * PageSense - content/element-map.js
 * Owns the elementId <-> real DOM element mapping.
 * The mapping is materialized on the page elements as the namespaced
 * attribute `data-pagesense-id`, so a JSON elementId can be resolved back
 * to the exact DOM node that was scanned.
 */
(function (global) {
  "use strict";

  if (global.__PAGESENSE_ELEMENT_MAP_LOADED__) {
    return;
  }
  global.__PAGESENSE_ELEMENT_MAP_LOADED__ = true;

  var PS = global.PAGESENSE;
  var ID_ATTR = PS.PAGE_SENSE_ID_ATTR;

  /** Only positive integers (number or numeric string) are accepted. */
  function isValidId(elementId) {
    if (typeof elementId === "number") {
      return Number.isInteger(elementId) && elementId > 0;
    }
    if (typeof elementId === "string") {
      return /^[1-9]\d*$/.test(elementId);
    }
    return false;
  }

  /**
   * Remove every PageSense mapping attribute in the current document.
   * Called before each scan so stale ids never survive a rescan.
   */
  function clearMappings() {
    var nodes = global.document.querySelectorAll("[" + ID_ATTR + "]");
    Array.prototype.forEach.call(nodes, function (element) {
      element.removeAttribute(ID_ATTR);
    });
  }

  /** Bind one element to a PageSense elementId. */
  function assignId(element, elementId) {
    if (!element || !isValidId(elementId)) {
      return false;
    }
    element.setAttribute(ID_ATTR, String(elementId));
    return true;
  }

  /**
   * Resolve a PageSense elementId to the real DOM element.
   * Returns null for invalid input or when the element no longer exists.
   */
  function getElementById(elementId) {
    if (!isValidId(elementId)) {
      return null;
    }
    var selector = "[" + ID_ATTR + '="' + String(elementId) + '"]';
    return global.document.querySelector(selector);
  }

  global.PageSenseElementMap = {
    ID_ATTR: ID_ATTR,
    isValidId: isValidId,
    clearMappings: clearMappings,
    assignId: assignId,
    getElementById: getElementById
  };
})(typeof window !== "undefined" ? window : globalThis);
