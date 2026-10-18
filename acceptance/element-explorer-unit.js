"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "..", "pagesense");
const dom = new JSDOM('<!doctype html><html><body>' +
  '<main id="main"><h1>页面标题</h1><p class="copy featured" data-kind="price">' +
  '正文前缀 <strong>行内内容</strong>' + "长".repeat(400) + '末尾搜索词</p>' +
  '<div id="generic">直接文本<span>子项文本</span></div>' +
  '<button id="a:b.1" class="action featured" data-testid="send">提交</button>' +
  '<label>表单说明</label><input id="field" value="字段值">' +
  '<input type="password" value="secret-fixture"><img alt="封面" src="cover.png">' +
  '<ul><li><span>列表内容</span></li></ul><table><tbody><tr><td>单元格</td></tr></tbody></table>' +
  '<div id="dup">重复ID1</div><div id="dup">重复ID2</div><div id="1foo">数字ID</div>' +
  '<div hidden><p>隐藏父级文本</p></div><div style="opacity:0"><button>透明祖先</button></div>' +
  '<div data-pagesense-overlay="highlight">扩展覆盖层</div><script>脚本文字</script><div class="empty"></div>' +
  '</main></body></html>', { url: "https://fixture.test/", runScripts: "outside-only" });
const w = dom.window;
Object.defineProperty(w.Element.prototype, "innerText", { get() { return this.textContent; } });
w.Element.prototype.getBoundingClientRect = function () {
  return { x: 5, y: 5, left: 5, top: 5, right: 105, bottom: 35, width: 100, height: 30 };
};
let router;
w.chrome = { runtime: { onMessage: { addListener(fn) { router = fn; } } } };
for (const file of ["shared/constants.js", "content/element-map.js", "content/scanner.js", "content/element-search.js"]) {
  w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
}
w.PageSenseHighlighter = { clearHighlight() {} };
w.eval(fs.readFileSync(path.join(ROOT, "content/content.js"), "utf8"));
function request(message) {
  let response;
  router(Object.assign({ action: w.PAGESENSE.ACTIONS.SCAN_PAGE }, message), {}, r => { response = r; });
  return response;
}
function search(query, options = {}) {
  return request(Object.assign({ action: w.PAGESENSE.ACTIONS.SEARCH_ELEMENTS, query }, options)).data;
}
const legacy = request({}).data;
assert.ok(legacy.elements.every(el => el.interactive));
const scan = request({ scope: "content" }).data;
assert.ok(scan.elements.length > legacy.elements.length);
assert.ok(["heading", "paragraph", "text", "button", "input", "image", "list", "table", "region"]
  .every(kind => scan.elements.some(el => el.category === kind)), JSON.stringify(scan.stats.categories));
assert.ok(!scan.elements.some(el => /隐藏父级|透明祖先|扩展覆盖层|脚本文字/.test(el.text)));
assert.ok(!scan.elements.some(el => el.tag === "strong"));
assert.equal(scan.elements.find(el => el.id === "generic").text, "直接文本");
assert.equal(search("末尾搜索词").total, 1);
assert.equal(search("", { tag: "p", className: "copy featured", attributes: { "data-kind": "price" } }).total, 1);
assert.equal(search("", { className: "feat" }).total, 0);
assert.equal(search("", { attributes: { "data-kind": null } }).total, 1);
assert.equal(search("", { selector: "main > p.copy[data-kind=price]" }).total, 1);
assert.equal(request({ action: w.PAGESENSE.ACTIONS.SEARCH_ELEMENTS, selector: "p[" }).error, "INVALID_SELECTOR");
assert.equal(request({ action: w.PAGESENSE.ACTIONS.SEARCH_ELEMENTS, attributes: [] }).error, "INVALID_PARAMS");
for (const element of scan.elements) {
  assert.equal(w.document.querySelectorAll(element.selector).length, 1, element.selector);
  assert.equal(w.document.querySelector(element.selector).getAttribute(w.PAGESENSE.PAGE_SENSE_ID_ATTR), String(element.elementId));
}
const target = scan.elements.find(el => el.id === "a:b.1");
const details = request({ action: w.PAGESENSE.ACTIONS.GET_ELEMENT_DETAILS, elementId: target.elementId });
assert.equal(details.data.element.attributes["data-testid"], "send");
assert.equal(details.data.selectorMatches, 1);
assert.equal(details.data.ancestors[0].id, "main");
assert.ok(!details.data.html.includes(w.PAGESENSE.PAGE_SENSE_ID_ATTR));
assert.ok(!JSON.stringify(scan).includes("secret-fixture"));
const full = request({ scope: "all" }).data;
assert.ok(full.elements.some(el => el.className === "empty"));
const mainDetails = request({ action: w.PAGESENSE.ACTIONS.GET_ELEMENT_DETAILS,
  elementId: full.elements.find(el => el.id === "main").elementId }).data;
assert.ok(!mainDetails.html.includes("secret-fixture"));
assert.ok(mainDetails.childrenCount > 5);
const button = w.document.createElement("button");
button.textContent = "stable";
w.document.body.prepend(button);
const oldId = full.elements.find(el => el.id === "a:b.1").elementId;
const stable = w.PageSenseScanner.scanPage({ scope: "all", preserveIds: true });
assert.equal(stable.elements.find(el => el.id === "a:b.1").elementId, oldId);
console.log("PASS scan scopes, text/structure/media categories, hidden ancestry, duplicate text, long text search, attributes, native CSS, escaped unique paths, details, password masking and stable IDs");

const records = Array.from({ length: 257 }, (_, i) => ({
  elementId: i + 1, tag: "p", text: "分页正文 " + i, category: "paragraph", className: "item",
  attributes: { "data-index": String(i) }, visible: true, inViewport: i < 10
}));
w.PageSenseElementSearch.buildIndex(records, "fixture");
const allIds = [];
for (const offset of [0, 100, 200]) {
  const page = w.PageSenseElementSearch.search("分页正文", { offset, limit: 100 });
  assert.equal(page.total, 257);
  assert.equal(page.indexSize, 257);
  assert.equal(page.truncated, offset !== 200);
  allIds.push(...page.results.map(el => el.elementId));
}
assert.equal(new Set(allIds).size, 257);
assert.equal(w.PageSenseElementSearch.search("", { inViewport: true }).total, 10);
assert.equal(w.PageSenseElementSearch.search("", { type: "text-content" }).total, 257);
assert.equal(w.PageSenseElementSearch.search("", { type: "interactive" }).total, 0);
console.log("PASS 257 matches paged completely without duplicates or lost records; viewport and group filters");
dom.window.close();
