"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><button id="one">选择目标</button><button class="duplicate">A</button><button class="duplicate">B</button></body></html>', {
  url: "https://fixture.test", runScripts: "outside-only"
});
const w = dom.window;
w.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 });
for (const file of ["shared/constants.js", "content/element-map.js", "content/scanner.js"]) {
  w.eval(fs.readFileSync(path.resolve(__dirname, "../pagesense", file), "utf8"));
}
const scanner = w.PageSenseScanner, map = w.PageSenseElementMap;
const button = w.document.getElementById("one");
button.setAttribute("data-testid", 'quote"slash\\line\nend');
const detail = scanner.resolveElement("#one").data;
assert.ok(detail.pageId && detail.element.pageId === detail.pageId);
assert.equal(detail.locator.label, "data-testid");
assert.equal(w.document.querySelector(detail.locator.selector), button);
assert.equal(scanner.resolveElement(".duplicate").error, "AMBIGUOUS_SELECTOR");
assert.equal(scanner.resolveElement("#missing").error, "ELEMENT_NOT_FOUND");
assert.equal(scanner.resolveElement("button[").error, "INVALID_SELECTOR");
assert.equal(scanner.resolveElement(1).error, "INVALID_SELECTOR");
const clone = button.cloneNode(true);
clone.id = "cloned"; w.document.body.prepend(clone);
assert.equal(map.getElementById(detail.element.elementId), button, "a cloned mapping must never redirect a handle");
assert.equal(scanner.resolveElement(detail.locator.selector).error, "AMBIGUOUS_SELECTOR");
button.remove();
assert.equal(map.getElementById(detail.element.elementId), null, "a removed original must not resolve to its clone");
scanner.scanPage({ preserveIds: true, scope: "all" });
assert.equal(map.getElementById(detail.element.elementId), null, "old IDs must not be reassigned to clones");
dom.window.close();
console.log("PASS escaped attribute locators, strict CSS errors, scoped handles and clone/removal identity");
