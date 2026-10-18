/* PageSense V2.0 Element Search unit tests.
 * Loads the real shared/constants.js + content/element-search.js into a jsdom
 * sandbox and exercises them with synthetic scan results (no DOM scanning).
 * Covers: field coverage, Chinese, case folding, multi-keyword AND, ranking,
 * empty query, no results, limit clamping, index lifecycle and performance. */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "pagesense");
const readSrc = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}
function eq(id, name, actual, expected) {
  check(id, name, actual === expected, `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "https://fixture.test/", runScripts: "outside-only"
});
const world = dom.window;
world.eval(readSrc("shared/constants.js"));
world.eval(readSrc("content/element-search.js"));

const PS = world.PAGESENSE;
const Search = world.PageSenseElementSearch;

/** Build a serialized element the way scanner.js does. */
function el(elementId, overrides) {
  const base = {
    elementId,
    tag: "div",
    text: "",
    id: null,
    className: null,
    name: null,
    type: null,
    role: null,
    href: null,
    placeholder: null,
    ariaLabel: null,
    title: null,
    alt: null,
    value: "",
    visible: true,
    inViewport: true
  };
  return Object.assign(base, overrides || {});
}

function index(elements) {
  Search.clearIndex();
  Search.buildIndex(elements, "2026-01-01T00:00:00.000Z");
}
function run(query, options) {
  return Search.search(query, options || {});
}

/* ---- 1. normalization ------------------------------------------------- */

eq("S01a", "normalizeSearchText 折叠连续空格并小写",
  PS.normalizeSearchText("  AI   工程师 "), "ai 工程师");
eq("S01b", "normalizeSearchText 处理全角空格",
  PS.normalizeSearchText("立即　沟通"), "立即 沟通");
eq("S01c", "normalizeSearchText 中文不被破坏",
  PS.normalizeSearchText("立即沟通"), "立即沟通");
eq("S01d", "normalizeSearchText null 安全", PS.normalizeSearchText(null), "");
eq("S01e", "tokenize 空查询 -> []", PS.tokenizeSearchQuery("   ").length, 0);

/* ---- 2. Chinese text matching ----------------------------------------- */

index([
  el(1, { tag: "button", text: "立即沟通" }),
  el(2, { tag: "button", text: "继续沟通" }),
  el(3, { tag: "a", text: "沟通记录" }),
  el(4, { tag: "button", text: "不相关" })
]);

let r = run("立即沟通");
eq("S02a", "中文精确匹配 text -> score 100, matchedFields=[text]",
  r.results[0].score + "|" + r.results[0].matchedFields.join(","), "100|text");
eq("S02b", "中文精确匹配 elementId 正确", r.results[0].elementId, 1);
eq("S02c", "中文精确匹配 element 摘要字段完整",
  ["tag", "text", "role", "visible", "inViewport"]
    .every((k) => k in r.results[0].element) ? 1 : 0, 1);

r = run("沟通");
eq("S03a", "中文包含匹配 -> 3 条命中", r.total, 3);
const hitById = (result, id) => result.results.filter((x) => x.elementId === id)[0];
eq("S03b", "中文 contains 命中 score=60（立即沟通 / 继续沟通）",
  hitById(r, 1).score + "|" + hitById(r, 2).score, "60|60");
eq("S03c", "中文 startsWith 命中 score=80（沟通记录）", hitById(r, 3).score, 80);
eq("S03d", "中文全部命中 and matchedFields=text",
  r.results.every((x) => x.matchedFields.join(",") === "text") ? 1 : 0, 1);

/* Tie-break on equal scores must fall back to DOM order (elementId asc). */
index([
  el(5, { tag: "button", text: "立即沟通" }),
  el(2, { tag: "button", text: "继续沟通" }),
  el(9, { tag: "button", text: "记录沟通" })
]);
eq("S03e", "同分时按 elementId 升序（DOM 顺序）稳定",
  run("沟通").results.map((x) => x.elementId).join(","), "2,5,9");

/* ---- 3. English + case folding ---------------------------------------- */

index([
  el(10, { tag: "a", text: "Search Jobs" }),
  el(11, { tag: "a", text: "Browse" })
]);
eq("S04a", "英文大小写不敏感（小写查询命中大写文本）", run("search").total, 1);
// "SEARCH JOBS" is two keywords: "search" (prefix, 80) + "jobs" (contains, 60).
eq("S04b", "英文大小写不敏感（全大写多词查询命中）", run("SEARCH JOBS").results[0].score, 140);
eq("S04c", "英文前缀匹配 score=80", run("sear").results[0].score, 80);
eq("S04d", "英文包含匹配 score=60", run("jobs").results[0].score, 60);
eq("S04e", "英文大小写不敏感（混合大小写）", run("SeArCh").total, 1);

index([el(12, { tag: "button", text: "Jobs" })]);
eq("S04f", "英文精确匹配 score=100", run("jobs").results[0].score, 100);

/* ---- 4. multi-keyword AND --------------------------------------------- */

index([
  el(20, { tag: "a", text: "AI应用工程师" }),
  el(21, { tag: "a", text: "AI产品经理" }),
  el(22, { tag: "a", text: "Java工程师" })
]);
r = run("AI 工程师");
eq("S05a", "多关键词 AND：两个词都命中才返回", r.total, 1);
eq("S05b", "多关键词命中 AI应用工程师", r.results[0].elementId, 20);
check("S05c", "多关键词分数为各词分数之和（80+60）", r.results[0].score >= 140,
  "score=" + r.results[0].score);
eq("S05d", "多关键词需要全部命中（缺少一个词则不返回）", run("AI 不存在的词").total, 0);
eq("S05e", "多关键词关键词列表已归一化", r.keywords.join("|"), "ai|工程师");

/* ---- 5. field coverage ------------------------------------------------ */

index([
  el(30, { tag: "input", text: "", placeholder: "搜索职位、公司" }),
  el(31, { tag: "button", text: "", ariaLabel: "关闭弹窗" }),
  el(32, { tag: "a", text: "", title: "点击查看详情" }),
  el(33, { tag: "input", text: "", id: "jobInput" }),
  el(34, { tag: "button", text: "", className: "btn-primary" }),
  el(35, { tag: "button", text: "" }),
  el(36, { tag: "div", text: "", role: "button" }),
  el(37, { tag: "a", text: "", href: "https://example.com/py-jobs" })
]);

eq("S06a", "placeholder 命中", run("搜索职位").results[0].elementId, 30);
eq("S06b", "placeholder 前缀匹配 score=40", run("搜索职位").results[0].score, 40);
eq("S06c", "placeholder 精确匹配 score=50", run("搜索职位、公司").results[0].score, 50);
eq("S06d", "aria-label 命中", run("关闭弹窗").results[0].matchedFields.join(","), "ariaLabel");
eq("S06e", "aria-label 精确 score=55", run("关闭弹窗").results[0].score, 55);
eq("S06f", "title 命中", run("点击查看详情").results[0].matchedFields.join(","), "title");
eq("S06g", "id 精确匹配 score=45", run("jobInput").results[0].score, 45);
eq("S06h", "className 包含匹配 score=20", run("primary").results[0].score, 20);
const buttonHits = run("button").results;
const byId = (id) => buttonHits.filter((x) => x.elementId === id)[0];
eq("S06i", "tag 精确匹配命中全部 <button>（31/34/35 及 role=button 的 36）",
  buttonHits.map((x) => x.elementId).sort((a, b) => a - b).join(","), "31,34,35,36");
eq("S06j", "tag 精确匹配 score=35", byId(31).score, 35);
eq("S06k", "role 精确匹配（role=button 的 div）score=40 且排在 tag 命中之前",
  byId(36).score + "|" + (buttonHits[0].elementId === 36 ? 1 : 0), "40|1");
eq("S06l", "href 可被文本匹配", run("py-jobs").total, 1);
eq("S06m", "href 单字符关键词不参与匹配（避免命中所有链接）",
  run("p").results.filter((x) => x.elementId === 37).length, 0);

/* ---- 6. ranking -------------------------------------------------------- */

index([
  el(40, { tag: "button", text: "搜索职位" }),     // exact text  -> 100
  el(41, { tag: "button", text: "搜索职位、公司" }), // prefix text -> 80
  el(42, { tag: "button", text: "高级搜索职位" }),   // contains    -> 60
  el(43, { tag: "input", text: "", placeholder: "搜索职位" }) // placeholder exact -> 50
]);
r = run("搜索职位");
eq("S07a", "排序：exact > prefix > contains > placeholder",
  r.results.map((x) => x.elementId).join(","), "40,41,42,43");
check("S07b", "分数单调递减",
  r.results.every((x, i) => i === 0 || r.results[i - 1].score >= x.score),
  r.results.map((x) => x.score).join(","));
check("S07c", "更贴近用户目标的 exact 结果排在最前", r.results[0].elementId === 40);

/* ---- 7. empty query ---------------------------------------------------- */

index([el(50, { tag: "a", text: "A" }), el(51, { tag: "button", text: "B" })]);
r = run("");
eq("S08a", "空 query 返回全部元素（不报错）", r.total, 2);
eq("S08b", "空 query score=0", r.results[0].score, 0);
eq("S08c", "空 query matchedFields 为空数组", r.results[0].matchedFields.length, 0);
eq("S08d", "空 query 保持 DOM 顺序",
  r.results.map((x) => x.elementId).join(","), "50,51");
eq("S08e", "仅空格的 query 等同空 query", run("    ").total, 2);

/* ---- 8. no results ----------------------------------------------------- */

eq("S09a", "无结果返回 total=0 且结果为空数组", run("绝对不存在的词xyz").total, 0);
eq("S09b", "无结果 results 长度为 0", run("绝对不存在的词xyz").results.length, 0);

/* ---- 9. limit ---------------------------------------------------------- */

const many = [];
for (let i = 1; i <= 150; i++) {
  many.push(el(i, { tag: "button", text: "搜索按钮 " + i }));
}
index(many);
eq("S10a", "默认 limit = 20", run("搜索").results.length, 20);
eq("S10b", "total 仍然报告全部命中数", run("搜索").total, 150);
eq("S10c", "truncated 标记为 true", run("搜索").truncated, true);
eq("S10d", "显式 limit 生效", run("搜索", { limit: 5 }).results.length, 5);
eq("S10e", "limit 上限 100", run("搜索", { limit: 9999 }).results.length, 100);
eq("S10f", "limit 非法值回退默认 20", run("搜索", { limit: "abc" }).results.length, 20);
eq("S10g", "limit < 1 被夹取为 1", run("搜索", { limit: 0 }).results.length, 1);
eq("S10h", "clampSearchLimit 上限", PS.clampSearchLimit(5000), 100);
eq("S10i", "clampSearchLimit 默认", PS.clampSearchLimit(undefined), 20);

/* ---- 10. type filter (Popup chips) ------------------------------------- */

index([
  el(60, { tag: "button", text: "搜索" }),
  el(61, { tag: "a", text: "搜索链接" }),
  el(62, { tag: "input", text: "", placeholder: "搜索框" })
]);
eq("S11a", "query + Button filter (AND)", run("搜索", { type: "button" }).total, 1);
eq("S11b", "query + Link filter (AND)", run("搜索", { type: "link" }).total, 1);
eq("S11c", "query + Input filter (AND)", run("搜索", { type: "input" }).total, 1);
eq("S11d", "query + Other filter (AND)", run("搜索", { type: "other" }).total, 0);
eq("S11e", "无匹配类型时返回 0 而非报错", run("搜索", { type: "other" }).ok, true);
eq("S11f", "空 query + Button filter 返回全部按钮",
  run("", { type: "button" }).total, 1);

/* ---- 11. index lifecycle ----------------------------------------------- */

Search.clearIndex();
r = run("搜索");
eq("S12a", "索引失效后搜索返回 NO_SCAN_DATA", r.ok === false ? r.error.code : "ok", "NO_SCAN_DATA");
eq("S12b", "索引失效时不返回任何结果", r.results === undefined ? 1 : 0, 1);

index([el(70, { tag: "button", text: "旧元素" })]);
eq("S12c", "重建索引后可搜索", run("旧元素").total, 1);
index([el(80, { tag: "button", text: "新元素" })]);
eq("S12d", "重新建索引后旧元素不可再被搜到", run("旧元素").total, 0);
eq("S12e", "重新建索引后新元素可被搜到", run("新元素").total, 1);
eq("S12f", "getIndexInfo 反映索引规模", Search.getIndexInfo().size, 1);

/* ---- 12. search never touches the DOM ---------------------------------- */

const searchSrc = readSrc("content/element-search.js");
// Strip comments first: the word "document." appears in a prose sentence.
const searchCode = searchSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
// (the trailing UMD wrapper legitimately references `window`, so only real
// DOM APIs are asserted absent here)
check("S13a", "element-search.js 不访问 DOM（搜索只基于 Scanner 数据）",
  !/\bdocument\b/.test(searchCode) && !/querySelector/.test(searchCode) &&
  !/getComputedStyle/.test(searchCode) && !/\.body\b/.test(searchCode));
check("S13b", "element-search.js 不建立第二套 DOM 映射",
  !/data-pagesense-id|setAttribute/.test(searchSrc));

/* ---- 13. performance ---------------------------------------------------- */

function perf(n) {
  const list = [];
  for (let i = 1; i <= n; i++) {
    list.push(el(i, {
      tag: i % 3 === 0 ? "a" : "button",
      text: "搜索按钮 职位 沟通 工程师 编号" + i,
      id: "el" + i,
      className: "btn btn-" + (i % 7),
      placeholder: i % 5 === 0 ? "搜索职位、公司" : null
    }));
  }
  Search.clearIndex();
  Search.buildIndex(list, new Date(0).toISOString());

  const buildStart = Date.now();
  Search.buildIndex(list, new Date(0).toISOString());
  const buildMs = Date.now() - buildStart;

  const t0 = Date.now();
  const outcome = run("搜索 工程师", { limit: 100 });
  const ms = Date.now() - t0;
  return { n, buildMs, ms, total: outcome.total, reported: outcome.durationMs };
}

const perfResults = [100, 500, 1000].map(perf);
console.log("\n  search performance:");
let perfOk = true;
perfResults.forEach((p) => {
  console.log(`    ${String(p.n).padStart(4)} elements  build=${p.buildMs}ms  search=${p.ms}ms  hits=${p.total}`);
  if (p.ms > 250) perfOk = false;
});
check("S14a", "100/500/1000 元素下搜索不卡顿（单次 < 250ms）", perfOk,
  perfResults.map((p) => `${p.n}:${p.ms}ms`).join(" "));
check("S14b", "搜索结果返回 durationMs 指标",
  perfResults.every((p) => typeof p.reported === "number"));
eq("S14c", "1000 元素全部命中多关键词查询", perfResults[2].total, 1000);

console.log(`\nV2 SEARCH UNIT SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
