/* Scanner unit tests (acceptance spec sections 8, 9, 12-16).
 * Runs the REAL shared/constants.js + content/scanner.js inside jsdom.
 * jsdom performs no layout, so getBoundingClientRect is stubbed with
 * deterministic values; viewport/layout behaviors are separately verified
 * in the real-browser E2E stage. */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "pagesense");
const constantsSrc = fs.readFileSync(path.join(ROOT, "shared", "constants.js"), "utf8");
const elementMapSrc = fs.readFileSync(path.join(ROOT, "content", "element-map.js"), "utf8");
const scannerSrc = fs.readFileSync(path.join(ROOT, "content", "scanner.js"), "utf8");

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}
function eq(id, name, actual, expected) {
  check(id, name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

function R(x, y, w, h) {
  return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}

function makePage(bodyHtml, opts = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><title>${opts.title || "Unit"}</title></head><body>${bodyHtml}</body></html>`,
    { url: opts.url || "https://unit.test/page", runScripts: "outside-only" }
  );
  const w = dom.window;
  Object.defineProperty(w.Element.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent; }
  });
  w.Element.prototype.getBoundingClientRect = function () {
    const s = this.style;
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return R(0, 0, 0, 0);
    if (parseFloat(s.width) === 0 || parseFloat(s.height) === 0) return R(0, 0, 0, 0);
    return R(8, 8, 120, 40);
  };
  w.eval(constantsSrc);
  w.eval(elementMapSrc);
  w.eval(scannerSrc);
  return w;
}

/* 8.1 button */
let w = makePage(`<button>测试按钮</button>`);
let scan = w.PageSenseScanner.scanPage();
eq("U01", "button: tag/text", { tag: scan.elements[0].tag, text: scan.elements[0].text },
  { tag: "button", text: "测试按钮" });

/* 8.2 link */
w = makePage(`<a href="https://example.com">测试链接</a>`);
scan = w.PageSenseScanner.scanPage();
eq("U02", "link: tag/text/href",
  { tag: scan.elements[0].tag, text: scan.elements[0].text, href: scan.elements[0].href },
  { tag: "a", text: "测试链接", href: "https://example.com/" });

/* 8.3 input */
w = makePage(`<input placeholder="请输入姓名">`);
scan = w.PageSenseScanner.scanPage();
eq("U03", "input: tag/placeholder",
  { tag: scan.elements[0].tag, placeholder: scan.elements[0].placeholder },
  { tag: "input", placeholder: "请输入姓名" });

/* 8.4 textarea */
w = makePage(`<textarea placeholder="请输入内容"></textarea>`);
scan = w.PageSenseScanner.scanPage();
eq("U04", "textarea: tag/placeholder",
  { tag: scan.elements[0].tag, placeholder: scan.elements[0].placeholder },
  { tag: "textarea", placeholder: "请输入内容" });

/* 8.5 select + option */
w = makePage(`<select name="city"><option>长沙</option></select>`);
scan = w.PageSenseScanner.scanPage();
check("U05a", "select 被识别", scan.elements.some((e) => e.tag === "select"));
check("U05b", "option 长沙 被识别（可见性跟随 select）",
  scan.elements.some((e) => e.tag === "option" && e.text === "长沙"));

/* 8.6 ARIA role=button */
w = makePage(`<div role="button" aria-label="提交"></div>`);
scan = w.PageSenseScanner.scanPage();
eq("U06", "ARIA: role/ariaLabel/text",
  { role: scan.elements[0].role, ariaLabel: scan.elements[0].ariaLabel, text: scan.elements[0].text },
  { role: "button", ariaLabel: "提交", text: "提交" });

/* 8.7 contenteditable */
w = makePage(`<div contenteditable="true">编辑内容</div>`);
scan = w.PageSenseScanner.scanPage();
eq("U07a", "contenteditable: tag/text",
  { tag: scan.elements[0].tag, text: scan.elements[0].text },
  { tag: "div", text: "编辑内容" });
if (scan.elements[0].contentEditable === true) {
  check("U07b", "contenteditable 归类为 input",
    w.PAGESENSE.categorizeElement(scan.elements[0]) === "input");
} else {
  console.log("SKIP   U07b contenteditable 分类（jsdom 不实现 isContentEditable；由真实浏览器 E2E 覆盖）");
}

/* 9 visibility cases */
w = makePage(`<button style="display:none">隐藏按钮</button>`);
eq("U08", "display:none 被过滤", w.PageSenseScanner.scanPage().stats.total, 0);

w = makePage(`<button style="visibility:hidden">隐藏按钮</button>`);
eq("U09", "visibility:hidden 被过滤", w.PageSenseScanner.scanPage().stats.total, 0);

w = makePage(`<button style="opacity:0">隐藏按钮</button>`);
eq("U10", "opacity:0 被过滤", w.PageSenseScanner.scanPage().stats.total, 0);

w = makePage(`<button style="width:0;height:0">零尺寸</button>`);
eq("U11", "width/height=0 被过滤", w.PageSenseScanner.scanPage().stats.total, 0);

w = makePage(`<button>可见</button><button style="display:none">隐藏</button>`);
scan = w.PageSenseScanner.scanPage();
eq("U12", "混合: matched/total/hidden",
  [scan.stats.matched, scan.stats.total, scan.stats.hidden], [2, 1, 1]);

/* 12 elementId unique & sequential */
w = makePage(`<button>a</button><button>b</button><a href="#">c</a>`);
scan = w.PageSenseScanner.scanPage();
eq("U13", "elementId 1..N 唯一", scan.elements.map((e) => e.elementId), [1, 2, 3]);

/* 13 text extraction */
w = makePage(`<button>提交</button>`);
eq("U14", "text=提交", w.PageSenseScanner.scanPage().elements[0].text, "提交");

w = makePage(`<button aria-label="关闭"></button>`);
eq("U15", "aria-label 回退=关闭", w.PageSenseScanner.scanPage().elements[0].text, "关闭");

w = makePage(`<input placeholder="搜索职位">`);
eq("U16", "placeholder 回退=搜索职位", w.PageSenseScanner.scanPage().elements[0].text, "搜索职位");

const longText = "字".repeat(1000);
w = makePage(`<button>${longText}</button>`);
scan = w.PageSenseScanner.scanPage();
eq("U17", "1000 字符截断为 300", scan.elements[0].text.length, 300);

w = makePage(`<input value="已填值" placeholder="占位文本">`);
eq("U18", "value 优先于 placeholder", w.PageSenseScanner.scanPage().elements[0].text, "已填值");

w = makePage(`<button title="提示"></button>`);
eq("U19", "title 回退=提示", w.PageSenseScanner.scanPage().elements[0].text, "提示");

w = makePage(`<input type="image" alt="图片按钮">`);
scan = w.PageSenseScanner.scanPage();
eq("U20", "alt 回退=图片按钮", { type: scan.elements[0].type, text: scan.elements[0].text },
  { type: "image", text: "图片按钮" });

/* 14 special characters roundtrip */
w = makePage(`<button>测试 "按钮" 🚀
第二行 'a' \\b &amp; &lt;tag&gt;</button>`);
scan = w.PageSenseScanner.scanPage();
const json = JSON.stringify(scan);
const reparsed = JSON.parse(json);
check("U21", "特殊字符 JSON roundtrip 成功且文本保留",
  reparsed.elements[0].text.includes('测试 "按钮" 🚀') &&
  reparsed.elements[0].text.includes("'a' \\b") &&
  reparsed.elements[0].text.includes("<tag>"),
  reparsed.elements[0].text);

/* 15 structure */
w = makePage(`<button>x</button>`, { title: "T", url: "https://example.org/p?a=1" });
scan = w.PageSenseScanner.scanPage();
check("U22", "page 字段完整",
  scan.page.title === "T" && scan.page.url === "https://example.org/p?a=1" &&
  scan.page.domain === "example.org" &&
  typeof scan.page.viewport.width === "number" &&
  typeof scan.page.scroll.x === "number");
check("U22b", "顶层 page/stats/elements 存在",
  scan.page && scan.stats && Array.isArray(scan.elements));

/* 16 stats consistency */
w = makePage(
  `<button>a</button><button>b</button><a href="#">c</a>` +
  `<button style="display:none">h</button>`
);
scan = w.PageSenseScanner.scanPage();
eq("U23a", "stats.total === elements.length", scan.stats.total, scan.elements.length);
eq("U23b", "stats.inViewport 与数据一致",
  scan.stats.inViewport, scan.elements.filter((e) => e.inViewport).length);
eq("U23c", "stats.matched/hidden 一致",
  scan.stats.matched - scan.stats.hidden, scan.elements.length);

/* null/undefined robustness: scanner on empty body */
w = makePage(``);
scan = w.PageSenseScanner.scanPage();
eq("U24", "空页面不崩溃，返回空 elements", scan.elements.length, 0);

/* ---- V1.1 mapping tests (unit layer) ---- */

/* VT1: JSON elementId === DOM mapping attribute */
w = makePage(`<button>测试按钮</button>`);
scan = w.PageSenseScanner.scanPage();
let mapped = w.document.querySelector("[" + w.PAGESENSE.PAGE_SENSE_ID_ATTR + "]");
check("VT1", "扫描后真实 DOM 写入映射，elementId 与属性一致",
  mapped && mapped.getAttribute(w.PAGESENSE.PAGE_SENSE_ID_ATTR) ===
    String(scan.elements[0].elementId),
  mapped ? mapped.getAttribute(w.PAGESENSE.PAGE_SENSE_ID_ATTR) : "no mapped node");

/* VT2: unique mapping, each id resolves to its own node */
w = makePage(`<button>a</button><a href="#">b</a><input placeholder="c">`);
scan = w.PageSenseScanner.scanPage();
let attrs = Array.from(w.document.querySelectorAll("[" + w.PAGESENSE.PAGE_SENSE_ID_ATTR + "]"))
  .map((n) => n.getAttribute(w.PAGESENSE.PAGE_SENSE_ID_ATTR));
let resolves = scan.elements.map((e) =>
  w.PageSenseElementMap.getElementById(e.elementId) ===
  w.document.querySelector("[" + w.PAGESENSE.PAGE_SENSE_ID_ATTR + '="' + e.elementId + '"]'));
check("VT2", "映射唯一且每个 elementId 解析到对应节点",
  new Set(attrs).size === 3 && attrs.join(",") === "1,2,3" && resolves.every(Boolean),
  attrs.join(","));

/* Invalid ids are rejected rather than producing a selector */
check("VT2b", "非法 elementId 返回 null",
  w.PageSenseElementMap.getElementById(0) === null &&
  w.PageSenseElementMap.getElementById(-1) === null &&
  w.PageSenseElementMap.getElementById("1; DROP") === null &&
  w.PageSenseElementMap.getElementById(undefined) === null);

/* VT3: rescan clears old mapping and rebuilds */
w = makePage(`<button>a</button><button>b</button><button>c</button>`);
w.PageSenseScanner.scanPage();
let before = w.document.querySelectorAll("[" + w.PAGESENSE.PAGE_SENSE_ID_ATTR + "]").length;
/* remove the middle element before rescan */
let buttons = w.document.querySelectorAll("button");
buttons[1].parentNode.removeChild(buttons[1]);
scan = w.PageSenseScanner.scanPage();
let afterAttrs = Array.from(w.document.querySelectorAll("[" + w.PAGESENSE.PAGE_SENSE_ID_ATTR + "]"))
  .map((n) => n.getAttribute(w.PAGESENSE.PAGE_SENSE_ID_ATTR));
let staleLookup = w.PageSenseElementMap.getElementById(3);
check("VT3", "重新扫描清理旧映射并正确重建",
  before === 3 && afterAttrs.join(",") === "1,2" && staleLookup === null,
  JSON.stringify({ before, afterAttrs, staleLookup: Boolean(staleLookup) }));

console.log(`\nSCANNER UNIT SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
