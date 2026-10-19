/* Real registered Native Messaging host, isolated Chrome profile and local fixture.
 * A unique test-only HKCU host registration is restored/removed in finally.
 * No personal browser, clipboard, browsing data, token logging or source mutation.
 */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const http = require("node:http"), crypto = require("node:crypto"), { spawn, spawnSync } = require("node:child_process");
const { createInterface } = require("node:readline");
const puppeteer = require("puppeteer-core");
const ROOT = path.resolve(__dirname, "../pagesense"), CONTROLLER = path.resolve(__dirname, "../controller");
const EVIDENCE = path.resolve(process.argv[2] || path.join(__dirname, "evidence-native-bridge"));
const BROWSER = process.env.PAGESENSE_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PYTHON = process.env.PAGESENSE_TEST_PYTHON || "python";
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "pagesense-native-"));
const RUNTIME = path.join(TEMP, "runtime"), HOST = "com.pagesense.bridge.test_" + crypto.randomBytes(5).toString("hex");
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>自动桥接演示</title>
<style>body{font:16px sans-serif;margin:24px;background:#f4f7fa;color:#172b3a}button,input{padding:10px;margin:8px}section{background:white;padding:20px;margin:12px 0}</style>
<h1>订单查询</h1><p>插件自动启动连接，Python 直接编写流程。</p><section><label for="order">订单号</label><input id="order" name="order"><button id="query" data-testid="query" onclick="window.clicks++">查询订单</button><p id="note">测试正文</p></section>
<section id="records">${Array.from({ length: 123 }, (_, i) => `<p class="record">订单记录 ${i}</p>`).join("")}</section><script>window.clicks=0</script></html>`;
const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(fixture); });
let browser, panel, worker, controller, lines, snippet;
const errors = [], results = [];
function pass(name, data) { results.push({ name, data }); console.log("PASS " + name); }
async function wait(fn, ...args) { await panel.waitForFunction(fn, { timeout: 12000, polling: 50 }, ...args); }
async function rpc(method, params = {}) {
  controller.stdin.write(JSON.stringify({ method, params }) + "\n");
  const next = await lines.next(); if (next.done) throw new Error("client stopped");
  const response = JSON.parse(next.value);
  if (!response.ok) throw Object.assign(new Error(response.message), { code: response.code });
  return response.result;
}
async function fill(selector, value) { await panel.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); }, value); }
(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, pipe: true,
    userDataDir: path.join(TEMP, "profile"), enableExtensions: [ROOT], args: ["--no-first-run", "--no-default-browser-check"] });
  const target = await browser.waitForTarget(t => t.type() === "service_worker");
  worker = await target.worker(); const extensionId = new URL(target.url()).hostname;
  const demo = await browser.newPage(), url = "http://127.0.0.1:" + server.address().port;
  await demo.goto(url);
  const windowId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].windowId);
  const helper = await browser.newPage(); await helper.goto("chrome-extension://" + extensionId + "/popup/popup.html");
  await helper.evaluate(windowId => { const b = document.createElement("button"); b.id = "testOpen"; b.textContent = "Open";
    b.onclick = () => chrome.sidePanel.open({ windowId }); document.body.appendChild(b); }, windowId);
  await helper.click("#testOpen"); await demo.bringToFront();
  panel = await (await browser.waitForTarget(t => t !== helper.target() && t.url().endsWith("/popup/popup.html"))).asPage();
  panel.on("pageerror", error => errors.push(error.message));
  await panel.setViewport({ width: 400, height: 900 });
  await wait(() => document.getElementById("currentPageUrl").textContent.startsWith("http://127.0.0.1:"));
  await panel.click("#tab-python");
  assert.equal(await panel.$eval("#exportTarget", el => el.value), "all");
  assert.equal(await panel.$eval("#legacyConfig", el => el.classList.contains("hidden")), true);
  assert.ok((await panel.$eval("#installCommand", el => el.textContent)).includes(extensionId));
  assert.equal(await panel.$eval("#sendPythonBtn", el => el.disabled), false);
  await new Promise(resolve => setTimeout(resolve, 250));
  await panel.screenshot({ path: path.join(EVIDENCE, "first-install-400.png"), captureBeyondViewport: false });
  pass("Automatic mode and complete-page export are default; missing host has a concrete install command");

  const installed = spawnSync(PYTHON, [path.join(CONTROLLER, "install_bridge.py"), "--extension-id", extensionId,
    "--browser", "chrome", "--name", HOST, "--destination", path.join(TEMP, "host"), "--runtime-directory", RUNTIME],
    { encoding: "utf8", windowsHide: true });
  assert.equal(installed.status, 0, installed.stderr);
  await worker.evaluate(hostName => PageSenseNativeBridge.connect({ hostName }), HOST);
  await wait(() => document.getElementById("pythonStatus").textContent.includes("桥接就绪"));
  const sessions = fs.readdirSync(RUNTIME).filter(file => file.endsWith(".json"));
  assert.equal(sessions.length, 1);
  const session = JSON.parse(fs.readFileSync(path.join(RUNTIME, sessions[0]), "utf8"));
  assert.ok(session.pid && session.port && session.token);
  assert.equal(await worker.evaluate(() => PageSenseBridge.getStatus().connected), false);
  pass("Browser starts the actual registered native host; legacy Python server is absent");

  // Queue data before Python starts. The default action performs its own scan.
  await wait(() => !!document.getElementById("rawJson").textContent);
  await panel.click("#sendPythonBtn");
  await wait(() => document.getElementById("exportStatus").textContent.startsWith("本地收件箱已收到"));
  const firstScan = await panel.$eval("#rawJson", el => JSON.parse(el.textContent));
  controller = spawn(PYTHON, ["-u", path.join(__dirname, "native-client-driver.py")], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PAGESENSE_RUNTIME_DIR: RUNTIME } });
  controller.stderr.on("data", data => process.stderr.write(data));
  lines = createInterface({ input: controller.stdout })[Symbol.asyncIterator]();
  assert.ok(JSON.parse((await lines.next()).value).ready);
  await rpc("connect"); await wait(() => document.getElementById("pythonStatus").textContent === "Python 已连接");
  const received = await rpc("wait_for_export", { timeout: 1 });
  assert.equal(received.elements.length, firstScan.elements.length); assert.equal(received.kind, "all");
  assert.ok(received.elements.length > 123);
  assert.equal(JSON.stringify(received).includes(session.token), false);
  const status = await rpc("get_status"); assert.equal(status.mode, "native"); assert.equal(status.connected, true);
  await rpc("locator", { selector: "#query", operation: "click" });
  await rpc("locator", { selector: "#order", operation: "input", args: { value: "PS-1001" } });
  assert.equal(await demo.evaluate(() => window.clicks), 1);
  assert.equal(await demo.$eval("#order", el => el.value), "PS-1001");
  assert.equal(await rpc("locator", { selector: "#note", operation: "text" }), "测试正文");
  pass("Python connects without server/token setup, receives prequeued full-page data and executes DOM operations");

  await panel.click("#tab-explore"); await fill("#searchInput", "订单记录"); await fill("#classFilter", "record");
  await wait(() => document.getElementById("listMeta").textContent.includes("123 个结果"));
  await demo.evaluate(() => { const p = document.createElement("p"); p.className = "record"; p.textContent = "订单记录 新增"; document.getElementById("records").appendChild(p); });
  await panel.click("#tab-python"); await panel.click("#sendPythonBtn");
  await wait(() => document.getElementById("exportStatus").textContent.startsWith("Python 已收到"));
  const full = await rpc("wait_for_export", { timeout: 1 });
  assert.equal(full.elements.filter(el => el.className === "record").length, 124);
  assert.ok(full.elements.some(el => el.id === "query"));
  pass("Default send refreshes the current page and includes all records despite search/category/pagination");
  await assert.rejects(rpc("locator", { selector: "#order", operation: "input", args: { value: "x".repeat(1100000) } }), { code: "REQUEST_TOO_LARGE" });
  assert.equal(await demo.$eval("#order", el => el.value), "PS-1001");
  pass("Commands exceeding the native 1 MiB outbound limit fail before execution");

  // More than 1 MiB travels extension -> native host -> Python intact.
  await demo.evaluate(() => { const s = document.createElement("section"); for (let i = 0; i < 2200; i++) { const p = document.createElement("p");
    p.textContent = "大型扫描记录 " + i + " 内容".repeat(30); s.appendChild(p); } document.body.appendChild(s); });
  await panel.click("#sendPythonBtn"); await wait(() => document.getElementById("exportStatus").textContent.startsWith("Python 已收到"));
  const large = await rpc("wait_for_export", { timeout: 2 });
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 1024 * 1024);
  assert.ok(large.elements.length > 2200);
  pass("Complete scan payload exceeding 1 MiB crosses the actual native messaging path without truncation", { elements: large.elements.length });

  await panel.click("#tab-inspect"); await panel.click("#pickElementBtn");
  await wait(() => document.getElementById("pickStatus").textContent.includes("悬停并点击")); await demo.click("#query");
  await wait(() => document.getElementById("tab-inspect").getAttribute("aria-selected") === "true");
  await panel.select("#pythonAction", "click");
  const source = await panel.$eval("#pythonCode", el => el.textContent);
  assert.ok(source.includes("with PageSenseClient()") && !source.includes("Token:") && !source.includes("wait_for_extension"));
  await rpc("compile", { source });
  await panel.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.__copied = text; } } }));
  await panel.click("#copyPythonBtn"); assert.equal(await panel.evaluate(() => window.__copied), source);
  for (const width of [320, 400, 600]) {
    await panel.setViewport({ width, height: 900 }); await panel.click("#tab-python");
    const metrics = await panel.evaluate(() => ({ width: innerWidth, scroll: document.querySelector(".app-main").scrollWidth, main: document.querySelector(".app-main").clientWidth }));
    assert.ok(metrics.scroll <= metrics.main, JSON.stringify(metrics));
    await panel.evaluate(() => document.getElementById("toast").classList.add("hidden"));
    await new Promise(resolve => setTimeout(resolve, 200));
    await panel.screenshot({ path: path.join(EVIDENCE, "connected-" + width + ".png"), captureBeyondViewport: false });
  }
  pass("Copied Python is client-only and connection/send controls fit 320/400/600px");

  // Closing a business client does not terminate the browser-owned host.
  await rpc("close"); await wait(() => document.getElementById("pythonStatus").textContent.includes("等待 Python"));
  assert.ok(fs.existsSync(path.join(RUNTIME, sessions[0])));
  await rpc("connect"); assert.ok((await rpc("ping")).pong);
  const handle = (await rpc("locator", { selector: "#query", operation: "inspect" })).element;
  const other = await browser.newPage(); await other.goto(url + "/other"); await other.bringToFront();
  await wait(() => document.getElementById("currentPageUrl").textContent.endsWith("/other"));
  await assert.rejects(rpc("element", { handle, operation: "click" }), { code: "STALE_PAGE" });
  assert.equal(await other.evaluate(() => window.clicks), 0);
  await rpc("close");
  snippet = spawn(PYTHON, ["-u", "-c", source], { cwd: CONTROLLER, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PAGESENSE_RUNTIME_DIR: RUNTIME } });
  const finished = new Promise(resolve => snippet.once("exit", resolve));
  let snippetErrors = ""; snippet.stderr.on("data", data => { snippetErrors += data; });
  assert.equal(await finished, 0, snippetErrors); assert.equal(await other.evaluate(() => window.clicks), 1);
  pass("Client exit/reconnect preserves host, old handles fail on another page, and exact generated Python executes directly");
  assert.deepEqual(errors, []);
  const browserVersion = await browser.version();
  await browser.close(); browser = null;
  for (let i = 0; i < 100 && fs.existsSync(path.join(RUNTIME, sessions[0])); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(path.join(RUNTIME, sessions[0])), false);
  pass("Closing the browser terminates its host and removes its own discovery credential");
  const files = ["pagesense/bridge/native-bridge.js", "pagesense/background/service-worker.js", "pagesense/popup/popup.js", "pagesense/popup/popup.html", "pagesense/popup/popup.css", "pagesense/manifest.json",
    "controller/native_host.py", "controller/native_client.py", "controller/install_bridge.py", "controller/pagesense.py"];
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), browser: browserVersion, results, errors,
    sourceHashes: Object.fromEntries(files.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname, "..", file))).digest("hex")])) }, null, 2));
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (panel && !panel.isClosed()) await panel.screenshot({ path: path.join(EVIDENCE, "failure.png") }).catch(() => {});
}).finally(async () => {
  if (controller && !controller.killed) controller.stdin.end(JSON.stringify({ method: "stop" }) + "\n");
  if (snippet && snippet.exitCode === null) snippet.kill();
  if (browser) await browser.close();
  // This key uses a random test-only name and has never belonged to the user's installation.
  const cleanup = spawnSync(PYTHON, ["-c", "import sys,winreg\ntry: winreg.DeleteKey(winreg.HKEY_CURRENT_USER,sys.argv[1])\nexcept FileNotFoundError: pass", "Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST], { windowsHide: true, encoding: "utf8" });
  if (cleanup.status !== 0) { console.error("Test registration cleanup failed:", cleanup.stderr); process.exitCode = 1; }

  server.close();
});
