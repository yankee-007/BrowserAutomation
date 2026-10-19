/* Popup UI tests (acceptance spec sections 17, 18, 19).
 * Drives the REAL popup.js inside jsdom with a fake chrome.* bridge wired
 * to a real fixture page world, so the full popup -> scripting -> messaging
 * -> rendering path runs, then we exercise the real search/filter controls. */
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
  check(id, name, actual === expected, `expected ${expected} got ${actual}`);
}
function R(x, y, w, h) {
  return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}

/* ---- Page (fixture) world ------------------------------------------- */

const FIXTURE = `
  <button id="btnLogin">登录</button>
  <button id="btnReg">注册</button>
  <button id="btnComm" class="btn-primary">立即沟通</button>
  <button id="btnSearch">搜索</button>
  <a href="https://example.com/py">Python开发工程师</a>
  <a href="https://example.com/java">Java工程师</a>
  <input id="jobInput" placeholder="搜索职位">
  <div role="button" aria-label="更多操作"></div>
`;

const pageDom = new JSDOM(
  `<!DOCTYPE html><html><head><title>Fixture</title></head><body>${FIXTURE}</body></html>`,
  { url: "https://fixture.test/", runScripts: "outside-only" }
);
const pageWorld = pageDom.window;
Object.defineProperty(pageWorld.Element.prototype, "innerText", {
  configurable: true,
  get() { return this.textContent; }
});
pageWorld.Element.prototype.getBoundingClientRect = function () {
  const s = this.style;
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return R(0, 0, 0, 0);
  if (parseFloat(s.width) === 0 || parseFloat(s.height) === 0) return R(0, 0, 0, 0);
  return R(8, 8, 120, 40);
};

/* Fake chrome for the page world: capture the content.js listeners. */
pageWorld.chrome = {
  runtime: {
    onMessage: {
      addListener(fn) { pageWorld.__psListener = fn; }
    },
    onConnect: {
      addListener(fn) { pageWorld.__onConnect = fn; }
    }
  }
};

/* Fake live-scan Port connecting the real popup.js to the real content.js. */
function connectLivePort(tabId, info) {
  const popupMessages = [], popupDisconnects = [];
  const pagePort = {
    name: info && info.name,
    messageListeners: [], disconnectListeners: [],
    onMessage: { addListener(fn) { pagePort.messageListeners.push(fn); } },
    onDisconnect: { addListener(fn) { pagePort.disconnectListeners.push(fn); } },
    postMessage(data) { popupMessages.forEach((fn) => fn(data)); }
  };
  if (pageWorld.__onConnect) pageWorld.__onConnect(pagePort);
  return {
    onMessage: { addListener(fn) { popupMessages.push(fn); } },
    onDisconnect: { addListener(fn) { popupDisconnects.push(fn); } },
    postMessage(message) { pagePort.messageListeners.forEach((fn) => fn(message)); },
    disconnect() { pagePort.disconnectListeners.forEach((fn) => fn()); }
  };
}

/* ---- Popup world with fake chrome ----------------------------------- */

const popupDom = new JSDOM(popupHtml, {
  url: "https://fixture.test/popup",
  runScripts: "outside-only"
});
const popupWorld = popupDom.window;

popupWorld.chrome = {
  windows: { getCurrent() { return Promise.resolve({ id: 1 }); } },
  runtime: { lastError: null },
  tabs: {
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    query(q, cb) {
      cb([{ id: 1, title: "Fixture", url: "https://fixture.test/" }]);
    },
    sendMessage(tabId, message, cb) {
      let response;
      pageWorld.__psListener(message, {}, (r) => { response = r; });
      cb(response);
    },
    connect: connectLivePort
  },
  scripting: {
    executeScript({ files }) {
      for (const f of files) {
        const src = readSrc(f);
        pageWorld.eval(src);
      }
      return Promise.resolve([]);
    }
  }
};

popupWorld.eval(constantsSrc);
// V2.0: popup.js searches through the shared element-search module, exactly
// like content.js does for SEARCH_ELEMENTS.
popupWorld.eval(searchSrc);
popupWorld.eval(popupSrc);

/* Helpers driving the real UI. */
function setSearch(value) {
  const el = popupWorld.document.getElementById("searchInput");
  el.value = value;
  el.dispatchEvent(new popupWorld.Event("input", { bubbles: true }));
}
function clickFilter(filter) {
  popupWorld.document.querySelector(`.filter-chip[data-filter="${filter}"]`).click();
}
function cardCount() {
  return popupWorld.document.querySelectorAll(".element-card").length;
}
function cardTexts() {
  return Array.from(popupWorld.document.querySelectorAll(".element-card .element-text"))
    .map((e) => e.textContent.trim());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* The panel starts live scanning by itself; no manual scan button exists. */
  check("P00", "侧栏已移除手动扫描按钮",
    popupWorld.document.getElementById("scanBtn") === null);

  for (let i = 0; i < 100; i++) {
    if (!popupWorld.document.getElementById("resultPanel").className.includes("hidden")) break;
    await sleep(50);
  }
  check("P01", "自动实时扫描后面板显示且渲染 8 张卡片",
    !popupWorld.document.getElementById("resultPanel").className.includes("hidden") &&
    cardCount() === 8, "cards=" + cardCount());

  /* 17 search */
  setSearch("Python");
  eq("P02", "搜索 Python -> 1 张且为 Python开发工程师",
    cardCount() === 1 && cardTexts()[0] === "Python开发工程师" ? 1 : 0, 1);

  setSearch("沟通");
  eq("P03", "搜索 沟通 -> 立即沟通",
    cardCount() === 1 && cardTexts()[0] === "立即沟通" ? 1 : 0, 1);

  setSearch("搜索");
  eq("P04", "搜索 搜索 -> 按钮文本 + input placeholder 共 2 张", cardCount(), 2);

  setSearch("");
  eq("P05", "空搜索恢复全部 8 张", cardCount(), 8);

  setSearch("不存在的关键字xyz");
  check("P06", "无结果显示空状态",
    popupWorld.document.querySelector(".empty-list") !== null && cardCount() === 0);
  setSearch("");

  /* 18 type filter */
  clickFilter("button");
  eq("P07", "Button 过滤: 4 button + role=button 共 5 张", cardCount(), 5);

  clickFilter("link");
  eq("P08", "Link 过滤: 2 张", cardCount(), 2);

  clickFilter("input");
  eq("P09", "Input 过滤: 1 张", cardCount(), 1);

  clickFilter("other");
  eq("P10", "Other 过滤: 0 张（空状态）", cardCount(), 0);

  clickFilter("all");
  eq("P11", "All 恢复 8 张", cardCount(), 8);

  /* 19 combined search AND filter */
  clickFilter("button");
  setSearch("搜索");
  eq("P12", "Button + 搜索 -> 仅搜索按钮 1 张",
    cardCount() === 1 && cardTexts()[0] === "搜索" ? 1 : 0, 1);

  setSearch("沟通");
  eq("P13", "Button + 沟通 -> 立即沟通 1 张", cardCount(), 1);

  clickFilter("link");
  setSearch("Python");
  eq("P14a", "Link + Python -> 1 张", cardCount(), 1);
  setSearch("沟通");
  eq("P14b", "Link + 沟通 -> 0 张", cardCount(), 0);

  setSearch("");
  clickFilter("all");
  eq("P15", "清空条件恢复 8 张", cardCount(), 8);

  /* Search field coverage: id / className / tag */
  setSearch("jobInput");
  eq("P17", "按 id 搜索 jobInput -> 1 张", cardCount(), 1);
  setSearch("btn-primary");
  eq("P18", "按 className 搜索 -> 1 张", cardCount(), 1);
  setSearch("button");
  eq("P19", "搜索 button -> 5 张（4 个 tag=button + 1 个 role=button 的 div，role 也在搜索范围）",
    cardCount(), 5);
  setSearch("");

  /* Raw JSON populated */
  const raw = popupWorld.document.getElementById("rawJson").textContent;
  check("P20", "Raw JSON 已生成且可解析",
    raw.startsWith("{") && JSON.parse(raw).elements.length === 8);

  console.log(`\nPOPUP UI SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
