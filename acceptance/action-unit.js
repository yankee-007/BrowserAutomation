/* Action Executor unit tests (V1.2 spec sections 6-24, 37-50).
 * Runs the REAL content scripts inside jsdom. jsdom performs no layout,
 * so getBoundingClientRect is stubbed; real click/input/keyboard/scroll
 * behavior is separately verified in the real-browser E2E stage. */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "pagesense");
function src(f) {
  return fs.readFileSync(path.join(ROOT, f), "utf8");
}
const constantsSrc = src("shared/constants.js");
const elementMapSrc = src("content/element-map.js");
const scannerSrc = src("content/scanner.js");
const highlighterSrc = src("content/highlighter.js");
const actionSrc = src("content/action-executor.js");

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}
function R(x, y, w, h) {
  return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}

function makePage(bodyHtml) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><title>Action Unit</title></head><body>${bodyHtml}</body></html>`,
    { url: "https://unit.test/page", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const w = dom.window;
  Object.defineProperty(w.Element.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent; }
  });
  // jsdom does not implement isContentEditable; shim from the attribute.
  // Real contenteditable behavior is verified in the browser E2E stage.
  Object.defineProperty(w.Element.prototype, "isContentEditable", {
    configurable: true,
    get() { return this.getAttribute("contenteditable") === "true"; }
  });
  w.Element.prototype.getBoundingClientRect = function () {
    const s = this.style;
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return R(0, 0, 0, 0);
    return R(8, 8, 120, 40);
  };
  // jsdom scrollBy is a no-op; emulate simple scrolling.
  w.scrollPos = { x: 0, y: 0 };
  w.scrollBy = function (dx, dy) {
    w.scrollPos.x = Math.max(0, w.scrollPos.x + dx);
    w.scrollPos.y = Math.max(0, w.scrollPos.y + dy);
  };
  Object.defineProperty(w, "scrollX", { get() { return w.scrollPos.x; } });
  Object.defineProperty(w, "scrollY", { get() { return w.scrollPos.y; } });

  w.eval(constantsSrc);
  w.eval(elementMapSrc);
  w.eval(scannerSrc);
  w.eval(highlighterSrc);
  w.eval(actionSrc);
  return w;
}

/** Build a scan so element ids are materialized, then return window + scan. */
function scannedPage(bodyHtml) {
  const w = makePage(bodyHtml);
  const scan = w.PageSenseScanner.scanPage();
  return { w, scan };
}

function idFor(scan, predicate) {
  const el = scan.elements.find(predicate);
  return el ? el.elementId : null;
}

/* ---- CLICK ---- */

let { w, scan } = scannedPage(
  '<button id="t">测试按钮</button><button disabled id="d">禁用</button>'
);
let counter = 0;
w.document.getElementById("t").addEventListener("click", () => { counter++; });

let r = w.PageSenseActionExecutor.click(idFor(scan, (e) => e.id === "t"));
check("A01", "click success envelope shape",
  r.success === true && r.action === w.PAGESENSE.ACTIONS.CLICK_ELEMENT &&
  /^act_/.test(r.actionId) && typeof r.timestamp === "number" &&
  typeof r.durationMs === "number" && r.rescanRecommended === true &&
  counter === 1, JSON.stringify(r));

[null, undefined, -1, 0, "abc"].forEach((bad, i) => {
  const rr = w.PageSenseActionExecutor.click(bad);
  check("A02" + i, "click invalid id -> INVALID_ELEMENT_ID (" + JSON.stringify(bad) + ")",
    rr.success === false && rr.error.code === "INVALID_ELEMENT_ID");
});

r = w.PageSenseActionExecutor.click(999999);
check("A03", "click missing id -> ELEMENT_NOT_FOUND",
  r.success === false && r.error.code === "ELEMENT_NOT_FOUND");

r = w.PageSenseActionExecutor.click(idFor(scan, (e) => e.id === "d"));
check("A04", "click disabled -> ELEMENT_DISABLED",
  r.success === false && r.error.code === "ELEMENT_DISABLED" && counter === 1);

({ w, scan } = scannedPage('<span aria-disabled="true" role="button" id="ad">x</span>'));
r = w.PageSenseActionExecutor.click(idFor(scan, (e) => e.id === "ad"));
check("A04b", "click aria-disabled -> ELEMENT_DISABLED",
  r.success === false && r.error.code === "ELEMENT_DISABLED");

/* ---- INPUT ---- */

({ w, scan } = scannedPage(
  '<input id="inp" placeholder="p"><textarea id="ta"></textarea>' +
  '<div contenteditable="true" id="ce"></div><div role="button" id="plain">x</div>'
));
let inputEvents = 0, changeEvents = 0;
const inp = w.document.getElementById("inp");
inp.addEventListener("input", () => { inputEvents++; });
inp.addEventListener("change", () => { changeEvents++; });

r = w.PageSenseActionExecutor.input(idFor(scan, (e) => e.id === "inp"), "PageSense");
check("A05", "input text success + events + readback",
  r.success === true && inp.value === "PageSense" &&
  inputEvents === 1 && changeEvents === 1 && r.value === "PageSense");

const ta = w.document.getElementById("ta");
r = w.PageSenseActionExecutor.input(
  scan.elements.find((e) => e.tag === "textarea").elementId, "多行文本"
);
check("A06", "input textarea success",
  r.success === true && ta.value === "多行文本");

const ce = w.document.getElementById("ce");
r = w.PageSenseActionExecutor.input(
  scan.elements.find((e) => e.id === "ce").elementId, "CE内容"
);
check("A07", "input contenteditable success",
  r.success === true && ce.textContent === "CE内容");

r = w.PageSenseActionExecutor.input(
  scan.elements.find((e) => e.id === "plain").elementId, "x"
);
check("A08", "input unsupported -> UNSUPPORTED_ELEMENT",
  r.success === false && r.error.code === "UNSUPPORTED_ELEMENT");

r = w.PageSenseActionExecutor.input(
  idFor(scan, (e) => e.id === "inp"), 123
);
check("A09", "input non-string value -> INVALID_VALUE",
  r.success === false && r.error.code === "INVALID_VALUE");

/* ---- CLEAR ---- */

r = w.PageSenseActionExecutor.clear(idFor(scan, (e) => e.id === "inp"));
check("A10", "clear empties value (action CLEAR_ELEMENT)",
  r.success === true && r.action === w.PAGESENSE.ACTIONS.CLEAR_ELEMENT &&
  inp.value === "");

/* ---- KEYPRESS ---- */

let downKeys = [], upKeys = [];
inp.addEventListener("keydown", (e) => { downKeys.push(e.key); });
inp.addEventListener("keyup", (e) => { upKeys.push(e.key); });

r = w.PageSenseActionExecutor.keypress(idFor(scan, (e) => e.id === "inp"), "Enter");
check("A11", "keypress Enter fires keydown/keyup",
  r.success === true && downKeys.includes("Enter") && upKeys.includes("Enter") &&
  r.rescanRecommended === true);

r = w.PageSenseActionExecutor.keypress(idFor(scan, (e) => e.id === "inp"), "FakeKey");
check("A12", "keypress invalid -> INVALID_KEY",
  r.success === false && r.error.code === "INVALID_KEY");

r = w.PageSenseActionExecutor.keypress(idFor(scan, (e) => e.id === "inp"), "Space");
check("A13", "keypress Space alias normalized",
  r.success === true && downKeys.includes(" ") && r.key === "Space");

r = w.PageSenseActionExecutor.keypress(idFor(scan, (e) => e.id === "inp"), "ArrowDown");
check("A13b", "keypress ArrowDown no rescan hint",
  r.success === true && r.rescanRecommended === false);

/* ---- SCROLL ---- */

r = w.PageSenseActionExecutor.scrollPage("down", 500);
check("A14", "scroll down returns before/after + moved",
  r.success === true && r.before.y === 0 && r.after.y === 500 && r.moved === true);
r = w.PageSenseActionExecutor.scrollPage("up", 500);
check("A14b", "scroll up returns to 0", r.after.y === 0);
r = w.PageSenseActionExecutor.scrollPage("sideways", 100);
check("A15a", "scroll invalid direction -> INVALID_VALUE",
  r.success === false && r.error.code === "INVALID_VALUE");
[0, -5, NaN, Infinity, 99999].forEach((bad, i) => {
  const rr = w.PageSenseActionExecutor.scrollPage("down", bad);
  check("A15" + i, "scroll invalid amount " + bad + " -> INVALID_VALUE",
    rr.success === false && rr.error.code === "INVALID_VALUE");
});

/* ---- Boundary: already at edge ---- */

r = w.PageSenseActionExecutor.scrollPage("up", 300);
check("A15c", "scroll at boundary -> moved false, still success",
  r.success === true && r.moved === false);

/* ---- Capability classification ---- */

({ w, scan } = scannedPage(
  '<button>b</button><a href="#">l</a><input type="text" id="ti">' +
  '<input type="checkbox" id="cb"><div contenteditable="true" id="ce2"></div>'
));
const P = w.PAGESENSE;
const byId = (id) => scan.elements.find((e) => e.id === id);
check("A17a", "isTextEntry: text input / CE",
  P.isTextEntryElement(byId("ti")) && P.isTextEntryElement(byId("ce2")) &&
  !P.isTextEntryElement(byId("cb")));
check("A17b", "isClickable: button/link/checkbox, not text input",
  P.isClickableElement(scan.elements.find((e) => e.tag === "button")) &&
  P.isClickableElement(scan.elements.find((e) => e.tag === "a")) &&
  P.isClickableElement(byId("cb")) && !P.isClickableElement(byId("ti")));

/* ---- 20x CLICK / 20x INPUT ---- */

({ w, scan } = scannedPage('<button id="c">c</button><input id="i2">'));
let c20 = 0;
w.document.getElementById("c").addEventListener("click", () => { c20++; });
const cid = idFor(scan, (e) => e.id === "c");
for (let i = 0; i < 20; i++) {
  w.PageSenseActionExecutor.click(cid);
}
check("A18", "20 clicks -> counter exactly 20", c20 === 20, "got " + c20);

const iid = idFor(scan, (e) => e.id === "i2");
for (let i = 1; i <= 20; i++) {
  w.PageSenseActionExecutor.input(iid, "value-" + i);
}
const finalInput = w.document.getElementById("i2");
check("A19", "20 inputs -> final value-20", finalInput.value === "value-20",
  "got " + finalInput.value);

/* ---- Mixed sequence INPUT/CLEAR/INPUT/KEY ---- */

let mixed = true;
w.PageSenseActionExecutor.input(iid, "abc");
w.PageSenseActionExecutor.clear(iid);
w.PageSenseActionExecutor.input(iid, "def");
const kr = w.PageSenseActionExecutor.keypress(iid, "Enter");
mixed = finalInput.value === "def" && kr.success;
check("A20", "mixed sequence no state pollution", mixed, "value=" + finalInput.value);

console.log(`\nACTION UNIT SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
