/* Isolated Chrome + synthetic HTTP pages + real native host. No personal browser. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const http = require("node:http"), crypto = require("node:crypto"), { spawn, spawnSync } = require("node:child_process");
const puppeteer = require("puppeteer-core");
const PROJECT = path.resolve(__dirname, ".."), ROOT = path.join(PROJECT, "pagesense"), CONTROLLER = path.join(PROJECT, "controller");
const EVIDENCE = path.resolve(process.argv[2] || path.join(__dirname, "evidence-element-api"));
const BROWSER = process.env.PAGESENSE_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PYTHON = process.env.PAGESENSE_TEST_PYTHON || "python";
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "pagesense-element-api-"));
const RUNTIME = path.join(TEMP, "runtime"), HOST = "com.pagesense.bridge.test_" + crypto.randomBytes(5).toString("hex");
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>按需定位合成页</title>
<style>body{font:16px sans-serif;margin:16px}button,input{padding:8px;margin:3px}#long{margin-top:600px}#root{padding:10px}</style>
<h1>按需定位</h1><section id="root"><a class="item" href="/first">第一条</a><a id="second" class="item" href="/second">第二条</a><p>段落一</p><p>段落二</p></section>
<a href="/outside">容器外部</a><input id="field"><input id="password" type="password" value="synthetic-value">
<button id="action" onclick="document.getElementById('clicks').textContent=String(++window.clicks)">点击测试</button><span id="clicks">0</span>
<button id="insert" onclick="const a=document.createElement('a');a.className='item';a.textContent='插入项';document.getElementById('root').prepend(a)">插入</button>
<button id="clone" onclick="const b=document.getElementById('second');b.replaceWith(b.cloneNode(true))">替换克隆</button>
<a id="next" href="/other">下一页</a><p id="long">${"长".repeat(21000)}</p><script>window.clicks=0</script></html>`;
const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url === "/other" ? '<!doctype html><meta charset="utf-8"><title>第二页</title><h1>第二页</h1><p>新文档</p><button id="action">第二页按钮</button>' : fixture); });
let browser, panel;
const results = [], errors = [];
function pass(name, data) { results.push({ name, data }); console.log("PASS " + name); }
async function wait(fn, ...args) { await panel.waitForFunction(fn, { timeout: 15000, polling: 50 }, ...args); }
async function python(args) {
  const child = spawn(PYTHON, args, { cwd: CONTROLLER, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONPATH: CONTROLLER, PYTHONIOENCODING: "utf-8", PAGESENSE_RUNTIME_DIR: RUNTIME } });
  let output = "", failure = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { failure += data; });
  const timer = setTimeout(() => child.kill(), 60000);
  const exit = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  clearTimeout(timer); assert.equal(exit, 0, failure || output);
  return output;
}
function snippet(source) { return python(["-u", "-c", source]); }
(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, pipe: true,
    userDataDir: path.join(TEMP, "profile"), enableExtensions: [ROOT], args: ["--no-first-run", "--no-default-browser-check"] });
  const target = await browser.waitForTarget(t => t.type() === "service_worker");
  const worker = await target.worker(), extensionId = new URL(target.url()).hostname;
  const demo = await browser.newPage(), url = "http://127.0.0.1:" + server.address().port;
  await demo.goto(url);
  const installed = spawnSync(PYTHON, [path.join(CONTROLLER, "install_bridge.py"), "--extension-id", extensionId, "--browser", "chrome",
    "--name", HOST, "--destination", path.join(TEMP, "host"), "--runtime-directory", RUNTIME], { encoding: "utf8", windowsHide: true });
  assert.equal(installed.status, 0, installed.stderr);
  await worker.evaluate(hostName => PageSenseNativeBridge.connect({ hostName }), HOST);
  // Wait on discovery without reading or printing its credential fields.
  for (let i = 0; i < 100 && (!fs.existsSync(RUNTIME) || !fs.readdirSync(RUNTIME).some(name => name.endsWith(".json"))); i++) await new Promise(resolve => setTimeout(resolve, 100));
  // The first test runs with NO side panel, proving that find does not need scanning.
  const api = JSON.parse(await python(["-u", path.join(__dirname, "element-api-client.py")]));
  api.checks.forEach(name => pass(name));
  pass("Actual Native Messaging and Python client path", { methodCounts: api.methodCounts });

  await demo.goto(url);
  const windowId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].windowId);
  const helper = await browser.newPage(); await helper.goto("chrome-extension://" + extensionId + "/popup/popup.html");
  await helper.evaluate(windowId => { const b = document.createElement("button"); b.id = "openTestPanel"; b.textContent = "Open";
    b.onclick = () => chrome.sidePanel.open({ windowId }); document.body.appendChild(b); }, windowId);
  await helper.click("#openTestPanel"); await demo.bringToFront();
  panel = await (await browser.waitForTarget(t => t !== helper.target() && t.url().endsWith("/popup/popup.html"))).asPage();
  await helper.close();
  panel.on("pageerror", error => errors.push(error.message));
  await wait(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中"));
  assert.equal(await panel.$("#scanBtn"), null); assert.equal(await panel.$("#liveScanToggle"), null); assert.equal(await panel.$("#rescanHintBtn"), null);
  pass("Side panel starts live scanning by default with no manual scan/pause controls");
  await snippet('from pagesense import PageSenseClient\nwith PageSenseClient() as c:\n c.find("css_position", "#insert").click()');
  await wait(() => JSON.parse(document.getElementById("rawJson").textContent).elements.some(el => el.text === "插入项"));
  pass("Default live scan reflects Python-triggered DOM mutations without manual refresh");
  await snippet('import time\nfrom pagesense import PageSenseClient\nwith PageSenseClient() as c:\n root=c.find("css_position", "#root")\n saved=root.findall("css_position", ".item")[-1]\n c.find("css_position", "#insert").click()\n time.sleep(0.6)\n assert saved.get_text()=="第二条"\n c.scan(scope="interactive")\n assert saved.get_text()=="第二条"');
  await wait(() => document.getElementById("scanScope").value === "interactive" && JSON.parse(document.getElementById("rawJson").textContent).scope === "interactive");
  pass("Live rescans preserve saved Python node references; explicit Python scope changes remain synchronized");
  await panel.click("#pickElementBtn"); await wait(() => document.getElementById("pickStatus").textContent.includes("悬停并点击"));
  await demo.click("#action"); await wait(() => !document.getElementById("pickedElementPanel").classList.contains("hidden"));
  await panel.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.__copied = text; } } }));
  await panel.click("#copyPickedXPathBtn"); assert.equal(await panel.evaluate(() => window.__copied), "//*[@id='action']");
  await panel.select("#locatorType", "xpath_position"); await panel.click("#validateLocatorBtn");
  await wait(() => document.getElementById("locatorValidation").textContent.includes("唯一匹配 1"));
  const source = await panel.$eval("#pythonCode", node => node.textContent);
  assert.ok(source.includes('client.find("xpath_position",') && source.includes("target.click()"));
  await snippet(source);
  const clicks = await snippet('from pagesense import PageSenseClient\nwith PageSenseClient() as c:\n print(c.find("css_position", "#clicks").get_text())');
  assert.equal(clicks.trim(), "1");
  pass("Picked XPath copies correctly, validates uniquely and exact generated Python executes");
  for (const width of [320, 400, 600]) {
    await panel.setViewport({ width, height: 900 });
    const metrics = await panel.evaluate(() => ({ width: document.querySelector(".app-main").clientWidth, scroll: document.querySelector(".app-main").scrollWidth }));
    assert.ok(metrics.scroll <= metrics.width, JSON.stringify(metrics));
  }
  pass("XPath controls fit the existing inspector at 320/400/600px");
  const other = await browser.newPage(); await other.goto(url + "/other"); await other.bringToFront();
  await wait(() => { const text = document.getElementById("rawJson").textContent; return text && JSON.parse(text).page.url.endsWith("/other"); });
  await other.reload(); await wait(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中"));
  await demo.bringToFront(); await wait(() => { const text = document.getElementById("rawJson").textContent; return text && JSON.parse(text).page.url.endsWith("/" ); });
  pass("Automatic scanning resumes after tab switch and reload");
  // Disconnect from the content side once, exercising the panel's backoff retry.
  await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      chrome.runtime.onConnect.addListener(port => {
        if (port.name !== PAGESENSE.LIVE_SCAN.PORT_NAME || window.__testDisconnected) return;
        window.__testDisconnected = true;
        port.onMessage.addListener(() => setTimeout(() => port.disconnect(), 100));
      });
    } }); });
  await panel.select("#scanScope", "interactive");
  await wait(() => document.getElementById("liveScanStatus").textContent.includes("将自动重连"));
  await wait(() => document.getElementById("liveScanStatus").textContent.startsWith("监听中"));
  pass("A disconnected content port automatically reconnects with no manual scan control");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), browser: await browser.version(),
    results, errors, sourceHashes: Object.fromEntries(["controller/pagesense.py", "controller/protocol.py", "pagesense/content/scanner.js", "pagesense/content/content.js", "pagesense/shared/constants.js", "pagesense/bridge/controller-bridge.js", "pagesense/popup/popup.js", "pagesense/popup/popup.html"].map(file =>
      [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(PROJECT, file))).digest("hex")])) }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  const cleanup = spawnSync(PYTHON, ["-c", "import sys,winreg\ntry: winreg.DeleteKey(winreg.HKEY_CURRENT_USER,sys.argv[1])\nexcept FileNotFoundError: pass",
    "Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST], { encoding: "utf8", windowsHide: true });
  if (cleanup.status !== 0) { console.error(cleanup.stderr); process.exitCode = 1; }
  server.close();
});
