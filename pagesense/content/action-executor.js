/*
 * PageSense - content/action-executor.js
 * V1.2 Action Layer. Executes page actions against elements resolved via
 * the Element Map and returns a single, structured result envelope for
 * every action. No action queues, no batch execution, no coordinate/CDP
 * simulation: CLICK uses element.click(), INPUT uses the native value
 * setter plus input/change events.
 */
(function (global) {
  "use strict";

  if (global.__PAGESENSE_ACTION_EXECUTOR_LOADED__) {
    return;
  }
  global.__PAGESENSE_ACTION_EXECUTOR_LOADED__ = true;

  var PS = global.PAGESENSE;
  var ACTIONS = PS.ACTIONS;
  var EC = PS.ERROR_CODES;

  /* ---- Result envelope ----------------------------------------------- */

  function randomSuffix() {
    return Math.random().toString(36).slice(2, 8);
  }

  function makeActionId() {
    return "act_" + Date.now().toString(36) + "_" + randomSuffix();
  }

  function success(actionName, elementId) {
    return {
      success: true,
      action: actionName,
      actionId: makeActionId(),
      timestamp: Date.now(),
      durationMs: 0,
      elementId: elementId == null ? null : Number(elementId),
      rescanRecommended: false
    };
  }

  function failure(actionName, elementId, code, message) {
    return {
      success: false,
      action: actionName,
      actionId: makeActionId(),
      timestamp: Date.now(),
      durationMs: 0,
      elementId: elementId == null ? null : Number(elementId),
      error: { code: code, message: message }
    };
  }

  /** Run an action builder and stamp its duration. */
  function timed(builder) {
    var start = Date.now();
    var result = builder();
    result.durationMs = Date.now() - start;
    return result;
  }

  /* ---- Shared preconditions ------------------------------------------ */

  function isDisabled(element) {
    return (
      element.disabled === true ||
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true"
    );
  }

  /**
   * Validate elementId, resolve it via the mapping and confirm the node is
   * still connected. Never guesses a replacement element.
   * @return {{element?: Element, error?: Object}}
   */
  function resolve(actionName, elementId) {
    if (!global.PageSenseElementMap.isValidId(elementId)) {
      return {
        error: failure(
          actionName, elementId, EC.INVALID_ELEMENT_ID, "无效的 elementId。"
        )
      };
    }
    var element = global.PageSenseElementMap.getElementById(elementId);
    if (!element || !element.isConnected) {
      return {
        error: failure(
          actionName, elementId, EC.ELEMENT_NOT_FOUND,
          "元素已不存在，页面内容可能已变化，请重新扫描页面。"
        )
      };
    }
    return { element: element };
  }

  /** Bring the element into the scroll view, then re-verify it exists. */
  function ensureReachable(actionName, elementId, element) {
    try {
      element.scrollIntoView({ block: "center", inline: "center" });
    } catch (e) {
      try {
        element.scrollIntoView();
      } catch (e2) { /* ignore */ }
    }
    if (!element.isConnected) {
      return {
        error: failure(
          actionName, elementId, EC.ELEMENT_NOT_FOUND,
          "元素已不存在，页面内容可能已变化，请重新扫描页面。"
        )
      };
    }
    return null;
  }

  /* ---- CLICK ---------------------------------------------------------- */

  function click(elementId) {
    return timed(function () {
      // Consistent policy: actions never leave an old overlay behind.
      global.PageSenseHighlighter.clearHighlight();

      var resolved = resolve(ACTIONS.CLICK_ELEMENT, elementId);
      if (resolved.error) {
        return resolved.error;
      }
      var element = resolved.element;

      if (isDisabled(element)) {
        return failure(
          ACTIONS.CLICK_ELEMENT, elementId, EC.ELEMENT_DISABLED,
          "元素处于禁用状态（disabled / aria-disabled），无法点击。"
        );
      }

      var reachError = ensureReachable(ACTIONS.CLICK_ELEMENT, elementId, element);
      if (reachError) {
        return reachError;
      }

      element.click();

      var result = success(ACTIONS.CLICK_ELEMENT, elementId);
      result.message = "Click completed";
      result.rescanRecommended = true;
      return result;
    });
  }

  /* ---- INPUT / CLEAR -------------------------------------------------- */

  /** Update value through the native prototype setter (framework-safe). */
  function setNativeValue(element, value) {
    var proto = element.tagName === "TEXTAREA"
      ? global.HTMLTextAreaElement.prototype
      : global.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function dispatchEvents(element, types) {
    types.forEach(function (type) {
      element.dispatchEvent(new Event(type, { bubbles: true }));
    });
  }

  /**
   * Shared implementation for INPUT_ELEMENT and CLEAR_ELEMENT (clear is
   * input with an empty value).
   */
  function setValue(actionName, elementId, value) {
    return timed(function () {
      global.PageSenseHighlighter.clearHighlight();

      if (typeof value !== "string") {
        return failure(
          actionName, elementId, EC.INVALID_VALUE,
          "value 必须是字符串。"
        );
      }

      var resolved = resolve(actionName, elementId);
      if (resolved.error) {
        return resolved.error;
      }
      var element = resolved.element;

      if (isDisabled(element)) {
        return failure(
          actionName, elementId, EC.ELEMENT_DISABLED,
          "元素处于禁用状态，无法输入。"
        );
      }

      var tag = element.tagName;

      try {
        if (tag === "INPUT" || tag === "TEXTAREA") {
          element.focus();
          setNativeValue(element, value);
          dispatchEvents(element, ["input", "change"]);

          // Verify the real DOM value.
          if (element.value !== value) {
            return failure(
              actionName, elementId, EC.ACTION_FAILED,
              "输入后实际值与目标值不一致。"
            );
          }
        } else if (element.isContentEditable) {
          element.focus();
          element.textContent = value;
          dispatchEvents(element, ["input"]);

          var actual = (element.innerText || element.textContent || "");
          if (actual !== value) {
            return failure(
              actionName, elementId, EC.ACTION_FAILED,
              "输入后 contenteditable 实际内容与目标不一致。"
            );
          }
        } else {
          return failure(
            actionName, elementId, EC.UNSUPPORTED_ELEMENT,
            "该元素不支持文本输入（仅支持 input / textarea / contenteditable）。"
          );
        }
      } catch (err) {
        return failure(
          actionName, elementId, EC.ACTION_FAILED,
          (err && err.message) ? err.message : String(err)
        );
      }

      var result = success(actionName, elementId);
      result.value = value;
      result.message = actionName === ACTIONS.CLEAR_ELEMENT
        ? "Clear completed"
        : "Input completed";
      result.rescanRecommended = true;
      return result;
    });
  }

  function input(elementId, value) {
    return setValue(ACTIONS.INPUT_ELEMENT, elementId, value);
  }

  function clear(elementId) {
    return setValue(ACTIONS.CLEAR_ELEMENT, elementId, "");
  }

  /* ---- KEYPRESS ------------------------------------------------------- */

  /** Keys that commonly change page state and warrant a rescan hint. */
  var STATE_CHANGING_KEYS = {
    "Enter": true, "Escape": true, "Tab": true,
    " ": true, "Backspace": true, "Delete": true
  };

  function keypress(elementId, key) {
    return timed(function () {
      global.PageSenseHighlighter.clearHighlight();

      var resolved = resolve(ACTIONS.KEYPRESS_ELEMENT, elementId);
      if (resolved.error) {
        return resolved.error;
      }
      var element = resolved.element;

      if (isDisabled(element)) {
        return failure(
          ACTIONS.KEYPRESS_ELEMENT, elementId, EC.ELEMENT_DISABLED,
          "元素处于禁用状态，无法发送按键。"
        );
      }

      // Normalize alias ("Space") and validate against the whitelist.
      var normalized = PS.KEY_ALIASES[key] !== undefined
        ? PS.KEY_ALIASES[key]
        : key;
      var code = PS.SUPPORTED_KEYS[normalized];
      if (code === undefined) {
        return failure(
          ACTIONS.KEYPRESS_ELEMENT, elementId, EC.INVALID_KEY,
          "不支持的按键：" + String(key)
        );
      }

      try {
        element.focus();
        var init = { key: normalized, code: code, bubbles: true, cancelable: true };
        element.dispatchEvent(new global.KeyboardEvent("keydown", init));
        element.dispatchEvent(new global.KeyboardEvent("keyup", init));
        // The deprecated DOM "keypress" event is intentionally not fired.
      } catch (err) {
        return failure(
          ACTIONS.KEYPRESS_ELEMENT, elementId, EC.ACTION_FAILED,
          (err && err.message) ? err.message : String(err)
        );
      }

      var result = success(ACTIONS.KEYPRESS_ELEMENT, elementId);
      result.key = normalized === " " ? "Space" : normalized;
      result.message = "Keypress completed";
      result.rescanRecommended = STATE_CHANGING_KEYS[normalized] === true;
      return result;
    });
  }

  /* ---- SCROLL ---------------------------------------------------------- */

  function scrollPage(direction, amount) {
    return timed(function () {
      var actionName = ACTIONS.SCROLL_PAGE;

      var directions = {
        up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0]
      };
      var vector = directions[direction];
      if (!vector) {
        return failure(
          actionName, null, EC.INVALID_VALUE,
          "direction 必须是 up / down / left / right。"
        );
      }

      var num = Number(amount);
      if (!Number.isFinite(num) || num <= 0 || num > PS.MAX_SCROLL_AMOUNT) {
        return failure(
          actionName, null, EC.INVALID_VALUE,
          "amount 必须满足 0 < amount <= " + PS.MAX_SCROLL_AMOUNT + "。"
        );
      }

      var before = { x: global.scrollX, y: global.scrollY };
      global.scrollBy(vector[0] * num, vector[1] * num);
      var after = { x: global.scrollX, y: global.scrollY };
      var moved = before.x !== after.x || before.y !== after.y;

      var result = success(actionName, null);
      result.before = before;
      result.after = after;
      result.moved = moved;
      result.message = moved ? "Scroll completed" : "Already at scroll boundary";
      // Scrolling does not change the DOM itself; mapping stays valid.
      result.rescanRecommended = false;
      return result;
    });
  }

  /* ---- Public API ------------------------------------------------------ */

  global.PageSenseActionExecutor = {
    click: click,
    input: input,
    clear: clear,
    keypress: keypress,
    scrollPage: scrollPage
  };
})(typeof window !== "undefined" ? window : globalThis);
