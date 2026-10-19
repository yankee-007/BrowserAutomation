"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ROOT = path.resolve(__dirname, "../pagesense");
const source = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function workerInitialization(mode) {
  let release, listener, startup, installed, nativeCalls = 0, legacyCalls = 0;
  const sandbox = { Promise, Object, console, importScripts() {} };
  sandbox.self = sandbox;
  sandbox.chrome = { storage: { local: { get: () => new Promise(resolve => { release = resolve; }), set: async () => {} } },
    sidePanel: { setPanelBehavior: async () => {} }, runtime: {
      getURL: file => "chrome-extension://fixture/" + file,
      onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener(fn) { startup = fn; } },
      onInstalled: { addListener(fn) { installed = fn; } }
    } };
  sandbox.PageSenseBridge = { init: async () => { legacyCalls++; }, getStatus: () => ({ connected: true, state: "CONNECTED" }) };
  sandbox.PageSenseNativeBridge = { connect: async () => { nativeCalls++; }, ensure: () => ({ connected: true, state: "CONNECTED" }) };
  vm.createContext(sandbox); vm.runInContext(source("shared/constants.js"), sandbox);
  vm.runInContext(source("background/service-worker.js"), sandbox);
  let response;
  assert.equal(listener({ type: sandbox.PAGESENSE.BRIDGE_MESSAGES.GET_STATUS }, {}, value => { response = value; }), true);
  startup(); installed();
  assert.equal(nativeCalls + legacyCalls, 0, "mode must load before connection/status dispatch");
  release({ [sandbox.PAGESENSE.NATIVE.MODE_KEY]: mode }); await tick();
  assert.equal(response.mode, mode);
  assert.equal(nativeCalls, mode === "native" ? 1 : 0);
  assert.equal(legacyCalls, mode === "legacy" ? 1 : 0);
}
(async () => {
  await workerInitialization("native"); await workerInitialization("legacy");
  let port, posted = [], dispatched = [];
  const sandbox = { Promise, Object, Map, Date, Error, setTimeout, clearTimeout, crypto: require("node:crypto").webcrypto };
  sandbox.self = sandbox;
  sandbox.chrome = { runtime: { getManifest: () => ({ version: "2.0.0" }), connectNative(name) {
    assert.equal(name, "com.pagesense.bridge");
    port = { onMessage: { addListener(fn) { port.message = fn; } }, onDisconnect: { addListener(fn) { port.closed = fn; } },
      postMessage(message) { posted.push(message); }, disconnect() { port.closed(); } };
    return port;
  } } };
  sandbox.PageSenseBridge = { dispatch: async (method, params) => { dispatched.push({ method, params }); return { connected: false }; } };
  vm.createContext(sandbox); vm.runInContext(source("shared/constants.js"), sandbox); vm.runInContext(source("bridge/native-bridge.js"), sandbox);
  const bridge = sandbox.PageSenseNativeBridge;
  await bridge.connect(); assert.equal(posted[0].type, "HELLO");
  port.message({ type: "HELLO_ACK", success: true, pythonConnected: false });
  assert.equal(bridge.getStatus().connected, true); assert.equal(bridge.getStatus().pythonConnected, false);
  port.message({ type: "NATIVE_STATUS", pythonConnected: true });
  assert.equal(bridge.getStatus().pythonConnected, true);
  const receipt = bridge.sendExport({ pageId: "fixture", elements: [] });
  const sent = posted.at(-1); assert.equal(sent.type, "EXPORT");
  port.message({ type: "EXPORT_ACK", id: sent.id, success: true }); assert.equal((await receipt).received, true);
  port.message({ type: "REQUEST", id: "status", method: "GET_STATUS", params: {} }); await tick();
  assert.equal(dispatched.length, 1); assert.equal(posted.at(-1).result.connected, true);
  const pending = bridge.sendExport({ pageId: "fixture", elements: [] });
  const rejected = assert.rejects(pending, /断开/);
  await bridge.disconnect(); await rejected;
  assert.equal(bridge.getStatus().connected, false);
  console.log("PASS native/legacy startup once, startup-status race, native handshake, request reuse, ACK and disconnect cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
