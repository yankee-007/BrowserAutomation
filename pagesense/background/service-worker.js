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
  "../bridge/controller-bridge.js"
);

var PS = self.PAGESENSE;
var BRIDGE_MESSAGES = PS.BRIDGE_MESSAGES;

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

    var bridge = self.PageSenseBridge;

    switch (message.type) {
      case BRIDGE_MESSAGES.GET_STATUS:
        sendResponse(bridge.getStatus());
        return false;

      case BRIDGE_MESSAGES.CONNECT:
        bridge.connect({
          host: message.host,
          port: message.port,
          token: message.token,
          autoconnect: true
        }).then(function (status) {
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
        bridge.disconnect().then(function (status) {
          sendResponse({ ok: true, status: status });
        });
        return true; // async response

      case BRIDGE_MESSAGES.SET_CONFIG:
        bridge.saveConfig({
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
    self.PageSenseBridge.init();
  });

  chrome.runtime.onInstalled.addListener(function () {
    self.PageSenseBridge.init();
  });

  // Reconnect as soon as the worker itself is (re)started.
  self.PageSenseBridge.init();
}
