/* Isolated real-browser verification; never touches an existing browser profile.
 * Usage: node acceptance/side-panel-browser.js [evidence-directory]
 * Serves the built-in demo on an OS-assigned loopback port; closes only its own
 * browser and server. Temporary profile is retained for inspection.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..", "pagesense");
const EVIDENCE = path.resolve(process.argv[2] || path.join(os.tmpdir(), "pagesense-side-panel-evidence"));
const EDGE = process.env.PAGESENSE_TEST_BROWSER ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
let browser;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/test/demo.html")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(fs.readFileSync(path.join(ROOT, "test/demo.html")));
  } else {
    res.writeHead(404).end();
  }
});
const results = [];
function pass(name, details) {
  results.push({ name, details });
  console.log("PASS " + name + (details ? " " + JSON.stringify(details) : ""));
}

(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const demoUrl = `http://127.0.0.1:${server.address().port}/test/demo.html`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pagesense-side-panel-profile-"));
  browser = await puppeteer.launch({
    executablePath: EDGE, headless: true, pipe: true, userDataDir: profile,
    enableExtensions: [ROOT],
    args: ["--no-first-run", "--no-default-browser-check"]
  });
  const workerTarget = await browser.waitForTarget(t => t.type() === "service_worker", { timeout: 15000 });
  const worker = await workerTarget.worker();
  const setup = await worker.evaluate(async () => ({
    behavior: await chrome.sidePanel.getPanelBehavior(),
    options: await chrome.sidePanel.getOptions({}),
    manifest: chrome.runtime.getManifest(),
    browser: navigator.userAgent
  }));
  assert.equal(setup.behavior.openPanelOnActionClick, true);
  assert.equal(setup.options.path, "popup/popup.html");
  assert.equal(setup.manifest.action.default_popup, undefined);
  pass("Native side panel configured with toolbar opening", { behavior: setup.behavior, options: setup.options, browser: setup.browser });

  const demo = await browser.newPage();
  await demo.goto(demoUrl);
  await demo.bringToFront();
  const windowId = await worker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].windowId);
  const extensionOrigin = "chrome-extension://" + new URL(workerTarget.url()).hostname;
  // Deliver an actual input gesture in an extension document. Worker evaluation
  // is deliberately rejected by Chromium's sidePanel user-gesture requirement.
  const helper = await browser.newPage();
  await helper.goto(extensionOrigin + "/popup/popup.html");
  await helper.evaluate(windowId => {
    const button = document.createElement("button");
    button.id = "testOpenNativePanel";
    button.textContent = "Open test panel";
    button.onclick = () => chrome.sidePanel.open({ windowId });
    document.querySelector(".app-header").appendChild(button);
  }, windowId);
  await helper.click("#testOpenNativePanel");
  await demo.bringToFront();
  const panelTarget = await browser.waitForTarget(t =>
    t !== helper.target() && t.url() === extensionOrigin + "/popup/popup.html", { timeout: 15000 });
  const panel = await panelTarget.asPage();
  const errors = [];
  panel.on("pageerror", err => errors.push(err.message));
  await panel.waitForFunction(() => document.getElementById("currentPageUrl").textContent.startsWith("http://127.0.0.1:"));
  pass("Real native side panel opened for demo", { type: panelTarget.type() });
  // Keep this regression focused on the original interactive-only flow.
  await panel.select("#scanScope", "interactive");
  await panel.click("#scanBtn");
  await panel.waitForFunction(() => !document.getElementById("resultPanel").classList.contains("hidden"));
  const total = await panel.$$eval(".element-card", cards => cards.length);
  assert.ok(total > 10);
  pass("Demo scanned through native panel", { total });

  await panel.type("#searchInput", "立即沟通");
  assert.ok(await panel.$$eval(".element-card", cards => cards.length) > 0);
  await panel.click('[data-card-action="highlight"]');
  await demo.waitForFunction(() => document.querySelector("[data-pagesense-overlay]") !== null);
  pass("Search and highlight from native panel");
  await panel.click("#searchClearBtn");

  await panel.type("#searchInput", "clickTestBtn");
  await panel.click('[data-card-action="click"]');
  await demo.waitForFunction(() => document.getElementById("clickCount").textContent === "1");
  pass("Manual click reaches the demo element");
  await panel.click("#searchClearBtn");
  await panel.type("#searchInput", "actionInput");
  await panel.type(".card-text-input", "side panel input");
  await panel.click('[data-card-action="input"]');
  await demo.waitForFunction(() => document.getElementById("actionInput").value === "side panel input");
  pass("Manual input reaches the demo field");
  await panel.click("#searchClearBtn");

  // The browser owns native panel width. Use device emulation to also exercise
  // the real panel document at both narrow and wide layout sizes.
  for (const width of [320, 400, 600]) {
    await panel.setViewport({ width, height: 780 });
    await panel.$eval("#controllerPanel", el => { el.open = true; });
    await panel.evaluate(async () => {
      document.querySelector(".app-main").scrollTop = 0;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const layout = await panel.evaluate(() => ({
      width: innerWidth, height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      mainWidth: document.querySelector(".app-main").clientWidth,
      mainScrollWidth: document.querySelector(".app-main").scrollWidth,
      footerBottom: document.querySelector(".app-footer").getBoundingClientRect().bottom
    }));
    assert.ok(layout.documentWidth <= layout.width, JSON.stringify(layout));
    assert.ok(layout.mainScrollWidth <= layout.mainWidth, JSON.stringify(layout));
    assert.ok(Math.abs(layout.footerBottom - layout.height) <= 1, JSON.stringify(layout));
    await panel.screenshot({ path: path.join(EVIDENCE, `panel-${width}.png`) });
    pass("Responsive panel layout " + width, layout);
  }

  const second = await browser.newPage();
  await second.goto(demoUrl + "?second");
  await second.bringToFront();
  await panel.waitForFunction(() => document.getElementById("currentPageUrl").textContent.endsWith("?second"));
  assert.equal(await panel.$$eval(".element-card", cards => cards.length), 0);
  assert.equal(await panel.$eval("#copyBtn", el => el.disabled), true);
  pass("Native panel persists and clears results on tab switch");
  await panel.click("#scanBtn");
  await panel.waitForFunction(() => !document.getElementById("resultPanel").classList.contains("hidden"));
  await second.reload();
  await panel.waitForFunction(() => document.getElementById("resultPanel").classList.contains("hidden"));
  pass("Navigation clears old results");
  assert.deepEqual(errors, []);
  const sourceHashes = Object.fromEntries([
    "manifest.json", "background/service-worker.js", "popup/popup.html",
    "popup/popup.css", "popup/popup.js"
  ].map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex")]));
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify({
    verifiedAt: new Date().toISOString(), browser: await browser.version(),
    node: process.version, sourceHashes, results, errors
  }, null, 2));
  console.log("Evidence: " + EVIDENCE);
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
