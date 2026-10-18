/* PageSense V2.0 - INDEPENDENT unit suite for the shared search logic.
 *
 * Independently authored for the independent acceptance pass. It loads the
 * SHIPPED source files (no copies, no re-implementation) into a jsdom global
 * and exercises them directly, so a change in the shipped file is picked up
 * automatically.
 *
 * Run:  node indep_unit.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "..", "pagesense");

let pass = 0;
const failures = [];
function check(id, name, cond, detail) {
  if (cond) { pass++; } else { failures.push(id); }
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
}
function eq(id, name, actual, expected) {
  check(id, name, actual === expected, `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}
function near(id, name, actual, max) {
  check(id, name, typeof actual === "number" && actual <= max, `got ${actual} (max ${max})`);
}

/* ---- load the shipped modules into a jsdom window -------------------- */
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://127.0.0.1/test/",
  // runScripts: "outside-only" makes window.eval execute INSIDE the jsdom
  // context; without it the modules attach to the Node global instead of the
  // window and every lookup returns undefined.
  runScripts: "outside-only",
  pretendToBeVisual: true
});
const win = dom.window;
for (const f of ["shared/constants.js", "content/element-search.js"]) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  win.eval(src);
}
const PS = win.PAGESENSE;
const Search = win.PageSenseElementSearch;

check("U-000", "shipped constants.js + element-search.js 已加载",
  Boolean(PS) && Boolean(Search) && Boolean(PS.SEARCH_SCORES),
  `PS=${Boolean(PS)} Search=${Boolean(Search)}`);

/* ==================================================================== */
/* normalizeSearchText / tokenize                                        */
/* ==================================================================== */
const norm = [
  ["U-101", "  立即沟通  ", "立即沟通"],
  ["U-102", "AI   工程师", "ai 工程师"],
  ["U-103", "AI 　工程师", "ai 工程师"],       // full-width space
  ["U-104", "\t\nAI\t\n", "ai"],
  ["U-105", "ABC", "abc"],
  ["U-106", "Ａｂｃ", "ａｂｃ"],                 // full-width latin: case-folds, width kept
  ["U-107", "", ""],
  ["U-108", "   ", ""],
  ["U-109", "中文 English 混合", "中文 english 混合"],
  ["U-110", "emoji 🔑 键", "emoji 🔑 键"],
];
for (const [id, input, want] of norm) {
  eq(id, `normalizeSearchText(${JSON.stringify(input)})`, PS.normalizeSearchText(input), want);
}
eq("U-111", "normalizeSearchText(null) -> ''", PS.normalizeSearchText(null), "");
eq("U-112", "normalizeSearchText(undefined) -> ''", PS.normalizeSearchText(undefined), "");
eq("U-113", "normalizeSearchText(123) -> '123'", PS.normalizeSearchText(123), "123");

eq("U-120", "tokenize('') -> []", JSON.stringify(PS.tokenizeSearchQuery("")), "[]");
eq("U-121", "tokenize('   ') -> []", JSON.stringify(PS.tokenizeSearchQuery("   ")), "[]");
eq("U-122", "tokenize('AI 工程师')",
  JSON.stringify(PS.tokenizeSearchQuery("AI 工程师")), JSON.stringify(["ai", "工程师"]));
eq("U-123", "tokenize 多空格折叠",
  JSON.stringify(PS.tokenizeSearchQuery("a    b   c")), JSON.stringify(["a", "b", "c"]));
eq("U-124", "tokenize 全角空格分隔",
  JSON.stringify(PS.tokenizeSearchQuery("a　b")), JSON.stringify(["a", "b"]));

/* ==================================================================== */
/* clampSearchLimit                                                      */
/* ==================================================================== */
const limits = [
  [null, 20], [undefined, 20], ["", 20], ["abc", 20], [NaN, 20], [Infinity, 20],
  [0, 1], [-1, 1], [-999, 1], [1, 1], [20, 20], [100, 100], [101, 100],
  [1000, 100], [10 ** 9, 100], [3.7, 3], ["5", 5], ["  7  ", 7],
  [{}, 20],
  // QUIRK (recorded, not a crash): Number([]) === 0 and Number(true) === 1, so
  // these "invalid" values clamp to 1 instead of falling back to the documented
  // default of 20. The function comment says "invalid values fall back to
  // SEARCH_DEFAULT_LIMIT", which is not literally true for values that JS
  // coerces to a number. The outcome is still a legal limit and no shipped
  // caller can produce these (the CLI and the Python client both pass ints or
  // omit the field), so this is recorded as a documentation nit, not a defect.
  [[], 1], [true, 1],
];
const quirks = [];
for (const [input, want] of limits) {
  const got = PS.clampSearchLimit(input);
  eq(`U-13x-${String(input)}`, `clampSearchLimit(${JSON.stringify(input)}) === ${want}`,
    got, want);
}
quirks.push(["[]", PS.clampSearchLimit([])], ["true", PS.clampSearchLimit(true)],
  ["{}", PS.clampSearchLimit({})], ["'abc'", PS.clampSearchLimit("abc")]);
check("U-139", "记录 clampSearchLimit 的 JS 强制转换怪异行为（[] / true -> 1，{} / 'abc' -> 20）",
  JSON.stringify(quirks) === JSON.stringify([["[]", 1], ["true", 1], ["{}", 20], ["'abc'", 20]]),
  JSON.stringify(quirks));

/* ==================================================================== */
/* categorizeElement / isTextEntryElement / isClickableElement           */
/* ==================================================================== */
const cats = [
  [{ tag: "a" }, "link"],
  [{ tag: "a", role: "link" }, "link"],
  [{ tag: "div", role: "link" }, "link"],
  [{ tag: "button" }, "button"],
  [{ tag: "div", role: "button" }, "button"],
  [{ tag: "input", type: "text" }, "input"],
  [{ tag: "textarea" }, "input"],
  [{ tag: "select" }, "input"],
  [{ tag: "option" }, "input"],
  [{ tag: "div", role: "textbox" }, "input"],
  [{ tag: "div", contentEditable: true }, "input"],
  [{ tag: "div" }, "other"],
  [{ tag: "span" }, "other"],
];
for (const [el, want] of cats) {
  eq(`U-2xx-${JSON.stringify(el)}`, `categorize(${JSON.stringify(el)}) === ${want}`,
    PS.categorizeElement(el), want);
}

const textEntry = [
  [{ tag: "input", type: "text" }, true],
  [{ tag: "input" }, true],
  [{ tag: "input", type: "TEXT" }, true],
  [{ tag: "input", type: "email" }, true],
  [{ tag: "input", type: "search" }, true],
  [{ tag: "input", type: "password" }, true],
  [{ tag: "input", type: "url" }, true],
  [{ tag: "input", type: "tel" }, true],
  [{ tag: "input", type: "number" }, true],
  [{ tag: "input", type: "checkbox" }, false],
  [{ tag: "input", type: "radio" }, false],
  [{ tag: "input", type: "submit" }, false],
  [{ tag: "input", type: "file" }, false],
  [{ tag: "input", type: "date" }, false],
  [{ tag: "textarea" }, true],
  [{ tag: "div", contentEditable: true }, true],
  [{ tag: "div", role: "textbox" }, true],
  [{ tag: "button" }, false],
  [{ tag: "select" }, false],
];
for (const [el, want] of textEntry) {
  eq(`U-3xx-${JSON.stringify(el)}`, `isTextEntry(${JSON.stringify(el)}) === ${want}`,
    PS.isTextEntryElement(el), want);
}

const clickable = [
  [{ tag: "button" }, true],
  [{ tag: "div", role: "button" }, true],
  [{ tag: "a" }, true],
  [{ tag: "input", type: "checkbox" }, true],
  [{ tag: "input", type: "submit" }, true],
  [{ tag: "input", type: "file" }, true],
  [{ tag: "input", type: "text" }, false],
  [{ tag: "textarea" }, false],
  [{ tag: "div" }, false],
];
for (const [el, want] of clickable) {
  eq(`U-4xx-${JSON.stringify(el)}`, `isClickable(${JSON.stringify(el)}) === ${want}`,
    PS.isClickableElement(el), want);
}

/* ==================================================================== */
/* inspectUrl                                                            */
/* ==================================================================== */
const urls = [
  ["http://127.0.0.1/x", false],
  ["https://example.com/x", false],
  ["https://example.com:8443/a?b=c#d", false],
  ["edge://extensions/", true],
  ["chrome://settings", true],
  ["about:blank", true],
  ["devtools://devtools/bundled/x.html", true],
  ["view-source:https://example.com", true],
  ["chrome-extension://abc/popup.html", true],
  ["moz-extension://abc/x.html", true],
  ["https://chromewebstore.google.com/detail/x", true],
  ["https://chrome.google.com/webstore/x", true],
  ["https://microsoftedge.microsoft.com/addons/x", true],
  ["https://addons.mozilla.org/x", true],
  ["", true],
  ["not a url", true],
  ["file:///C:/tmp/x.html", false],
];
for (const [url, want] of urls) {
  const r = PS.inspectUrl(url);
  eq(`U-5xx-${url || "empty"}`, `inspectUrl(${JSON.stringify(url)}).restricted === ${want}`,
    r.restricted, want);
}
eq("U-530", "file:// 返回 MAY_NEED_ACCESS_TOGGLE 提示",
  PS.inspectUrl("file:///C:/x.html").reason, "FILE_URL_MAY_NEED_ACCESS_TOGGLE");
eq("U-531", "空 URL 原因为 EMPTY_URL", PS.inspectUrl("").reason, "EMPTY_URL");

/* ==================================================================== */
/* search(): index lifecycle                                             */
/* ==================================================================== */
eq("U-600", "未扫描时 search -> NO_SCAN_DATA",
  Search.search("a").ok === false && Search.search("a").error.code, PS.ERROR_CODES.NO_SCAN_DATA);
eq("U-601", "未扫描时 getIndexInfo().valid === false", Search.getIndexInfo().valid, false);

const els = [
  { elementId: 1, tag: "button", text: "立即沟通" },
  { elementId: 2, tag: "a", text: "Python开发工程师", href: "https://x.com/a" },
  { elementId: 3, tag: "input", text: "", placeholder: "搜索职位", id: "jobInput" },
  { elementId: 4, tag: "div", role: "button", ariaLabel: "关闭弹窗", text: "" },
];
eq("U-602", "buildIndex 返回文档数量", Search.buildIndex(els, "2026-01-01T00:00:00Z"), 4);
eq("U-603", "buildIndex 后 index valid", Search.getIndexInfo().valid, true);
eq("U-604", "getIndexInfo().size == 4", Search.getIndexInfo().size, 4);
eq("U-605", "getIndexInfo().indexedAt 透传", Search.getIndexInfo().indexedAt,
  "2026-01-01T00:00:00Z");

eq("U-606", "buildIndex(null) 不崩溃且 size=0", Search.buildIndex(null), 0);
eq("U-607", "buildIndex([]) 后空 query 返回 0", Search.search("").total, 0);
eq("U-608", "buildIndex 过滤 null 元素项", Search.buildIndex([null, els[0], undefined, "x", 5]), 1);
eq("U-609", "buildIndex 过滤非对象项后仍可搜索",
  Search.search("立即沟通").total, 1);

/* fresh index for the rest */
Search.buildIndex(els, "T");

eq("U-610", "空 query 返回全部（DOM 顺序）",
  JSON.stringify(Search.search("").results.map((r) => r.elementId)),
  JSON.stringify([1, 2, 3, 4]));
eq("U-611", "空 query 的 score 全 0",
  Search.search("").results.every((r) => r.score === 0), true);
eq("U-612", "空 query 的 matchedFields 为空数组",
  Search.search("").results.every((r) => Array.isArray(r.matchedFields) && r.matchedFields.length === 0),
  true);
eq("U-613", "空 query 的 total 为全部", Search.search("").total, 4);
eq("U-614", "空 query 的 normalizedQuery 为空", Search.search("").normalizedQuery, "");

/* field coverage */
function top(query) {
  const r = Search.search(query, { limit: 100 });
  return r.results[0] || null;
}
eq("U-620", "text 命中", top("立即沟通").elementId, 1);
eq("U-621", "placeholder 命中（text 空时）", top("搜索职位").elementId, 3);
eq("U-622", "ariaLabel 命中", top("关闭弹窗").elementId, 4);
eq("U-623", "id 命中", top("jobInput").elementId, 3);
eq("U-624", "tag 命中（button）", top("button") !== null, true);
eq("U-625", "role 命中（button -> role=button 的 div 也在内）",
  Search.search("button", { limit: 100 }).total >= 2, true);
eq("U-626", "href 命中（长度>=2 关键词）", top("x.com") !== null, true);

/* href min length.
 * The tag must not itself contain the keyword, otherwise the `tag` field
 * matches and the href rule is never exercised. */
Search.buildIndex([{ elementId: 1, tag: "button", text: "Z", href: "https://aaa.com/1" }], "T");
eq("U-630", "单字符关键词不匹配 href",
  Search.search("a", { limit: 100 }).total, 0);
eq("U-631", "两字符关键词匹配 href",
  Search.search("aa", { limit: 100 }).total, 1);
eq("U-631b", "href 命中分数为 contains 档 (10)",
  Search.search("aa", { limit: 100 }).results[0].score, 10);

/* exact / prefix / contains tiers */
Search.buildIndex([
  { elementId: 1, tag: "button", text: "x" },
  { elementId: 2, tag: "button", text: "xy" },
  { elementId: 3, tag: "button", text: "zxy" },
], "T");
const s = Search.search("x", { limit: 100 });
eq("U-640", "exact 得 100 分", s.results.find((r) => r.elementId === 1).score, 100);
eq("U-641", "prefix 得 80 分", s.results.find((r) => r.elementId === 2).score, 80);
eq("U-642", "contains 得 60 分", s.results.find((r) => r.elementId === 3).score, 60);
eq("U-643", "按分数降序排列",
  JSON.stringify(s.results.map((r) => r.elementId)), JSON.stringify([1, 2, 3]));

/* tie-break by elementId ascending */
Search.buildIndex([
  { elementId: 9, tag: "button", text: "same" },
  { elementId: 3, tag: "button", text: "same" },
  { elementId: 7, tag: "button", text: "same" },
], "T");
eq("U-650", "同分按 elementId 升序",
  JSON.stringify(Search.search("same", { limit: 100 }).results.map((r) => r.elementId)),
  JSON.stringify([3, 7, 9]));

/* AND semantics, including across different fields */
Search.buildIndex([
  { elementId: 1, tag: "button", text: "AI应用工程师" },
  { elementId: 2, tag: "button", text: "AI产品经理" },
  { elementId: 3, tag: "button", text: "Java工程师" },
  { elementId: 4, tag: "button", text: "AI", placeholder: "工程师" },
  { elementId: 5, tag: "button", text: "工程师", ariaLabel: "AI" },
], "T");
eq("U-660", "AND：两词都在 text 中",
  Search.search("AI 工程师", { limit: 100 }).results.some((r) => r.elementId === 1), true);
eq("U-661", "AND：只有 AI -> 排除",
  Search.search("AI 工程师", { limit: 100 }).results.some((r) => r.elementId === 2), false);
eq("U-662", "AND：只有 工程师 -> 排除",
  Search.search("AI 工程师", { limit: 100 }).results.some((r) => r.elementId === 3), false);
eq("U-663", "AND：关键词落在不同字段也算命中（text + placeholder）",
  Search.search("AI 工程师", { limit: 100 }).results.some((r) => r.elementId === 4), true);
eq("U-664", "AND：text + ariaLabel 组合",
  Search.search("AI 工程师", { limit: 100 }).results.some((r) => r.elementId === 5), true);
eq("U-665", "AND 分数为各关键词分数之和",
  Search.search("ai 工程师", { limit: 100 }).results.find((r) => r.elementId === 1).score,
  80 + 60);
eq("U-666", "matchedFields 合并两个关键词的字段",
  JSON.stringify(Search.search("ai 工程师", { limit: 100 })
    .results.find((r) => r.elementId === 4).matchedFields),
  JSON.stringify(["text", "placeholder"]));
// Ordering note: #1 = ai(80)+工程(60)+师(60) = 200, #5 = ai(55,aria)+工程(80)+师(60)
// = 195, #4 = ai(100,text)+工程(40)+师(25) = 165, hence [1, 5, 4].
eq("U-667", "三关键词 AND：全部命中才返回，按总分降序（1/5/4）",
  JSON.stringify(Search.search("ai 工程 师", { limit: 100 }).results.map((r) => r.elementId)),
  JSON.stringify([1, 5, 4]));
eq("U-667b", "三关键词 AND：有一个词不命中则整体排除",
  Search.search("ai 工程 zzz", { limit: 100 }).total, 0);
eq("U-667c", "三关键词分数为三者之和",
  Search.search("ai 工程 师", { limit: 100 }).results.find((r) => r.elementId === 1).score,
  80 + 60 + 60);
eq("U-668", "重复关键词不重复计分（去重字段）",
  JSON.stringify(Search.search("ai ai", { limit: 100 })
    .results.find((r) => r.elementId === 1).matchedFields), JSON.stringify(["text"]));

/* no results / limit / truncated */
eq("U-670", "无结果 total=0 returned=0 truncated=false",
  JSON.stringify([Search.search("zzzz").total, Search.search("zzzz").returned,
    Search.search("zzzz").truncated]), JSON.stringify([0, 0, false]));
Search.buildIndex(Array.from({ length: 250 }, (_, i) => ({
  elementId: i + 1, tag: "button", text: `item ${i + 1}`
})), "T");
const limited = Search.search("item", { limit: 20 });
eq("U-671", "limit=20 返回 20 条", limited.results.length, 20);
eq("U-672", "total 为全部命中数 250", limited.total, 250);
eq("U-673", "truncated === true", limited.truncated, true);
eq("U-674", "limit 超过上限被夹取", Search.search("item", { limit: 5000 }).limit, 100);
eq("U-675", "limit 被夹取后返回 100 条", Search.search("item", { limit: 5000 }).results.length, 100);
eq("U-676", "durationMs 是非负整数",
  Number.isInteger(Search.search("item").durationMs) && Search.search("item").durationMs >= 0, true);

/* index replaced by a new scan (stale elementIds must not survive) */
Search.buildIndex([{ elementId: 1, tag: "button", text: "old target" }], "T1");
eq("U-680", "第一次扫描可搜到旧元素", Search.search("old target").total, 1);
Search.buildIndex([{ elementId: 1, tag: "button", text: "brand new" }], "T2");
eq("U-681", "重新扫描后旧文本搜不到", Search.search("old target").total, 0);
eq("U-682", "重新扫描后新文本可搜到", Search.search("brand new").total, 1);
eq("U-683", "重新扫描后 indexedAt 更新", Search.getIndexInfo().indexedAt, "T2");

Search.clearIndex();
eq("U-684", "clearIndex 后 search -> NO_SCAN_DATA",
  Search.search("x").error.code, PS.ERROR_CODES.NO_SCAN_DATA);
eq("U-685", "clearIndex 后 valid === false", Search.getIndexInfo().valid, false);

/* type filter (used by the Popup) */
Search.buildIndex([
  { elementId: 1, tag: "button", text: "搜索" },
  { elementId: 2, tag: "a", text: "搜索链接" },
  { elementId: 3, tag: "input", text: "搜索", placeholder: "搜索" },
  { elementId: 4, tag: "div", text: "搜索其它" },
], "T");
eq("U-690", "type=button 只返回 button",
  JSON.stringify(Search.search("搜索", { type: "button", limit: 100 }).results.map((r) => r.elementId)),
  JSON.stringify([1]));
eq("U-691", "type=link 只返回 link",
  JSON.stringify(Search.search("搜索", { type: "link", limit: 100 }).results.map((r) => r.elementId)),
  JSON.stringify([2]));
eq("U-692", "type=input 只返回 input",
  JSON.stringify(Search.search("搜索", { type: "input", limit: 100 }).results.map((r) => r.elementId)),
  JSON.stringify([3]));
eq("U-693", "type=other 只返回 other",
  JSON.stringify(Search.search("搜索", { type: "other", limit: 100 }).results.map((r) => r.elementId)),
  JSON.stringify([4]));
eq("U-694", "type=all 返回全部",
  Search.search("搜索", { type: "all", limit: 100 }).total, 4);
eq("U-695", "空 query + type 过滤",
  JSON.stringify(Search.search("", { type: "link", limit: 100 }).results.map((r) => r.elementId)),
  JSON.stringify([2]));

/* query normalization reaches matching */
Search.buildIndex([{ elementId: 1, tag: "button", text: "AI应用工程师" }], "T");
eq("U-700", "查询大小写不敏感", Search.search("AI").total, 1);
eq("U-701", "查询前后空白被忽略", Search.search("   AI   ").total, 1);
eq("U-702", "查询中的全角空格被忽略", Search.search("AI　应用").total, 1);
eq("U-703", "返回的 normalizedQuery 是规范化后的查询",
  Search.search("  AI  ").normalizedQuery, "ai");
eq("U-704", "返回的 query 是原始查询（不修改调用方输入）",
  Search.search("  AI  ").query, "  AI  ");
eq("U-705", "非字符串 query（数字）被安全处理",
  typeof Search.search(123).ok, "boolean");
eq("U-706", "null query 按空 query 处理", Search.search(null).total, 1);

/* ==================================================================== */
/* performance (in-process, real shipped code)                           */
/* ==================================================================== */
const perf = [];
for (const n of [100, 500, 1000, 5000]) {
  const big = Array.from({ length: n }, (_, i) => ({
    elementId: i + 1, tag: "button", className: `row row-${i % 10}`,
    text: `元素 ${i} 项目名称`, ariaLabel: `item ${i}`
  }));
  let t0 = process.hrtime.bigint();
  const size = Search.buildIndex(big, "T");
  let buildMs = Number(process.hrtime.bigint() - t0) / 1e6;

  t0 = process.hrtime.bigint();
  const hit = Search.search("元素 4999", { limit: 100 });
  let searchMs = Number(process.hrtime.bigint() - t0) / 1e6;

  t0 = process.hrtime.bigint();
  const miss = Search.search("绝不存在zzz", { limit: 100 });
  let missMs = Number(process.hrtime.bigint() - t0) / 1e6;

  perf.push({ n, size, buildMs: +buildMs.toFixed(1), searchMs: +searchMs.toFixed(1),
              missMs: +missMs.toFixed(1), total: hit.total });
  eq(`U-8xx-${n}`, `buildIndex(${n}) 建立 ${n} 条`, size, n);
  check(`U-8xy-${n}`, `buildIndex(${n}) < 2000ms`, buildMs < 2000, `${buildMs.toFixed(1)}ms`);
  check(`U-8xz-${n}`, `search(${n}) < 500ms`, searchMs < 500, `${searchMs.toFixed(1)}ms`);
}
console.log("\nperf: " + JSON.stringify(perf));

fs.writeFileSync(
  path.resolve(__dirname, "..", "evidence-v2-independent", "search-performance-unit.json"),
  JSON.stringify(perf, null, 2));
eq("U-880", "5000 元素下命中数为 1", perf[3].total, 1);

/* ==================================================================== */
/* constants hygiene                                                     */
/* ==================================================================== */
eq("U-900", "SEARCH_FIELDS 覆盖规格要求的字段",
  JSON.stringify(PS.SEARCH_FIELDS),
  JSON.stringify(["text", "value", "placeholder", "ariaLabel", "title", "alt",
    "tag", "role", "id", "className", "href"]));
eq("U-901", "每个 SEARCH_FIELD 都有权重", PS.SEARCH_FIELDS.every((f) => PS.SEARCH_SCORES[f]), true);
eq("U-902", "SEARCH_DEFAULT_LIMIT = 20", PS.SEARCH_DEFAULT_LIMIT, 20);
eq("U-903", "SEARCH_MAX_LIMIT = 100", PS.SEARCH_MAX_LIMIT, 100);
eq("U-904", "BRIDGE 只允许回环 host",
  JSON.stringify(PS.BRIDGE.ALLOWED_HOSTS), JSON.stringify(["127.0.0.1", "localhost"]));
eq("U-905", "重连退避有上限且非紧密循环",
  PS.BRIDGE.RECONNECT_DELAYS_MS[PS.BRIDGE.RECONNECT_DELAYS_MS.length - 1] >= 10000, true);
eq("U-906", "SUPPORTED_KEYS 只包含白名单按键",
  JSON.stringify(Object.keys(PS.SUPPORTED_KEYS).sort()),
  JSON.stringify([" ", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp",
    "Backspace", "Delete", "Enter", "Escape", "Tab"].sort()));
eq("U-907", "KEY_ALIASES 把 Space 映射到 \" \"", PS.KEY_ALIASES.Space, " ");
eq("U-908", "MAX_SCROLL_AMOUNT = 5000", PS.MAX_SCROLL_AMOUNT, 5000);
eq("U-909", "MAX_TEXT_LENGTH = 300", PS.MAX_TEXT_LENGTH, 300);
eq("U-910", "REQUEST_LOG_LIMIT = 20", PS.BRIDGE.REQUEST_LOG_LIMIT, 20);
eq("U-911", "METHOD_TO_ACTION 不包含 PING/GET_STATUS（由 SW 直接回答）",
  !PS.METHOD_TO_ACTION.PING && !PS.METHOD_TO_ACTION.GET_STATUS, true);
eq("U-912", "METHODS 与 METHOD_TO_ACTION + PING/GET_STATUS 一致",
  JSON.stringify(Object.keys(PS.METHODS).sort()),
  JSON.stringify(Object.keys(PS.METHOD_TO_ACTION).concat(["PING", "GET_STATUS"]).sort()));
eq("U-913", "sanitizeFilePart 过滤 Windows 非法字符",
  PS.sanitizeFilePart('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
eq("U-914", "sanitizeFilePart 折叠连续下划线",
  PS.sanitizeFilePart("a   b"), "a_b");
eq("U-915", "sanitizeFilePart 截断到 80 字符",
  PS.sanitizeFilePart("x".repeat(200)).length, 80);
eq("U-916", "OVERLAY_ATTR 具名空间", PS.OVERLAY_ATTR, "data-pagesense-overlay");
eq("U-917", "RESTRICTED_SCHEMES 覆盖 edge:/chrome:",
  ["edge:", "chrome:", "about:", "devtools:", "view-source:"]
    .every((s) => PS.RESTRICTED_SCHEMES.includes(s)), true);

/* ==================================================================== */
console.log(`\nINDEP UNIT SUMMARY: ${pass} PASS / ${failures.length} FAIL (${pass + failures.length} total)`);
if (failures.length) console.log("FAILED: " + failures.join(", "));
process.exit(failures.length ? 1 : 0);
