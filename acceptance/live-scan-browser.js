/* Real Edge/native side panel live-scan acceptance. Uses only a new temporary
 * profile, an OS-assigned loopback port and the shipped demo. No user profile.
 * Usage: node acceptance/live-scan-browser.js [evidence-directory]
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
const EVIDENCE = path.resolve(process.argv[2] || path.join(os.tmpdir(), "pagesense-live-scan-evidence"));
const EDGE = process.env.PAGESENSE_TEST_BROWSER ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const errors = [];
let browser, panel;
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(fs.readFileSync(path.join(ROOT, "test/demo.html")));
});
function pass(name, details) {
  results.push({ name, details });
  console.log("PASS " + name + (details ? " " + JSON.stringify(details) : ""));
}
async function snapshot() {
  return panel.$eval("#rawJson", el => el.textContent ? JSON.parse(el.textContent) : null);
}
async function waitScan(predicate, ...args) {
  // Sample native panel state independently of animation-frame production.
  await panel.waitForFunction(predicate, { timeout: 10000, polling: 100 }, ...args);
}

(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const demoUrl = "http://127.0.0.1:" + server.address().port + "/test/demo.html";
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pagesense-live-scan-profile-"));
  browser = await puppeteer.launch({
    executablePath: EDGE, headless: true, pipe: true, userDataDir: profile,
    enableExtensions: [ROOT], args: ["--no-first-run", "--no-default-browser-check"]
  });
  const workerTarget = await browser.waitForTarget(t => t.type() === "service_worker");
  const worker = await workerTarget.worker();
  const origin = "chrome-extension://" + new URL(workerTarget.url()).hostname;
  const demo = await browser.newPage();
  await demo.goto(demoUrl);
  const tabId = await worker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  const windowId = await worker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].windowId);
  const helper = await browser.newPage();
  await helper.goto(origin + "/popup/popup.html");
  await helper.evaluate(windowId => {
    const button = document.createElement("button");
    button.id = "openPanel";
    button.textContent = "Open test panel";
    button.onclick = () => chrome.sidePanel.open({ windowId });
    document.querySelector(".app-header").appendChild(button);
  }, windowId);
  await helper.click("#openPanel");
  await demo.bringToFront();
  const panelTarget = await browser.waitForTarget(t =>
    t !== helper.target() && t.url() === origin + "/popup/popup.html");
  panel = await panelTarget.asPage();
  panel.on("pageerror", error => errors.push(error.message));
  await waitScan(() => document.getElementById("currentPageUrl").textContent.startsWith("http://127.0.0.1:"));
  assert.equal(await panel.$eval("#liveScanToggle", el => el.checked), false);
  // The dedicated element-explorer acceptance covers the new content default.
  await panel.select("#scanScope", "interactive");
  await panel.click("#liveScanToggle");
  await waitScan(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中"));
  const first = await snapshot();
  assert.ok(first.elements.length > 10);
  pass("Toggle immediately scans in a real native side panel", { total: first.stats.total });

  // Instrument only the test's isolated world to measure actual scans and idle
  // cleanup, independent of what the side panel chooses to render.
  async function isolated(command, value) {
    return worker.evaluate(async (tabId, command, value) => {
      const result = await chrome.scripting.executeScript({
        target: { tabId }, func: (command, value) => {
          if (command === "instrument") {
            window.__testScans = [];
            const original = PageSenseScanner.scanPage;
            PageSenseScanner.scanPage = function (...args) {
              window.__testScans.push(Date.now());
              return original.apply(this, args);
            };
          } else if (command === "scans") {
            return window.__testScans.slice();
          } else if (command === "click") {
            return PageSenseActionExecutor.click(value);
          } else if (command === "search") {
            return PageSenseElementSearch.search(value);
          }
        }, args: [command, value === undefined ? null : value]
      });
      return result[0].result;
    }, tabId, command, value);
  }
  await isolated("instrument");
  const scans = () => isolated("scans");
  await delay(850);
  assert.equal((await scans()).length, 0);
  pass("Idle page and mapping attributes do not trigger rescan loops");

  const surviving = first.elements.find(el => el.id === "clickTestBtn");
  const removed = first.elements[0];
  await demo.evaluate(removedId => {
    document.querySelector('[data-pagesense-id="' + removedId + '"]').remove();
    const button = document.createElement("button");
    button.id = "liveAdded";
    button.textContent = "实时新增目标";
    document.body.prepend(button);
    document.getElementById("clickTestBtn").firstChild.data = "实时修改目标";
  }, removed.elementId);
  await waitScan(() => {
    const scan = JSON.parse(document.getElementById("rawJson").textContent);
    return scan.elements.some(el => el.id === "liveAdded") &&
      scan.elements.some(el => el.text === "实时修改目标");
  });
  let current = await snapshot();
  assert.equal(current.elements.find(el => el.id === surviving.id).elementId, surviving.elementId);
  assert.ok(current.elements.find(el => el.id === "liveAdded").elementId > first.elements.length);
  assert.ok(!current.elements.some(el => el.elementId === removed.elementId));
  const oldAction = await isolated("click", removed.elementId);
  assert.equal(oldAction.error.code, "ELEMENT_NOT_FOUND");
  await panel.type("#searchInput", "实时");
  assert.equal(await panel.$$eval(".element-card", cards => cards.length), 2);
  const contentSearch = await isolated("search", "实时");
  assert.equal(contentSearch.total, 2);
  pass("Add/remove/text update both indexes; surviving IDs stable and removed IDs never retarget");

  await demo.$eval("#liveAdded", el => { el.style.display = "none"; });
  await waitScan(() => !JSON.parse(document.getElementById("rawJson").textContent)
    .elements.some(el => el.id === "liveAdded"));
  await demo.$eval("#liveAdded", el => { el.style.display = ""; el.disabled = true; });
  await waitScan(() => JSON.parse(document.getElementById("rawJson").textContent)
    .elements.some(el => el.id === "liveAdded" && el.disabled));
  pass("Visibility and disabled attribute changes update without manual scanning");

  await panel.click("#searchClearBtn");
  await panel.type("#searchInput", "actionInput");
  await panel.$eval(".type-filters", el => { el.open = true; });
  await panel.click('[data-filter="input"]');
  await panel.type(".card-text-input", "未提交草稿");
  await panel.$eval(".card-text-input", el => { el.setSelectionRange(2, 4); });
  await demo.$eval("#actionInput", el => {
    el.value = "页面实时输入";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitScan(() => JSON.parse(document.getElementById("rawJson").textContent)
    .elements.some(el => el.id === "actionInput" && el.text === "页面实时输入"));
  const draft = await panel.$eval(".card-text-input", el => ({
    value: el.value, focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd
  }));
  assert.deepEqual(draft, { value: "未提交草稿", focused: true, start: 2, end: 4 });
  assert.equal(await panel.$eval("#searchInput", el => el.value), "actionInput");
  assert.equal(await panel.$eval('[data-filter="input"]', el => el.classList.contains("active")), true);
  pass("Input/change refresh results while retaining search, filter, draft, focus and selection");
  const eventOnlyId = first.elements.find(el => el.tag === "input" && el.id !== "actionInput").elementId;
  await demo.evaluate(id => {
    const input = document.querySelector('[data-pagesense-id="' + id + '"]');
    input.value = "只有输入事件";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, eventOnlyId);
  await waitScan(id => JSON.parse(document.getElementById("rawJson").textContent)
    .elements.some(el => el.elementId === id && el.text === "只有输入事件"), eventOnlyId);
  pass("Input event without a DOM attribute or text mutation refreshes its value");
  await panel.$eval(".card-text-input", el => {
    window.__composingNode = el;
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await demo.$eval("#actionInput", el => {
    el.placeholder = "输入法期间页面变化";
  });
  await waitScan(() => document.getElementById("liveScanStatus").textContent.includes("输入中"));
  assert.equal(await panel.$eval(".card-text-input", el => el === window.__composingNode), true);
  await panel.$eval(".card-text-input", el => {
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  await waitScan(() => document.getElementById("rawJson").textContent.includes("输入法期间页面变化"));
  assert.equal(await panel.$eval(".card-text-input", el => el.value), "未提交草稿");
  pass("Composition events defer card replacement until IME input finishes");
  await panel.click('[data-card-action="input"]');
  await demo.waitForFunction(() => document.getElementById("actionInput").value === "未提交草稿");
  pass("Manual input action remains usable during live scanning");

  await panel.click("#searchClearBtn");
  await panel.click('[data-filter="all"]');
  await panel.type("#searchInput", "clickTestBtn");
  await panel.click('[data-card-action="highlight"]');
  await demo.waitForFunction(() => document.querySelector("[data-pagesense-overlay]"));
  await delay(1100); // allow smooth-scroll events and their trailing scan to settle
  const countBeforeHighlightIdle = (await scans()).length;
  await delay(850);
  assert.equal((await scans()).length, countBeforeHighlightIdle);
  assert.equal(await demo.$eval("[data-pagesense-overlay]", el => el.isConnected), true);
  pass("Highlight survives updates and its overlay causes no scan feedback");
  await demo.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await waitScan(() => JSON.parse(document.getElementById("rawJson").textContent).page.scroll.y > 500);
  const viewportScan = await snapshot();
  assert.ok(viewportScan.elements.some(el => el.inViewport));
  pass("Scrolling refreshes coordinates and viewport flags", { scroll: viewportScan.page.scroll });
  await demo.setViewport({ width: 680, height: 540 });
  await waitScan(() => {
    const viewport = JSON.parse(document.getElementById("rawJson").textContent).page.viewport;
    return viewport.width === 680 && viewport.height === 540;
  });
  pass("Page resize refreshes viewport dimensions");
  await demo.setViewport({ width: 800, height: 600 });
  await waitScan(() => JSON.parse(document.getElementById("rawJson").textContent).page.viewport.width === 800);

  const countBeforeBurst = (await scans()).length;
  await demo.evaluate(async () => {
    for (let i = 0; i < 24; i++) {
      document.getElementById("clickTestBtn").textContent = "连续变化" + i;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
  });
  await waitScan(() => JSON.parse(document.getElementById("rawJson").textContent)
    .elements.some(el => el.text === "连续变化23"));
  const burstTimes = (await scans()).slice(countBeforeBurst);
  assert.ok(burstTimes.length >= 2 && burstTimes.length <= 5, JSON.stringify(burstTimes));
  assert.ok(burstTimes.every((time, i) => !i || time - burstTimes[i - 1] >= 275));
  pass("Continuous changes are throttled and do not starve updates", { scans: burstTimes.length });

  await panel.click("#liveScanToggle");
  const paused = await snapshot();
  const countAtPause = (await scans()).length;
  await demo.$eval("#clickTestBtn", el => { el.textContent = "暂停期间变化"; });
  await delay(800);
  assert.deepEqual(await snapshot(), paused);
  assert.equal((await scans()).length, countAtPause);
  pass("Pause retains the last snapshot and stops actual scans");
  await panel.click("#scanBtn");
  await waitScan(() => {
    const raw = document.getElementById("rawJson").textContent;
    return raw && JSON.parse(raw).elements.some(el => el.text === "暂停期间变化");
  });
  pass("Manual scan still works while live scanning is paused");
  await panel.click("#liveScanToggle");
  await waitScan(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中"));

  const second = await browser.newPage();
  await second.goto(demoUrl + "?second");
  await second.bringToFront();
  await waitScan(() => {
    const raw = document.getElementById("rawJson").textContent;
    return raw && JSON.parse(raw).page.url.endsWith("?second");
  });
  const countAfterSwitch = (await scans()).length;
  await demo.$eval("#clickTestBtn", el => { el.textContent = "非活动页面变化"; });
  await delay(750);
  assert.equal((await scans()).length, countAfterSwitch);
  await second.reload();
  await waitScan(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中") &&
    document.getElementById("rawJson").textContent.includes("?second"));
  await second.$eval("#clickTestBtn", el => { el.textContent = "刷新后实时变化"; });
  await waitScan(() => document.getElementById("rawJson").textContent.includes("刷新后实时变化"));
  pass("Tab switch releases the old observer; refresh reconnects and updates the new document");

  await second.goto(EDGE.toLowerCase().includes("msedge") ? "edge://version" : "chrome://version");
  await waitScan(() => document.getElementById("liveScanStatus").textContent.includes("不支持"));
  assert.equal(await panel.$eval("#resultPanel", el => el.classList.contains("hidden")), true);
  await second.goto(demoUrl + "?returned");
  await waitScan(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中") &&
    document.getElementById("rawJson").textContent.includes("?returned"));
  await second.close();
  await demo.bringToFront();
  await waitScan(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中") &&
    document.getElementById("rawJson").textContent.includes("非活动页面变化"));
  pass("Restricted page clears results; returning to an ordinary page and closing a tab resume scanning");

  if (await panel.$eval("#searchInput", el => el.value)) await panel.click("#searchClearBtn");
  for (const width of [320, 400, 600]) {
    await panel.setViewport({ width, height: 780 });
    await panel.evaluate(() => { document.querySelector(".app-main").scrollTop = 0; });
    const layout = await panel.evaluate(() => ({
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      mainWidth: document.querySelector(".app-main").clientWidth,
      mainScrollWidth: document.querySelector(".app-main").scrollWidth
    }));
    assert.ok(layout.documentWidth <= width && layout.mainScrollWidth <= layout.mainWidth);
    await panel.screenshot({ path: path.join(EVIDENCE, "live-panel-" + width + ".png") });
    pass("Live controls fit panel width " + width, layout);
  }
  await panel.close(); // closes the native panel target, leaving the demo alive
  await delay(500);
  const countAfterClose = (await scans()).length;
  await demo.$eval("#clickTestBtn", el => { el.textContent = "侧栏关闭后变化"; });
  await delay(800);
  assert.equal((await scans()).length, countAfterClose);
  pass("Closing the native side panel releases the live observer");
  assert.deepEqual(errors, []);
  const sourceHashes = Object.fromEntries([
    "shared/constants.js", "content/scanner.js", "content/content.js",
    "popup/popup.html", "popup/popup.css", "popup/popup.js"
  ].map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex")]));
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify({
    verifiedAt: new Date().toISOString(), browser: await browser.version(),
    node: process.version, sourceHashes, results, errors
  }, null, 2));
  console.log("Evidence: " + EVIDENCE);
})().catch(async error => {
  console.error(error);
  if (panel && !panel.isClosed()) {
    await panel.screenshot({ path: path.join(EVIDENCE, "failure.png") }).catch(() => {});
    console.error(await panel.$eval("#liveScanStatus", el => el.textContent).catch(() => ""));
    console.error(await panel.evaluate(() => ({
      error: document.getElementById("devLog").textContent,
      scanButton: document.getElementById("scanBtn").outerHTML,
      sample: document.getElementById("rawJson").textContent &&
        JSON.parse(document.getElementById("rawJson").textContent).elements.filter(el => el.id === "clickTestBtn")
    })).catch(() => ""));
  }
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
