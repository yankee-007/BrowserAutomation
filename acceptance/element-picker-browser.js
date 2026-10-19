/* Real native side-panel picker acceptance. Only a new temporary Edge profile,
 * synthetic loopback fixture and its own browser/server; no personal clipboard.
 * node acceptance/element-picker-browser.js [evidence-directory]
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const http = require("node:http"), crypto = require("node:crypto");
const puppeteer = require("puppeteer-core");
const ROOT = path.resolve(__dirname, "..", "pagesense");
const EVIDENCE = path.resolve(process.argv[2] || path.join(os.tmpdir(), "pagesense-picker-evidence"));
const EDGE = process.env.PAGESENSE_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const fixture = '<!doctype html><html><head><meta charset="utf-8"><title>页面点选验收</title>' +
  '<style>body{font:16px sans-serif;margin:28px}button,a,input{margin:8px;padding:8px}p{padding:10px;background:#eef3ff}' +
  '#plain{display:inline-block;padding:8px}iframe{display:block;width:240px;height:75px}</style></head><body>' +
  '<h1>选择页面中的元素</h1><button id="counter" onclick="window.clicks++">业务按钮</button>' +
  '<a id="link" href="#navigated"><span id="linkText">业务链接文本</span></a>' +
  '<label><input id="check" type="checkbox">勾选框</label>' +
  '<p>普通段落 <span id="plain" class="leaf featured" data-kind="note">精确选择的文本</span></p>' +
  '<div id="shadowHost" style="display:inline-block;padding:10px;background:#eee"></div>' +
  '<iframe id="frame" srcdoc="<button id=inner onclick=window.clicks++>iframe 按钮</button><script>window.clicks=0;</script>"></iframe>' +
  '<script>window.clicks=0;document.getElementById("shadowHost").attachShadow({mode:"open"}).innerHTML="<button>Shadow 内部按钮</button>";</script>' +
  '</body></html>';
const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(fixture); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [], errors = [];
let browser, panel, helper, demo, worker, origin, url;
function pass(name, details) { results.push({ name, details }); console.log("PASS " + name + (details ? " " + JSON.stringify(details) : "")); }
async function wait(fn, ...args) { await panel.waitForFunction(fn, { polling: 100, timeout: 10000 }, ...args); }
async function openPanel(page) {
  await helper.bringToFront();
  await helper.click("#openPanel");
  await page.bringToFront();
  const target = await browser.waitForTarget(t => t !== helper.target() && t.url() === origin + "/popup/popup.html");
  panel = await target.asPage();
  await panel.setViewport({ width: 400, height: 900 });
  panel.on("pageerror", error => errors.push(error.message));
  await wait(() => document.getElementById("currentPageUrl").textContent.startsWith("http://127.0.0.1:"));
}
async function start() {
  await panel.click("#pickElementBtn");
  await wait(() => document.getElementById("pickStatus").textContent.includes("悬停并点击"));
}
async function selected(id, page = demo) {
  await page.click("#" + id);
  await wait(id => !document.getElementById("pickedElementPanel").classList.contains("hidden") &&
    document.getElementById("pickedElementDetails").textContent.includes('"' + id + '"'), id);
}
async function noOverlay(page) {
  await page.waitForFunction(() => !document.querySelector('[data-pagesense-overlay="picker-shield"]'), { polling: 100 });
}
(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + server.address().port + "/picker";
  browser = await puppeteer.launch({
    executablePath: EDGE, headless: true, pipe: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pagesense-picker-profile-")),
    enableExtensions: [ROOT], args: ["--no-first-run", "--no-default-browser-check"]
  });
  const workerTarget = await browser.waitForTarget(t => t.type() === "service_worker");
  worker = await workerTarget.worker();
  origin = "chrome-extension://" + new URL(workerTarget.url()).hostname;
  demo = await browser.newPage(); await demo.goto(url);
  const windowId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].windowId);
  helper = await browser.newPage(); await helper.goto(origin + "/popup/popup.html");
  await helper.evaluate(windowId => {
    const button = document.createElement("button");
    button.id = "openPanel"; button.textContent = "Open native panel";
    button.onclick = () => chrome.sidePanel.open({ windowId });
    document.querySelector(".app-header").appendChild(button);
  }, windowId);
  await openPanel(demo);
  assert.equal(await panel.$eval("#rawJson", el => el.textContent), "");
  await start();
  const rect = await demo.$eval("#counter", el => {
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await demo.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await demo.waitForFunction(() => document.querySelector('[data-pagesense-overlay="picker-label"]').textContent.includes("button#counter"));
  const box = await demo.$eval('[data-pagesense-overlay="picker"]', el => {
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  for (const key of Object.keys(rect)) assert.ok(Math.abs(rect[key] - box[key]) <= 1);
  await delay(200);
  await demo.screenshot({ path: path.join(EVIDENCE, "hover-preview.png"), captureBeyondViewport: false });
  pass("Picker starts without a scan; hover frame matches the exact element");
  await selected("counter");
  assert.equal(await demo.evaluate(() => window.clicks), 0);
  await noOverlay(demo);
  const details = await panel.$eval("#pickedElementDetails", el => el.textContent);
  assert.ok(details.includes("全部属性") && details.includes("HTML") && (await panel.$eval("#view-inspect", el => el.textContent)).includes("CSS 选择器"));
  assert.equal(await panel.$eval("#rawJson", el => el.textContent), "");
  await demo.click("#counter");
  assert.equal(await demo.evaluate(() => window.clicks), 1);
  pass("Selection displays full details without triggering the page button; ordinary clicks resume afterward");

  await start(); await selected("linkText");
  assert.equal(await demo.url(), url);
  assert.equal(await panel.$eval("#pickedElementSummary", el => el.textContent), "业务链接文本");
  await start(); await selected("check");
  assert.equal(await demo.$eval("#check", el => el.checked), false);
  pass("Nested link text is selected exactly; selection neither navigates nor toggles checkbox");
  await start(); await selected("frame");
  const child = await (await demo.$("#frame")).contentFrame();
  assert.equal(await child.evaluate(() => window.clicks), 0);
  await start(); await selected("shadowHost");
  pass("iframe and Shadow host selected as outer elements without entering their internals");

  await start(); await demo.keyboard.press("Escape");
  await wait(() => document.getElementById("pickStatus").textContent.includes("已取消"));
  await noOverlay(demo);
  assert.equal(await panel.$eval("#pickElementBtn", el => el.getAttribute("aria-pressed")), "false");
  await start(); await panel.keyboard.press("Escape"); await noOverlay(demo);
  assert.equal(await panel.$eval("#pickElementBtn", el => el.getAttribute("aria-pressed")), "false");
  for (let i = 0; i < 3; i++) {
    await start(); await panel.click("#pickElementBtn"); await noOverlay(demo);
  }
  await demo.click("#counter");
  assert.equal(await demo.evaluate(() => window.clicks), 2);
  pass("Escape/button cancellation and repeated sessions release event interception");

  await panel.select("#scanScope", "interactive");
  await panel.click("#scanBtn");
  await wait(() => document.getElementById("rawJson").textContent);
  await panel.$eval("#searchInput", el => { el.value = "不存在的过滤条件"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.equal(await panel.$$eval(".element-card", cards => cards.length), 0);
  await demo.evaluate(() => {
    const clone = document.getElementById("counter").cloneNode(true);
    clone.id = "counter-clone"; clone.textContent = "克隆的旧映射";
    document.body.prepend(clone);
  });
  await start(); await selected("counter");
  assert.ok(!(await panel.$eval("#pickedElementDetails", el => el.textContent)).includes("counter-clone"));
  await demo.$eval("#counter-clone", el => el.remove());
  pass("Explicit selection resolves the exact target even when the page cloned an old mapping attribute");
  await start(); await selected("plain");
  assert.equal(await panel.$eval("#searchInput", el => el.value), "不存在的过滤条件");
  assert.equal(await panel.$$eval(".element-card", cards => cards.length), 0);
  assert.ok((await panel.$eval("#pickedElementDetails", el => el.textContent)).includes("精确选择的文本"));
  await panel.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { writeText: async text => { window.__copied = text; } }
  }));
  await panel.click("#copyPickedCssBtn");
  const selector = await panel.evaluate(() => window.__copied);
  assert.equal(await demo.evaluate(selector => document.querySelector(selector).id, selector), "plain");
  await panel.click("#copyPickedTextBtn");
  assert.equal(await panel.evaluate(() => window.__copied), "精确选择的文本");
  pass("Non-interactive node outside scan scope/filter gets its own details; CSS/text copy payloads are correct");

  await panel.click("#liveScanToggle");
  await wait(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中"));
  async function scanCounter(instrument) {
    return worker.evaluate(async instrument => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: instrument => {
        if (instrument) {
          window.__pickerScans = 0;
          const original = PageSenseScanner.scanPage;
          PageSenseScanner.scanPage = function (...args) { window.__pickerScans++; return original.apply(this, args); };
        }
        return window.__pickerScans;
      }, args: [instrument] });
      return result[0].result;
    }, instrument);
  }
  await delay(400); await scanCounter(true);
  await start();
  await demo.mouse.move(rect.x + 10, rect.y + 10);
  await delay(650);
  assert.equal(await scanCounter(false), 0);
  await selected("plain"); await delay(450);
  assert.equal(await scanCounter(false), 0);
  await demo.$eval("#counter", el => { el.textContent = "实时变化后的业务按钮"; });
  await wait(() => document.getElementById("rawJson").textContent.includes("实时变化后的业务按钮"));
  assert.ok((await panel.$eval("#pickedElementDetails", el => el.textContent)).includes("精确选择的文本"));
  await panel.click("#liveScanToggle");
  pass("Picker overlay/mapping causes no live-scan loop; picked snapshot survives unrelated live updates");

  for (const width of [320, 400, 600]) {
    await panel.setViewport({ width, height: 900 });
    await panel.evaluate(() => {
      document.getElementById("toast").className = "toast hidden";
      document.getElementById("pickedElementPanel").scrollIntoView({ block: "start" });
    });
    const layout = await panel.evaluate(() => ({
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      mainWidth: document.querySelector(".app-main").clientWidth, mainScrollWidth: document.querySelector(".app-main").scrollWidth
    }));
    assert.ok(layout.documentWidth <= width && layout.mainScrollWidth <= layout.mainWidth);
    await panel.screenshot({ path: path.join(EVIDENCE, "picked-" + width + ".png") });
    pass("Picked details fit width " + width, layout);
  }
  await panel.click("#clearPickedBtn");
  assert.equal(await panel.$eval("#pickedElementPanel", el => el.classList.contains("hidden")), true);
  await start();
  const second = await browser.newPage(); await second.goto(url + "?second"); await second.bringToFront();
  await wait(() => document.getElementById("currentPageUrl").textContent.endsWith("?second"));
  await noOverlay(demo);
  assert.equal(await panel.$eval("#pickElementBtn", el => el.getAttribute("aria-pressed")), "false");
  const before = await demo.evaluate(() => window.clicks);
  await demo.$eval("#counter", el => el.click());
  assert.equal(await demo.evaluate(() => window.clicks), before + 1);
  pass("Clearing selection and changing tabs release the old page session");
  await start();
  await second.reload();
  await wait(() => document.getElementById("pickElementBtn").getAttribute("aria-pressed") === "false");
  await noOverlay(second);
  await start(); await selected("counter", second);
  await second.goto(EDGE.toLowerCase().includes("msedge") ? "edge://version" : "chrome://version");
  // Internal-page URL/title may be withheld by the existing minimal tab
  // permissions. Assert the lifecycle behavior instead of assuming visibility.
  await wait(() => document.getElementById("pickedElementPanel").classList.contains("hidden") &&
    document.getElementById("pickElementBtn").getAttribute("aria-pressed") === "false");
  await panel.click("#pickElementBtn");
  await wait(() => document.getElementById("pickStatus").textContent.includes("不支持"));
  assert.equal(await panel.$eval("#pickedElementPanel", el => el.classList.contains("hidden")), true);
  await second.goto(url + "?returned");
  await wait(() => document.getElementById("currentPageUrl").textContent.endsWith("?returned"));
  await start();
  await panel.close();
  await noOverlay(second);
  await second.click("#counter");
  assert.equal(await second.evaluate(() => window.clicks), 1);
  pass("Reload/restricted page/side-panel close cancel picking; page actions remain usable");
  await openPanel(second);
  assert.equal(await panel.$eval("#pickElementBtn", el => el.getAttribute("aria-pressed")), "false");
  assert.equal(await panel.$eval("#pickedElementPanel", el => el.classList.contains("hidden")), true);
  pass("Reopened panel starts with no active or stale selection");
  assert.deepEqual(errors, []);
  const sourceHashes = Object.fromEntries([
    "shared/constants.js", "content/scanner.js", "content/content.js", "content/element-picker.js",
    "popup/popup.js", "popup/popup.html", "popup/popup.css", "bridge/controller-bridge.js"
  ].map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex")]));
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify({
    verifiedAt: new Date().toISOString(), browser: await browser.version(), node: process.version,
    sourceHashes, results, errors
  }, null, 2));
  console.log("Evidence: " + EVIDENCE);
})().catch(async error => {
  console.error(error);
  if (panel && !panel.isClosed()) {
    await panel.screenshot({ path: path.join(EVIDENCE, "failure.png") }).catch(() => {});
    console.error(await panel.$eval("#pickStatus", el => el.textContent).catch(() => ""));
  }
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); server.close(); });
