/* demo.html, README and CSS content acceptance (sections 7, 24, 27). */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "pagesense");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}

/* ---- demo.html completeness ---- */
const demo = read("test/demo.html");
const demoChecks = [
  ["D01", "普通链接", /<a\s+[^>]*href="https?:\/\/[^"]*"/.test(demo)],
  ["D02", "普通按钮", /<button[^>]*class="primary"[^>]*>\s*立即沟通/.test(demo)],
  ["D03", "disabled button", /<button[^>]*disabled/.test(demo)],
  ["D04", "input", /<input[^>]*placeholder/.test(demo)],
  ["D05", "textarea", /<textarea/.test(demo)],
  ["D06", "select + option", /<select[\s\S]*<option/.test(demo)],
  ["D07", "contenteditable", /contenteditable="true"/.test(demo)],
  ["D08", "ARIA button", /<button[^>]*aria-label="关闭弹窗"/.test(demo)],
  ["D09", "display:none", /display:\s*none/.test(demo)],
  ["D10", "visibility:hidden", /visibility:\s*hidden/.test(demo)],
  ["D11", "opacity:0", /opacity:\s*0/.test(demo)],
  ["D12", "长页面 spacer", /height:\s*1200px/.test(demo)],
  ["D13", "页面底部按钮", /id="bottomButton"/.test(demo)],
  ["D14", "hidden 属性场景", /\shidden>/.test(demo) || /\shidden\s*>/.test(demo)],
  ["D15", "动态目标按钮", /id="dynamicTarget"/.test(demo) && /动态目标按钮/.test(demo)],
  ["D16", "删除/恢复目标按钮", /id="deleteTargetBtn"/.test(demo) && /id="restoreTargetBtn"/.test(demo)],
  ["D17", "动态新增按钮", /id="addElementBtn"/.test(demo) && /id="addedContainer"/.test(demo)]
];
for (const [id, name, cond] of demoChecks) check(id, "demo: " + name, cond);

/* ---- README completeness ---- */
const r = read("README.md");
const readmeChecks = [
  ["R01", "说明项目是什么", /PageSense/.test(r) && /DOM/.test(r)],
  ["R02", "Chrome 加载方式", /chrome:\/\/extensions/.test(r)],
  ["R03", "Edge 加载方式", /edge:\/\/extensions/.test(r)],
  ["R04", "如何扫描页面", /扫描当前页面/.test(r)],
  ["R05", "demo 测试说明", /demo\.html/.test(r)],
  ["R06", "当前能力", /当前能力/.test(r)],
  ["R07", "限制: 内部页面", /浏览器内部页面/.test(r)],
  ["R08", "限制: iframe", /iframe/.test(r)],
  ["R09", "限制: Shadow DOM", /Shadow DOM/.test(r)],
  ["R10", "限制: Canvas", /Canvas/.test(r)],
  ["R11", "限制: 虚拟列表", /虚拟列表/.test(r)],
  ["R12", "限制: 动态页面快照", /快照/.test(r)],
  ["R13", "安全边界说明", /安全边界/.test(r)]
];
for (const [id, name, cond] of readmeChecks) check(id, name, cond);

/* README claims match the shipped manifest */
const manifest = JSON.parse(read("manifest.json"));
// V2.0: every declared permission must be documented, and the new
// host_permissions must be justified rather than silently added.
check("R14", "README 描述的权限与 manifest 一致且 host_permissions 有说明",
  manifest.permissions.every((p) => new RegExp(`\\b${p}\\b`).test(r)) &&
  /host_permissions/.test(r) &&
  /为什么必要|用途/.test(r));
check("R15", "README 明确声明 V2 不具备自动操作 / LLM / Agent 能力",
  /不包含 LLM/.test(r) && /明确未实现/.test(r) &&
  /自动任务/.test(r) && /Action Queue/.test(r));
check("R16", "README 写明 V1.1 Mapping/定位/高亮",
  /data-pagesense-id/.test(r) && /LOCATE_ELEMENT/.test(r) && /HIGHLIGHT_ELEMENT/.test(r));
check("R17", "README 写明 elementId 生命周期（非永久 ID）",
  /不是永久 ID/.test(r) && /最近一次.*扫描/.test(r));
check("R18", "README 写明侧栏关闭后高亮继续存在",
  /侧栏关闭后高亮继续存在/.test(r));
check("R19", "README 项目结构含新模块",
  /element-map\.js/.test(r) && /highlighter\.js/.test(r));

/* ---- CSS reachability ---- */
const css = read("popup/popup.css");
check("C01", "侧栏宽度随浏览器调整",
  /width:\s*100%/.test(css) && !/width:\s*600px/.test(css));
check("C02", "侧栏填满高度，主体区域可滚动",
  /\.app-main[\s\S]*overflow-y:\s*auto/.test(css) &&
  /height:\s*100%/.test(css) && /min-height:\s*0/.test(css));
check("C03", "关键按钮未被隐藏",
  !/#scanBtn\s*\{[^}]*display:\s*none/.test(css) &&
  !/\.app-footer\s*\{[^}]*display:\s*none/.test(css));
check("C04", ".hidden 工具类存在",
  /\.hidden\s*\{[\s\S]*display:\s*none/.test(css));

console.log(`\nCONTENT/DOCS SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
