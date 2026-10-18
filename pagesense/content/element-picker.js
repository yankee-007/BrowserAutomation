/* Point-and-inspect mode. One document, one Port-owned picking session.
 * Never clicks/focuses the page element or changes its inline styles.
 */
(function (global) {
  "use strict";
  if (global.__PAGESENSE_PICKER_LOADED__) return;
  global.__PAGESENSE_PICKER_LOADED__ = true;
  var PS = global.PAGESENSE;
  var activeSession = null;

  function start(port) {
    if (activeSession) activeSession.cancel("replaced");
    var doc = global.document;
    var shield = doc.createElement("div");
    shield.setAttribute(PS.OVERLAY_ATTR, "picker-shield");
    shield.style.cssText = "position:fixed;inset:0;z-index:2147483647;" +
      "background:transparent;cursor:crosshair;user-select:none;pointer-events:auto;";
    var box = doc.createElement("div");
    box.setAttribute(PS.OVERLAY_ATTR, "picker");
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;" +
      "border:0 solid #2b5fff;box-sizing:border-box;background:rgba(43,95,255,.10);";
    var label = doc.createElement("div");
    label.setAttribute(PS.OVERLAY_ATTR, "picker-label");
    label.style.cssText = "position:fixed;top:12px;left:12px;max-width:calc(100vw - 24px);" +
      "padding:6px 10px;background:#234eda;color:white;border-radius:5px;" +
      "font:12px/1.5 sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;";
    label.textContent = "PageSense：悬停预览，点击选择，Esc 取消";
    box.appendChild(label);
    shield.appendChild(box);
    (doc.body || doc.documentElement).appendChild(shield);
    var target = null, x = null, y = null, frame = null, stopped = false;
    var listeners = [];

    function send(message) {
      try { port.postMessage(message); } catch (error) { cleanup(); }
    }
    function listen(type, fn) {
      global.addEventListener(type, fn, true);
      listeners.push([type, fn]);
    }
    function valid(element) {
      return element && element.nodeType === 1 && element.ownerDocument === doc &&
        !element.closest("[" + PS.OVERLAY_ATTR + "]");
    }
    function hitTest(clientX, clientY) {
      // The shield catches clicks over iframe contents too. Temporarily make it
      // transparent to hit testing; elementFromPoint resolves the iframe/host.
      shield.style.pointerEvents = "none";
      var element;
      try { element = doc.elementFromPoint(clientX, clientY); }
      finally { shield.style.pointerEvents = "auto"; }
      return element;
    }
    function draw() {
      frame = null;
      if (stopped) return;
      if (x !== null) target = hitTest(x, y);
      if (!valid(target) || !target.isConnected) {
        box.style.borderWidth = "0";
        box.style.width = box.style.height = "0";
        label.textContent = "PageSense：悬停预览，点击选择，Esc 取消";
        return;
      }
      var rect = target.getBoundingClientRect();
      box.style.borderWidth = "2px";
      box.style.left = rect.left + "px"; box.style.top = rect.top + "px";
      box.style.width = rect.width + "px"; box.style.height = rect.height + "px";
      var name = target.localName + (target.id ? "#" + target.id : "");
      var classes = target.getAttribute("class");
      if (classes) name += "." + classes.trim().split(/\s+/).join(".");
      label.textContent = name.slice(0, 100) + " · 点击选择 · Esc 取消";
    }
    function schedule() {
      if (frame === null && !stopped) frame = global.requestAnimationFrame(draw);
    }
    function move(event) {
      x = event.clientX; y = event.clientY;
      schedule();
    }
    function block(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    function cleanup() {
      if (stopped) return;
      stopped = true;
      listeners.forEach(function (entry) { global.removeEventListener(entry[0], entry[1], true); });
      if (frame !== null) global.cancelAnimationFrame(frame);
      shield.remove();
      target = null;
      if (activeSession === session) activeSession = null;
    }
    function cancel(reason) {
      cleanup();
      send({ type: "cancelled", reason: reason });
    }
    function choose(event) {
      block(event);
      if (event.button !== 0 || event.detail === 0) return;
      var element = hitTest(event.clientX, event.clientY);
      if (!valid(element)) return;
      cleanup();
      try {
        var result = global.PageSenseScanner.inspectTarget(element);
        send(result.ok ? { type: "selected", data: result.data } :
          { type: "error", error: result.message || result.error });
      } catch (error) {
        send({ type: "error", error: error.message });
      }
    }
    var session = { cancel: cancel };
    activeSession = session;
    port.onDisconnect.addListener(cleanup);
    listen("pointermove", move);
    ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick", "dblclick", "contextmenu"].forEach(function (type) {
      listen(type, block);
    });
    listen("click", choose);
    listen("keydown", function (event) {
      if (event.key === "Escape") { block(event); cancel("escape"); }
    });
    listen("scroll", schedule);
    listen("resize", schedule);
    listen("pagehide", cleanup);
    send({ type: "started" });
  }

  global.PageSenseElementPicker = { start: start };
})(typeof window !== "undefined" ? window : globalThis);
