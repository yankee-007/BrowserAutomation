/* New temporary Edge profile, native side panel and real Python/WebSocket
 * Controller. Serves only synthetic fixtures; no personal browser or clipboard.
 * node acceptance/element-explorer-browser.js [evidence-directory]
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const puppeteer = require("puppeteer-core");
const ROOT = path.resolve(__dirname, "..", "pagesense");
const EVIDENCE = path.resolve(process.argv[2] || path.join(os.tmpdir(), "pagesense-explorer-evidence"));
const EDGE = process.env.PAGESENSE_TEST_BROWSER ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const fixture = '<!doctype html><html><head><meta charset="utf-8"><title>页面内容查询验收</title>' +
  '<style>body{font:16px sans-serif;margin:24px}p{margin:8px 0}button,input{padding:8px}.hidden{display:none}</style>' +
  '</head><body><main id="catalog"><h1>页面内容查询</h1><h2>商品目录</h2>' +
  '<p id="intro">本页包含 257 条可检索文本、交互控件和语义结构。</p>' +
  '<article class="card featured"><p id="price:a.1" class="price featured" data-kind="price" data-testid="price">参考价格 128 元</p>' +
  '<button id="buy" class="primary featured" data-testid="buy">查看详情</button></article>' +
  '<label for="name">姓名</label><input id="name" placeholder="输入姓名"><select><option>默认选项</option></select>' +
  '<input type="checkbox"><div contenteditable="true">可编辑内容</div>' +
  '<img alt="示例封面" width="64" height="32" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'64\' height=\'32\'%3E%3Crect width=\'64\' height=\'32\' fill=\'%232b5fff\'/%3E%3C/svg%3E">' +
  '<ul><li>列表条目</li></ul><table><tr><th>名称</th><td>示例</td></tr></table>' +
  '<div class="plain">普通文本内容<span>行内补充</span></div><div class="empty" style="height:10px"></div>' +
  '<p class="hidden">不应扫描的隐藏文字</p><p id="long">' + "长文".repeat(210) + '尾部定位词</p>' +
  Array.from({ length: 257 }, (_, i) => '<p class="record" data-row="' + i + '">目录记录 ' + i + '</p>').join("") +
  '</main></body></html>';
const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(fixture); });
const results = [], errors = [];
let browser, panel, controller, lines;
function pass(name, details) { results.push({ name, details }); console.log("PASS " + name + (details ? " " + JSON.stringify(details) : "")); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, ...args) { await panel.waitForFunction(fn, { polling: 100, timeout: 10000 }, ...args); }
async function raw() { return panel.$eval("#rawJson", el => el.textContent ? JSON.parse(el.textContent) : null); }
async function fill(selector, value) {
  await panel.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); }, value);
}
async function rpc(method, params) {
  controller.stdin.write(JSON.stringify({ method, params }) + "\n");
  const response = JSON.parse((await lines.next()).value);
  if (!response.ok) throw Object.assign(new Error(response.message), { code: response.code });
  return response.result;
}
(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({
    executablePath: EDGE, headless: true, pipe: true,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pagesense-explorer-profile-")),
    enableExtensions: [ROOT], args: ["--no-first-run", "--no-default-browser-check"]
  });
  const workerTarget = await browser.waitForTarget(t => t.type() === "service_worker");
  const worker = await workerTarget.worker();
  const origin = "chrome-extension://" + new URL(workerTarget.url()).hostname;
  const demo = await browser.newPage();
  await demo.goto("http://127.0.0.1:" + server.address().port + "/fixture");
  const windowId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].windowId);
  const helper = await browser.newPage();
  await helper.goto(origin + "/popup/popup.html");
  await helper.evaluate(windowId => {
    const button = document.createElement("button");
    button.id = "openPanel"; button.textContent = "Open test panel";
    button.onclick = () => chrome.sidePanel.open({ windowId });
    document.querySelector(".app-header").appendChild(button);
  }, windowId);
  await helper.click("#openPanel");
  await demo.bringToFront();
  panel = await (await browser.waitForTarget(t => t !== helper.target() && t.url() === origin + "/popup/popup.html")).asPage();
  panel.on("pageerror", e => errors.push(e.message));
  await wait(() => document.getElementById("currentPageUrl").textContent.includes("/fixture"));
  assert.equal(await panel.$eval("#scanScope", el => el.value), "content");
  await panel.click("#scanBtn");
  await wait(() => document.getElementById("rawJson").textContent);
  const initial = await raw();
  assert.ok(initial.stats.total > 270);
  assert.ok(["button", "input", "toggle", "editable", "heading", "paragraph", "image", "table", "list", "region"]
    .every(category => initial.stats.categories[category]));
  assert.ok(!initial.elements.some(el => el.text.includes("不应扫描")));
  assert.equal(await panel.$$eval(".element-card", cards => cards.length), 100);
  pass("Default content scan includes text/media/structure/controls; card rendering paginated", { total: initial.stats.total, categories: initial.stats.categories });
  await fill("#searchInput", "目录记录");
  await wait(() => document.getElementById("listMeta").textContent.includes("257 个结果"));
  const ids = new Set();
  for (let page = 0; page < 3; page++) {
    for (const id of await panel.$$eval(".element-card", cards => cards.map(el => el.dataset.recordId))) ids.add(id);
    if (page < 2) await panel.click("#nextPageBtn");
  }
  assert.equal(ids.size, 257);
  assert.equal(await panel.$$eval(".element-card", cards => cards.length), 57);
  assert.equal(await panel.$eval("#nextPageBtn", el => el.disabled), true);
  await panel.click("#prevPageBtn");
  assert.equal(await panel.$eval("#pageStatus", el => el.textContent), "2 / 3");
  pass("All 257 search matches reachable across pages without duplicates or an overall cap");
  await fill("#searchInput", "尾部定位词");
  assert.equal(await panel.$$eval(".element-card", cards => cards.length), 1);
  pass("Search finds text beyond the 300-character card preview");
  await fill("#searchInput", "");
  await panel.$eval("#advancedFilters", el => { el.open = true; });
  await fill("#tagFilter", "p");
  await fill("#classFilter", "price featured");
  await fill("#attributeFilter", '{"data-kind":"price"}');
  assert.equal(await panel.$$eval(".element-card", cards => cards.length), 1);
  await fill("#cssFilter", "article.card > p.price[data-kind=price]");
  await wait(() => !document.getElementById("elementList").classList.contains("is-query-pending") &&
    document.querySelectorAll(".element-card").length === 1);
  await panel.$eval(".element-inspector", el => { el.open = true; });
  await wait(() => document.querySelector("#elementList .inspector-body").textContent.includes("全部属性"));
  const inspected = await panel.$eval("#elementList .inspector-body", el => el.textContent);
  assert.ok(inspected.includes("data-testid") && inspected.includes("price:a.1") && inspected.includes("article"));
  await panel.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.__copied = text; } } }); });
  await panel.click('[data-card-action="copy-selector"]');
  const selector = await panel.evaluate(() => window.__copied);
  assert.equal(await demo.evaluate(selector => document.querySelectorAll(selector).length, selector), 1);
  await panel.click('[data-card-action="copy-text"]');
  await wait(() => window.__copied === "参考价格 128 元");
  assert.equal(await panel.evaluate(() => window.__copied), "参考价格 128 元");
  await panel.click('[data-card-action="highlight"]');
  await demo.waitForFunction(() => document.querySelector("[data-pagesense-overlay]"));
  pass("Tag/class/attributes/CSS intersect; details, escaped unique selector, copy payloads and highlight work");
  await fill("#cssFilter", "article[");
  await wait(() => document.getElementById("listMeta").textContent.includes("CSS 选择器语法无效"));
  await fill("#cssFilter", "");
  await fill("#attributeFilter", "{invalid");
  assert.ok((await panel.$eval("#listMeta", el => el.textContent)).includes("JSON 格式无效"));
  await panel.click("#clearFiltersBtn");
  assert.equal(await panel.$eval("#searchInput", el => el.value), "");
  await panel.click('[data-filter="text-content"]');
  assert.ok(await panel.$$eval(".element-card", cards => cards.length) > 0);
  await panel.$eval(".type-filters", el => { el.open = true; });
  await panel.click('[data-filter="heading"]');
  assert.equal(await panel.$$eval(".element-card", cards => cards.length), 2);
  pass("Invalid CSS/JSON are explicit errors; clear and group/subtype filtering work");

  await panel.click("#clearFiltersBtn");
  await fill("#cssFilter", "p.price");
  await wait(() => !document.getElementById("elementList").classList.contains("is-query-pending") &&
    document.querySelectorAll(".element-card").length === 1);
  await panel.click("#liveScanToggle");
  await wait(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中"));
  const beforeId = (await raw()).elements.find(el => el.id === "price:a.1").elementId;
  await demo.evaluate(() => {
    const paragraph = document.createElement("p");
    paragraph.className = "price"; paragraph.textContent = "新增价格 256 元";
    document.querySelector("article").appendChild(paragraph);
  });
  await wait(() => document.querySelectorAll(".element-card").length === 2 &&
    !document.getElementById("elementList").classList.contains("is-query-pending"));
  assert.equal((await raw()).elements.find(el => el.id === "price:a.1").elementId, beforeId);
  await panel.click("#liveScanToggle");
  pass("CSS result membership refreshes with live content changes and stable IDs");

  await panel.select("#scanScope", "interactive");
  await wait(() => {
    const value = document.getElementById("rawJson").textContent;
    return value && JSON.parse(value).scope === "interactive";
  });
  assert.ok((await raw()).elements.every(el => el.interactive));
  await panel.select("#scanScope", "all");
  await wait(() => {
    const value = document.getElementById("rawJson").textContent;
    return value && JSON.parse(value).scope === "all";
  });
  assert.ok((await raw()).elements.some(el => el.className === "empty"));
  pass("Interactive and all-visible-DOM scopes rescan correctly");

  controller = spawn(process.env.PAGESENSE_TEST_PYTHON || "python", ["-u", path.join(__dirname, "element-explorer-controller.py")], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" })
  });
  controller.stderr.on("data", data => { process.stderr.write(data); });
  lines = createInterface({ input: controller.stdout })[Symbol.asyncIterator]();
  const settings = JSON.parse((await lines.next()).value);
  await worker.evaluate(settings => PageSenseBridge.connect({ host: "127.0.0.1", port: settings.port, token: settings.token }), settings);
  await worker.waitForFunction(() => PageSenseBridge.getStatus().connected, { timeout: 10000 });
  const apiScan = await rpc("scan", { scope: "content" });
  assert.ok(apiScan.elements.some(el => el.category === "paragraph"));
  const apiPage = await rpc("search", { query: "目录记录", limit: 100, offset: 200, tag: "p", class_name: "record" });
  assert.equal(apiPage.total, 257); assert.equal(apiPage.returned, 57);
  assert.equal(apiPage.indexSize, apiScan.elements.length);
  const apiCss = await rpc("search", { query: "", selector: "article.card > p[data-kind=price]", attrs: { "data-kind": "price" } });
  assert.equal(apiCss.total, 1);
  assert.equal(apiCss.results[0].elementId, beforeId);
  const apiDetails = await rpc("inspect", { element_id: apiCss.results[0].elementId });
  assert.equal(apiDetails.selectorMatches, 1);
  await assert.rejects(rpc("search", { query: "", selector: "p[" }), { code: "INVALID_SELECTOR" });
  pass("Real Python client ↔ WebSocket ↔ extension supports scopes, page 3, CSS/attrs, accurate indexSize and inspect");

  await panel.select("#scanScope", "content");
  await wait(() => {
    const value = document.getElementById("rawJson").textContent;
    return value && JSON.parse(value).scope === "content";
  });
  await panel.click("#clearFiltersBtn");
  await fill("#searchInput", "参考价格");
  await panel.$eval(".element-inspector", el => { el.open = true; });
  await wait(() => document.querySelector("#elementList .inspector-body").textContent.includes("全部属性"));
  await panel.$eval("#advancedFilters", el => { el.open = false; });
  await panel.$eval(".type-filters", el => { el.open = false; });
  for (const width of [320, 400, 600]) {
    await panel.setViewport({ width, height: 900 });
    await panel.evaluate(() => {
      document.getElementById("searchInput").blur();
      document.getElementById("toast").className = "toast hidden";
      document.querySelector(".app-main").scrollTop = 0;
    });
    const layout = await panel.evaluate(() => ({
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      mainWidth: document.querySelector(".app-main").clientWidth, mainScrollWidth: document.querySelector(".app-main").scrollWidth
    }));
    assert.ok(layout.documentWidth <= width && layout.mainScrollWidth <= layout.mainWidth, JSON.stringify(layout));
    await panel.screenshot({ path: path.join(EVIDENCE, "explorer-" + width + ".png") });
    await panel.$eval(".element-inspector", el => el.scrollIntoView({ block: "start" }));
    await panel.screenshot({ path: path.join(EVIDENCE, "details-" + width + ".png") });
    pass("Detailed card and query controls fit width " + width, layout);
  }
  await demo.evaluate(() => {
    const container = document.createElement("section");
    for (let i = 0; i < 5000; i++) {
      const paragraph = document.createElement("p");
      paragraph.textContent = "性能样本 " + i; container.appendChild(paragraph);
    }
    document.body.appendChild(container);
  });
  const started = Date.now();
  const largeScan = await rpc("scan", { scope: "content", timeout: 20 });
  const scanMs = Date.now() - started;
  assert.ok(largeScan.elements.length > 5000);
  const lastPage = await rpc("search", { query: "性能样本", offset: 4900, limit: 100 });
  assert.equal(lastPage.returned, 100); assert.equal(lastPage.total, 5000);
  pass("5000 DOM text records scanned without count cap; final page reachable", { total: largeScan.stats.total, scanMs });
  assert.deepEqual(errors, []);
  const hashes = Object.fromEntries([
    "shared/constants.js", "content/scanner.js", "content/element-search.js", "content/content.js",
    "popup/popup.js", "popup/popup.html", "popup/popup.css", "bridge/controller-bridge.js"
  ].map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex")]));
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify({
    verifiedAt: new Date().toISOString(), browser: await browser.version(), node: process.version,
    sourceHashes: hashes, results, errors
  }, null, 2));
  console.log("Evidence: " + EVIDENCE);
})().catch(async error => {
  console.error(error);
  if (panel && !panel.isClosed()) {
    await panel.screenshot({ path: path.join(EVIDENCE, "failure.png") }).catch(() => {});
    console.error(await panel.evaluate(() => ({ meta: document.getElementById("listMeta").textContent, error: document.getElementById("devLog").textContent })).catch(() => ""));
  }
  process.exitCode = 1;
}).finally(async () => {
  if (controller && !controller.killed) { controller.stdin.end(JSON.stringify({ method: "stop" }) + "\n"); }
  if (browser) await browser.close();
  server.close();
});
