/* Real extension-pipeline E2E (acceptance spec sections 5, 22, 23).
 * Temporarily grants localhost host permissions ONLY to let an extension
 * page drive chrome.scripting/tabs APIs (the shipped flow is granted by the
 * user clicking the toolbar action = activeTab; that click is a MANUAL item).
 * The shipped manifest is restored and re-verified at the end. */
"use strict";
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..", "pagesense");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const manifestPath = path.join(ROOT, "manifest.json");
const originalManifest = fs.readFileSync(manifestPath, "utf8");

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}
function eq(id, name, actual, expected) {
  check(id, name, actual === expected, `expected ${expected} got ${actual}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function patchManifest(hostPerms) {
  const m = JSON.parse(originalManifest);
  if (hostPerms) m.host_permissions = hostPerms;
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
}

async function findExtensionId(browser, profileDir) {
  const prefsPath = path.join(profileDir, "Default", "Preferences");
  // Edge may delay writing Preferences; poll for up to 30s.
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
      const settings = (prefs.extensions && prefs.extensions.settings) || {};
      for (const [k, v] of Object.entries(settings)) {
        if (v.path && path.resolve(v.path) === ROOT) return k;
      }
    }
    await sleep(1000);
  }
  return null;
}

(async () => {
  /* ---- Test-only manifest with localhost host permission ---- */
  patchManifest(["http://127.0.0.1/*", "http://localhost/*"]);

  const profileDir = path.join(__dirname, "edge-pipeline-profile");
  fs.rmSync(profileDir, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
    args: [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${ROOT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1300,900"
    ]
  });

  const extensionId = await findExtensionId(browser, profileDir);
  check("E01", "扩展已加载并取得 ID", Boolean(extensionId), extensionId);
  console.log("extension id:", extensionId);

  /* Open the extension's REAL popup page as a tab (has chrome.* APIs). */
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  await sleep(500);

  const pipeline = await popup.evaluate(async () => {
    const out = { steps: [] };
    try {
      const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8765/test/demo.html" });
      out.steps.push("tabs.query: " + tabs.length);
      if (tabs.length === 0) throw new Error("demo tab missing");
      const tabId = tabs[0].id;

      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["shared/constants.js", "content/scanner.js", "content/content.js"]
      });
      out.steps.push("executeScript #1 OK");

      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["shared/constants.js", "content/scanner.js", "content/content.js"]
      });
      out.steps.push("executeScript #2 OK (guards should prevent duplicate listeners)");

      const resp = await chrome.tabs.sendMessage(tabId, {
        action: PAGESENSE.ACTIONS.SCAN_PAGE
      });
      out.steps.push("sendMessage ok=" + resp.ok);
      out.resp = resp;
      return out;
    } catch (e) {
      out.error = e.message;
      return out;
    }
  });

  check("E02", "真实扩展管线无错误", !pipeline.error, pipeline.error);
  console.log("steps:\n  " + pipeline.steps.join("\n  "));
  const scan = pipeline.resp && pipeline.resp.data;
  check("E03", "管线返回扫描数据", pipeline.resp && pipeline.resp.ok && Boolean(scan));
  if (scan) {
    eq("E04", "stats.total", scan.stats.total, 19);
    eq("E05", "stats.hidden", scan.stats.hidden, 6);
    check("E06", "page 基本信息正确",
      scan.page.domain === "127.0.0.1" && scan.page.title === "PageSense Demo Page");
  }

  /* Duplicate-listener guard: one message -> exactly one response */
  const dup = await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8765/test/demo.html" });
    const tabId = tabs[0].id;
    return new Promise((resolve) => {
      let responses = 0;
      chrome.tabs.sendMessage(tabId, { action: PAGESENSE.ACTIONS.SCAN_PAGE }, () => {
        responses++;
        setTimeout(() => resolve(responses), 600);
      });
    });
  });
  eq("E07", "重复注入后一条消息仅一个响应（无重复监听）", dup, 1);

  /* 20 scans through the real message channel */
  const repeated = await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8765/test/demo.html" });
    const tabId = tabs[0].id;
    let ok = true;
    for (let i = 0; i < 20; i++) {
      const r = await chrome.tabs.sendMessage(tabId, { action: PAGESENSE.ACTIONS.SCAN_PAGE });
      if (!r.ok || r.data.elements.length !== r.data.stats.total ||
          new Set(r.data.elements.map((e) => e.elementId)).size !== r.data.elements.length) {
        ok = false;
      }
    }
    return ok;
  });
  check("E08", "真实消息通道连续 20 次扫描稳定", repeated);

  /* Negative: scripting into a chrome:// tab must fail (popup catches it) */
  const neg = await popup.evaluate(async () => {
    return new Promise((resolve) => {
      chrome.tabs.create({ url: "chrome://version" }, async (tab) => {
        // Wait for the internal page, then attempt injection.
        setTimeout(async () => {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["shared/constants.js"]
            });
            resolve("INJECTION_UNEXPECTEDLY_SUCCEEDED");
          } catch (e) {
            resolve("BLOCKED: " + e.message);
          }
        }, 2500);
      });
    });
  });
  check("E09", "chrome:// 页面注入被浏览器拒绝（popup 会转为友好错误）",
    neg.startsWith("BLOCKED"), neg);

  await browser.close();

  /* ---- Restore shipped manifest and verify it loads ---- */
  patchManifest(null);
  const restored = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  check("E10", "manifest 已还原为最小权限版本",
    !restored.host_permissions &&
    JSON.stringify(restored.permissions.sort()) === JSON.stringify(["activeTab", "scripting"].sort()));

  const profileDir2 = path.join(__dirname, "edge-shipped-profile");
  fs.rmSync(profileDir2, { recursive: true, force: true });
  const browser2 = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
    args: [
      `--user-data-dir=${profileDir2}`,
      `--load-extension=${ROOT}`,
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });
  const shippedId = await findExtensionId(browser2, profileDir2);
  check("E11", "还原后的 manifest 仍可加载扩展", Boolean(shippedId), shippedId);
  await browser2.close();

  console.log(`\nPIPELINE SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  patchManifest(null); // always restore
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
