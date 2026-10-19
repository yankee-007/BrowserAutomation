/*
 * PageSense - background/service-worker.js
 * MV3 Service Worker entry point.
 *
 * Responsibilities:
 *  - own the Controller Bridge for the whole browser session (the Popup is
 *    far too short-lived to hold a WebSocket)
 *  - answer Popup control messages (status / connect / disconnect / config)
 *  - re-establish the bridge after the worker is restarted by the browser
 *
 * The worker can be terminated at any time by Chromium; nothing here assumes
 * the socket survives that. An open Controller session produces continuous
 * WebSocket traffic, which is what keeps the worker alive in practice.
 */
"use strict";

importScripts(
  "../shared/constants.js",
  "../bridge/controller-bridge.js",
  "../bridge/native-bridge.js"
);

var PS = self.PAGESENSE;
var BRIDGE_MESSAGES = PS.BRIDGE_MESSAGES;
var transportMode = "native";
function activeBridge() { return transportMode === "legacy" ? self.PageSenseBridge : self.PageSenseNativeBridge; }
var initialization = null;
function initTransport() {
  if (initialization) return initialization;
  initialization = chrome.storage.local.get([PS.NATIVE.MODE_KEY]).then(function (stored) {
    transportMode = stored[PS.NATIVE.MODE_KEY] || "native";
    if (transportMode === "legacy") return self.PageSenseBridge.init();
    if (transportMode === "paused") return self.PageSenseNativeBridge.disconnect();
    return self.PageSenseNativeBridge.connect();
  });
  return initialization;
}

/** Guard against registering the same listener twice in one worker life. */
if (!self.__PAGESENSE_SW_READY__) {
  self.__PAGESENSE_SW_READY__ = true;

  // Use the browser's persistent side panel when the toolbar icon is clicked.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(function (err) {
      console.error("PageSense side panel setup failed:", err);
    });

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) {
      return false;
    }

    var bridge = activeBridge();

    switch (message.type) {
      case BRIDGE_MESSAGES.SEND_EXPORT:
        // Only extension UI may export page data through the authenticated socket.
        if (sender.tab || sender.url !== chrome.runtime.getURL("popup/popup.html")) return false;
        bridge.sendExport(message.data).then(function (receipt) {
          sendResponse({ ok: true, receipt: receipt });
        }).catch(function (err) {
          sendResponse({ ok: false, error: { code: err.code, message: err.message } });
        });
        return true;

      case BRIDGE_MESSAGES.START_NATIVE:
        if (sender.tab || sender.url !== chrome.runtime.getURL("popup/popup.html")) return false;
        self.PageSenseBridge.disconnect().then(function () {
          transportMode = "native";
          return chrome.storage.local.set({ [PS.NATIVE.MODE_KEY]: "native" });
        }).then(function () { return self.PageSenseNativeBridge.connect(); }).then(function (status) {
          sendResponse({ ok: true, status: status });
        });
        return true;

      case BRIDGE_MESSAGES.GET_STATUS:
        initTransport().then(function () {
          var selectedBridge = activeBridge();
          var status = transportMode === "native" ? self.PageSenseNativeBridge.ensure() : selectedBridge.getStatus();
          status.mode = transportMode === "legacy" ? "legacy" : "native";
          sendResponse(status);
        }).catch(function () { sendResponse({ state: "ERROR", mode: "native", connected: false,
          lastError: { message: "无法读取本地连接配置，请重新打开侧栏。" } }); });
        return true;

      case BRIDGE_MESSAGES.CONNECT:
        self.PageSenseNativeBridge.disconnect().then(function () {
          transportMode = "legacy";
          return chrome.storage.local.set({ [PS.NATIVE.MODE_KEY]: "legacy" });
        }).then(function () { return self.PageSenseBridge.connect({
          host: message.host,
          port: message.port,
          token: message.token,
          autoconnect: true
        }); }).then(function (status) {
          sendResponse({ ok: true, status: status });
        }).catch(function (err) {
          sendResponse({
            ok: false,
            error: {
              code: err && err.code ? err.code : "BRIDGE_ERROR",
              message: err && err.message ? err.message : String(err)
            },
            status: bridge.getStatus()
          });
        });
        return true; // async response

      case BRIDGE_MESSAGES.DISCONNECT:
        if (transportMode !== "legacy") {
          transportMode = "paused";
          chrome.storage.local.set({ [PS.NATIVE.MODE_KEY]: "paused" });
        }
        bridge.disconnect().then(function (status) {
          sendResponse({ ok: true, status: status });
        });
        return true; // async response

      case BRIDGE_MESSAGES.SET_CONFIG:
        self.PageSenseBridge.saveConfig({
          host: message.host,
          port: message.port,
          token: message.token
        }).then(function () {
          sendResponse({ ok: true, status: bridge.getStatus() });
        }).catch(function (err) {
          sendResponse({
            ok: false,
            error: {
              code: err && err.code ? err.code : "INVALID_PARAMS",
              message: err && err.message ? err.message : String(err)
            },
            status: bridge.getStatus()
          });
        });
        return true; // async response

      default:
        return false;
    }
  });

  // A restored worker has no socket: reconnect when the user has opted in.
  chrome.runtime.onStartup.addListener(function () {
    initTransport();
  });

  chrome.runtime.onInstalled.addListener(function () {
    initTransport();
  });

  // Reconnect as soon as the worker itself is (re)started.
  initTransport();
}
