/* Real-browser V1.1 acceptance (VT4-VT10). Connects to Edge on 9226
 * (temp host_permissions manifest), drives the extension page through
 * chrome.scripting / sendMessage, and verifies the overlay in the demo
 * tab. Layout/scroll/resize are real Chromium behaviors. */
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOL = 5; // px tolerance for border/rAF rounding

(async () => {
  // DEBUG_PORT lets the same harness reuse one Edge instance (default unchanged).
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:" + (process.env.DEBUG_PORT || "9226")
  });
  const extensionId = "fjekeadnlgppeafgmgaipjlkiphlgehe";

  const demo = (await browser.pages()).find((p) => p.url().includes("/test/demo.html"));
  check("VT0", "demo 标签页存在", Boolean(demo), (await browser.pages()).map((p) => p.url()).join(","));
  await demo.setViewport({ width: 1300, height: 900 });
  // Reset state left by any previous run (deleted dynamic target, scroll).
  await demo.evaluate(() => {
    document.getElementById("restoreTargetBtn").click();
    window.scrollTo(0, 0);
  });
  await sleep(300);

  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  await sleep(400);

  /* Inject + initial scan from the extension page */
  const setup = await ext.evaluate(async (files) => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8765/test/demo.html" });
    if (tabs.length === 0) return { error: "demo tab not found" };
    const tabId = tabs[0].id;
    await chrome.scripting.executeScript({
      target: { tabId },
      files
    });
    const r = await chrome.tabs.sendMessage(tabId, { action: PAGESENSE.ACTIONS.SCAN_PAGE });
    return { tabId, scan: r.data };
  }, CONTENT_FILES);
  // 28 = 23 (V1.1 demo) + 5 elements added by the V1.2 demo section 10.
  check("VT0b", "扩展注入与初始扫描成功", setup && setup.scan && setup.scan.stats.total === 28,
    setup && setup.scan ? String(setup.scan.stats.total) : JSON.stringify(setup && setup.error));
  const tabId = setup.tabId;

  /* Helper: send an element action from the extension page */
  async function action(actionName, elementId) {
    return ext.evaluate(async (tid, a, id) => {
      return await chrome.tabs.sendMessage(tid, { action: a, elementId: id });
    }, tabId, actionName, elementId);
  }
  async function clear() {
    return ext.evaluate(async (tid) => {
      return await chrome.tabs.sendMessage(tid, { action: PAGESENSE.ACTIONS.CLEAR_HIGHLIGHT });
    }, tabId);
  }
  /* Read overlay state in the demo tab */
  function overlayState() {
    return demo.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('[data-pagesense-overlay="highlight"]'));
      const target = boxes[0];
      if (!target) return { count: boxes.length };
      const br = target.getBoundingClientRect();
      const label = target.querySelector('[data-pagesense-overlay="label"]');
      return {
        count: boxes.length,
        rect: { left: br.left, top: br.top, width: br.width, height: br.height },
        label: label ? label.textContent : null
      };
    });
  }
  function elementRect(domId) {
    return demo.evaluate((id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }, domId);
  }
  function aligned(a, b) {
    return Math.abs(a.left - b.left) <= TOL && Math.abs(a.top - b.top) <= TOL &&
      Math.abs(a.width - b.width) <= TOL && Math.abs(a.height - b.height) <= TOL;
  }

  /* ---- VT4 Locate: real scrollIntoView ---- */
  await demo.bringToFront(); // mimic real usage: page is the active tab while popup is open
  await demo.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  const bottomId = setup.scan.elements.find((e) => e.id === "bottomButton").elementId;
  const beforeY = await demo.evaluate(() => window.scrollY);
  const lr = await action("PAGESENSE_LOCATE_ELEMENT", bottomId);
  await sleep(2300);
  const after = await demo.evaluate(() => {
    const r = document.getElementById("bottomButton").getBoundingClientRect();
    return { y: window.scrollY, top: r.top };
  });
  check("VT4", "LOCATE 真实滚动到元素并居中",
    lr.success && beforeY === 0 && after.y > 0 &&
    Math.abs(after.top - 450) < 80,
    JSON.stringify({ beforeY, afterY: after.y, top: after.top }));

  /* ---- VT5 Highlight: overlay matches element rect ---- */
  await demo.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  const hr = await action("PAGESENSE_HIGHLIGHT_ELEMENT", bottomId);
  await sleep(1300);
  let ov = await overlayState();
  let er = await elementRect("bottomButton");
  check("VT5", "HIGHLIGHT 成功，Overlay 位置/尺寸与元素一致，标签含 #id",
    hr.success && ov.count === 1 && aligned(ov.rect, er) &&
    ov.label && ov.label.startsWith("#" + bottomId + " <button>"),
    JSON.stringify({ ov: ov.rect, er, label: ov.label }));

  /* ---- VT6 single overlay after 3 highlights ---- */
  const linkId = setup.scan.elements.find((e) => e.text === "前往 Example").elementId;
  const commId = setup.scan.elements.find((e) => e.text === "立即沟通").elementId;
  await action("PAGESENSE_HIGHLIGHT_ELEMENT", linkId);
  await sleep(700);
  await action("PAGESENSE_HIGHLIGHT_ELEMENT", commId);
  await sleep(700);
  ov = await overlayState();
  check("VT6", "连续高亮 3 个元素后仅 1 个 Overlay 且属于最新元素",
    ov.count === 1 && ov.label && ov.label.startsWith("#" + commId),
    JSON.stringify({ count: ov.count, label: ov.label }));

  /* ---- VT7 clear ---- */
  const cr = await clear();
  ov = await overlayState();
  check("VT7", "CLEAR_HIGHLIGHT 后 Overlay 为 0，重复调用安全",
    cr.success && ov.count === 0 && (await clear()).success,
    JSON.stringify({ cr: cr.success, count: ov.count }));

  /* ---- VT8 scroll follow ---- */
  await action("PAGESENSE_HIGHLIGHT_ELEMENT", bottomId);
  await sleep(1300);
  let pre = { ov: await overlayState(), el: await elementRect("bottomButton") };
  await demo.evaluate(() => window.scrollBy(0, -350));
  await sleep(350);
  let post = { ov: await overlayState(), el: await elementRect("bottomButton") };
  check("VT8", "滚动后 Overlay 跟随真实元素",
    aligned(pre.ov.rect, pre.el) && aligned(post.ov.rect, post.el),
    JSON.stringify({ ov: post.ov.rect, el: post.el }));

  /* ---- VT9 resize follow ---- */
  await demo.setViewport({ width: 1100, height: 700 });
  await sleep(400);
  let resized = { ov: await overlayState(), el: await elementRect("bottomButton") };
  check("VT9", "Resize 后 Overlay 重新定位并与元素一致",
    resized.ov.count === 1 && aligned(resized.ov.rect, resized.el),
    JSON.stringify({ ov: resized.ov.rect, el: resized.el }));
  await demo.setViewport({ width: 1300, height: 900 });
  await sleep(400);

  /* ---- VT10 element removed ---- */
  /* Fresh scan so ids match the current DOM, find dynamic target */
  const fresh = await ext.evaluate(async (tid) => {
    const r = await chrome.tabs.sendMessage(tid, { action: PAGESENSE.ACTIONS.SCAN_PAGE });
    return r.data;
  }, tabId);
  const targetId = fresh.elements.find((e) => e.id === "dynamicTarget").elementId;
  const h2 = await action("PAGESENSE_HIGHLIGHT_ELEMENT", targetId);
  await sleep(1300);
  let highlightedNow = await overlayState();
  /* delete via the demo page's own control */
  await demo.evaluate(() => document.getElementById("deleteTargetBtn").click());
  await sleep(250);
  let afterDelete = await overlayState();
  const locateGone = await action("PAGESENSE_LOCATE_ELEMENT", targetId);
  const highlightGone = await action("PAGESENSE_HIGHLIGHT_ELEMENT", targetId);
  check("VT10", "删除 DOM 后 Overlay 自动移除，再定位/高亮返回 ELEMENT_NOT_FOUND",
    h2.success && highlightedNow.count === 1 && afterDelete.count === 0 &&
    locateGone.success === false && locateGone.error.code === "ELEMENT_NOT_FOUND" &&
    highlightGone.success === false && highlightGone.error.code === "ELEMENT_NOT_FOUND",
    JSON.stringify({
      highlighted: highlightedNow.count, after: afterDelete.count,
      locate: locateGone.error && locateGone.error.code,
      highlight: highlightGone.error && highlightGone.error.code
    }));

  /* Screenshot evidence of a highlight */
  await demo.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  const restored = await ext.evaluate(async (tid) => {
    const r = await chrome.tabs.sendMessage(tid, { action: PAGESENSE.ACTIONS.SCAN_PAGE });
    return r.data;
  }, tabId);
  const commFresh = restored.elements.find((e) => e.text === "立即沟通").elementId;
  await action("PAGESENSE_HIGHLIGHT_ELEMENT", commFresh);
  await sleep(1200);
  await demo.screenshot({ path: "evidence-highlight.png" });

  await browser.disconnect();
  console.log(`\nV1.1 BROWSER SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
