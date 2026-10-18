/* PageSense V2.0 - INDEPENDENT acceptance browser agent.
 *
 * Written from scratch for the independent acceptance pass. It does not
 * import or reuse acceptance/v2-browser-agent.js: the point of this pass is
 * that the harness itself is also independently authored.
 *
 * Responsibilities (browser side only - it never speaks the PageSense
 * WebSocket protocol, so it cannot mask a protocol bug):
 *   - launch a real Edge with the real unpacked PageSense extension
 *   - serve DOM test fixtures over loopback http (perf grids, search
 *     ranking fixtures, elementId-lifecycle fixtures, ...)
 *   - expose a small HTTP control API so the Python driver can look at the
 *     real DOM and control tabs
 *   - collect console errors / unhandled rejections from the Service Worker,
 *     the Popup and the page
 *
 * Usage: node indep-agent.js <token> <wsPort> <demoPort> <httpPort> [profileDir]
 * Prints "READY <httpPort> <extId>" once the extension is CONNECTED.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");

const TOKEN = process.argv[2];
const WS_PORT = Number(process.argv[3] || 8765);
const DEMO_PORT = Number(process.argv[4] || 8765);
const HTTP_PORT = Number(process.argv[5] || 8799);
const PROFILE_DIR = process.argv[6] || path.join(__dirname, "edge-indep-profile");

const ROOT = path.resolve(__dirname, "..", "..", "pagesense");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DEMO_MATCH = "/test/demo.html";
const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}${DEMO_MATCH}`;
const DEBUG_PORT = Number(process.env.INDEP_DEBUG_PORT || 9333);
const STARTED_AT = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let demoPage = null;
let popupPage = null;
let extensionId = null;

/* Collected browser-side diagnostics. Kept bounded so a long run cannot grow
 * without limit - the same property the extension's own logs must have. */
const consoleLog = [];
const LOG_LIMIT = 500;
function record(kind, source, text) {
  consoleLog.push({ t: Date.now(), kind, source, text: String(text).slice(0, 600) });
  if (consoleLog.length > LOG_LIMIT) consoleLog.splice(0, consoleLog.length - LOG_LIMIT);
}

function attachDiagnostics(page, source) {
  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      record("console." + type, source, msg.text());
    }
  });
  page.on("pageerror", (err) => record("pageerror", source, err && err.message));
}

/** Service Worker diagnostics need a CDP session on the worker target.
 *
 * INDEP_NO_SW_CDP=1 skips this. Attaching a CDP session with Runtime.enable to
 * an extension service worker changes its lifetime behaviour, so a control run
 * without it is needed before blaming a WebSocket drop on PageSense.
 */
async function attachServiceWorkerDiagnostics() {
  if (process.env.INDEP_NO_SW_CDP === "1") {
    record("agent", "service-worker", "diagnostics disabled by INDEP_NO_SW_CDP");
    return;
  }
  const targets = browser.targets();
  const swTarget = targets.find(
    (t) => t.type() === "service_worker" && t.url().includes(extensionId)
  );
  if (!swTarget) {
    record("agent", "service-worker", "service worker target not found at attach time");
    return;
  }
  try {
    const session = await swTarget.createCDPSession();
    await session.send("Runtime.enable");
    session.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails || {};
      record("uncaught", "service-worker",
        (d.exception && (d.exception.description || d.exception.value)) || d.text);
    });
    session.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error" || p.type === "warning") {
        record("console." + p.type, "service-worker",
          (p.args || []).map((a) => a.value || a.description || a.type).join(" "));
      }
    });
    record("agent", "service-worker", "diagnostics attached");
  } catch (e) {
    record("agent", "service-worker", "attach failed: " + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* DOM fixtures                                                        */
/* ------------------------------------------------------------------ */

const FIXTURES = {};

/* Search-ranking fixture: every match tier for every weighted field. */
FIXTURES["rank"] = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Rank Fixture</title></head><body>
<h1>Ranking fixture</h1>
<a id="f-text-exact" href="/x1">工程师</a>
<a id="f-text-prefix" href="/x2">工程师助理</a>
<a id="f-text-contains" href="/x3">高级工程师职位</a>
<input id="f-ph-exact" placeholder="工程师" />
<input id="f-ph-prefix" placeholder="工程师助理" />
<input id="f-ph-contains" placeholder="高级工程师职位" />
<button id="f-aria-exact" aria-label="工程师">A</button>
<button id="f-aria-prefix" aria-label="工程师助理">B</button>
<button id="f-title-exact" title="工程师">C</button>
<button id="f-class-contains" class="job-工程师-box">D</button>
<button id="f-role-exact" role="link">E</button>
<button id="f-tag-only">F</button>
<a id="f-href-contains" href="https://example.com/工程师/1">G</a>
<a id="f-id-exact" href="/y">H</a>
<button id="f-multi" aria-label="AI 工程师">AI 工程师</button>
</body></html>`;

/* Multi-keyword AND fixture (README example). */
FIXTURES["and"] = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>AND Fixture</title></head><body>
<button id="and-both">AI应用工程师</button>
<button id="and-only-ai">AI产品经理</button>
<button id="and-only-eng">Java工程师</button>
<button id="and-neither">产品运营</button>
</body></html>`;

/* elementId lifecycle fixture: removable / re-addable nodes. */
FIXTURES["lifecycle"] = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Lifecycle Fixture</title></head><body>
<button id="keep-1">keep one</button>
<button id="victim">victim button</button>
<button id="keep-2">keep two</button>
<button id="removeBtn">remove victim</button>
<button id="addBtn">add button</button>
<div id="holder"></div>
<script>
document.getElementById('removeBtn').addEventListener('click', function () {
  var v = document.getElementById('victim');
  if (v) v.remove();
});
document.getElementById('addBtn').addEventListener('click', function () {
  var b = document.createElement('button');
  b.id = 'added-' + document.querySelectorAll('#holder button').length;
  b.textContent = 'added button';
  document.getElementById('holder').appendChild(b);
});
</script>
</body></html>`;

/* Widget fixture for CLICK/INPUT/KEYPRESS/SCROLL计数. */
FIXTURES["widget"] = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Widget Fixture</title></head><body>
<div id="count">0</div>
<button id="btn" onclick="document.getElementById('count').textContent=String(Number(document.getElementById('count').textContent)+1)">click me</button>
<button id="disabledBtn" disabled>disabled</button>
<button id="ariaDisabledBtn" aria-disabled="true" onclick="document.getElementById('count').textContent='ARIA_CLICKED'">aria disabled</button>
<input id="text" />
<textarea id="area"></textarea>
<div id="ce" contenteditable="true"></div>
<div id="keys"></div>
<input id="keySink" />
<div style="height:3000px"></div>
<button id="bottom">bottom</button>
<script>
var keys = [];
function log(e) {
  keys.push(e.type + ':' + e.key);
  document.getElementById('keys').textContent = keys.join(',');
}
['keydown','keyup','keypress'].forEach(function (t) {
  document.getElementById('keySink').addEventListener(t, log);
  document.getElementById('text').addEventListener(t, log);
});
window.__events = { input: 0, change: 0, keydown: 0 };
document.getElementById('text').addEventListener('input', function () {
  window.__events.input++; document.getElementById('keys').textContent = 'input:' + window.__events.input;
});
document.getElementById('text').addEventListener('change', function () {
  window.__events.change++; document.getElementById('count').textContent = 'change:' + window.__events.change;
});
document.getElementById('text').addEventListener('keydown', function () {
  window.__events.keydown++;
});
</script>
</body></html>`;

/* Large DOM fixtures for search performance.
 * `short=1` keeps the same element count with a much smaller serialized
 * payload, which separates "many elements" from "big JSON" as the cause of a
 * failure. */
function perfFixture(n, short, pad) {
  const rows = [];
  const filler = pad ? "文".repeat(pad) : "";
  for (let i = 0; i < n; i++) {
    if (short) {
      rows.push(`<button id="p${i}">x</button>`);
    } else {
      rows.push(
        `<button id="p${i}" class="row row-${i % 10}" aria-label="item ${i}">` +
        `元素 ${i} 项目名称${filler}</button>`
      );
    }
  }
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<title>Perf ${n}${short ? " short" : ""}${pad ? " pad" + pad : ""}</title></head>` +
    `<body>${rows.join("")}</body></html>`;
}

/* Narrow fixture: no horizontal scroll, no vertical scroll (boundary test). */
FIXTURES["noscroll"] = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>No Scroll</title></head><body><button id="only">only button</button></body></html>`;

/* ------------------------------------------------------------------ */
/* Fixture + control server                                            */
/* ------------------------------------------------------------------ */

function sendJson(res, code, body) {
  const payload = JSON.stringify(body === undefined ? null : body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(html)
  });
  res.end(html);
}

/** Full observable DOM state of any page. Used to assert real DOM effects. */
function readPageState(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const el = (s) => document.getElementById(s);
    const text = (s) => (el(s) ? el(s).textContent : null);
    const mapped = Array.from(document.querySelectorAll("[data-pagesense-id]"));
    const overlays = Array.from(
      document.querySelectorAll('[data-pagesense-overlay="highlight"]')
    );
    const overlayRects = overlays.map((o) => {
      const r = o.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      url: location.href,
      title: document.title,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      overlayCount: overlays.length,
      overlayRects,
      overlayLabel: overlays.length ? (overlays[0].querySelector('div[data-pagesense-overlay="label"]') || {}).textContent : null,
      mappedCount: mapped.length,
      mappedIds: mapped.map((m) => m.getAttribute("data-pagesense-id")),
      overlayTotal: q("[data-pagesense-overlay]"),
      count: text("count"),
      clickCount: text("clickCount"),
      // `keys` belongs to the widget fixture, `lastKey` to test/demo.html.
      keys: text("keys"),
      lastKey: text("lastKey"),
      lastKeyExists: Boolean(el("lastKey")),
      inputValue: el("text") ? el("text").value : null,
      areaValue: el("area") ? el("area").value : null,
      ceText: el("ce") ? el("ce").innerText : null,
      events: window.__events ? JSON.parse(JSON.stringify(window.__events)) : null,
      listenerProbe: window.__probe || null
    };
  });
}

/**
 * elementId -> live DOM facts, measured with the SAME rules the scanner
 * documents: the text fallback chain innerText -> value -> aria-label ->
 * placeholder -> title -> alt, and the <option> rect borrowed from its
 * owning <select> (a closed option reports a zero-size rect).
 *
 * Getting this wrong makes the "spot check the scan against the real DOM"
 * assertion fail for reasons that have nothing to do with the product.
 */
function readDomIndex(page) {
  return page.evaluate(() => {
    const out = {};
    const attr = (e, n) => e.getAttribute(n);
    const pick = (v) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
    document.querySelectorAll("[data-pagesense-id]").forEach((e) => {
      const id = e.getAttribute("data-pagesense-id");
      const tag = e.tagName.toLowerCase();
      let rect = e.getBoundingClientRect();
      if (tag === "option" && rect.width === 0) {
        const sel = e.closest("select");
        if (sel) rect = sel.getBoundingClientRect();
      }
      let text = "";
      const candidates = [e.innerText, e.value, attr(e, "aria-label"),
        attr(e, "placeholder"), attr(e, "title"), attr(e, "alt")];
      for (const c of candidates) {
        const p = pick(c);
        if (p !== null) { text = p.replace(/\s+/g, " ").trim(); break; }
      }
      if (text.length > 300) text = text.slice(0, 300);
      out[id] = {
        domId: e.id || null,
        tag,
        text,
        value: typeof e.value === "string" ? e.value : null,
        rect: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height)
        },
        pageX: Math.round(rect.left + window.scrollX),
        pageY: Math.round(rect.top + window.scrollY),
        hasOwnMappingAttr: e.hasAttribute("data-pagesense-id")
      };
    });
    return out;
  });
}

/**
 * Overlay rect and target rect read in ONE evaluation, so a smooth scroll
 * still settling between two round-trips cannot show up as a false overlay
 * misalignment.
 */
function readOverlayVs(page, elementId) {
  return page.evaluate((eid) => {
    const target = document.querySelector(`[data-pagesense-id="${eid}"]`);
    const box = document.querySelector('[data-pagesense-overlay="highlight"]');
    const label = box ? box.querySelector('[data-pagesense-overlay="label"]') : null;
    const rectOf = (e) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      overlay: rectOf(box),
      target: rectOf(target),
      targetExists: Boolean(target),
      label: label ? label.textContent : null,
      overlayCount: document.querySelectorAll('[data-pagesense-overlay="highlight"]').length,
      overlayTotal: document.querySelectorAll("[data-pagesense-overlay]").length
    };
  }, String(elementId));
}

async function closeStaleTabs(keep) {
  for (const page of await browser.pages()) {
    if (page === keep) continue;
    const url = page.url();
    if (url.includes(DEMO_MATCH) || url.startsWith("chrome-extension://" + extensionId) ||
        url.includes("/f/") || url.startsWith("edge://version")) {
      await page.close().catch(() => {});
    }
  }
}

async function gotoFixture(name) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/f/${name}`, { waitUntil: "load" });
  await page.setViewport({ width: 1300, height: 900 });
  await page.bringToFront();
  await sleep(150);
  return page;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");

  /* -- fixtures (plain HTML, no control semantics) -- */
  if (url.pathname.startsWith("/f/")) {
    const name = url.pathname.slice(3);
    if (name.startsWith("perf")) {
      const n = Number(url.searchParams.get("n") || name.replace(/^perf(short)?/, "") || 100);
      const short = url.searchParams.get("short") === "1" || name.startsWith("perfshort");
      const pad = Number(url.searchParams.get("pad") || 0);
      return sendHtml(res, perfFixture(n, short, pad));
    }
    const html = FIXTURES[name];
    if (!html) { res.writeHead(404).end("no such fixture"); return; }
    return sendHtml(res, html);
  }

  try {
    switch (url.pathname) {
      case "/c/ping":
        // `startedAt` lets the driver prove it is talking to THIS run's agent
        // and not to a stale process left over from an earlier run.
        return sendJson(res, 200, { ok: true, extensionId, startedAt: STARTED_AT,
                                    pid: process.pid, agentPort: HTTP_PORT });

      case "/c/state":
        return sendJson(res, 200, await readPageState(url.searchParams.get("target") === "popup" ? popupPage : demoPage));

      case "/c/dom-index":
        return sendJson(res, 200, await readDomIndex(demoPage));

      case "/c/overlay-vs":
        return sendJson(res, 200, await readOverlayVs(demoPage, url.searchParams.get("id")));

      case "/c/page-dom-index": {
        // Read the mapping straight off ANY open tab (cross-tab diagnostics).
        const target = url.searchParams.get("url");
        const pages = await browser.pages();
        const page = pages.find((p) => p.url().startsWith(target));
        if (!page) return sendJson(res, 404, { error: "no such tab: " + target });
        return sendJson(res, 200, await readDomIndex(page));
      }

      case "/c/popup-state":
        return sendJson(res, 200, await readPageState(popupPage));

      case "/c/bridge":
        return sendJson(res, 200, await popupPage.evaluate(() => new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: PAGESENSE.BRIDGE_MESSAGES.GET_STATUS },
            (s) => resolve(s || null)
          );
        })));

      case "/c/demo": {
        demoPage = (await browser.pages()).find((p) => p.url() === DEMO_URL) || null;
        if (!demoPage) {
          demoPage = await browser.newPage();
          await demoPage.goto(DEMO_URL, { waitUntil: "load" });
          attachDiagnostics(demoPage, "demo");
        }
        await demoPage.setViewport({ width: 1300, height: 900 });
        await demoPage.reload({ waitUntil: "load" });
        await demoPage.bringToFront();
        await sleep(250);
        return sendJson(res, 200, { url: demoPage.url(), state: await readPageState(demoPage) });
      }

      case "/c/fixture": {
        const name = url.searchParams.get("name");
        if (demoPage && !demoPage.isClosed() && demoPage.url().includes("/f/")) {
          await demoPage.close().catch(() => {});
        }
        demoPage = await gotoFixture(name);
        attachDiagnostics(demoPage, "fixture:" + name);
        await sleep(200);
        return sendJson(res, 200, { url: demoPage.url(), state: await readPageState(demoPage) });
      }

      case "/c/activate-demo": {
        const existing = (await browser.pages()).find((p) => p.url() === DEMO_URL);
        if (!existing) {
          return sendJson(res, 500, { error: "demo tab is gone" });
        }
        demoPage = existing;
        await demoPage.bringToFront();
        await sleep(200);
        return sendJson(res, 200, { url: demoPage.url() });
      }

      case "/c/activate":
        {
          const target = url.searchParams.get("target") || url.searchParams.get("url");
          const pages = await browser.pages();
          let page = pages.find((p) => p.url().startsWith(target));
          if (!page) {
            page = await browser.newPage();
            attachDiagnostics(page, "page:" + target.slice(0, 40));
            await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
            await sleep(1000);
          }
          await page.bringToFront();
          await sleep(250);
          // Fixture pages can become the observation target (used by the perf
          // runs); browser-internal pages never do.
          if (url.searchParams.get("setDemo") === "1") demoPage = page;
          return sendJson(res, 200, { url: page.url() });
        }

      case "/c/active-tab":
        return sendJson(res, 200, await popupPage.evaluate(() => new Promise((resolve) => {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
            resolve(tabs && tabs[0] ? { id: tabs[0].id, url: tabs[0].url, title: tabs[0].title } : null));
        })));

      case "/c/tabs":
        return sendJson(res, 200, await popupPage.evaluate(() => new Promise((resolve) => {
          chrome.tabs.query({}, (tabs) => resolve(tabs.map((t) => ({ id: t.id, url: t.url, active: t.active }))));
        })));

      case "/c/popup-connect": {
        const port = url.searchParams.get("port") || String(WS_PORT);
        const token = url.searchParams.get("token") || TOKEN;
        const out = await popupPage.evaluate((p, tok) => {
          document.getElementById("controllerPanel").open = true;
          document.getElementById("controllerPort").value = String(p);
          document.getElementById("controllerToken").value = tok;
          document.getElementById("controllerConnectBtn").click();
          return true;
        }, port, token);
        return sendJson(res, 200, { clicked: out });
      }

      case "/c/popup-disconnect":
        await popupPage.evaluate(() => document.getElementById("controllerDisconnectBtn").click());
        return sendJson(res, 200, { clicked: true });

      case "/c/set-token": {
        // Change the stored token behind the UI (used for wrong-token tests).
        const tok = url.searchParams.get("token") || "";
        return sendJson(res, 200, await popupPage.evaluate((t) => new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: PAGESENSE.BRIDGE_MESSAGES.SET_CONFIG, token: t
          }, (r) => resolve(r || null));
        }), tok));
      }

      case "/c/wait-state": {
        const wanted = (url.searchParams.get("state") || "CONNECTED").split(",");
        const timeout = Number(url.searchParams.get("timeout") || 30000);
        const deadline = Date.now() + timeout;
        let last = null;
        const t0 = Date.now();
        while (Date.now() < deadline) {
          try {
            last = await popupPage.evaluate(() => new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { type: PAGESENSE.BRIDGE_MESSAGES.GET_STATUS }, (s) => resolve(s || null));
            }));
            if (last && wanted.includes(last.state)) {
              return sendJson(res, 200, { state: last.state, waitedMs: Date.now() - t0, status: last });
            }
          } catch (e) { /* popup may be navigating */ }
          await sleep(200);
        }
        return sendJson(res, 200, { state: last && last.state, waitedMs: Date.now() - t0,
          timedOut: true, status: last });
      }

      case "/c/count-reconnects": {
        // Sample the bridge log twice to detect a tight reconnect loop.
        const sample = async () => {
          const s = await popupPage.evaluate(() => new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: PAGESENSE.BRIDGE_MESSAGES.GET_STATUS },
              (x) => resolve(x || null));
          }));
          return s;
        };
        const a = await sample();
        await sleep(Number(url.searchParams.get("window") || 6000));
        const b = await sample();
        return sendJson(res, 200, { a: a && a.state, b: b && b.state, first: a, second: b });
      }

      case "/c/reload-extension":
        await popupPage.evaluate(() => chrome.runtime.reload()).catch(() => {});
        await sleep(2500);
        popupPage = await openPopup();
        await sleep(400);
        await demoPage.bringToFront();
        await sleep(250);
        return sendJson(res, 200, { reloaded: true });

      case "/c/reload-page":
        await demoPage.reload({ waitUntil: "load" });
        await demoPage.bringToFront();
        await sleep(300);
        return sendJson(res, 200, { url: demoPage.url() });

      case "/c/set-content": {
        // Replace the live DOM of the target page (DOM mutation lifecycle).
        const html = url.searchParams.get("html") || "";
        await demoPage.evaluate((h) => { document.body.innerHTML = h; }, html);
        await sleep(100);
        return sendJson(res, 200, { ok: true });
      }

      case "/c/eval": {
        const expr = url.searchParams.get("js") || "null";
        const out = await demoPage.evaluate((src) => {
          try { return { ok: true, value: new Function("return (" + src + ")")() }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        }, expr);
        return sendJson(res, 200, out);
      }

      /* Bring the popup tab to the foreground and let its own 2 s status poll
       * run at least once before reading the rendered UI.
       *
       * The harness opens the popup as a TAB, so it is normally in the
       * background - and Chromium heavily throttles timers in background tabs.
       * Reading the DOM without focusing it would report a stale "连接中…"
       * even though the bridge is already CONNECTED. A real extension popup is
       * focused whenever it is visible, so this is a harness artifact. */
      case "/c/popup-focus-read": {
        await popupPage.bringToFront();
        await sleep(Number(url.searchParams.get("wait") || 2600));
        const dom = await popupPage.evaluate(() => ({
          state: document.getElementById("controllerStateText").textContent,
          inline: document.getElementById("controllerStateInline").textContent,
          endpoint: document.getElementById("controllerEndpoint").textContent,
          dot: document.getElementById("controllerDot").className,
          err: document.getElementById("controllerError").className,
          errText: document.getElementById("controllerError").textContent,
          panelOpen: document.getElementById("controllerPanel").open,
          buttonDisabled: document.getElementById("controllerConnectBtn").disabled,
          title: document.getElementById("currentPageTitle").textContent,
          version: (document.querySelector(".brand-version") || {}).textContent
        }));
        const log = await popupPage.evaluate(() => {
          const nodes = document.querySelectorAll("#controllerLog .controller-log-item");
          return Array.from(nodes).slice(0, 3).map((n) => n.textContent.trim());
        });
        return sendJson(res, 200, { dom, log });
      }

      case "/c/popup-eval": {
        const expr = url.searchParams.get("js") || "null";
        const out = await popupPage.evaluate((src) => {
          try { return { ok: true, value: new Function("return (" + src + ")")() }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        }, expr);
        return sendJson(res, 200, out);
      }

      /* Count how many times a content-script message callback fires for a
       * single sendMessage. More than one response == duplicate listener. */
      case "/c/probe-responses": {
        const action = url.searchParams.get("action") || "SCAN_PAGE";
        const rounds = Number(url.searchParams.get("rounds") || 1);
        const out = await popupPage.evaluate(async (act, n) => {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = tabs[0].id;
          const perRound = [];
          for (let i = 0; i < n; i++) {
            const count = await new Promise((resolve) => {
              let c = 0;
              chrome.tabs.sendMessage(tabId, { action: PAGESENSE.ACTIONS[act] }, () => {
                c++;
                if (chrome.runtime.lastError) { /* ignore */ }
                setTimeout(() => resolve(c), 500);
              });
            });
            perRound.push(count);
          }
          return { tabId, perRound };
        }, action, rounds);
        return sendJson(res, 200, out);
      }

      case "/c/console": {
        const filter = url.searchParams.get("kind");
        const items = filter ? consoleLog.filter((c) => c.kind.includes(filter)) : consoleLog;
        return sendJson(res, 200, { count: items.length, items });
      }

      case "/c/console-reset":
        consoleLog.length = 0;
        return sendJson(res, 200, { ok: true });

      case "/c/sw-info":
        return sendJson(res, 200, {
          // targetId lets the driver detect a Service Worker RESTART: a new
          // worker means a new target id, which is how an MV3 recycle shows up.
          swTargets: browser.targets()
            .filter((t) => t.type() === "service_worker")
            .map((t) => ({
              url: t.url(),
              targetId: t._targetId || t.targetId || null
            })),
          popupUrl: popupPage ? popupPage.url() : null,
          pages: (await browser.pages()).map((p) => p.url())
        });

      case "/c/screenshot": {
        const name = url.searchParams.get("name") || "shot";
        const dir = path.join(__dirname, "..", "evidence-v2-independent");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name + ".png");
        await demoPage.screenshot({ path: file, fullPage: url.searchParams.get("full") === "1" });
        return sendJson(res, 200, { file });
      }

      case "/c/popup-screenshot": {
        const name = url.searchParams.get("name") || "popup";
        const dir = path.join(__dirname, "..", "evidence-v2-independent");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name + ".png");
        await popupPage.screenshot({ path: file, fullPage: true });
        return sendJson(res, 200, { file });
      }

      case "/c/quit":
        sendJson(res, 200, { ok: true });
        setTimeout(() => {
          try { browser.disconnect(); } catch (e) { /* ignore */ }
          spawn("powershell", ["-NoProfile", "-Command",
            `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | ` +
            `Where-Object { $_.CommandLine -like '*${PROFILE_DIR.replace(/\\/g, "\\\\")}*' } | ` +
            `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
          ], { detached: true, stdio: "ignore" }).unref();
          setTimeout(() => process.exit(0), 1500);
        }, 100);
        return;

      default:
        return sendJson(res, 404, { error: "unknown endpoint " + url.pathname });
    }
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.stack) || e) });
  }
}

async function openPopup() {
  const page = await browser.newPage();
  attachDiagnostics(page, "popup");
  await page.setViewport({ width: 700, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  await sleep(400);
  return page;
}

/**
 * Discover the PageSense extension id from the live CDP target list.
 *
 * The Preferences file is NOT a reliable source here: an unpacked extension
 * registered with --load-extension is not necessarily written into
 * extensions.settings, and Preferences lags behind reality. The running
 * Service Worker target is ground truth.
 */
async function findExtensionId() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await res.json();
      const sw = targets.find(
        (t) => t.type === "service_worker" &&
          t.url.endsWith("/background/service-worker.js")
      );
      if (sw) return new URL(sw.url).hostname;
    } catch (e) { /* browser not up yet */ }
    await sleep(500);
  }
  return null;
}

/**
 * Spawn Edge ourselves and attach puppeteer over CDP.
 *
 * Edge 154 ignores --load-extension when the browser is started by
 * puppeteer's own launcher (regardless of --enable-unsafe-extension-debugging);
 * spawning msedge.exe directly and connecting with puppeteer.connect() loads
 * the unpacked extension correctly. This is an environment limitation of the
 * automation harness, not of PageSense.
 */
async function launchEdge() {
  // A previous Edge may still be shutting down and holding the profile
  // directory; Windows then refuses the delete with EPERM. Retry instead of
  // failing the whole run.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      break;
    } catch (e) {
      if (attempt === 19) {
        console.error("AGENT ERROR: cannot clear profile dir " + PROFILE_DIR + ": " + e.message);
        process.exit(1);
      }
      await sleep(1000);
    }
  }
  const child = spawn(EDGE, [
    `--user-data-dir=${PROFILE_DIR}`,
    `--load-extension=${ROOT}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1300,900",
    "about:blank"
  ], { detached: true, stdio: "ignore" });
  child.unref();

  let lastErr = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      return await puppeteer.connect({
        browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
        defaultViewport: null
      });
    } catch (e) { lastErr = e; }
  }
  throw new Error("could not attach to Edge: " + (lastErr && lastErr.message));
}

(async () => {
  browser = await launchEdge();
  browser.on("disconnected", () => {
    console.error("AGENT: browser disconnected");
    process.exit(3);
  });

  extensionId = await findExtensionId();
  if (!extensionId) {
    console.error("AGENT ERROR: extension did not load");
    process.exit(1);
  }

  demoPage = await browser.newPage();
  attachDiagnostics(demoPage, "demo");
  await demoPage.setViewport({ width: 1300, height: 900 });
  await demoPage.goto(DEMO_URL, { waitUntil: "load" });
  await closeStaleTabs(demoPage);

  popupPage = await openPopup();
  await attachServiceWorkerDiagnostics();

  // Connect through the REAL popup UI (no direct bridge calls).
  await popupPage.evaluate((p, tok) => {
    document.getElementById("controllerPanel").open = true;
    document.getElementById("controllerPort").value = String(p);
    document.getElementById("controllerToken").value = tok;
    document.getElementById("controllerConnectBtn").click();
  }, WS_PORT, TOKEN);

  await demoPage.bringToFront();

  // Wait for CONNECTED.
  let state = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    state = await popupPage.evaluate(() => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: PAGESENSE.BRIDGE_MESSAGES.GET_STATUS },
        (s) => resolve(s || null));
    })).catch(() => null);
    if (state && state.state === "CONNECTED") break;
    await sleep(250);
  }
  if (!state || state.state !== "CONNECTED") {
    console.error("AGENT ERROR: bridge never reached CONNECTED: " + JSON.stringify(state));
    process.exit(1);
  }
  await demoPage.bringToFront();
  await sleep(200);

  const server = http.createServer(handleRequest);
  // Fail loudly rather than silently moving to another port: the Python driver
  // talks to a fixed port, so a "helpful" fallback would make it talk to a
  // STALE agent from an earlier run. That produced a bogus KeyError once
  // already - never again.
  const boundPort = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(HTTP_PORT, "127.0.0.1", () => resolve(HTTP_PORT));
  }).catch((err) => {
    console.error(`AGENT ERROR: cannot bind control port ${HTTP_PORT}: ${err.message}. ` +
      "A stale agent is probably still running - kill it first.");
    process.exit(1);
  });

  console.log(`READY ${boundPort} ${extensionId}`);
})().catch((e) => {
  console.error("AGENT ERROR:", e);
  process.exit(1);
});
