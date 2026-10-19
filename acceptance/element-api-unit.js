"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM(`<!doctype html><html><body><section id="root"><button class="row" id="a">A</button><button class="row" id="b">B</button><a href="../next">下一页</a><input type="password" value="fixture-secret"><p>段落一</p><p>段落二</p></section><button class="row" id="outside">外部</button><div data-pagesense-overlay="highlight"><button class="row">覆盖层</button></div></body></html>`, {
  url: "https://fixture.test/path/page", runScripts: "outside-only"
});
const w = dom.window, messages = [];
w.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 });
w.Element.prototype.scrollIntoView = () => {};
w.chrome = { runtime: { onMessage: { addListener: fn => messages.push(fn) } } };
for (const file of ["shared/constants.js", "content/element-map.js", "content/scanner.js", "content/element-search.js", "content/highlighter.js", "content/action-executor.js", "content/content.js"]) {
  const filename = path.resolve(__dirname, "../pagesense", file);
  w.eval(fs.readFileSync(filename, "utf8"));
}
const scanner = w.PageSenseScanner, plain = value => JSON.parse(JSON.stringify(value));
function find(selector, options = {}) { return scanner.findElements({ by: "css_position", selector, ...options }).elements; }
function error(fn, code) { assert.throws(fn, e => e.code === code); }
const root = find("#root")[0];
assert.deepEqual(Object.keys(root).sort(), ["elementId", "pageId", "referenceId"]);
const rows = find(".row", { multiple: true, scope: root });
assert.equal(rows.length, 2);
assert.deepEqual(plain(rows.map(h => scanner.readElement(h).value)), ["A", "B"]);
assert.equal(find("//button", { by: "xpath_position", multiple: true, scope: root }).length, 2, "XPath cannot escape scope");
assert.equal(find(".//button", { by: "xpath_position", multiple: true, scope: root }).length, 2);
assert.equal(find(".missing", { multiple: true }).length, 0);
error(() => find(".missing"), "ELEMENT_NOT_FOUND");
error(() => find(".row"), "AMBIGUOUS_SELECTOR");
assert.equal(find(".row", { strict: false })[0].referenceId, rows[0].referenceId);
for (const options of [{ selector: "button[" }, { by: "xpath_position", selector: "//[" }, { by: "xpath_position", selector: "//a/@href" }, { by: "xpath_position", selector: "count(//a)" }, { by: "unknown", selector: "a" }]) {
  error(() => scanner.findElements(options), options.by === "unknown" ? "INVALID_LOCATOR" : "INVALID_SELECTOR");
}
const link = find("a")[0];
assert.equal(scanner.readElement({ ...link, mode: "attribute", name: "href" }).value, "../next");
assert.equal(scanner.readElement({ ...link, mode: "property", name: "href" }).value, "https://fixture.test/next");
assert.equal(scanner.readElement({ ...link, mode: "attribute", name: "absent" }).value, null);
error(() => scanner.readElement({ ...link, mode: "property", name: "onclick" }), "INVALID_PARAMS");
assert.equal(scanner.readElement({ ...find("input")[0], mode: "attribute", name: "value" }).value, "[密码已隐藏]");
assert.deepEqual(plain(scanner.readElements({ selector: "p", scope: root }).items).map(item => item.value), ["段落一", "段落二"]);
const inserted = w.document.createElement("button"); inserted.className = "row"; inserted.textContent = "NEW";
w.document.getElementById("root").prepend(inserted);
assert.equal(scanner.readElement(rows[1]).value, "B", "inserting a node must not shift saved list entries");
scanner.scanPage({ scope: "all" }); // explicit numbering reset
assert.equal(scanner.readElement(rows[1]).value, "B", "saved references survive scan numbering resets");
let clicked = 0;
w.document.getElementById("b").addEventListener("click", () => clicked++);
let reply;
messages[0]({ action: w.PAGESENSE.ACTIONS.CLICK_ELEMENT, ...rows[1] }, {}, value => { reply = value; });
assert.equal(reply.success, true); assert.equal(clicked, 1);
messages[0]({ action: w.PAGESENSE.ACTIONS.READ_ELEMENT, ...rows[1], pageId: "other-page" }, {}, value => { reply = value; });
assert.equal(reply.error.code, "STALE_PAGE");
messages[0]({ action: w.PAGESENSE.ACTIONS.CLICK_ELEMENT, referenceId: rows[1].referenceId }, {}, value => { reply = value; });
assert.equal(reply.error.code, "INVALID_PARAMS");
const clone = w.document.getElementById("b").cloneNode(true);
w.document.getElementById("b").replaceWith(clone);
error(() => scanner.readElement(rows[1]), "ELEMENT_NOT_FOUND");
messages[0]({ action: w.PAGESENSE.ACTIONS.CLICK_ELEMENT, ...rows[1] }, {}, value => { reply = value; });
assert.equal(reply.error.code, "ELEMENT_NOT_FOUND"); assert.equal(clicked, 1);
error(() => find("a", { scope: { ...root, pageId: "other" } }), "STALE_PAGE");
const p = w.document.querySelector("p"); p.textContent = "长".repeat(21000);
const read = scanner.readElement(find("p", { strict: false })[0]);
assert.equal(read.value.length, 20000); assert.equal(read.length, 21000); assert.equal(read.truncated, true);
const quoted = w.document.createElement("div"); quoted.id = `both'and"quotes`; w.document.body.appendChild(quoted);
const detail = scanner.inspectTarget(quoted).data;
assert.equal(w.document.evaluate(detail.xpath, w.document, null, w.XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue, quoted);
const html = fs.readFileSync(path.resolve(__dirname, "../pagesense/popup/popup.html"), "utf8");
assert.ok(!html.includes('id="scanBtn"') && !html.includes('id="liveScanToggle"') && !html.includes('id="rescanHintBtn"'));
assert.ok(html.includes('id="copyPickedXPathBtn"') && html.includes('id="locatorType"'));

/* Short XPath: nearest unique id anchor, plain HTML names and no redundant [1]. */
const secondParagraph = w.document.querySelectorAll("#root p")[1];
const shortDetail = scanner.inspectTarget(secondParagraph).data;
assert.equal(shortDetail.xpath, "//*[@id='root']/p[2]");
assert.equal(w.document.evaluate(shortDetail.xpath, w.document, null, w.XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue, secondParagraph);
const svg = w.document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.appendChild(w.document.createElementNS("http://www.w3.org/2000/svg", "circle"));
w.document.getElementById("root").appendChild(svg);
const circlePath = scanner.inspectTarget(svg.firstChild).data.xpath;
assert.ok(circlePath.includes("local-name()='svg'") && circlePath.includes("local-name()='circle'"), circlePath);
// jsdom's XPath engine cannot evaluate namespace-uri() on foreign nodes; Chrome covers execution.
assert.ok(circlePath.includes("namespace-uri()='http://www.w3.org/2000/svg'"));
const loose = w.document.createElement("article");
loose.innerHTML = "<p>甲</p><p>乙</p>";
w.document.body.appendChild(loose);
const loosePath = scanner.inspectTarget(loose.querySelector("p")).data.xpath;
assert.ok(!loosePath.includes("local-name()") && /^\/html\/body/.test(loosePath), loosePath);
assert.equal(w.document.evaluate(loosePath, w.document, null, w.XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue, loose.querySelector("p"));
for (const element of Array.from(w.document.querySelectorAll("body *"))) {
  if (element.closest("[data-pagesense-overlay]") || element.closest("svg")) continue;
  const data = scanner.inspectTarget(element);
  assert.equal(data.ok, true, element.localName);
  assert.equal(w.document.evaluate(data.data.xpath, w.document, null, w.XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue,
    element, data.data.xpath);
}
dom.window.close();
console.log("PASS CSS/XPath queries, scoped lists, minimal reads, stable identity, DOM mutations/rescan, stale pages, truncation, short XPath and automatic-scan controls");
