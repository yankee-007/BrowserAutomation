/* PageSense V2.0 E2E - browser side agent.
 *
 * Bridges a real Edge (puppeteer) to the Python Controller E2E orchestrator:
 *   - opens the real extension Popup and clicks the real "连接 Controller" button
 *   - exposes the demo page's live DOM state over a tiny loopback HTTP API
 *   - can activate / reload tabs so the Python side can drive E2E-10..12
 *
 * The Controller itself is Python. This process never speaks the PageSense
 * WebSocket protocol; it only observes the browser and reports facts.
 *
 * Usage: node v2-browser-agent.js <token> <wsPort> <demoPort> <httpPort> [debugPort]
 * Prints "READY <httpPort>" on stdout once the extension is connected.
 */
"use strict";
const http = require("http");
const puppeteer = require("puppeteer-core");

const TOKEN = process.argv[2];
const WS_PORT = Number(process.argv[3] || 8765);
const DEMO_PORT = Number(process.argv[4] || 8770);
const HTTP_PORT = Number(process.argv[5] || 8791);
const DEBUG_PORT = process.argv[6] || process.env.DEBUG_PORT || "9224";

const EXTENSION_ID = process.env.EXTENSION_ID || "fjekeadnlgppeafgmgaipjlkiphlgehe";
const DEMO_MATCH = "/test/demo.html";
// Match the FULL url, not just the path: a leftover demo tab from another
// port (whose server is gone) is a dead error page that scans as 0 elements.
const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}${DEMO_MATCH}`;
const POPUP_URL = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let demoPage;
let popupPage;

/* ---- Tab hygiene ------------------------------------------------------ */

/** Close every tab we are not using, so stale pages can never be scanned. */
async function closeStaleTabs(keep) {
  const pages = await browser.pages();
  for (const page of pages) {
    if (page === keep) continue;
    const url = page.url();
    if (url.startsWith("chrome-extension://" + EXTENSION_ID) ||
        url.includes(DEMO_MATCH) ||
        url.startsWith("edge://version") ||
        url.startsWith("chrome://version")) {
      await page.close().catch(() => {});
    }
  }
}

/* ---- Demo page helpers ---------------------------------------------- */

async function ensureDemoPage() {
  const pages = await browser.pages();
  let page = pages.find((p) => p.url() === DEMO_URL) || null;

  if (!page) {
    // Reuse (and re-point) a stale demo tab if there is one, else open one.
    page = pages.find((p) => p.url().includes(DEMO_MATCH)) || null;
    if (!page) {
      page = await browser.newPage();
    }
    await page.goto(DEMO_URL, { waitUntil: "networkidle0" });
  }

  await page.setViewport({ width: 1300, height: 900 });
  // Fail loudly instead of silently scanning an empty page later.
  const count = await page.evaluate(
    () => document.querySelectorAll("button,a,input").length
  );
  if (count === 0) {
    throw new Error(`demo page at ${DEMO_URL} rendered no interactive elements`);
  }
  return page;
}

/** Live state of the demo page's action-test widgets (V1.2 + V2 markers). */
function readDemoState(page) {
  return page.evaluate(() => ({
    clickCount: document.getElementById("clickCount").textContent,
    inputValue: document.getElementById("actionInput").value,
    inputShown: document.getElementById("actionInputValue").textContent,
    inputEvents: document.getElementById("inputEventCount").textContent,
    changeEvents: document.getElementById("changeEventCount").textContent,
    textareaValue: document.getElementById("actionTextarea").value,
    ceText: document.getElementById("actionCE").innerText,
    lastKey: document.getElementById("lastKey").textContent,
    scrollY: window.scrollY,
    overlays: document.querySelectorAll('[data-pagesense-overlay="highlight"]').length,
    mappedIds: document.querySelectorAll("[data-pagesense-id]").length
  }));
}

async function resetDemo(page) {
  await page.evaluate(() => {
    const restore = document.getElementById("restoreTargetBtn");
    if (restore) restore.click();
    window.scrollTo(0, 0);
  });
  await sleep(250);
}

/* ---- Popup helpers ---------------------------------------------------- */

async function openPopup() {
  const page = await browser.newPage();
  await page.goto(POPUP_URL, { waitUntil: "load" });
  await sleep(300);
  return page;
}

async function popupBridgeStatus(page) {
  return page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: PAGESENSE.BRIDGE_MESSAGES.GET_STATUS },
      (status) => resolve(status || null)
    );
  }));
}

/** Drive the real Controller panel: type the token, click 连接. */
async function connectViaPopupUI(page, token, port) {
  return page.evaluate((tok, p) => {
    const panel = document.getElementById("controllerPanel");
    panel.open = true;
    document.getElementById("controllerPort").value = String(p);
    document.getElementById("controllerToken").value = tok;
    document.getElementById("controllerConnectBtn").click();
    return true;
  }, token, port);
}

async function waitForPopupState(page, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await popupBridgeStatus(page);
      if (last && wanted.includes(last.state)) return last;
    } catch (e) { /* popup may be reloading */ }
    await sleep(250);
  }
  return last;
}

/* ---- Control API ------------------------------------------------------ */

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    switch (url.pathname) {
      case "/state":
        return json(res, 200, await readDemoState(demoPage));

      case "/reset":
        await resetDemo(demoPage);
        return json(res, 200, await readDemoState(demoPage));

      case "/activate-demo":
        demoPage = await ensureDemoPage();
        await demoPage.bringToFront();
        await sleep(200);
        return json(res, 200, { url: demoPage.url() });

      case "/activate":
        // Bring an arbitrary URL to the front (used for restricted pages).
        {
          const target = url.searchParams.get("url");
          const pages = await browser.pages();
          let page = pages.find((p) => p.url().startsWith(target));
          if (!page) {
            page = await browser.newPage();
            await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
            await sleep(1200);
          }
          await page.bringToFront();
          await sleep(300);
          return json(res, 200, { url: page.url() });
        }

      case "/active-tab":
        return json(res, 200, await popupPage.evaluate(() =>
          new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              resolve(tabs && tabs[0] ? { id: tabs[0].id, url: tabs[0].url } : null);
            });
          })
        ));

      case "/bridge":
        return json(res, 200, await popupBridgeStatus(popupPage));

      case "/reload-extension":
        // E2E-11: reload the extension; the Service Worker must come back and
        // re-establish the socket without restarting the browser.
        await popupPage.evaluate(() => chrome.runtime.reload()).catch(() => {});
        await sleep(1500);
        popupPage = await openPopup();
        // Reopening the popup makes it the active tab; hand focus back so the
        // Controller still targets the demo page.
        await demoPage.bringToFront();
        await sleep(200);
        return json(res, 200, { reloaded: true });

      case "/quit":
        json(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 50);
        return;

      default:
        return json(res, 404, { error: "unknown endpoint" });
    }
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
}

/* ---- main ------------------------------------------------------------- */

(async () => {
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${DEBUG_PORT}`
  });

  demoPage = await ensureDemoPage();
  await closeStaleTabs(demoPage);
  await resetDemo(demoPage);

  popupPage = await openPopup();
  await connectViaPopupUI(popupPage, TOKEN, WS_PORT);

  const status = await waitForPopupState(popupPage, ["CONNECTED"], 20000);
  if (!status || status.state !== "CONNECTED") {
    console.error("AGENT ERROR: extension did not reach CONNECTED, last=" +
      JSON.stringify(status));
    process.exit(1);
  }

  // The Controller targets the active tab, so hand focus back to the demo.
  await demoPage.bringToFront();
  await sleep(200);

  // Bind the requested port, or the next free one. The caller reads the real
  // port back from the READY line, so a stale agent can never wedge a run.
  const server = http.createServer(handleRequest);
  const boundPort = await new Promise((resolve, reject) => {
    let candidate = HTTP_PORT;
    const attempt = () => {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && candidate < HTTP_PORT + 20) {
          candidate += 1;
          attempt();
        } else {
          reject(err);
        }
      });
      server.listen(candidate, "127.0.0.1", () => resolve(candidate));
    };
    attempt();
  });

  console.log(`READY ${boundPort} state=${status.state} version=${status.version}`);
})().catch((e) => {
  console.error("AGENT ERROR:", e);
  process.exit(1);
});
