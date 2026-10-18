/* Static acceptance checks for PageSense. */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "pagesense");
let failures = 0;
function check(id, name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${id} ${name}` + (cond ? "" : `  -> ${detail || ""}`));
  if (!cond) failures++;
}
function read(f) { return fs.readFileSync(path.join(ROOT, f), "utf8"); }
function exists(f) { return fs.existsSync(path.join(ROOT, f)); }

/* T01 manifest exists & parses */
let manifest = null;
try {
  manifest = JSON.parse(read("manifest.json"));
  check("T01", "manifest.json 存在且可解析", true);
} catch (e) {
  check("T01", "manifest.json 存在且可解析", false, e.message);
}

if (manifest) {
  check("T02", "manifest_version === 3", manifest.manifest_version === 3, "got " + manifest.manifest_version);
  check("T03", "name/version 合法",
    typeof manifest.name === "string" && manifest.name.length > 0 &&
    /^\d+\.\d+\.\d+$/.test(manifest.version), JSON.stringify({ n: manifest.name, v: manifest.version }));
  check("T04", "原生侧栏指向界面，工具栏不再使用临时弹窗",
    manifest.side_panel && manifest.side_panel.default_path === "popup/popup.html" &&
    manifest.action && !manifest.action.default_popup);
  // V2.0 adds "storage" (bridge host/port/token must survive Service Worker
  // restarts) and host_permissions (the Controller injects without a user
  // gesture, which activeTab alone cannot authorise).
  check("T05", "permissions 最小化 (activeTab, scripting, storage, sidePanel)",
    JSON.stringify(manifest.permissions.slice().sort()) ===
      JSON.stringify(["activeTab", "scripting", "storage", "sidePanel"].sort()),
    JSON.stringify(manifest.permissions));
  const highRisk = ["history", "cookies", "webRequest", "webRequestBlocking",
    "management", "debugger", "tabs", "downloads", "browsingData", "privacy"];
  const bad = (manifest.permissions || []).filter((p) => highRisk.includes(p));
  check("T06", "无高风险权限", bad.length === 0, bad.join(","));
  check("T07", "无 MV2 配置 (browser_action/background.scripts)",
    !manifest.browser_action && !(manifest.background && manifest.background.scripts),
    JSON.stringify(manifest.browser_action || manifest.background));
  check("T08", "无静态 content_scripts（按需注入设计）", !manifest.content_scripts,
    JSON.stringify(manifest.content_scripts));

  /* manifest referenced files exist */
  const refs = [manifest.side_panel.default_path, manifest.background.service_worker];
  Object.values(manifest.icons || {}).forEach((v) => refs.push(v));
  const missing = refs.filter((r) => !exists(r));
  check("T09", "manifest 引用文件全部存在", missing.length === 0, missing.join(","));
}

/* T10 required files exist */
const required = [
  "popup/popup.html", "popup/popup.css", "popup/popup.js",
  "content/content.js", "content/scanner.js",
  "content/element-map.js", "content/highlighter.js",
  "content/action-executor.js", "content/element-search.js",
  "shared/constants.js", "test/demo.html", "README.md",
  "background/service-worker.js", "bridge/controller-bridge.js"
];
const missReq = required.filter((r) => !exists(r));
check("T10", "要求的全部文件存在", missReq.length === 0, missReq.join(","));

/* T11 HTML references exist */
const html = read("popup/popup.html");
const htmlRefs = ["popup.css", "popup.js", "../shared/constants.js", "../icons/icon-32.png"];
const missHtml = htmlRefs.filter((r) => !exists(path.join("popup", r)));
check("T11", "popup.html 引用的 CSS/JS/图片存在", missHtml.length === 0, missHtml.join(","));

/* T12 every getElementById in popup.js exists in popup.html */
const popupJs = read("popup/popup.js");
const idRefs = Array.from(popupJs.matchAll(/getElementById\("([^"]+)"\)/g)).map((m) => m[1]);
const htmlIds = Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]);
const missingIds = Array.from(new Set(idRefs)).filter((id) => !htmlIds.includes(id));
check("T12", "popup.js 引用的 DOM ID 全部存在于 popup.html", missingIds.length === 0,
  missingIds.join(","));

/* T13 executeScript files exist (derived from CONTENT_FILES in popup.js) */
const cfMatch = popupJs.match(/var CONTENT_FILES\s*=\s*\[([\s\S]*?)\]/);
let injected = [];
if (cfMatch) {
  injected = Array.from(cfMatch[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
}
const missInj = injected.filter((f) => !exists(f));
check("T13", "popup.js 注入的脚本文件全部存在", cfMatch && missInj.length === 0,
  cfMatch ? missInj.join(",") : "CONTENT_FILES not found");

/* Injection order: constants before element-map before scanner
 * before highlighter before action-executor before picker before content */
const expectedOrder = ["shared/constants.js", "content/element-map.js",
  "content/scanner.js", "content/element-search.js", "content/highlighter.js",
  "content/action-executor.js", "content/element-picker.js", "content/content.js"];
check("T13b", "注入顺序正确（依赖在前）",
  JSON.stringify(injected) === JSON.stringify(expectedOrder), injected.join(","));

/* T14 genericity / no site hardcoding & no anti-detection */
const allJs = ["content/scanner.js", "content/content.js", "content/element-map.js",
  "content/highlighter.js", "content/action-executor.js",
  "content/element-search.js", "content/element-picker.js", "shared/constants.js", "popup/popup.js",
  "bridge/controller-bridge.js", "background/service-worker.js"]
  .map(read).join("\n");
const forbidden = [
  /bosszhipin/i, /zhipin/i, /job-card/i, /boss-job/i,
  /navigator\.webdriver\s*=/, /webdriver\s*=\s*false/,
  /cdc_adoQpoasnfa76/, /__nightmare/, /_phantom/,
  /fingerprint/i, /devtools.*detect/i
];
const hits = forbidden.filter((re) => re.test(allJs));
check("T14", "无网站硬编码/反检测代码", hits.length === 0, hits.map((h) => h.toString()).join(";"));

/* ---- V1.1 static checks ---- */
const constantsSrc = read("shared/constants.js");
check("T15", "constants 定义 LOCATE/HIGHLIGHT/CLEAR Action",
  /LOCATE_ELEMENT:\s*"PAGESENSE_LOCATE_ELEMENT"/.test(constantsSrc) &&
  /HIGHLIGHT_ELEMENT:\s*"PAGESENSE_HIGHLIGHT_ELEMENT"/.test(constantsSrc) &&
  /CLEAR_HIGHLIGHT:\s*"PAGESENSE_CLEAR_HIGHLIGHT"/.test(constantsSrc));
check("T16", "constants 集中管理映射属性名与 Overlay 标识",
  /PAGE_SENSE_ID_ATTR\s*=\s*"data-pagesense-id"/.test(constantsSrc) &&
  /OVERLAY_ATTR\s*=\s*"data-pagesense-overlay"/.test(constantsSrc));

/* The literal attribute name must not be scattered: only constants.js
 * defines it; other files reference it via the constant. */
const scattered = ["content/scanner.js", "content/content.js",
  "content/highlighter.js", "popup/popup.js"]
  .filter((f) => /data-pagesense-id/.test(read(f)));
check("T17", "data-pagesense-id 字符串未散落在其他文件", scattered.length === 0,
  scattered.join(","));

const highlighterSrc = read("content/highlighter.js");
check("T18", "Overlay pointer-events:none（不拦截页面交互）",
  /pointerEvents:\s*"none"/.test(highlighterSrc));
check("T19", "Overlay 使用最大 z-index",
  /zIndex:\s*"2147483647"/.test(highlighterSrc));
check("T20", "scroll/resize 经 requestAnimationFrame 节流",
  /requestAnimationFrame/.test(highlighterSrc) &&
  /addEventListener\("scroll"/.test(highlighterSrc) &&
  /addEventListener\("resize"/.test(highlighterSrc));
check("T21", "元素删除检测使用 isConnected",
  /isConnected/.test(highlighterSrc));
check("T22", "失效返回 ELEMENT_NOT_FOUND 且不猜测同名元素",
  /ELEMENT_NOT_FOUND/.test(highlighterSrc) &&
  !/querySelectorAll\([^)]*tagName/.test(highlighterSrc));

/* Popup uses event delegation with data attributes */
check("T23", "Popup 卡片按钮使用 data-card-action 事件委托",
  /data-card-action/.test(popupJs) &&
  /addEventListener\("click",\s*handleElementAction\)/.test(popupJs));
check("T24", "Popup 存在取消高亮入口",
  /clearHighlightBtn/.test(html) && /CLEAR_HIGHLIGHT/.test(popupJs));

/* ---- V1.2 Action Layer static checks ---- */
const actionSrc = read("content/action-executor.js");
check("T25", "constants 定义 V1.2 五个 Action",
  /CLICK_ELEMENT:\s*"PAGESENSE_CLICK_ELEMENT"/.test(constantsSrc) &&
  /INPUT_ELEMENT:\s*"PAGESENSE_INPUT_ELEMENT"/.test(constantsSrc) &&
  /CLEAR_ELEMENT:\s*"PAGESENSE_CLEAR_ELEMENT"/.test(constantsSrc) &&
  /KEYPRESS_ELEMENT:\s*"PAGESENSE_KEYPRESS_ELEMENT"/.test(constantsSrc) &&
  /SCROLL_PAGE:\s*"PAGESENSE_SCROLL_PAGE"/.test(constantsSrc));
check("T26", "ERROR_CODES 扩展 V1.2 错误码",
  ["ELEMENT_NOT_INTERACTABLE", "ELEMENT_DISABLED", "UNSUPPORTED_ELEMENT",
    "INVALID_VALUE", "INVALID_KEY", "ACTION_FAILED"]
    .every((c) => new RegExp(c + ':').test(constantsSrc)));
check("T27", "KEYPRESS 按键白名单 SUPPORTED_KEYS",
  /SUPPORTED_KEYS\s*=/.test(constantsSrc) && /INVALID_KEY/.test(actionSrc));
check("T28", "CLICK 使用 element.click()，无坐标/CDP 模拟",
  /element\.click\(\)/.test(actionSrc) &&
  !/Input\.dispatchMouseEvent|dispatchMouseEvent|mouseMoved|dispatchKeyEvent/.test(actionSrc));
check("T29", "INPUT 使用原生 value setter 并触发 input/change",
  /getOwnPropertyDescriptor\(proto,\s*"value"\)/.test(actionSrc) &&
  /"input",\s*"change"/.test(actionSrc));
check("T30", "无 Action Queue/批量执行入口",
  !/actionQueue|runBatch|forEach.*execute|Promise\.all\(.*actions/i.test(actionSrc + popupJs));
check("T31", "SCROLL amount 安全校验（0 < amount <= 5000）",
  /MAX_SCROLL_AMOUNT/.test(constantsSrc) &&
  /num <= 0|num > PS\.MAX_SCROLL_AMOUNT/.test(actionSrc));
check("T32", "Popup 存在全局滚动控制与 Action Log",
  /data-scroll-direction/.test(html) && /actionLogList/.test(html));
check("T33", "Popup 按能力显示 Action（isClickable/isTextEntry）",
  /isClickableElement/.test(popupJs) && /isTextEntryElement/.test(popupJs));
check("T34", "Action 统一返回协议（actionId/timestamp/durationMs）",
  /actionId: makeActionId/.test(actionSrc) &&
  /timestamp: Date\.now\(\)/.test(actionSrc) && /durationMs/.test(actionSrc));

/* ==================================================================
 * V2.0 - Element Search + Controller Bridge
 * ================================================================== */

const bridgeSrc = read("bridge/controller-bridge.js");
const swSrc = read("background/service-worker.js");
const searchSource = read("content/element-search.js");
const contentScriptSrc = read("content/content.js");
const htmlV2 = read("popup/popup.html");
const readme = read("README.md");

/* ---- version consistency ---- */
check("T35", "manifest version = 2.0.0", manifest && manifest.version === "2.0.0",
  manifest && manifest.version);
check("T35b", "Popup 显示 V2.0", /brand-version">V2\.0</.test(htmlV2));
check("T35c", "README 标注 V2.0", /PageSense V2\.0/.test(readme));

/* ---- MV3 background ---- */
check("T36", "MV3 service_worker 正确配置（非 MV2 常驻后台页）",
  manifest && manifest.background &&
  manifest.background.service_worker === "background/service-worker.js" &&
  !manifest.background.persistent && !manifest.background.scripts,
  JSON.stringify(manifest && manifest.background));
check("T36b", "background 引用的 SW 文件存在", exists("background/service-worker.js"));

/* ---- permissions ---- */
check("T37", "host_permissions 仅 http/https（无 file:// 等）",
  manifest && Array.isArray(manifest.host_permissions) &&
  manifest.host_permissions.every((h) => /^https?:\/\//.test(h)),
  JSON.stringify(manifest && manifest.host_permissions));

/* ---- transport layered correctly ---- */
check("T38", "Popup 不建立 WebSocket（长连接必须由 Service Worker 持有）",
  !/new\s+WebSocket/.test(popupJs));
check("T38b", "Service Worker 通过 importScripts 载入 bridge",
  /importScripts\(/.test(swSrc) && /controller-bridge\.js/.test(swSrc));
check("T39", "扩展内不存在 WebSocket 服务端实现（扩展只做 client）",
  !/createServer|\.listen\(|WebSocketServer|ws\.Server/i.test(bridgeSrc + swSrc));
check("T39b", "bridge 使用 WebSocket client 构造",
  /new WebSocket\(/.test(bridgeSrc));

/* ---- security ---- */
check("T40", "默认仅回环地址 127.0.0.1",
  /DEFAULT_HOST:\s*"127\.0\.0\.1"/.test(constantsSrc) &&
  /ALLOWED_HOSTS:\s*\["127\.0\.0\.1",\s*"localhost"\]/.test(constantsSrc));
check("T40b", "源码中不存在 0.0.0.0 绑定", !/0\.0\.0\.0/.test(bridgeSrc + swSrc + popupJs));
// Only the chrome.storage KEY name may be a literal; a token VALUE never is.
const tokenLiterals = Array.from(
  (bridgeSrc + swSrc + constantsSrc)
    .matchAll(/\btoken\b\s*[:=]\s*["']([^"']+)["']/gi)
).map((m) => m[1]).filter((v) => !/^pagesenseBridge/.test(v));
check("T41", "源码中不存在硬编码 token 字面量", tokenLiterals.length === 0,
  tokenLiterals.join(","));
check("T41c", "Controller 侧 token 由 secrets 随机生成",
  /secrets\.token_hex/.test(fs.readFileSync(
    path.join(ROOT, "..", "controller", "server.py"), "utf8")));
check("T41b", "token 仅由用户输入并存入 chrome.storage",
  /BRIDGE_STORAGE_KEYS\.TOKEN/.test(bridgeSrc) &&
  /chrome\.storage\.local\.set/.test(bridgeSrc));

/* ---- reconnect / lifecycle ---- */
check("T42", "指数退避重连（1/2/5/10/30s，上限 30s）",
  /RECONNECT_DELAYS_MS:\s*\[1000,\s*2000,\s*5000,\s*10000,\s*30000\]/.test(constantsSrc));
check("T42b", "重连使用 setTimeout 而非紧循环",
  /scheduleReconnect/.test(bridgeSrc) && /setTimeout/.test(bridgeSrc) &&
  !/while\s*\(\s*true\s*\)/.test(bridgeSrc));
check("T42c", "处理断线/错误/关闭（onclose/onerror/onopen）",
  /onclose/.test(bridgeSrc) && /onerror/.test(bridgeSrc) && /onopen/.test(bridgeSrc));
check("T42d", "心跳维持 MV3 worker 存活",
  /HEARTBEAT/.test(bridgeSrc) && /setInterval/.test(bridgeSrc));

/* ---- Element Search module ---- */
check("T43", "element-search.js 是独立模块（buildIndex/search/clearIndex/getIndexInfo）",
  /buildIndex:/.test(searchSource) && /search:/.test(searchSource) &&
  /clearIndex:/.test(searchSource) && /getIndexInfo:/.test(searchSource));
check("T43b", "搜索基于 Scanner 数据，不重新查询 DOM",
  !/querySelector/.test(searchSource) && !/\bdocument\b/.test(
    searchSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")));
check("T43c", "统一 normalizeSearchText（trim + 折叠空白 + 小写）",
  /normalizeSearchText\s*=\s*function/.test(constantsSrc) &&
  /\[\\s　\]\+/.test(constantsSrc));
check("T43d", "SEARCH_ELEMENTS Action 定义于 constants",
  /SEARCH_ELEMENTS:\s*"PAGESENSE_SEARCH_ELEMENTS"/.test(constantsSrc));
check("T43e", "content.js 处理 SEARCH_ELEMENTS",
  /ACTIONS\.SEARCH_ELEMENTS/.test(contentScriptSrc));

/* ---- search index lifecycle bound to scan ---- */
check("T44", "SCAN_PAGE 后重建索引（索引与最近一次扫描绑定）",
  /buildIndex\(result\.elements,\s*result\.scannedAt\)/.test(contentScriptSrc));
check("T44b", "搜索索引失效时返回 NO_SCAN_DATA",
  /NO_SCAN_DATA/.test(constantsSrc) && /NO_SCAN_DATA/.test(searchSource));

/* ---- bridge reuses the V1.x pipeline (no second action impl) ---- */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const bridgeCode = stripComments(bridgeSrc);
check("T45", "bridge 不直接操作 DOM（无 click()/querySelector/dispatchEvent）",
  !/\.click\(\)/.test(bridgeCode) && !/querySelector/.test(bridgeCode) &&
  !/dispatchEvent/.test(bridgeCode) && !/setAttribute/.test(bridgeCode) &&
  !/\bdocument\b/.test(bridgeCode));
check("T45b", "bridge 通过既有 Content Script Action 执行动作（不建第二套 Action）",
  /(PS\.ACTIONS|A)\.CLICK_ELEMENT/.test(bridgeCode) &&
  /(PS\.ACTIONS|A)\.INPUT_ELEMENT/.test(bridgeCode) &&
  /(PS\.ACTIONS|A)\.KEYPRESS_ELEMENT/.test(bridgeCode) &&
  /chrome\.tabs\.sendMessage/.test(bridgeCode));
check("T45c", "bridge 与 Popup 使用同一份 CONTENT_FILES 依赖顺序",
  (() => {
    const grab = (src) => {
      const m = src.match(/CONTENT_FILES\s*=\s*\[([\s\S]*?)\]/);
      return m ? Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]) : null;
    };
    const a = grab(popupJs), b = grab(bridgeSrc);
    return a && b && JSON.stringify(a) === JSON.stringify(b);
  })());

/* ---- methods ---- */
check("T46", "协议方法集合完整（PING..SCROLL_PAGE）",
  ["PING", "GET_STATUS", "SCAN_PAGE", "SEARCH_ELEMENTS", "LOCATE_ELEMENT",
    "HIGHLIGHT_ELEMENT", "CLEAR_HIGHLIGHT", "CLICK_ELEMENT", "INPUT_ELEMENT",
    "CLEAR_ELEMENT", "KEYPRESS_ELEMENT", "SCROLL_PAGE"]
    .every((m) => new RegExp(`${m}:\\s*"${m}"`).test(constantsSrc)));
check("T46b", "未知方法返回 UNKNOWN_METHOD",
  /UNKNOWN_METHOD/.test(constantsSrc) && /UNKNOWN_METHOD/.test(bridgeSrc));
check("T46c", "请求带唯一 id，响应按 id 关联",
  /id:\s*id,\s*type:\s*TYPES\.RESPONSE/.test(bridgeSrc));

/* ---- no LLM / agent / queue ---- */
const v2Js = bridgeSrc + swSrc + searchSource + popupJs + constantsSrc;
check("T47", "V2 未引入 LLM / Agent / Planner",
  !/openai|deepseek|qwen|ollama|langchain|langgraph|anthropic|gpt-/i.test(v2Js));
check("T47b", "V2 未实现 Action Queue / 批量执行",
  !/actionQueue|runBatch|taskQueue|planner/i.test(v2Js));
check("T47c", "CLI 不做 search-and-click（无自动选第一条点击）",
  (() => {
    const cli = fs.readFileSync(path.join(ROOT, "..", "controller", "cli.py"), "utf8");
    return !/results\[0\]/.test(cli) && !/auto_?click/i.test(cli);
  })());

/* ---- controller package ---- */
const controllerFiles = ["requirements.txt", "server.py", "protocol.py",
  "pagesense.py", "cli.py", "README.md"];
const missingController = controllerFiles.filter(
  (f) => !fs.existsSync(path.join(ROOT, "..", "controller", f)));
check("T48", "controller/ 包文件齐全（无大型后端依赖）", missingController.length === 0,
  missingController.join(","));
check("T48b", "Controller 仅依赖 websockets",
  (() => {
    const req = fs.readFileSync(path.join(ROOT, "..", "controller", "requirements.txt"), "utf8");
    return !/django|fastapi|flask|redis|celery|sqlalchemy|torch|openai/i.test(req);
  })());

console.log(`\nSTATIC CHECK SUMMARY: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
