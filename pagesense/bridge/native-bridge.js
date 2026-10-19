/* Browser-owned transport. DOM operations continue through PageSenseBridge.dispatch. */
(function (global) {
  "use strict";
  var PS = global.PAGESENSE, port = null, phase = "DISCONNECTED", lastError = null;
  var pythonConnected = false, paused = false, retryAt = 0, retryTimer = null, helloTimer = null;
  var generation = 0, pending = new Map(), recentRequests = [], hostName = PS.NATIVE.HOST;

  function status() {
    return { mode: "native", state: phase, connected: phase === "CONNECTED", pythonConnected: pythonConnected,
      lastError: lastError, hostName: hostName, recentRequests: recentRequests.slice() };
  }
  function rejectPending(message) {
    pending.forEach(function (item) { clearTimeout(item.timer); item.reject(new Error(message)); });
    pending.clear();
  }
  function close() {
    generation++;
    clearTimeout(helloTimer); clearTimeout(retryTimer);
    var old = port; port = null;
    if (old) old.disconnect();
    pythonConnected = false;
    rejectPending("本地桥接已断开，无法确认收件。请检查 Python，未自动重发。");
  }
  function fail(message) {
    close(); phase = "ERROR";
    var hint = message || "请先安装本地桥接，再重试自动连接。";
    if (/not found/i.test(hint)) hint = "尚未安装本地桥接。请运行上方安装命令，再点击“重试自动连接”。";
    else if (/forbidden|not allowed/i.test(hint)) hint = "扩展 ID 尚未注册或已变化，请重新运行上方安装命令。";
    else if (/failed to start|host has exited/i.test(hint)) hint = "本地桥接无法启动，请检查 Python 和依赖，再重新运行安装命令。";
    lastError = { code: "NATIVE_HOST_UNAVAILABLE", message: hint, details: message || "" };
    retryAt = Date.now() + 30000;
    if (!paused) retryTimer = setTimeout(function () { connect(); }, 30000);
  }
  function post(message) {
    if (!port) throw new Error("本地桥接未连接。");
    port.postMessage(message);
  }
  function connect(options) {
    paused = false;
    if (options && options.hostName) hostName = options.hostName;
    close(); phase = "CONNECTING"; lastError = null;
    var current = generation;
    try {
      var opened = chrome.runtime.connectNative(hostName); port = opened;
      opened.onDisconnect.addListener(function () {
        var error = chrome.runtime.lastError;
        if (current !== generation || port !== opened) return;
        fail(error ? error.message : "本地桥接已退出，请重试连接。");
      });
      opened.onMessage.addListener(function (message) {
        if (current !== generation || port !== opened || !message) return;
        if (message.type === "HELLO_ACK") {
          clearTimeout(helloTimer);
          if (!message.success) { fail("本地桥接拒绝了连接。"); return; }
          phase = "CONNECTED"; lastError = null; pythonConnected = Boolean(message.pythonConnected);
        } else if (message.type === "NATIVE_STATUS") {
          pythonConnected = Boolean(message.pythonConnected);
        } else if (message.type === "EXPORT_ACK") {
          var item = pending.get(message.id);
          if (!item) return;
          clearTimeout(item.timer); pending.delete(message.id);
          if (message.success) item.resolve({ received: true, pythonConnected: pythonConnected });
          else item.reject(new Error((message.error || {}).message || "本地收件箱拒绝数据。"));
        } else if (message.type === "REQUEST") {
          var started = Date.now();
          Promise.resolve().then(function () { return global.PageSenseBridge.dispatch(message.method, message.params || {}); })
            .then(function (result) { reply(true, result); }).catch(function (error) {
              reply(false, { code: error.code || "BRIDGE_ERROR", message: error.message || String(error) });
            });
          function reply(success, payload) {
            if (current !== generation || port !== opened) return;
            var response = { type: "RESPONSE", id: message.id, success: success };
            if (success && message.method === "GET_STATUS") payload = Object.assign({}, payload,
              { mode: "native", connected: phase === "CONNECTED", state: phase, pythonConnected: pythonConnected });
            response[success ? "result" : "error"] = payload;
            try { post(response); }
            catch (error) { fail("操作回执发送失败，执行结果未知，请检查页面。"); }
            recentRequests.push({ time: new Date().toLocaleTimeString(), method: message.method,
              success: success, summary: success ? (Date.now() - started) + "ms" : payload.code });
            recentRequests = recentRequests.slice(-20);
          }
        }
      });
      helloTimer = setTimeout(function () { if (current === generation) fail("本地桥接启动超时，请检查安装与 Python 依赖。"); }, 10000);
      post({ type: "HELLO", protocol: PS.BRIDGE.PROTOCOL, client: "extension", version: chrome.runtime.getManifest().version });
    } catch (error) { fail(error.message); }
    return Promise.resolve(status());
  }
  function ensure() {
    if (!paused && !port && Date.now() >= retryAt) connect();
    return status();
  }
  function disconnect() {
    paused = true; close(); phase = "DISCONNECTED"; lastError = null;
    return Promise.resolve(status());
  }
  function sendExport(data) {
    if (phase !== "CONNECTED") return Promise.reject(new Error("本地桥接尚未就绪，请在 Python 对接页完成首次安装。"));
    if (!data || !data.pageId || !Array.isArray(data.elements)) return Promise.reject(new Error("发送数据缺少页面或元素。"));
    var id = "export_" + crypto.randomUUID();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pending.delete(id); reject(new Error("8 秒内未收到本地桥接确认；数据可能已收到，未自动重发。"));
      }, 8000);
      pending.set(id, { timer: timer, resolve: resolve, reject: reject });
      try { post({ type: "EXPORT", id: id, data: data }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  global.PageSenseNativeBridge = { connect: connect, disconnect: disconnect, getStatus: status,
    ensure: ensure, sendExport: sendExport };
})(typeof self !== "undefined" ? self : globalThis);
