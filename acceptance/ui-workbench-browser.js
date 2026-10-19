/* Real MV3 side panel and Python over WebSocket. Only synthetic local fixtures,
 * an isolated browser profile, private stdio, and OS-assigned server ports.
 * PAGESENSE_TEST_BROWSER may select Chrome or Edge. No user browser/clipboard.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const http = require("node:http"), crypto = require("node:crypto");
const { spawn } = require("node:child_process"), { createInterface } = require("node:readline");
const puppeteer = require("puppeteer-core");
const ROOT = path.resolve(__dirname, "..", "pagesense");
const EVIDENCE = path.resolve(process.argv[2] || path.join(__dirname, "evidence-ui-workbench", "workbench"));
const BROWSER = process.env.PAGESENSE_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PYTHON = process.env.PAGESENSE_TEST_PYTHON || "python";
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>自动化工作台演示</title>
<style>body{font:16px Segoe UI,sans-serif;color:#172b3a;margin:0;background:#f3f5f8}header{padding:24px;background:#172b3a;color:white}main{padding:24px;max-width:900px;margin:auto}section{background:white;padding:20px;margin-bottom:16px;border:1px solid #d5dde5}button,input{font:inherit;padding:10px;margin:6px}button{background:#185adb;color:white;border:0}p{line-height:1.8}</style>
<header>PageSense 示例页面</header><main><h1>订单管理</h1><p>点选按钮获取定位信息，使用 Python 编写自动化流程。</p>
<section id="actions"><h2>查找订单</h2><label for="order">订单号</label><input id="order" placeholder="输入订单号" name="order"><button id="search" data-testid="search-order" onclick="window.clicks++">查询订单</button><p id="status">等待查询</p></section>
<section><h2>批次信息</h2><p id="note">共 123 条订单记录，等待处理。</p><button class="duplicate" onclick="window.clicks++">重复按钮 A</button><button class="duplicate" onclick="window.clicks++">重复按钮 B</button></section>
<section id="records">${Array.from({ length: 123 }, (_, i) => `<p class="record" data-row="${i}">订单记录 ${i}</p>`).join("")}</section>
<script>window.clicks=0;</script></main></html>`;
const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(fixture); });
let browser, panel, controller, lines, worker, demo, snippetProcess;
const results = [], errors = [];
function pass(name, data) { results.push({ name, data }); console.log("PASS " + name); }
async function wait(fn, ...args) { await panel.waitForFunction(fn, { polling: 50, timeout: 10000 }, ...args); }
async function fill(selector, value) {
  await panel.$eval(selector, (node, value) => { node.value = value; node.dispatchEvent(new Event("input", { bubbles: true })); }, value);
}
async function rpc(method, params = {}) {
  controller.stdin.write(JSON.stringify({ method, params }) + "\n");
  const next = await lines.next();
  if (next.done) throw new Error("Python test driver stopped");
  const response = JSON.parse(next.value);
  if (!response.ok) throw Object.assign(new Error(response.message), { code: response.code });
  return response.result;
}
async function exportFromPanel(kind) {
  await panel.click("#tab-python");
  await panel.select("#exportTarget", kind);
  await panel.click("#sendPythonBtn");
  await wait(() => document.getElementById("exportStatus").textContent.startsWith("Python 已收到"));
  return rpc("wait_for_export", { timeout: 2 });
}
(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, pipe: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pagesense-workbench-")), enableExtensions: [ROOT],
    args: ["--no-first-run", "--no-default-browser-check"] });
  const target = await browser.waitForTarget(t => t.type() === "service_worker");
  worker = await target.worker();
  const origin = "chrome-extension://" + new URL(target.url()).hostname;
  demo = await browser.newPage();
  const url = "http://127.0.0.1:" + server.address().port + "/workbench";
  await demo.goto(url);
  const windowId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].windowId);
  const helper = await browser.newPage(); await helper.goto(origin + "/popup/popup.html");
  await helper.evaluate(windowId => {
    const button = document.createElement("button"); button.id = "testOpen"; button.textContent = "Open";
    button.onclick = () => chrome.sidePanel.open({ windowId }); document.body.appendChild(button);
  }, windowId);
  await helper.click("#testOpen"); await demo.bringToFront();
  panel = await (await browser.waitForTarget(t => t !== helper.target() && t.url() === origin + "/popup/popup.html")).asPage();
  panel.on("pageerror", error => errors.push(error.message));
  await wait(() => document.getElementById("currentPageUrl").textContent.includes("/workbench"));
  await panel.setViewport({ width: 400, height: 900 });
  await panel.click("#tab-python");
  await panel.select("#transportMode", "legacy");
  await panel.select("#exportTarget", "selected");
  await panel.click("#tab-explore");
  await panel.screenshot({ path: path.join(EVIDENCE, "empty-400.png") });
  assert.equal(await panel.$eval("#sendPythonBtn", el => el.disabled), true);
  await panel.click("#pickElementBtn");
  await wait(() => document.getElementById("pickStatus").textContent.includes("悬停并点击"));
  await demo.click("#search");
  await wait(() => document.getElementById("tab-inspect").getAttribute("aria-selected") === "true");
  assert.equal(await demo.evaluate(() => window.clicks), 0);
  assert.equal(await panel.$eval("#rawJson", el => el.textContent), "");
  assert.equal(await panel.$eval("#locatorInput", el => el.value), '[data-testid="search-order"]');
  assert.ok((await panel.$eval("#pickedElementDetails", el => el.textContent)).includes("页面坐标"));
  pass("Point selection without scanning opens a readable inspector and prioritizes unique test attributes");

  await panel.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: { writeText: async value => { window.__copied = value; } } }));
  await panel.click("#copyPythonBtn");
  const generatedClick = await panel.$eval("#pythonCode", el => el.textContent);
  assert.equal(await panel.evaluate(() => window.__copied), generatedClick);
  assert.ok(generatedClick.includes('target.click()') && !generatedClick.includes('\\n'));
  await panel.click("#validateLocatorBtn");
  await wait(() => document.getElementById("locatorValidation").textContent.includes("唯一匹配 1"));
  await fill("#locatorInput", ".duplicate"); await panel.click("#validateLocatorBtn");
  await wait(() => document.getElementById("locatorValidation").textContent.includes("匹配 2"));
  assert.equal(await demo.evaluate(() => window.clicks), 0);
  await fill("#locatorInput", "#missing"); await panel.click("#validateLocatorBtn");
  await wait(() => document.getElementById("locatorValidation").textContent.includes("匹配 0"));
  await fill("#locatorInput", "button["); await panel.click("#validateLocatorBtn");
  await wait(() => document.getElementById("locatorValidation").textContent.startsWith("验证失败"));
  await fill("#locatorInput", '[data-testid="search-order"]'); await panel.click("#validateLocatorBtn");
  await wait(() => document.getElementById("locatorValidation").textContent.includes("唯一匹配 1"));
  pass("Locator validation highlights one element and reports missing, ambiguous and invalid CSS without clicking");

  await panel.click("#sendPickedBtn");
  await wait(() => document.getElementById("exportStatus").textContent.startsWith("发送失败"));
  controller = spawn(PYTHON, ["-u", path.join(__dirname, "ui-workbench-controller.py")], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  controller.stderr.on("data", chunk => process.stderr.write(chunk));
  lines = createInterface({ input: controller.stdout })[Symbol.asyncIterator]();
  const settings = JSON.parse((await lines.next()).value);
  await rpc("compile", { source: generatedClick });
  await rpc("compile", { source: await panel.$eval("#receiverCode", el => el.textContent) });
  await fill("#controllerPort", String(settings.port)); await fill("#controllerToken", settings.token);
  await panel.click("#controllerConnectBtn");
  await wait(() => document.getElementById("pythonStatus").textContent === "Python 已连接");
  const selected = await exportFromPanel("selected");
  assert.equal(selected.elements.length, 1); assert.equal(selected.kind, "selected");
  assert.ok(selected.pageId && selected.exportId && selected.details.locators.length);
  assert.equal(selected.elements[0].selector, '[data-testid="search-order"]');
  assert.equal(JSON.stringify(selected).includes(settings.token), false);
  assert.equal(await demo.evaluate(() => window.clicks), 0);
  await rpc("element", { handle: selected.elements[0], operation: "click" });
  assert.equal(await demo.evaluate(() => window.clicks), 1);
  await rpc("locator", { selector: "#order", operation: "input", args: { value: "PS-1001" } });
  assert.equal(await demo.$eval("#order", el => el.value), "PS-1001");
  await rpc("locator", { selector: "#order", operation: "clear" });
  assert.equal(await demo.$eval("#order", el => el.value), "");
  await rpc("locator", { selector: "#order", operation: "keypress", args: { key: "Enter" } });
  assert.equal(await rpc("locator", { selector: "#note", operation: "text" }), "共 123 条订单记录，等待处理。");
  await assert.rejects(rpc("locator", { selector: ".duplicate", operation: "click" }), { code: "AMBIGUOUS_SELECTOR" });
  await assert.rejects(rpc("locator", { selector: "#absent", operation: "click" }), { code: "ELEMENT_NOT_FOUND" });
  await assert.rejects(rpc("locator", { selector: "p[", operation: "click" }), { code: "INVALID_SELECTOR" });
  pass("UI connects Python; selected export is acknowledged and Python clicks, inputs, clears, reads and rejects ambiguous targets");

  await panel.click("#tab-explore");
  await panel.click("#scanBtn");
  await wait(() => !!document.getElementById("rawJson").textContent);
  const scan = await panel.$eval("#rawJson", el => JSON.parse(el.textContent));
  assert.ok(scan.page.dimensions.height > scan.page.viewport.height);
  assert.ok(await panel.$$eval("#pageMap [data-map-id]", nodes => nodes.length) > 0);
  await panel.select("#mapMode", "page");
  assert.equal(await panel.$eval("#pageMap", el => el.getAttribute("viewBox")), `0 0 ${scan.page.dimensions.width} ${scan.page.dimensions.height}`);
  await panel.select("#mapMode", "viewport");
  await panel.$eval("#pageMap [data-map-id]", node => node.focus());
  await panel.keyboard.press("ArrowRight");
  await panel.keyboard.press("Enter");
  await wait(() => document.getElementById("tab-inspect").getAttribute("aria-selected") === "true");
  const all = await exportFromPanel("all"); assert.equal(all.elements.length, scan.elements.length);
  await panel.click("#tab-explore");
  await fill("#searchInput", "订单记录");
  await fill("#classFilter", "record");
  await wait(() => document.getElementById("listMeta").textContent.includes("123 个结果"));
  const filtered = await exportFromPanel("filtered");
  assert.equal(filtered.elements.length, 123);
  assert.equal(filtered.settings.filters.query, "订单记录");
  assert.ok(filtered.elements.every(el => el.className === "record"));
  pass("Page distribution opens elements; complete and filtered exports include all results across pagination");

  // Inbox pressure is explicit: ACK only after admission, never silently drop.
  for (let i = 0; i < 8; i++) await exportFromPanel("all").then(async () => {
    // Put this snapshot back via a real bridge send so the eight slots remain occupied.
    const response = await panel.evaluate(data => new Promise(resolve => chrome.runtime.sendMessage({ type: PAGESENSE.BRIDGE_MESSAGES.SEND_EXPORT, data }, resolve)), all);
    assert.ok(response.ok);
  });
  const rejected = await panel.evaluate(data => new Promise(resolve => chrome.runtime.sendMessage({ type: PAGESENSE.BRIDGE_MESSAGES.SEND_EXPORT, data }, resolve)), all);
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, "EXPORT_REJECTED");
  for (let i = 0; i < 8; i++) await rpc("wait_for_export", { timeout: 1 });
  pass("A full Python inbox rejects exports explicitly and recovers after consumption");

  await panel.click("#tab-explore");
  await fill("#classFilter", "");
  await fill("#searchInput", "查询订单");
  await panel.click('[data-card-action="inspect"]');
  await wait(() => document.getElementById("tab-inspect").getAttribute("aria-selected") === "true");
  for (const operation of ["text", "click", "input", "clear", "keypress", "locate"]) {
    await panel.select("#pythonAction", operation);
    await rpc("compile", { source: await panel.$eval("#pythonCode", el => el.textContent) });
  }
  await panel.select("#pythonAction", "click");
  for (const width of [320, 400, 600]) {
    await panel.setViewport({ width, height: 900 });
    for (const view of ["explore", "inspect", "python"]) {
      await panel.click("#tab-" + view);
      await panel.evaluate(() => { document.getElementById("toast").classList.add("hidden"); });
      const layout = await panel.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
        main: document.querySelector(".app-main").clientWidth, scroll: document.querySelector(".app-main").scrollWidth,
        headerTop: document.querySelector(".app-header").getBoundingClientRect().top, rootScroll: scrollY, bodyScroll: document.body.scrollTop }));
      assert.ok(layout.document <= width && layout.scroll <= layout.main, JSON.stringify(layout));
      assert.equal(layout.headerTop, 0, JSON.stringify(layout));
      await panel.screenshot({ path: path.join(EVIDENCE, view + "-" + width + ".png") });
      if (view === "inspect") {
        await panel.$eval("#pythonCode", el => el.scrollIntoView({ block: "center" }));
        await panel.screenshot({ path: path.join(EVIDENCE, "code-" + width + ".png") });
      }
    }
  }
  await panel.click("#tab-explore"); await panel.focus("#tab-explore"); await panel.keyboard.press("ArrowRight");
  assert.equal(await panel.$eval("#tab-inspect", el => el.getAttribute("aria-selected")), "true");
  await panel.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  assert.equal(await panel.$eval("#scanBtn", el => getComputedStyle(el).transitionDuration), "0s");
  await panel.click("#copyPythonBtn");
  assert.equal(await panel.evaluate(() => window.__copied), await panel.$eval("#pythonCode", el => el.textContent));
  pass("All three workspaces fit 320/400/600px; keyboard tabs, reduced motion and generated Python syntax work");

  const other = await browser.newPage(); await other.goto(url + "?other"); await other.bringToFront();
  await wait(() => document.getElementById("currentPageUrl").textContent.endsWith("?other"));
  await rpc("scan", { scope: "content" });
  await assert.rejects(rpc("element", { handle: selected.elements[0], operation: "click" }), { code: "STALE_PAGE" });
  assert.equal(await other.evaluate(() => window.clicks), 0);
  const beforeReload = await rpc("locator", { selector: "#search", operation: "inspect" });
  await other.reload();
  await assert.rejects(rpc("element", { handle: beforeReload.element, operation: "click" }), { code: "STALE_PAGE" });
  await rpc("locator", { selector: "#search", operation: "click" });
  assert.equal(await other.evaluate(() => window.clicks), 1);
  pass("Old snapshot handles fail after tab switch/navigation; fresh CSS locators work without a scan");

  // Run the exact generated artifact, including its own server and connection.
  await panel.click("#pickElementBtn");
  await wait(() => document.getElementById("pickStatus").textContent.includes("悬停并点击"));
  await other.click("#search");
  await wait(() => document.getElementById("tab-inspect").getAttribute("aria-selected") === "true");
  await panel.select("#pythonAction", "click");
  const source = await panel.$eval("#pythonCode", el => el.textContent);
  const stopped = new Promise(resolve => controller.once("exit", resolve));
  controller.stdin.end(JSON.stringify({ method: "stop" }) + "\n");
  await stopped; controller = null;
  snippetProcess = spawn(PYTHON, ["-u", "-c", source], {
    cwd: path.resolve(__dirname, "../controller"), windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" }
  });
  const executed = new Promise(resolve => snippetProcess.once("exit", resolve));
  snippetProcess.stderr.on("data", chunk => process.stderr.write(chunk));
  const scriptLines = createInterface({ input: snippetProcess.stdout })[Symbol.asyncIterator]();
  const startup = (await scriptLines.next()).value;
  assert.ok(startup && startup.startsWith("Token:"));
  await worker.evaluate(settings => PageSenseBridge.connect(settings), {
    host: "127.0.0.1", port: settings.port, token: startup.slice("Token:".length).trim()
  });
  assert.equal(await executed, 0);
  assert.equal(await other.evaluate(() => window.clicks), 2);
  pass("The exact copied Python script starts, authenticates and executes its generated click");
  assert.deepEqual(errors, []);
  const sources = ["pagesense/popup/popup.js", "pagesense/popup/popup.css", "pagesense/popup/popup.html", "pagesense/content/scanner.js",
    "pagesense/content/content.js", "pagesense/content/element-map.js", "pagesense/bridge/controller-bridge.js", "pagesense/background/service-worker.js", "pagesense/shared/constants.js",
    "controller/pagesense.py", "controller/server.py", "controller/protocol.py"];
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify({ verifiedAt: new Date().toISOString(),
    browser: await browser.version(), node: process.version, results, errors,
    sourceHashes: Object.fromEntries(sources.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname, "..", file))).digest("hex")])) }, null, 2));
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (panel && !panel.isClosed()) await panel.screenshot({ path: path.join(EVIDENCE, "failure.png") }).catch(() => {});
}).finally(async () => {
  if (controller && !controller.killed) controller.stdin.end(JSON.stringify({ method: "stop" }) + "\n");
  if (snippetProcess && snippetProcess.exitCode === null) snippetProcess.kill();
  if (browser) await browser.close();
  server.close();
});
