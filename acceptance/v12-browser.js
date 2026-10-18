/* Real-browser V1.2 Action Layer acceptance (E2E-01..06 + extras).
 * Connects to Edge on 9229 (temp host_permissions manifest), drives the
 * extension popup page through chrome.scripting / sendMessage, and verifies
 * real DOM effects in the demo tab. click/focus/input/keyboard/scroll are
 * all real Chromium behaviors — no CDP input simulation, no coordinates. */
"use strict";
const puppeteer = require("puppeteer-core");

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { contentFiles } = require("./content-files");

/* Injected files come from the extension source, never a local copy. */
const CONTENT_FILES = contentFiles();

(async () => {
  // DEBUG_PORT lets the same harness reuse one Edge instance (default unchanged).
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:" + (process.env.DEBUG_PORT || "9229")
  });
  const extensionId = "fjekeadnlgppeafgmgaipjlkiphlgehe";

  const demo = (await browser.pages()).find((p) => p.url().includes("/test/demo.html"));
  check("V12-00", "demo 标签页存在", Boolean(demo));
  await demo.setViewport({ width: 1300, height: 900 });
  await demo.bringToFront();
  await demo.evaluate(() => {
    document.getElementById("restoreTargetBtn").click();
    window.scrollTo(0, 0);
  });
  await sleep(300);

  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: "load" });
  await sleep(300);

  const setup = await ext.evaluate(async (files) => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8765/test/demo.html" });
    if (tabs.length === 0) return { error: "demo tab not found" };
    const tabId = tabs[0].id;
    await chrome.scripting.executeScript({ target: { tabId }, files });
    const r = await chrome.tabs.sendMessage(tabId, { action: PAGESENSE.ACTIONS.SCAN_PAGE });
    return { tabId, scan: r.data };
  }, CONTENT_FILES);
  check("V12-01", "六文件注入与扫描成功",
    setup && setup.scan && setup.scan.stats.total > 0,
    setup ? String(setup.scan && setup.scan.stats.total) : JSON.stringify(setup));
  const tabId = setup.tabId;
  const scan = setup.scan;

  const idByDomId = (domId) => scan.elements.find((e) => e.id === domId).elementId;

  /* Generic message sender via the extension page */
  async function send(payload) {
    return ext.evaluate(async (tid, p) => {
      return await chrome.tabs.sendMessage(tid, p);
    }, tabId, payload);
  }
  const A = (n) => "PAGESENSE_" + n;

  /* Read demo-side test state */
  function demoState() {
    return demo.evaluate(() => ({
      clickCount: document.getElementById("clickCount").textContent,
      inputValue: document.getElementById("actionInput").value,
      inputShown: document.getElementById("actionInputValue").textContent,
      inputEvents: document.getElementById("inputEventCount").textContent,
      changeEvents: document.getElementById("changeEventCount").textContent,
      textareaValue: document.getElementById("actionTextarea").value,
      ceText: document.getElementById("actionCE").innerText,
      ceEvents: document.getElementById("ceInputCount").textContent,
      lastKey: document.getElementById("lastKey").textContent,
      scrollY: window.scrollY,
      overlays: document.querySelectorAll('[data-pagesense-overlay="highlight"]').length
    }));
  }

  /* ---- E2E-01 INPUT ---- */
  const inputId = idByDomId("actionInput");
  const r1 = await send({ action: A("INPUT_ELEMENT"), elementId: inputId, value: "PageSense" });
  let s1 = await demoState();
  check("E2E-01", "INPUT 写入真实 input，回显与 input/change 事件正确",
    r1.success && s1.inputValue === "PageSense" &&
    s1.inputShown === "PageSense" &&
    Number(s1.inputEvents) >= 1 && Number(s1.changeEvents) >= 1 &&
    r1.rescanRecommended === true && /^act_/.test(r1.actionId) &&
    typeof r1.durationMs === "number",
    JSON.stringify({ r: r1.success, s: s1 }));

  /* Textarea + contenteditable in real browser */
  const taId = idByDomId("actionTextarea");
  const ceId = idByDomId("actionCE");
  const rTa = await send({ action: A("INPUT_ELEMENT"), elementId: taId, value: "文本域内容" });
  const rCe = await send({ action: A("INPUT_ELEMENT"), elementId: ceId, value: "可编辑内容" });
  s1 = await demoState();
  check("E2E-01b", "INPUT 支持 textarea 与 contenteditable（含 CE input 事件）",
    rTa.success && rCe.success && s1.textareaValue === "文本域内容" &&
    s1.ceText === "可编辑内容" && Number(s1.ceEvents) >= 1,
    JSON.stringify({ ta: s1.textareaValue, ce: s1.ceText, ceEv: s1.ceEvents }));

  /* ---- E2E-02 CLICK ---- */
  const clickBtnId = idByDomId("clickTestBtn");
  const beforeCount = Number((await demoState()).clickCount);
  const r2 = await send({ action: A("CLICK_ELEMENT"), elementId: clickBtnId });
  let s2 = await demoState();
  check("E2E-02", "CLICK 真实点击，计数 +1",
    r2.success && Number(s2.clickCount) === beforeCount + 1,
    JSON.stringify({ before: beforeCount, after: s2.clickCount }));

  /* ---- E2E-03 KEYPRESS ---- */
  const r3 = await send({ action: A("KEYPRESS_ELEMENT"), elementId: inputId, key: "Enter" });
  await sleep(150);
  let s3 = await demoState();
  const r3b = await send({ action: A("KEYPRESS_ELEMENT"), elementId: inputId, key: "Escape" });
  await sleep(150);
  const r3c = await send({ action: A("KEYPRESS_ELEMENT"), elementId: inputId, key: "ArrowDown" });
  await sleep(150);
  const lastKey = (await demoState()).lastKey;
  const rBadKey = await send({ action: A("KEYPRESS_ELEMENT"), elementId: inputId, key: "FakeKey" });
  check("E2E-03", "KEYPRESS 真实 keydown 被页面记录（Enter/Escape/ArrowDown），非法键 INVALID_KEY",
    r3.success && s3.lastKey === "Enter" && r3b.success && r3c.success &&
    lastKey === "ArrowDown" && rBadKey.success === false &&
    rBadKey.error.code === "INVALID_KEY",
    JSON.stringify({ enter: s3.lastKey, final: lastKey, bad: rBadKey.error.code }));

  /* ---- E2E-04 CLEAR ---- */
  const r4 = await send({ action: A("CLEAR_ELEMENT"), elementId: inputId });
  const s4 = await demoState();
  check("E2E-04", "CLEAR 清空真实 input，action 为 CLEAR_ELEMENT",
    r4.success && r4.action === A("CLEAR_ELEMENT") && s4.inputValue === "",
    JSON.stringify({ value: s4.inputValue }));

  /* ---- E2E-05 SCROLL ---- */
  await demo.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  const r5 = await send({ action: A("SCROLL_PAGE"), direction: "down", amount: 500 });
  await sleep(200);
  const midY = (await demoState()).scrollY;
  const r5b = await send({ action: A("SCROLL_PAGE"), direction: "up", amount: 500 });
  await sleep(200);
  const backY = (await demoState()).scrollY;
  const r5c = await send({ action: A("SCROLL_PAGE"), direction: "up", amount: 500 });
  check("E2E-05", "SCROLL down/up 真实滚动，边界 moved:false",
    r5.success && midY > 0 && r5b.success && backY < midY &&
    r5c.success && r5c.moved === false,
    JSON.stringify({ mid: midY, back: backY, boundaryMoved: r5c.moved }));

  /* Scroll validation */
  const rBadDir = await send({ action: A("SCROLL_PAGE"), direction: "side", amount: 100 });
  const rBadAmt = await send({ action: A("SCROLL_PAGE"), direction: "down", amount: 99999 });
  check("E2E-05b", "SCROLL 非法 direction/amount 被拒绝",
    rBadDir.success === false && rBadDir.error.code === "INVALID_VALUE" &&
    rBadAmt.success === false && rBadAmt.error.code === "INVALID_VALUE");

  /* ---- E2E-06 element removed ---- */
  let fresh = await ext.evaluate(async (tid) => {
    const r = await chrome.tabs.sendMessage(tid, { action: PAGESENSE.ACTIONS.SCAN_PAGE });
    return r.data;
  }, tabId);
  const targetId = fresh.elements.find((e) => e.id === "dynamicTarget").elementId;
  await demo.evaluate(() => document.getElementById("deleteTargetBtn").click());
  await sleep(200);
  const goneClick = await send({ action: A("CLICK_ELEMENT"), elementId: targetId });
  const goneInput = await send({ action: A("INPUT_ELEMENT"), elementId: targetId, value: "x" });
  const goneClear = await send({ action: A("CLEAR_ELEMENT"), elementId: targetId });
  const goneKey = await send({ action: A("KEYPRESS_ELEMENT"), elementId: targetId, key: "Enter" });
  check("E2E-06", "删除后 CLICK/INPUT/CLEAR/KEYPRESS 均 ELEMENT_NOT_FOUND，无误操作",
    [goneClick, goneInput, goneClear, goneKey].every(
      (r) => r.success === false && r.error.code === "ELEMENT_NOT_FOUND"),
    JSON.stringify({
      c: goneClick.error.code, i: goneInput.error.code,
      cl: goneClear.error.code, k: goneKey.error.code
    }));

  /* ---- Disabled rejection ---- */
  const disabledId = idByDomId("actionDisabled");
  const countBeforeDisabled = Number((await demoState()).clickCount);
  const rDis = await send({ action: A("CLICK_ELEMENT"), elementId: disabledId });
  const countAfterDisabled = Number((await demoState()).clickCount);
  check("V12-D", "disabled 按钮 CLICK 返回 ELEMENT_DISABLED，计数不变",
    rDis.success === false && rDis.error.code === "ELEMENT_DISABLED" &&
    countBeforeDisabled === countAfterDisabled,
    JSON.stringify({ before: countBeforeDisabled, after: countAfterDisabled }));

  /* ---- Invalid ids ---- */
  const invalidResults = [];
  for (const bad of [null, -1, 0, "abc"]) {
    invalidResults.push(await send({ action: A("CLICK_ELEMENT"), elementId: bad }));
  }
  const missing = await send({ action: A("CLICK_ELEMENT"), elementId: 999999 });
  check("V12-I", "非法 elementId -> INVALID_ELEMENT_ID；不存在 -> ELEMENT_NOT_FOUND",
    invalidResults.every((r) => r.success === false &&
      r.error.code === "INVALID_ELEMENT_ID") &&
    missing.success === false && missing.error.code === "ELEMENT_NOT_FOUND");

  /* ---- 20x CLICK exact count ---- */
  fresh = await ext.evaluate(async (tid) => {
    const r = await chrome.tabs.sendMessage(tid, { action: PAGESENSE.ACTIONS.SCAN_PAGE });
    return r.data;
  }, tabId);
  const cId = fresh.elements.find((e) => e.id === "clickTestBtn").elementId;
  const cBefore = Number((await demoState()).clickCount);
  for (let i = 0; i < 20; i++) {
    await send({ action: A("CLICK_ELEMENT"), elementId: cId });
  }
  const cAfter = Number((await demoState()).clickCount);
  check("V12-20C", "连续 20 次 CLICK 计数精确 +20", cAfter === cBefore + 20,
    `before ${cBefore} after ${cAfter}`);

  /* ---- 20x INPUT final value ---- */
  const iId = fresh.elements.find((e) => e.id === "actionInput").elementId;
  for (let i = 1; i <= 20; i++) {
    await send({ action: A("INPUT_ELEMENT"), elementId: iId, value: "value-" + i });
  }
  const finalValue = (await demoState()).inputValue;
  check("V12-20I", "连续 20 次 INPUT 最终 value-20", finalValue === "value-20",
    "got " + finalValue);

  /* ---- Action clears stale highlight ---- */
  const hlId = fresh.elements.find((e) => e.text === "立即沟通").elementId;
  await send({ action: A("HIGHLIGHT_ELEMENT"), elementId: hlId });
  await sleep(900);
  const hlBefore = (await demoState()).overlays;
  await send({ action: A("CLICK_ELEMENT"), elementId: cId });
  await sleep(200);
  const hlAfter = (await demoState()).overlays;
  check("V12-HL", "Action 开始时清除旧高亮", hlBefore === 1 && hlAfter === 0,
    `before ${hlBefore} after ${hlAfter}`);

  await browser.disconnect();
  console.log(`\nV1.2 BROWSER SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
