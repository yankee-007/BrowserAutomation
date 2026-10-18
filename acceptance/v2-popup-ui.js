/* PageSense V2.0 Popup UI tests.
 * Drives the real popup.js in jsdom with the real element-search module:
 * search status line, clear (×) button, Ctrl+K focus, relevance metadata on
 * cards, search+filter AND, index lifecycle and the Controller panel. */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "pagesense");
const readSrc = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const constantsSrc = readSrc("shared/constants.js");
const scannerSrc = readSrc("content/scanner.js");
const searchSrc = readSrc("content/element-search.js");
const contentSrc = readSrc("content/content.js");
const popupSrc = readSrc("popup/popup.js");
const popupHtml = readSrc("popup/popup.html");

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}
function eq(id, name, actual, expected) {
  check(id, name, actual === expected, `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}
function R(x, y, w, h) {
  return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}

/* ---- Fixture page world ------------------------------------------------ */

const FIXTURE = `
  <button id="btnLogin">登录</button>
  <button id="btnComm" class="btn-primary">立即沟通</button>
  <button id="btnSearch">搜索</button>
  <button id="btnSearchJob">搜索职位</button>
  <a href="https://example.com/py">Python开发工程师</a>
  <a href="https://example.com/java">Java工程师</a>
  <input id="jobInput" placeholder="搜索职位、公司">
  <div role="button" aria-label="更多操作"></div>
`;

const pageDom = new JSDOM(
  `<!DOCTYPE html><html><head><title>Fixture</title></head><body>${FIXTURE}</body></html>`,
  { url: "https://fixture.test/", runScripts: "outside-only" }
);
const pageWorld = pageDom.window;
Object.defineProperty(pageWorld.Element.prototype, "innerText", {
  configurable: true, get() { return this.textContent; }
});
pageWorld.Element.prototype.getBoundingClientRect = function () {
  const s = this.style;
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return R(0, 0, 0, 0);
  if (parseFloat(s.width) === 0 || parseFloat(s.height) === 0) return R(0, 0, 0, 0);
  return R(8, 8, 120, 40);
};
pageWorld.chrome = {
  runtime: { onMessage: { addListener(fn) { pageWorld.__psListener = fn; } } }
};

/* ---- Popup world ------------------------------------------------------- */

const popupDom = new JSDOM(popupHtml, { url: "https://fixture.test/popup",
  runScripts: "outside-only" });
const popupWorld = popupDom.window;

/* Fake bridge status returned by the (fake) Service Worker. */
let bridgeStatus = {
  state: "CONNECTED", connected: true, host: "127.0.0.1", port: 8765,
  hasToken: true, protocol: "pagesense/1", version: "2.0.0",
  connectedSince: Date.now(), lastError: null,
  recentRequests: [
    { time: "23:41:01", method: "SCAN_PAGE", success: true, summary: "28 elements" },
    { time: "23:41:03", method: "SEARCH_ELEMENTS", success: true, summary: "2 results" }
  ]
};
const bridgeMessages = [];
const lastOf = (type) => bridgeMessages.filter((m) => m.type === type).pop() || {};

const tabEvents = {};
const tabEvent = (name) => ({ addListener(fn) { tabEvents[name] = fn; } });
let activeTab = { id: 1, windowId: 7, title: "Fixture", url: "https://fixture.test/" };
let lastTabQuery;
let pendingScan = null;

popupWorld.chrome = {
  windows: { getCurrent() { return Promise.resolve({ id: 7 }); } },
  runtime: {
    lastError: null,
    sendMessage(message, cb) {
      bridgeMessages.push(message);
      if (message.type === "PAGESENSE_BRIDGE_GET_STATUS") {
        cb(bridgeStatus);
      } else if (message.type === "PAGESENSE_BRIDGE_DISCONNECT") {
        bridgeStatus = Object.assign({}, bridgeStatus, { state: "DISCONNECTED", connected: false });
        cb({ ok: true, status: bridgeStatus });
      } else if (message.type === "PAGESENSE_BRIDGE_CONNECT") {
        bridgeStatus = Object.assign({}, bridgeStatus, {
          state: "CONNECTED", connected: true, port: message.port
        });
        cb({ ok: true, status: bridgeStatus });
      } else {
        cb({ ok: true });
      }
    }
  },
  tabs: {
    onActivated: tabEvent("activated"),
    onUpdated: tabEvent("updated"),
    onRemoved: tabEvent("removed"),
    query(q, cb) { lastTabQuery = q; cb([activeTab]); },
    sendMessage(tabId, message, cb) {
      let response;
      pageWorld.__psListener(message, {}, (r) => { response = r; });
      if (pendingScan && message.action === popupWorld.PAGESENSE.ACTIONS.SCAN_PAGE) {
        pendingScan.resolve = () => cb(response);
      } else {
        cb(response);
      }
    }
  },
  scripting: {
    executeScript({ files }) {
      for (const f of files) pageWorld.eval(readSrc(f));
      return Promise.resolve([]);
    }
  }
};

popupWorld.eval(constantsSrc);
popupWorld.eval(searchSrc);
popupWorld.eval(popupSrc);

const doc = popupWorld.document;
const $ = (id) => doc.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setSearch(value) {
  const el = $("searchInput");
  el.value = value;
  el.dispatchEvent(new popupWorld.Event("input", { bubbles: true }));
}
function clickFilter(filter) {
  doc.querySelector(`.filter-chip[data-filter="${filter}"]`).click();
}
function cardCount() { return doc.querySelectorAll(".element-card").length; }
function cardTexts() {
  return Array.from(doc.querySelectorAll(".element-card .element-text"))
    .map((e) => e.textContent.trim());
}
function matches() {
  return Array.from(doc.querySelectorAll(".element-card .element-match"))
    .map((e) => e.textContent.replace(/\s+/g, " ").trim());
}

(async () => {
  /* ---- scan ----------------------------------------------------------- */
  $("scanBtn").click();
  for (let i = 0; i < 60; i++) {
    if (!$("resultPanel").className.includes("hidden")) break;
    await sleep(50);
  }
  eq("V2P-01", "扫描渲染 8 张卡片", cardCount(), 8);

  /* ---- 18 search status ------------------------------------------------ */
  check("V2P-02", "未搜索时状态行显示扫描元素总数",
    /扫描元素：\s*8\s*个/.test($("searchStatus").textContent) &&
    /当前显示全部/.test($("searchStatus").textContent),
    $("searchStatus").textContent);

  setSearch("搜索");
  check("V2P-03", "有搜索结果时状态行同时显示扫描数与结果数",
    /扫描元素：\s*8\s*个/.test($("searchStatus").textContent) &&
    /搜索结果：\s*3\s*个/.test($("searchStatus").textContent),
    $("searchStatus").textContent);

  /* ---- 15/13 relevance metadata on cards -------------------------------- */
  setSearch("立即沟通");
  eq("V2P-04", "精确文本匹配只返回 1 张", cardCount(), 1);
  check("V2P-05", "卡片显示 matchedFields 与 score",
    /匹配：text/.test(matches()[0]) && /score: 100/.test(matches()[0]),
    matches()[0]);

  setSearch("搜索职位");
  check("V2P-06", "结果按相关度排序（exact text 100 在前，placeholder 次之）",
    cardTexts()[0] === "搜索职位", JSON.stringify(cardTexts()));
  check("V2P-07", "不同字段命中的卡片都被标注",
    matches().length === cardCount() && matches().every((m) => /score: \d+/.test(m)),
    JSON.stringify(matches()));

  /* ---- 17 clear button -------------------------------------------------- */
  check("V2P-08", "有查询时 × 按钮可见",
    !$("searchClearBtn").className.includes("hidden"));
  $("searchClearBtn").click();
  eq("V2P-09", "点击 × 清空查询并恢复全部元素", cardCount(), 8);
  eq("V2P-10", "清空后输入框为空", $("searchInput").value, "");
  check("V2P-11", "清空后 × 按钮隐藏",
    $("searchClearBtn").className.includes("hidden"));

  /* ---- 16 Ctrl+K -------------------------------------------------------- */
  const evt = new popupWorld.KeyboardEvent("keydown", {
    key: "k", ctrlKey: true, bubbles: true, cancelable: true
  });
  doc.dispatchEvent(evt);
  eq("V2P-12", "Ctrl+K 聚焦搜索框", doc.activeElement.id, "searchInput");
  check("V2P-13", "Ctrl+K 被 preventDefault（不触发浏览器默认行为）", evt.defaultPrevented);

  setSearch("搜索");
  const escEvt = new popupWorld.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  doc.dispatchEvent(escEvt);
  eq("V2P-14", "Escape 清空搜索", $("searchInput").value, "");

  /* ---- 19 search AND filter --------------------------------------------- */
  setSearch("搜索");
  clickFilter("button");
  eq("V2P-15", "query + Button 过滤（AND）", cardCount(), 2);
  clickFilter("link");
  eq("V2P-16", "query + Link 过滤（AND）", cardCount(), 0);
  clickFilter("input");
  eq("V2P-17", "query + Input 过滤（AND）", cardCount(), 1);
  check("V2P-18", "过滤状态下状态行仍显示搜索结果数",
    /搜索结果：\s*1\s*个/.test($("searchStatus").textContent),
    $("searchStatus").textContent);

  clickFilter("all");
  setSearch("");
  eq("V2P-19", "清空条件恢复 8 张", cardCount(), 8);

  /* ---- 22 index lifecycle ------------------------------------------------ */
  const staleQuery = "搜索";
  setSearch(staleQuery);
  const before = cardCount();
  // Delete the matched elements from the fixture, then rescan.
  await pageWorld.eval(`
    (function(){
      document.getElementById("btnSearch").remove();
      document.getElementById("btnSearchJob").remove();
      document.getElementById("jobInput").remove();
    })();
  `);
  $("scanBtn").click();
  await sleep(600);
  const afterRescan = cardCount();
  check("V2P-20", "重新扫描后搜索索引重建（旧结果不再出现）",
    afterRescan < before, `before=${before} after=${afterRescan}`);
  setSearch("");
  eq("V2P-21", "重新扫描后全量列表同步减少", cardCount(), 5);

  /* ---- 56 Controller panel ---------------------------------------------- */
  check("V2P-22", "Controller 面板存在且默认可折叠",
    Boolean($("controllerPanel")) && $("controllerPanel").open === false);
  eq("V2P-23", "Controller 面板显示 endpoint",
    $("controllerEndpoint").textContent, "127.0.0.1:8765");
  check("V2P-24", "Controller 面板显示已连接状态",
    /已连接/.test($("controllerStateText").textContent),
    $("controllerStateText").textContent);
  check("V2P-25", "连接状态圆点为已连接样式",
    $("controllerDot").className.includes("is-connected"),
    $("controllerDot").className);
  check("V2P-26", "Controller 面板显示最近请求日志",
    doc.querySelectorAll("#controllerLog .controller-log-item").length === 2,
    String(doc.querySelectorAll("#controllerLog .controller-log-item").length));
  check("V2P-27", "最近请求日志含方法与结果",
    /SCAN_PAGE/.test($("controllerLog").textContent) &&
    /SEARCH_ELEMENTS/.test($("controllerLog").textContent),
    $("controllerLog").textContent);

  /* Manual connect / disconnect */
  $("controllerDisconnectBtn").click();
  await sleep(80);
  eq("V2P-28", "点击断开后状态变为未连接",
    $("controllerStateText").textContent.includes("未连接") ? 1 : 0, 1);

  $("controllerPort").value = "9000";
  $("controllerToken").value = "TESTTOKEN";
  $("controllerConnectBtn").click();
  await sleep(80);
  eq("V2P-29", "点击连接后状态变为已连接",
    $("controllerStateText").textContent.includes("已连接") ? 1 : 0, 1);

  const connectMessage = lastOf("PAGESENSE_BRIDGE_CONNECT");
  eq("V2P-30", "连接请求携带用户输入的端口与 token",
    connectMessage.port + "|" + connectMessage.token, "9000|TESTTOKEN");
  eq("V2P-31", "连接请求由 Popup 主动发起（host 固定 127.0.0.1）",
    connectMessage.host, "127.0.0.1");
  check("V2P-32", "Popup 通过 Service Worker 消息控制连接（不在 Popup 建 WebSocket）",
    bridgeMessages.length > 0 &&
    !/new\s+WebSocket/.test(popupSrc),
    bridgeMessages.map((m) => m.type).join(","));

  /* ---- Persistent side panel lifecycle -------------------------------- */
  eq("SP-01", "查询限于侧栏所属窗口", lastTabQuery.windowId, 7);
  tabEvents.activated({ windowId: 8, tabId: 8 });
  await sleep(0);
  eq("SP-02", "其他窗口切换不影响当前结果", cardCount(), 5);

  activeTab = { id: 2, windowId: 7, title: "Second", url: "https://second.test/" };
  tabEvents.activated({ windowId: 7, tabId: 2 });
  await sleep(0);
  eq("SP-03", "切换标签页更新标题", $("currentPageTitle").textContent, "Second");
  check("SP-04", "切换后旧卡片、原始数据与操作入口清空",
    cardCount() === 0 && $("rawJson").textContent === "" &&
    $("resultPanel").classList.contains("hidden") &&
    $("copyBtn").disabled && $("exportBtn").disabled && $("clearHighlightBtn").disabled);

  pendingScan = {};
  $("scanBtn").click();
  await sleep(0);
  check("SP-05", "扫描请求正在等待响应", typeof pendingScan.resolve === "function");
  activeTab = { id: 3, windowId: 7, title: "Third", url: "https://third.test/" };
  tabEvents.activated({ windowId: 7, tabId: 3 });
  await sleep(0);
  pendingScan.resolve();
  pendingScan = null;
  await sleep(0);
  check("SP-06", "丢弃切换前迟到的扫描结果",
    cardCount() === 0 && $("resultPanel").classList.contains("hidden") && !$("scanBtn").disabled);

  $("scanBtn").click();
  await sleep(0);
  eq("SP-07", "新标签页可以重新扫描", cardCount(), 5);
  tabEvents.updated(3, { status: "loading" }, activeTab);
  check("SP-08", "刷新立即清空旧结果", cardCount() === 0 && $("copyBtn").disabled);
  $("scanBtn").click();
  await sleep(0);
  activeTab = Object.assign({}, activeTab, { url: "https://third.test/next" });
  tabEvents.updated(3, { url: activeTab.url }, activeTab);
  check("SP-09", "同标签页导航清空结果并更新 URL",
    cardCount() === 0 && $("currentPageUrl").textContent === activeTab.url);
  $("scanBtn").click();
  await sleep(0);
  activeTab = { id: 4, windowId: 7, title: "Fourth", url: "https://fourth.test/" };
  tabEvents.removed(3);
  await sleep(0);
  check("SP-10", "关闭当前标签页清空结果并切换标题",
    cardCount() === 0 && $("currentPageTitle").textContent === "Fourth");

  console.log(`\nV2 POPUP UI SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
