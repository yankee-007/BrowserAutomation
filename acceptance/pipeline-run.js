/* Runs against the already-launched Edge on port 9224 with the test-only
 * host-permission manifest. Real chrome.scripting / tabs APIs. */
"use strict";
const puppeteer = require("puppeteer-core");
const { contentFiles } = require("./content-files");

/* Injected files come from the extension source, never a local copy. */
const CONTENT_FILES = contentFiles();

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}
function eq(id, name, actual, expected) {
  check(id, name, actual === expected, `expected ${expected} got ${actual}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:" + (process.env.DEBUG_PORT || "9224")
  });
  const extensionId = "fjekeadnlgppeafgmgaipjlkiphlgehe";

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  await sleep(500);

  const pipeline = await popup.evaluate(async (files) => {
    const out = { steps: [] };
    try {
      const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8765/test/demo.html" });
      out.steps.push("tabs.query: " + tabs.length);
      if (tabs.length === 0) throw new Error("demo tab missing");
      const tabId = tabs[0].id;

      await chrome.scripting.executeScript({
        target: { tabId },
        files
      });
      out.steps.push("executeScript #1 OK");
      await chrome.scripting.executeScript({
        target: { tabId },
        files
      });
      out.steps.push("executeScript #2 OK");

      const resp = await chrome.tabs.sendMessage(tabId, { action: PAGESENSE.ACTIONS.SCAN_PAGE });
      out.steps.push("sendMessage ok=" + resp.ok);
      out.resp = resp;
      return out;
    } catch (e) {
      out.error = e.message;
      return out;
    }
  }, CONTENT_FILES);

  check("E02", "真实扩展管线无错误", !pipeline.error, pipeline.error);
  console.log("steps:\n  " + pipeline.steps.join("\n  "));
  const scan = pipeline.resp && pipeline.resp.data;
  check("E03", "管线返回扫描数据", pipeline.resp && pipeline.resp.ok && Boolean(scan));
  if (scan) {
    eq("E04", "stats.total=28", scan.stats.total, 28);
    eq("E05", "stats.hidden=6", scan.stats.hidden, 6);
    check("E06", "page 基本信息正确",
      scan.page.domain === "127.0.0.1" && scan.page.title === "PageSense Demo Page");
  }

  /* Duplicate listener guard */
  const dup = await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8765/test/demo.html" });
    return new Promise((resolve) => {
      let responses = 0;
      chrome.tabs.sendMessage(tabs[0].id, { action: PAGESENSE.ACTIONS.SCAN_PAGE }, () => {
        responses++;
        setTimeout(() => resolve(responses), 700);
      });
    });
  });
  eq("E07", "重复注入后一条消息仅一个响应", dup, 1);

  /* 20 scans over the real message channel */
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

  /* chrome:// injection rejected */
  const neg = await popup.evaluate(async () => {
    return new Promise((resolve) => {
      chrome.tabs.create({ url: "chrome://version" }, (tab) => {
        setTimeout(async () => {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["shared/constants.js"]
            });
            resolve("UNEXPECTED_SUCCESS");
          } catch (e) {
            resolve("BLOCKED: " + e.message);
          }
        }, 2500);
      });
    });
  });
  check("E09", "chrome:// 注入被拒绝（popup 会显示友好错误）",
    neg.startsWith("BLOCKED"), neg);

  await browser.disconnect();
  console.log(`\nPIPELINE RUN SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
