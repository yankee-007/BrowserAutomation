/* Highlighter unit tests (jsdom). Overlay DOM lifecycle, single-overlay
 * rule, clear idempotency, invalid/missing element handling. Real layout
 * (rects, scroll/resize follow) is verified in the real-browser stage. */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "pagesense");
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}

function R(x, y, w, h) {
  return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}

function makeEnv(bodyHtml) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><title>H</title></head><body>${bodyHtml}</body></html>`,
    { url: "https://unit.test/page", runScripts: "outside-only" }
  );
  const w = dom.window;
  Object.defineProperty(w.Element.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent; }
  });
  w.Element.prototype.getBoundingClientRect = function () {
    const s = this.style;
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return R(0, 0, 0, 0);
    return R(10, 20, 120, 40);
  };
  // jsdom has no layout/scrollIntoView; stub it (highlighter also guards).
  w.Element.prototype.scrollIntoView = function () { /* no-op */ };
  // Deterministic rAF instead of relying on pretendToBeVisual.
  w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  w.eval(src("shared/constants.js"));
  w.eval(src("content/element-map.js"));
  w.eval(src("content/scanner.js"));
  w.eval(src("content/highlighter.js"));
  return w;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* Highlight creates overlay with label */
  let w = makeEnv(`<button>测试按钮</button>`);
  w.PageSenseScanner.scanPage();
  let r = w.PageSenseHighlighter.highlightElement(1);
  let box = w.document.querySelector('[data-pagesense-overlay="highlight"]');
  let label = w.document.querySelector('[data-pagesense-overlay="label"]');
  check("VH1", "highlight 返回 success", r.success === true && r.elementId === 1);
  check("VH2", "Overlay 与标签被创建",
    Boolean(box) && Boolean(label));
  check("VH3", "标签显示 #id <tag> 文本",
    label && label.textContent === "#1 <button> 测试按钮",
    label && label.textContent);

  /* Single overlay across repeated highlights */
  w = makeEnv(`<button>a</button><button>b</button><button>c</button>`);
  w.PageSenseScanner.scanPage();
  w.PageSenseHighlighter.highlightElement(1);
  w.PageSenseHighlighter.highlightElement(2);
  w.PageSenseHighlighter.highlightElement(3);
  let boxes = w.document.querySelectorAll('[data-pagesense-overlay="highlight"]');
  let labels = Array.from(w.document.querySelectorAll('[data-pagesense-overlay="label"]'))
    .map((l) => l.textContent);
  check("VH4", "连续高亮后仅一个 Overlay，且属于最新元素",
    boxes.length === 1 && labels.length === 1 && labels[0] === "#3 <button> c",
    boxes.length + " / " + labels.join("|"));

  /* Clear removes overlay; idempotent */
  let c1 = w.PageSenseHighlighter.clearHighlight();
  let afterClear = w.document.querySelectorAll('[data-pagesense-overlay="highlight"]').length;
  let c2 = w.PageSenseHighlighter.clearHighlight();
  check("VH5", "CLEAR 移除 Overlay 且重复调用安全",
    c1.success && c2.success && afterClear === 0, afterClear + " left");

  /* Locate: success / not found / invalid */
  w = makeEnv(`<button>a</button>`);
  w.PageSenseScanner.scanPage();
  check("VH6", "locate 存在元素 success",
    w.PageSenseHighlighter.locateElement(1).success);
  let nf = w.PageSenseHighlighter.locateElement(99);
  check("VH7", "locate 缺失元素返回 ELEMENT_NOT_FOUND",
    nf.success === false && nf.error.code === "ELEMENT_NOT_FOUND",
    JSON.stringify(nf.error));
  let inv = w.PageSenseHighlighter.highlightElement("abc");
  check("VH8", "非法 id 返回 INVALID_ELEMENT_ID",
    inv.success === false && inv.error.code === "INVALID_ELEMENT_ID",
    JSON.stringify(inv.error));

  /* Element removed while highlighted: overlay auto-removed on next frame */
  w = makeEnv(`<button id="t">目标</button>`);
  w.PageSenseScanner.scanPage();
  w.PageSenseHighlighter.highlightElement(1);
  let target = w.document.getElementById("t");
  target.parentNode.removeChild(target);
  w.dispatchEvent(new w.Event("scroll"));
  await sleep(30);
  let gone = w.document.querySelectorAll('[data-pagesense-overlay="highlight"]').length;
  check("VH9", "高亮元素被删除后 Overlay 自动移除", gone === 0, gone + " left");

  /* Subsequent locate on the removed id -> ELEMENT_NOT_FOUND, no crash */
  let afterRemove = w.PageSenseHighlighter.locateElement(1);
  check("VH10", "删除后再次定位返回 ELEMENT_NOT_FOUND",
    afterRemove.success === false && afterRemove.error.code === "ELEMENT_NOT_FOUND");

  console.log(`\nHIGHLIGHTER UNIT SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
