# PageSense V2.0 Independent Acceptance Report

测试类型：独立最终验收（Independent Final Acceptance）
测试对象：PageSense V2.0
测试结论：**FAIL**
测试日期：2026-09-29
项目路径：`C:\Users\YK\Desktop\csss`
Extension Version：`2.0.0`（manifest_version 3）
Python Version：3.14.6
Node Version：v24.18.0
Edge Version：154.0.4258.37

> 本报告中的每一个数字都来自本次独立重新执行的测试。
> 开发阶段报告 `PageSense-V2.0-ACCEPTANCE-REPORT.md` 未被覆盖，其数字（355 PASS / 57 项 E2E / 0 FAIL）**未被引用为本报告的结论**；本报告独立复现了其中 57 项 E2E 并另行新增了 592 项独立检查。

---

## Executive Summary

```
PASS:     1045
FAIL:        2
BLOCKED:    10
MANUAL:      4
SKIP:        1

未解决缺陷（按严重程度）：
P0: 0
P1: 0        （验收中发现 1 个 P1 → BUG-003，已在本次验收内修复并回归）
P2: 1        FINDING-003（断线 >30s 后扩展不自恢复）
P3: 1        FINDING-001（elementId 无页面作用域）

缺陷总计：发现 4（P1×1 + P2×2 + P3×1）；已修复 2（BUG-001、BUG-003）；未解决 2。
另有 1 项文档/语义问题 FINDING-002（不计入严重程度分级）。
```

最终结论：**FAIL**

两个未解决的问题：

1. **FINDING-001（P3）**：`elementId` 没有页面作用域，跨标签页切换后会静默命中另一个页面上的元素（已实测可复现：旧 id 命中了目标页上的一条链接并触发了导航）。它违反「动作必须作用于调用方指定的那个元素」这一 Agent Layer 的核心安全前提，且触发条件（切换标签页）在日常使用中很常见。
2. **FINDING-003（P2）**：Controller 停机超过约 30 s 后，MV3 Service Worker 被浏览器回收，退避重连链随之消失，扩展**不会自行恢复连接**，必须有一次浏览器交互（打开 Popup / 切换标签页）才恢复（实测 3 次复现）。对"长期无人值守对接 Controller"的用法，这是阻塞级的。

详细理由见 §17。

> 注：验收过程中发现的 **BUG-003（P1）**——单帧超过 1 MiB 的响应会切断 WebSocket，导致约 2500 个交互元素以上的页面完全无法通过 Controller 扫描——是本次验收中最重要的发现，已在本次验收内完成根因定位、修复与全量回归（§12 BUG-003）。它不再阻塞。

---

## 1. Environment

| 项目 | 值 | 获取方式 |
|---|---|---|
| Windows | Windows 11 Education 10.0.26200.8875 | `cmd /c ver` |
| Edge | 154.0.4258.37 | `msedge.exe` VersionInfo |
| Chrome | 未安装（本机仅有 Edge） | — |
| Python | 3.14.6 | `python --version` |
| Node | v24.18.0 | `node --version` |
| npm | 11.16.0 | `npm --version` |
| websockets | 17.1 | `websockets.__version__` |
| websocket-client | 1.9.0 | `pip list` |
| puppeteer-core | ^25.12.0 | `acceptance/package.json` |
| jsdom | ^30.1.1 | `acceptance/package.json` |
| Git | 非 Git 仓库 | `git status` → not a repository |

路径：

```
Extension path : C:\Users\YK\Desktop\csss\pagesense
Controller path: C:\Users\YK\Desktop\csss\controller
Acceptance path: C:\Users\YK\Desktop\csss\acceptance
独立验收资产    : C:\Users\YK\Desktop\csss\acceptance\indep
证据           : C:\Users\YK\Desktop\csss\acceptance\evidence-v2-independent
```

扩展 ID（由未打包路径推导）：`fjekeadnlgppeafgmgaipjlkiphlgehe`

---

## 2. Baseline

```
csss/
├── PageSense-V2.0-ACCEPTANCE-REPORT.md          # 开发阶段报告（未改动）
├── PageSense-V2.0-INDEPENDENT-ACCEPTANCE-REPORT.md  # 本报告
├── .edge-profile/                               # 历史 Edge profile（含历史残留进程）
├── acceptance/
│   ├── *.js                                     # 既有测试（本次全部重跑）
│   └── indep/                                   # 本次独立验收新增
│       ├── indep-agent.js                       # 独立浏览器 agent（自行启动 Edge + fixture 服务）
│       ├── indep_unit.js                        # 独立单元测试（199 项）
│       ├── indep_protocol.py                    # 独立协议/安全测试（74 项）
│       ├── indep_e2e.py                         # 独立真实 E2E（258 项）
│       ├── indep_cli.py                         # 独立 CLI 验收（42 项）
│       ├── final_smoke.py                       # 最终 Smoke Test（20 步）
│       ├── run_indep_e2e.sh                     # 一键运行器
│       └── diag_*.py                            # 根因诊断脚本（5 个）
├── controller/
│   ├── server.py  protocol.py  pagesense.py  cli.py
│   └── test_bridge.py  test_cli.py  test_e2e.py
└── pagesense/
    ├── manifest.json
    ├── shared/constants.js
    ├── content/{scanner,element-map,element-search,highlighter,action-executor,content}.js
    ├── bridge/controller-bridge.js
    ├── background/service-worker.js
    ├── popup/{popup.html,popup.css,popup.js}
    ├── test/demo.html
    └── README.md
```

版本与权限基线（实际读取 `manifest.json`）：

```json
{
  "manifest_version": 3,
  "version": "2.0.0",
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "background": { "service_worker": "background/service-worker.js" }
}
```

---

## 3. Static & Architecture Review

| Component | Result | Notes |
|---|---|---|
| Manifest | PASS | MV3；`permissions` 仅 activeTab/scripting/storage，均已核实在代码中使用并被 README 解释。**无** debugger / cookies / webRequest / history / downloads / management / browsingData / privacy。 |
| Scanner | PASS | 可见性判定含 `isConnected`/`hidden`/`<option>` 特例；`stats.matched = total + hidden` 在真实页面上成立；无未捕获异常。 |
| Element Map | PASS | `clearMappings` → `assignId` → `getElementById` 全部收敛在 element-map.js，`data-pagesense-id` 未散落（static-check T17）。**缺陷见 FINDING-001（无页面作用域）。** |
| Element Search | PASS | 纯内存索引、与一次扫描严格绑定；AND 语义、分档打分、limit 夹取、排序 tie-break 全部与 README 一致。 |
| Highlighter | PASS | 只创建自有 overlay（不改页面元素 style，已实测 `style` 属性为空）；`pointer-events:none`；元素删除自动移除；连续高亮不累积。 |
| Action Executor | PASS | 原生 value setter + input/change；disabled/aria-disabled 拒绝；非法 id 不猜测；20×CLICK / 20×INPUT 精确。 |
| Content Router | PASS | 重复注入由 `__PAGESENSE_CONTENT_LOADED__` 保护；一条 SCAN/CLICK 消息只产生一个响应（实测 `perRound=[1]`）。 |
| Controller Bridge | PASS（含 1 处 P3） | 传输层纯净：无 `querySelector`/`element.click()`/`dispatchEvent`。**`indexSize` 字段语义错误（FINDING-002）。** |
| Service Worker | PASS | 无未捕获异常；重载后自动重建连接且不重启浏览器。 |
| Python Controller | PASS（修复 2 个缺陷） | BUG-001 / BUG-003 见 §12。 |
| Protocol | PASS | 信封、id 关联、超时、心跳、单会话语义全部验证。 |
| CLI | PASS | 42 项真实 CLI 验收全过，19 个错误输入不退出。 |

死代码 / 未使用符号：未发现影响运行的问题。语法与引用检查（static-check T01–T48b）72/72 通过。

---

## 4. Existing Test Audit

对既有测试逐一审查「是否存在假 PASS」后重跑。

| 判定 | 测试 | 说明 |
|---|---|---|
| 可信 | `static-check.js` (72) | 断言精确（如 permissions 为排序后全等比较），非恒真。 |
| 可信 | `scanner-unit.js` (32/1 SKIP) | 断言真实字段值；SKIP 项为 jsdom 不实现 `isContentEditable`，已由真实浏览器覆盖，属诚实 SKIP。 |
| 可信 | `highlighter-unit.js` (10)、`action-unit.js` (33) | 断言 DOM 真实状态与错误码。 |
| 可信 | `v2-search-unit.js` (73) | 断言 score/total/truncated/matchedFields 具体值，含性能。 |
| 可信 | `popup-ui.js` (20)、`v2-popup-ui.js` (32) | 断言卡片数量与文本；Popup 与 Content Script 共用同一 search 模块。 |
| 可信但有陈旧风险 | `content-docs-check.js` (40) | 大量正则匹配 README 文案，属「文档存在性」检查，不能证明行为正确。**其中 R14 已在 V2 更新为逐权限比对 + `host_permissions` 说明检查。** 旧的 `content-docs-check.js.log` 已陈旧（记录了 permissions 仅 activeTab/scripting），实际重跑为 40 PASS。 |
| 可信 | `test_bridge.py` (15)、`test_cli.py` (20) | 通过。`test_cli.py` 为纯解析单测（0.002s），不覆盖真实 CLI 会话 —— 本次新增 `indep_cli.py` 补足。 |
| 可信 | `test_e2e.py` (57) | **注意：它不是 unittest 模块**，`python -m unittest test_e2e` 报「Ran 0 tests」（NO TESTS RAN）。必须 `python test_e2e.py`。这不是假 PASS，而是运行方式陷阱，本次记录为测试基础设施问题。以正确方式运行后 57/0。 |
| 可信 | `pipeline-run.js` (8)、`v11-browser.js` (9)、`v12-browser.js` (15)、`browser-layout.js` (17) | 断言真实 DOM 状态（计数器、overlay 数、映射属性）。 |
| **存在问题** | `browser-pipeline.js` | **会临时改写 `pagesense/manifest.json`（把 host_permissions 换成 127.0.0.1）再还原**。本次实测还原正确（diff IDENTICAL），但「测试修改被测物」本身是风险点。且其 E01 在本环境**恒 FAIL**（见 §9 环境限制），**不能**把它当成产品缺陷证据。`browser-pipeline.js.log` 记录 T05「permissions 最小化 (activeTab, scripting)」已与 V2 manifest 不符，该日志陈旧。 |

发现并判定的测试代码问题（详见 §13）：
- `test_e2e.py` 无法通过 `unittest` 发现。
- `browser-pipeline.js` E10 仍断言 shipped manifest 无 `host_permissions` 且 permissions 仅 `["activeTab","scripting"]` —— 与 V2.0 manifest 不符（陈旧断言）。
- `browser-pipeline.js` / `browser-layout.js` 依赖 `puppeteer.launch` + `--load-extension`，在本机 Edge 154 上不生效。

**未发现「永远 true 的 assert」「catch 后不 fail」「mock 替代真实代码」「sleep 后直接 PASS」这类假 PASS。** 既有测试的核心断言普遍读回真实 DOM，质量可接受。

---

## 5. Automated Test Results

### 5.1 既有套件（本次重新执行）

| Suite | PASS | FAIL | BLOCKED | Duration |
|---|---:|---:|---:|---:|
| static-check | 72 | 0 | 0 | 90 ms |
| scanner-unit | 32 | 0 | 0 | 1116 ms |
| highlighter-unit | 10 | 0 | 0 | 898 ms |
| action-unit | 33 | 0 | 0 | 920 ms |
| v2-search-unit | 73 | 0 | 0 | 762 ms |
| content-docs-check | 40 | 0 | 0 | 74 ms |
| popup-ui | 20 | 0 | 0 | 917 ms |
| v2-popup-ui | 32 | 0 | 0 | 1674 ms |
| test_bridge (unittest) | 15 | 0 | 0 | 2359 ms |
| test_cli (unittest) | 20 | 0 | 0 | 244 ms |
| test_e2e.py（真实 E2E，脚本方式） | 57 | 0 | 0 | ~180 s |
| pipeline-run | 8 | 0 | 0 | 4616 ms |
| v11-browser | 9 | 0 | 0 | 12339 ms |
| v12-browser | 15 | 0 | 0 | 1840 ms |
| browser-layout | 17 | 0 | 0 | ~15 s |
| browser-pipeline | 0 | 1 | 10 | 环境阻断（§9） |
| **小计** | **453** | **1** | **10** | |

其中 `scanner-unit` 另有 1 个诚实 SKIP（jsdom 不实现 `isContentEditable`，由真实浏览器覆盖）。

### 5.2 本次新增独立套件

| Suite | PASS | FAIL | Duration |
|---|---:|---:|---:|
| indep_unit.js（纯逻辑：normalize/limit/分类/URL/索引/打分/AND/排序/limit/type/性能） | 199 | 0 | ~2 s |
| indep_protocol.py（bind/token/首帧/请求关联/并发/单会话/源码安全） | 74 | 0 | 19.4 s |
| indep_e2e.py（真实 Edge ↔ Python，17 个分组） | 257 | 1 | 82.6 s |
| indep_cli.py（真实 `server.py` 子进程 + 真实浏览器） | 42 | 0 | ~90 s |
| final_smoke.py（最终 Smoke Test，20 步） | 20 | 0 | 11 s |
| **小计** | **592** | **1** | |

`indep_e2e.py` 按分组的通过情况：

| 分组 | PASS | FAIL |
|---|---:|---:|
| CONNECT / handshake | 19 | 0 |
| SCAN | 15 | 0 |
| SEARCH (real browser) | 27 | 0 |
| SEARCH ranking fixture | 26 | 0 |
| LOCATE / HIGHLIGHT / CLEAR | 18 | 0 |
| ACTION: CLICK / INPUT / CLEAR / KEYPRESS / SCROLL | 46 | 0 |
| elementId lifecycle / invalidation | 11 | 0 |
| navigation / page reload / tab switch | 11 | 1 |
| restricted pages | 8 | 0 |
| protocol robustness | 16 | 0 |
| resource / leak checks | 12 | 0 |
| search performance | 7 | 0 |
| recovery | 16 | 0 |
| browser console | 3 | 0 |
| V1 regression | 9 | 0 |
| V1.2 regression | 11 | 0 |
| evidence | 2 | 0 |

---

## 6. Element Search Verification

### 6.1 字段、规范化、分档（`indep_unit.js` + 真实 fixture）

| 验证项 | 结果 | 证据 |
|---|---|---|
| 覆盖字段 text/value/placeholder/aria-label/title/alt/tag/role/id/className/href | PASS | `SEARCH_FIELDS` 全等断言（U-900） |
| 每个字段都有权重 | PASS | U-901 |
| 中文查询 | PASS | 真实浏览器 `search 立即沟通` → `total≥1`，`matchedFields=["text"]`，`score=100` |
| 英文 / 大小写不敏感 | PASS | U-105/U-700 `AI`→`ai`；`AI` 与 `ai` 命中同一元素 |
| 前缀 / 包含 / 精确分档 | PASS | fixture 上实测 100 / 80 / 60（text），55/45（aria-label），45（title），20（className） |
| 空 query | PASS | 返回全部扫描元素、`score=0`、`matchedFields=[]`、保持 DOM 顺序、`total=stats.total` |
| 无结果 | PASS | `total=0 returned=0 truncated=false` |
| limit=1 / 20 / 100 / >100 / 0 / 负数 / 非数字 | PASS | 夹取到 [1,100]，`"abc"`→20 |
| 多关键词 AND | PASS | 见 6.2 |
| 排序 | PASS | score 降序，同分按 elementId 升序（U-650、SEARCH-07/07b） |
| matchedFields | PASS | 只含真实命中字段；跨字段 AND 时合并（U-666） |
| total / truncated | PASS | `truncated === (total > returned)` |
| 索引生命周期 | PASS | 重新 SCAN 后旧文本搜不到、新文本可搜到、`indexedAt` 更新（U-680..683）；扫描后新增元素不被返回（LIFE-05），重扫后可被搜到（LIFE-06） |
| 索引失效 | PASS | `clearIndex` 后 `NO_SCAN_DATA` |
| 全角空格 / emoji / 特殊字符 | PASS | `AI　工程师` → `["ai","工程师"]`；`🔑` 原样保留 |
| 单字符不匹配 href | PASS | U-630/U-631（href 仅在关键词长度 ≥2 时参与） |

### 6.2 多关键词（AND）

真实浏览器 fixture `and`（`AI应用工程师` / `AI产品经理` / `Java工程师` / `产品运营`）：

```
search "AI 工程师" → 只返回 AI应用工程师（elements=[and-both]）
                    AI产品经理   未命中 ✅
                    Java工程师   未命中 ✅
                    产品运营     未命中 ✅
keywords = ["ai", "工程师"]   （AND，不是 OR）
```

三关键词 `ai 工程 师` → `[1,5,4]`（分数 200/195/165 降序，U-667/I-667c）。含不命中词 `ai 工程 zzz` → 0。

### 6.3 性能（真实浏览器，`evidence-v2-independent/search-performance.json`）

| 元素数 | buildIndex+scan | search 耗时 | 返回帧字节 | 结果 |
|---:|---:|---:|---:|---|
| 100 | 12.5 ms | 2.5 ms | 45,271 | PASS |
| 500 | 23.8 ms | 2.7 ms | 228,004 | PASS |
| 1000 | 35.8 ms | 2.5 ms | 457,956 | PASS |
| 5000 | 150.9 ms | 4.7 ms | **2,319,432** | PASS |

纯逻辑（jsdom，`search-performance-unit.json`）：buildIndex(5000) 与 search(5000) 均远低于阈值，任意规模搜索 < 500 ms。

> 5000 元素、2.32 MB 返回帧在本次验收前**必定失败**（见 BUG-003），修复后通过 —— 该行同时是 BUG-003 的回归护栏（`PERF-BUG003`）。

### 6.4 已知语义观察（非缺陷，记录备查）

1. **placeholder 分档在实践中几乎不可达**：`scanner.getElementText()` 的文本回退链是 `innerText → value → aria-label → placeholder → title → alt`，所以空 `<input>` 的 `placeholder` 同时成为它的 `text`，永远以 100/80/60 的 text 分档胜出，`PS.SEARCH_SCORES.placeholder`（50/40/25）实际不会被选中。已在 fixture 中实测并如实记录（`RANK-f-ph-*` 期望值改为真实行为）。
2. **href 匹配对非 ASCII 无效**：`scanner` 用 `element.href`（已解析的绝对 URL），浏览器会做百分号编码，`https://example.com/工程师/1` 变成 `.../%E5%B7%A5%E7%A8%8B%E5%B8%88/1`，因此中文关键词无法命中 href（`RANK-href-encoded` 已断言该真实行为）。ASCII 关键词正常命中（score=10）。

---

## 7. Protocol Tests

独立编写假扩展客户端（不经过真实扩展），共 74 项 PASS / 0 FAIL。

| 类别 | 用例 | 结果 |
|---|---|---|
| 首帧规则 | 非法 JSON / 空帧 / 数组 / null / 数字 / 非 HELLO / 缺 type / 协议版本不符 → 全部拒绝且服务端不崩溃 | PASS |
| HELLO 超时 | 不发 HELLO → 服务端约 5 s 断开；之后仍可正常握手 | PASS |
| params | None（归一化为 `{}`）/ `{}` / 嵌套 / 中文 / emoji / 512 KB 大字符串 / 数字 / 布尔 全部透传 | PASS |
| 错误响应 | `success=false` → 客户端抛 `PageSenseError(code)`；之后连接仍可用 | PASS |
| 未知方法 | 本地拒绝 → `UNKNOWN_METHOD` | PASS |
| 超时 | 无响应 → `REQUEST_TIMEOUT`，耗时接近配置值（1.5 s 配置实测 1.3–3.5 s），不永久挂起 | PASS |
| 重复 id 响应 | 只解析第一次 | PASS |
| 垃圾帧 | 非 JSON / 数组 / 无 id 响应 / 孤儿 id 响应 之后仍能拿到正确响应 | PASS |
| 乱序响应 | 9 个并发请求响应顺序颠倒，全部正确对应各自 request id | PASS |
| request id | 唯一且递增（`req_001…`） | PASS |
| 并发 | 30 个并发 PING/GET_STATUS/SEARCH 无异常；响应回显各自 params（无 A 请求收 B 响应） | PASS |
| 单会话 | 第二个连接顶替第一个，旧连接被服务端关闭 | PASS |
| 服务停止 | 有挂起请求时停止 Controller 不产生未捕获异常 | PASS |
| 真实扩展上的健壮性 | 未知方法 / 小写方法名 / 缺 elementId / id="abc" / id=null / id=10^15 / 缺 direction / 缺 key / 缺 query / 超时路径 → 全部返回结构化错误码，连接保持可用 | PASS |
| 重复注入 | 一条 SCAN 或 CLICK 消息只产生一个响应（`perRound=[1]`） | PASS |
| 请求日志 | 扩展端最多保留 20 条 | PASS |
| 20×SCAN | 每个请求恰好一个响应，`elements.length == stats.total` 恒成立 | PASS |

---

## 8. Security Verification

### 8.1 网络暴露面（实际启动测试，非仅读源码）

| Test | Result | Evidence |
|---|---|---|
| Controller 只监听 127.0.0.1 | PASS | `netstat` 实测监听地址仅 `127.0.0.1:8765`；无 `0.0.0.0` |
| LAN 地址无法连接 | PASS | 本机 LAN IP `10.112.62.165:8765` 连接被拒绝 |
| 拒绝 `host=0.0.0.0` | PASS | 构造 `ControllerServer` 抛 `ValueError` |
| 拒绝 `host=::` / `192.168.1.10` / `example.com` / `""` | PASS | 均抛 `ValueError`（非其他异常） |
| `ALLOWED_HOSTS` 仅回环 | PASS | `("127.0.0.1","localhost")` |
| 拒绝非法端口 -1 / 70000 | PASS | 抛 `ValueError` |
| 扩展侧也只允许回环 host | PASS | `PS.BRIDGE.ALLOWED_HOSTS` 全等断言 + `saveConfig` 拒绝非回环 |

### 8.2 Token 认证

| Test | Result | Evidence |
|---|---|---|
| 正确 token | PASS | `HELLO_ACK {success:true}` |
| 错误 / 空 / 随机 / 大小写不同 / 多一字符 / 少一字符 / 64 KB 超长 / 非 ASCII | PASS | 全部 `HELLO_ACK {success:false, error.code=UNAUTHORIZED}`，随后服务端关闭连接 |
| **非 ASCII token 不再导致内部错误** | PASS（BUG-001 修复后） | 修复前服务端抛 `TypeError` 并以 1011 关闭 |
| 无硬编码 token | PASS | 代码（剔除 docstring/注释）中无 token 字面量；`pagesense.py` 的 `token="ABC123"` 仅为文档示例 |
| token 生成 | PASS | `secrets.token_hex(8)` |
| token 比较 | PASS | `secrets.compare_digest`（常量时间，按 UTF-8 字节比较） |
| 随机 token 每会话不同 | PASS | `generate_token()` 每次不同 |
| 错误 token 时 Controller 侧不建立会话 | PASS | `server.connected === False` |
| 错误 token 时不疯狂重连 | PASS | 扩展按 1/2/5/10/30 s 退避；10 次采样状态稳定（REC-03d） |

### 8.3 Manifest 权限复核

| 权限 | 是否必需 | 代码是否使用 | README 是否解释 |
|---|---|---|---|
| `activeTab` | 是 | Popup 点击后注入 | 是（权限表） |
| `scripting` | 是 | `chrome.scripting.executeScript`（Popup 与 Bridge 两处） | 是 |
| `storage` | 是 | `chrome.storage.local` 保存 bridge host/port/token/autoconnect | 是 |
| `host_permissions: http://*/*, https://*/*` | 是（V2 无人值守注入所需） | Controller 无用户手势注入 | 是（README 明确说明 activeTab 无法授权无人值守注入） |

| 高危权限 | 结果 |
|---|---|
| debugger / cookies / webRequest / webRequestBlocking / history / downloads / management / browsingData / privacy / tabs | **均不存在**（static-check T06 通过） |

> `http://*/*` + `https://*/*` 意味着 PageSense 可注入任意网站，这是 V2.0 无人值守 Controller 的必要代价，已在 README 中说明；本报告不判定为 SECURITY FAIL，但属于应当知悉的攻击面（见 §15）。

---

## 9. Real Edge ↔ Python E2E

真实 Edge 154 + 真实未打包扩展 + 真实 Python Controller + 真实 demo 页面，`indep_e2e.py`（258 项）。以下为逐项真实观测值。

| ID | Test | Expected | Actual | Status |
|---|---|---|---|---|
| E2E-01 | CONNECT（HELLO/HELLO_ACK） | 连接建立 | `server.wait_for_extension → True`；`state=CONNECTED` | PASS |
| E2E-01c | 版本一致 | 2.0.0 | `version=2.0.0`；`protocol=pagesense/1` | PASS |
| E2E-01d | endpoint 一致 | 127.0.0.1:8765 | `host=127.0.0.1 port=8765` | PASS |
| E2E-01g | Popup 界面 | `● 已连接` | 渲染后 DOM 文本 `● 已连接`，`dot=controller-dot is-connected` | PASS |
| E2E-01k | Popup 版本标签 | V2.0 | `.brand-version` = `V2.0` | PASS |
| E2E-02 | PING | PONG | `{pong:true, version:"2.0.0", timestamp:…}` | PASS |
| E2E-03 | GET_STATUS | connected + activeTab | `tabId=276685385, url=http://127.0.0.1:8770/test/demo.html, title=PageSense Demo Page` | PASS |
| E2E-04 | SCAN | 真实 page/stats/elements | `stats={matched:34,total:28,hidden:6,inViewport:11}`，`elements.length=28=stats.total` | PASS |
| E2E-04-spot | 抽查元素与真实 DOM 一致 | tag/rect/text | 6 个抽样元素与 `data-pagesense-id` 节点逐一比对（tag、rect 容差 ≤2px、text 按 scanner 同一条回退链）全部一致 | PASS |
| E2E-04-ids | elementId 唯一递增 | 1..N | `[1..28]` 精确相等 | PASS |
| E2E-04-map | 映射数量 | == stats.total | 真实 DOM 上 28 个 `data-pagesense-id` | PASS |
| SEARCH-01 | 中文搜索 | 命中「立即沟通」 | `total=1, score=100, matchedFields=["text"]`，`elementId=4`；该 id 指向真实节点且 `text=="立即沟通"` | PASS |
| SEARCH-03 | 空 query | 全部元素 | `total=28`，score 全 0，DOM 顺序 | PASS |
| SEARCH-05 | limit 夹取 | [1,100] | 1/100/100/1/1/20 全部符合 | PASS |
| SEARCH-07 | 排序 | score 降序 + elementId 升序 | 通过 | PASS |
| RANK-* | 分档打分 | 见 §6 | 11 组分档断言全部符合 | PASS |
| AND-01 | 多关键词 AND | 只返回同时命中 | `["and-both"]` 精确相等 | PASS |
| HL-01 | HIGHLIGHT | overlay=1 | 真实 overlay 数 = 1 | PASS |
| HL-03 | overlay 贴合 | rect ≈ target | 同一帧内采样，`delta=(0,0,0,0)` | PASS |
| HL-05b | 不修改页面元素 | 无 style | 目标元素 `style` 属性为空 | PASS |
| HL-08 | CLEAR_HIGHLIGHT | overlay=0 | 0；重复调用幂等 | PASS |
| HL-09 | 非法/不存在 id | 结构化错误码 | `INVALID_ELEMENT_ID`（abc/0/-1）、`ELEMENT_NOT_FOUND`（999999） | PASS |
| ACT-CLICK | CLICK | 真实计数 +1 | `before→after` 精确 +1 | PASS |
| ACT-CLICK-20 | 连续 20 次 CLICK | +20 | 精确 +20 | PASS |
| ACT-CLICK-disabled | disabled / aria-disabled | `ELEMENT_DISABLED` | 均返回 `ELEMENT_DISABLED`，无副作用 | PASS |
| ACT-INPUT | INPUT | 真实 `element.value` | `input.value == "AI应用工程师"`；`__events.input>=1` 且 `change>=1` | PASS |
| ACT-INPUT-area/ce | textarea / contenteditable | 值正确 | `textarea.value`、`ce.innerText` 均等于目标串 | PASS |
| ACT-INPUT-* | 非法参数 | 结构化错误码 | `UNSUPPORTED_ELEMENT`/`INVALID_VALUE`/`ELEMENT_NOT_FOUND`/`ELEMENT_DISABLED` | PASS |
| ACT-CLEAR | CLEAR | 清空 | `input.value == ""`，`action=PAGESENSE_CLEAR_ELEMENT` | PASS |
| ACT-KEY-* | KEYPRESS | 真实页面收到事件 | 页面 `#keys` 记录 `keydown:Enter,keyup:Enter`；ArrowDown/Escape 同 | PASS |
| ACT-KEY-space | Space 别名 | 规范化为 `" "` | 回执 `key="Space"` | PASS |
| ACT-KEY-invalid | FakeKey / F1 / 空 | `INVALID_KEY` | 全部 `INVALID_KEY` | PASS |
| ACT-SCROLL-* | SCROLL | 真实 scrollY 变化 | down 500 → `scrollY>0`；up 500 → 回到 0；顶部再上滚 `moved=false` 且 `success=true`（不算异常） | PASS |
| ACT-SCROLL-非法 | 方向/amount 非法 | `INVALID_VALUE` | sideways/""/0/-100/99999/"abc" 全部 `INVALID_VALUE`；amount=5000（上限）接受 | PASS |
| LIFE-02a..e | 元素删除后动作 | `ELEMENT_NOT_FOUND` | CLICK/INPUT/HIGHLIGHT/LOCATE/CLEAR 全部 `ELEMENT_NOT_FOUND` | PASS |
| LIFE-03 | 同名同文本元素重加 | 不猜测 | 旧 id 仍然 `ELEMENT_NOT_FOUND` | PASS |
| LIFE-04 | 重扫后新 id | 新 elementId | 通过，映射数与 stats.total 一致 | PASS |
| NAV-01 | 同标签页导航 | 旧 id 失效 | `ELEMENT_NOT_FOUND` | PASS |
| NAV-04 | 页面刷新 | 旧 id 失效 | `ELEMENT_NOT_FOUND` | PASS |
| NAV-05/06 | 刷新后恢复 | SCAN/SEARCH/ACTION 正常 | 通过 | PASS |
| NAV-07 | 标签页切换 | 作用于新的活动标签页 | 扫描 `noscroll` fixture，`stats.total=1` | PASS |
| **NAV-09** | **跨标签页复用旧 elementId** | **不应命中另一页面的元素** | **实际命中 demo 上的 `<a>前往 Example`，并触发导航（执行上下文被销毁）** | **FAIL** |
| REST-01 | edge://extensions 上动作 | `RESTRICTED_PAGE` | SCAN/SEARCH/CLICK 全部 `RESTRICTED_PAGE` | PASS |
| REST-02/03/04 | 受限页面副作用 | 不崩溃 | Controller 未崩溃、扩展保持 CONNECTED、SW 无未捕获异常 | PASS |
| REST-05 | edge://settings | `RESTRICTED_PAGE` | 通过 | PASS |
| REST-06 | 返回普通页 | 恢复 | SCAN 正常 | PASS |
| PROTO-R1..R10 | 结构化错误 | 各错误码 | 全部符合 | PASS |
| PROTO-R12 | 超时路径 | `REQUEST_TIMEOUT` | 通过（不永久挂起） | PASS |
| PROTO-R14/15 | 重复响应 | 每请求恰一个响应 | `perRound=[1]` | PASS |
| RES-01..07 | 资源/泄漏 | 无累积 | 50×SCAN / 50×SEARCH / 50×HIGHLIGHT / 50×CLEAR 后：overlay 峰值 1、终值 0、无残留 overlay 节点、请求日志 ≤20、映射无重复、单 SW 实例、无挂起请求 | PASS |
| CONSOLE-01/02/03 | 控制台 | 无严重异常 | SW 无 uncaught；页面无 uncaught/unhandled rejection；仅 favicon 404 噪声 | PASS |

### 9.1 `demo.html` 实际扫描数据（本次实测）

```json
{ "matched": 34, "total": 28, "hidden": 6, "inViewport": 11 }
```

```
elements.length = 28 = stats.total        （自洽）
stats.matched   = 34 = 28 + 6 = total + hidden  （自洽）
schemaVersion   = 1
search "立即沟通"  → total=1, elementId=4, score=100, matchedFields=["text"]
search "沟通"      → total=1
search "搜索"      → total=0      （当前 demo 已无含「搜索」的元素）
search ""          → total=28
```

`total=28` 与开发报告一致；但既有 `browser-pipeline.js` 中硬编码的 `stats.total === 19` 已与当前 `test/demo.html`（2026-09-28 23:35 修改）不符 —— 该套件在本环境已被阻断，未执行到该断言。

---

## 10. Recovery & Lifecycle Tests

| 场景 | 恢复时间 | 最终状态 | 是否需要人工干预 |
|---|---|---|---|
| 停止 Controller | 扩展在 ~2 s 内离开 CONNECTED | ERROR（`lastError=BRIDGE_ERROR`） | 否 |
| 相同 host/port/token 重启 Controller | 自动恢复到 CONNECTED（REC-02 通过） | CONNECTED | **否**（无需重启浏览器 / 重载扩展 / 手动点连接） |
| 错误 token 重启 | 不进入 CONNECTED | ERROR，`lastError` 非空；Controller 侧未建立会话 | 否（不需要，行为正确） |
| 错误 token 期间重连节奏 | 10 次采样状态恒定，未出现数百毫秒级疯狂重连 | 稳定 | 否 |
| 恢复正确 token | 自动 CONNECTED；SCAN 正常 | CONNECTED | 否 |
| 扩展重载 `chrome.runtime.reload()` | SW 重启 → 重建 WebSocket → CONNECTED | CONNECTED，PING/SCAN 正常 | 否（浏览器未重启） |
| 页面刷新 | 旧 elementId 失效；重扫后 SCAN/SEARCH/ACTION 正常 | 正常 | 否 |
| 标签页切换 | SCAN 作用于新的活动标签页 | 正常 | 否（但见 FINDING-001） |
| Service Worker 生命周期（短间隔） | 自动恢复 CONNECTED | 正常 | 否 |
| **Service Worker 生命周期（长间隔 >30 s）** | **不自动恢复**，需一次浏览器交互唤醒 SW | 唤醒后 <0.1 s 恢复 CONNECTED | **是**（见 FINDING-003） |

验收过程中观测到的桥接恢复事件（`indep-e2e-results.json → recoveries`）：
- BUG-003 修复前：每次大页面扫描都会断开并以 1000 ms 重连（多次采样 1.0 s）。
- BUG-003 修复后：最终完整回归中 **recoveries = []**（无任何意外断线）。

---

## 11. Regression

### V1（Scanner 数据模型）

| 项 | 结果 | 证据 |
|---|---|---|
| Scanner | PASS | scanner-unit 32；真实扫描 `stats`/`elements` 自洽 |
| visible / 隐藏过滤 | PASS | 序列化结果中不含不可见元素；`hidden` 与 `matched-total` 一致 |
| inViewport | PASS | `sum(inViewport) == stats.inViewport` |
| rect / page coordinates | PASS | `position` 全字段存在；抽查与真实 `getBoundingClientRect` 逐项一致（含 `<option>` 借用 `<select>` rect 的规则） |
| page coordinates | PASS | `pageX/pageY` 与 `rect+scroll` 一致 |
| Raw JSON | PASS | 可序列化、无循环引用；Popup Raw Data 渲染正常 |
| search / filter | PASS | popup-ui 20；popup 与 content script 共用 `element-search.js` |
| copy / export | PASS | popup-ui P20 断言 Raw JSON 生成并可解析 |

### V1.1（Mapping / 定位 / 高亮）

| 项 | 结果 | 证据 |
|---|---|---|
| Mapping | PASS | `data-pagesense-id` 数量 == `stats.total`；无重复；重扫清理旧映射 |
| Locate | PASS | `success`；不存在/非法 id 返回结构化错误 |
| Highlight | PASS | overlay=1；标签 `#id <tag> 文本` |
| Clear | PASS | overlay=0；重复调用幂等 |
| Overlay follow（scroll / resize） | PASS | v11-browser 9 项含 scroll/resize 跟随；`indep` 中 overlay rect 与 target 同帧一致 |
| DOM 删除 | PASS | MutationObserver 立即移除 overlay；随后定位/高亮返回 `ELEMENT_NOT_FOUND` |

### V1.2（Action Layer）

| 项 | 结果 | 证据 |
|---|---|---|
| CLICK | PASS | 真实计数 +1；20 次 +20 |
| INPUT | PASS | 真实 value；`input`/`change` 事件计数 ≥1 |
| CLEAR | PASS | value 置空 |
| KEYPRESS | PASS | 页面真实记录 keydown/keyup |
| SCROLL | PASS | 真实 scrollY 变化；边界 `moved=false` |
| disabled | PASS | `ELEMENT_DISABLED`（含 aria-disabled） |
| invalid id | PASS | `INVALID_ELEMENT_ID`（abc / 0 / -1 / 缺参 / null） |
| deleted element | PASS | `ELEMENT_NOT_FOUND`，不猜测替代元素 |
| 20×CLICK / 20×INPUT | PASS | 精确 +20 / 逐次值正确 |
| Action 回执契约 | PASS | `success/action/actionId/timestamp/durationMs/elementId/rescanRecommended` 齐全；连续动作 actionId 唯一 |

---

## 12. Bugs Found

> 验收过程中发现的每一个问题都记录在此，**修复后不删除**。

### BUG-001

Severity: **P2**
Component: Python Controller / `controller/server.py`
Status: **FIXED**

#### Description

当 HELLO 的 `token` 含非 ASCII 字符时，服务端抛出未捕获的 `TypeError`，连接以 1011（internal error）异常关闭，而不是按协议返回 `HELLO_ACK {success:false, error.code:"UNAUTHORIZED"}`。

#### Steps to Reproduce

1. 启动 `python server.py --token AAAABBBBCCCCDDDD`
2. 以 WebSocket 连接并发送
   `{"type":"HELLO","protocol":"pagesense/1","client":"extension","version":"2.0.0","token":"令牌🔑"}`
3. 观察服务端与客户端

#### Expected

`HELLO_ACK {"type":"HELLO_ACK","success":false,"error":{"code":"UNAUTHORIZED",...}}`，随后服务端正常关闭连接。

#### Actual

```
connection handler failed
Traceback (most recent call last):
  File ".../websockets/asyncio/server.py", line 747, in protocol_handler
    await handler(connection)
  File "controller/server.py", line 200, in _handler
    if not secrets.compare_digest(str(message.get("token", "")), self.token):
TypeError: comparing strings with non-ASCII characters is not supported
```

客户端观测：`ConnectionClosedError: received 1011 (internal error)`

#### Root Cause

`secrets.compare_digest()` 对含非 ASCII 字符的 `str` 参数会抛 `TypeError`（其设计如此：避免编码歧义）。这个异常从 `_handler` 逃逸，websockets 以 1011 关闭连接。

可达性：用户在 Popup 中粘贴一个混入全角字符或输入法残留字符的 token 是常见操作失误，因此这是可达路径，不是纯理论问题。

#### Fix

在 `server.py` 中新增 `_token_bytes()`，把待比较值编码为 UTF-8 字节（非 `str` 一律视为不可能匹配），再走 `compare_digest` 的字节比较路径：

```python
def _token_bytes(value: object) -> bytes:
    if not isinstance(value, str):
        return b""
    return value.encode("utf-8", "replace")

...
if not secrets.compare_digest(_token_bytes(message.get("token", "")),
                              _token_bytes(self.token)):
```

#### Regression Verification

`indep_protocol.py` 的 8 组 token 用例（正确/错误/空/随机/大小写/多字符/少字符/64KB/非 ASCII）全部 PASS，并额外断言服务端在拒绝后关闭连接；`test_bridge.py` 15 项仍全过。

---

### BUG-002 —— 编号保留，未使用

`indexSize` 字段的语义错误经复核判定为**文档/字段命名问题**而非功能缺陷（无任何消费方、不影响行为），已归入 §14 的 **FINDING-002**，不占用 BUG 编号。此处保留编号说明，避免后续阅读时以为漏记了一个缺陷。

---

### BUG-003

Severity: **P1 Critical**（本次验收中最重要的发现）
Component: Python Controller / `controller/server.py`（配合 MV3 Service Worker 的 WebSocket 客户端）
Status: **FIXED**

#### Description

当扩展返回的单个 RESPONSE 帧超过 1 MiB 时，Controller 以 1009（message too big）关闭连接。扩展侧观察到 1006 异常关闭，丢弃 socket 并按退避重连；**正在进行的那次请求永久失败**，调用方只看到含义模糊的 `NOT_CONNECTED`。

后果：**交互元素约 2500 个以上的页面完全无法通过 Controller 扫描**。同一页面通过 Popup 路径（不经过 WebSocket）完全正常。

#### Steps to Reproduce

1. 启动 Controller 与扩展并连接
2. 打开一个约 2600 个 `<button>` 的页面（`http://127.0.0.1:<agent>/f/perf?n=2600`）
3. 执行 `scan`

#### Expected

返回该页面的扫描结果（与 Popup 路径一致）。

#### Actual

```
scan_FAIL code=NOT_CONNECTED ms≈70
Controller 侧: handler_exit close_code=1006 close_reason=""
扩展侧:        state CONNECTED → ERROR，lastError=null（onerror 未触发）
Service Worker: targetId 不变，内存 requestLog 未被重置（SW 未重启）
约 1.0 s 后扩展自动重连并再次成功握手
```

#### Root Cause

`websockets.asyncio.server.serve()` 的 `max_size` 默认值为 **1,048,576 字节**，而 `server.py::_serve()` 调用 `serve(self._handler, self.host, self.port)` 时未覆盖它。超过该值的入站消息被服务端以 1009 拒绝，异常被 `_handler` 的 `except ConnectionClosed` 吞掉，最终走到 `_fail_pending(NOT_CONNECTED)`。

**定位过程（逐层排除）**：

| 实验 | 结果 | 结论 |
|---|---|---|
| 3000 元素页面只发 PING 不发 SCAN | 10/10 成功 | 与"页面大"无关，是 SCAN 本身 |
| Popup 路径（`chrome.tabs.sendMessage`，无 WebSocket）扫描 1000/1500+pad/2600/3000/4000 | 全部成功 | 故障在 **SW→WebSocket** 这一段，Scanner/Content Script 无辜 |
| 不挂 CDP 到 Service Worker 重跑（`INDEP_NO_SW_CDP=1`） | 仍然失败 | 不是调试器干扰的假象 |
| 关闭 SW 的 CDP 后观测 SW targetId 与内存 requestLog | targetId 不变、日志不重置 | Service Worker **没有**重启，不是 SW 被回收 |
| 捕获服务端 `close_code` | **1006**（且无 `onerror`） | 非正常关闭，非扩展主动 `closeSocket()` |
| 用独立最简 `websockets` 服务端发送 1000k/1048576/1100000/1200000 字节 | ≤1048576 成功；≥1100000 报 `frame exceeds limit of 1048576` | **limit = 1 MiB 被确证** |
| 记录真实入站帧字节数 | 成功的 2560 元素 = **1,045,964**（刚好在限内）；失败的 1500/pad100 = **1,061,508**、2600 = 1,062,400、3000 = 1,226,761 | 边界与 1,048,576 完全吻合 |

> 早期的测量曾给出"边界不一致"的错觉（2400 通过 / 2600 失败，且 1500+长文本在更小字节数下失败）。原因是当时用 Python 的 `json.dumps()` 重新序列化来估算帧大小，而 `json.dumps` 默认分隔符为 `", "` / `": "`，比扩展侧 `JSON.stringify` 的结果大约 13%。改为直接记录**真实入站帧字节数**后，所有数据都与 1,048,576 这个硬上限自洽 —— 这也解释了"为什么 2560 个元素（估算 1.18 MB）反而通过"。

#### Fix

`controller/server.py` 显式设置 `max_size`，取值 64 MiB（与 Chrome 自身对扩展消息的上限一致，使桥接不再是链路上最窄的一段）：

```python
MAX_MESSAGE_SIZE = 64 * 1024 * 1024

async def _serve(self) -> None:
    self._server = await serve(self._handler, self.host, self.port,
                               max_size=MAX_MESSAGE_SIZE)
```

同时在 `pagesense/README.md` 的限制清单中记录该历史问题与当前上限。

#### Regression Verification

修复后逐项复测（`evidence-v2-independent/bug003-fix-verify.json`，含真实帧字节数）：

| 配置 | 修复前 | 修复后 | 真实帧字节 |
|---|---|---|---|
| n=1000 | OK | OK | 404,960 |
| n=1500 pad=100 | **FAIL** | OK | 1,061,508 |
| n=2560 | OK（临界） | OK | 1,045,964 |
| n=2600 | **FAIL** | OK | 1,062,400 |
| n=3000 | **FAIL** | OK | 1,226,761 |
| n=5000 | **FAIL** | OK | 2,054,454 |

并新增常驻回归护栏 `PERF-BUG003`（`indep_e2e.py`）：断言 5000 元素扫描结果 > 1 MiB 且仍能通过桥接返回。完整回归中该断言 PASS，且全流程 `recoveries = []`。

`indep_protocol.py`（74）、`indep_unit.js`（199）、既有 8 个 Node 套件、`test_bridge`/`test_cli`/`test_e2e`(57) 全部重跑通过。

---

### FINDING-001

Severity: **P3**（影响面大但触发条件被文档禁止；未修复，已文档化）
Component: Element Map / Controller Bridge（协议缺少页面作用域）
Status: **OPEN**（在 README 中显式文档化为限制）

#### Description

`elementId` 只在一个页面的映射属性内有效，但协议信封里没有任何页面/标签身份。`data-pagesense-id` 是写在页面元素上的属性，只要该页面在本次浏览器会话中被扫描过就会保留。因此：在标签页 B 扫描取得的 elementId，切回标签页 A 后再使用，会被解析到 **A 页面上恰好占用同一 id 的另一个元素**。

#### Steps to Reproduce

1. 扫描 demo（A 页）→ A 页元素获得 `data-pagesense-id="1..25"`
2. 切到 fixture 页（B 页）扫描 → B 页元素获得 `data-pagesense-id="1..N"`
3. 切回 A 页（此时 A 页仍保留第 1 步写入的属性）
4. 用 B 页的 elementId 执行 CLICK

#### Expected

失败（`ELEMENT_NOT_FOUND`），或至少在返回里带上作用域信息，使调用方能发现 id 不属于当前页面。

#### Actual（`NAV-09` 实测）

```
code = NO_ERROR            （点击"成功"了）
目标页上该 id 解析为 = { "tag": "a", "text": "前往 Example",
                        "pageX": 279, "pageY": 217, "hasOwnMappingAttr": true }
url  http://127.0.0.1:8770/test/demo.html  →  None
after_state_error = "Execution context was destroyed, most likely because of a navigation."
```

即：**旧 id 命中了另一页面上的一条链接并触发了导航**。这正是"动作必须作用于调用方指定的元素"这一前提被打破的实例。

#### Root Cause

`PS.PAGE_SENSE_ID_ATTR` 的值只有 `<elementId>`，没有扫描代数 / 页面身份；`PageSenseElementMap.getElementById()` 在**当前文档**里按该属性查找，因此切换标签页后属性仍然命中的是"同一文档上一次扫描留下的 id 空间"。同页面内的失效保证（DOM 删除、导航、刷新）全部正确 —— 只有在跨文档复用 id 时才出现别名。

#### Fix

未修复。三个候选方案都会改动已文档化的对外契约（README 明确写了 `data-pagesense-id="<elementId>"`，且 `scanner-unit` VT1 直接断言属性值等于 elementId）：

1. 属性值改为 `"<scanToken>:<elementId>"`（element-map 单点改动，但改动公开数据格式）；
2. 协议 `REQUEST` 增加 `tabId`/`scanId` 作用域并在 Service Worker 侧校验（协议扩展）；
3. Controller 侧维护"每个 tab 最近一次扫描的 generation"，不匹配即拒绝（Controller 侧改动）。

按验收规范「不属于 Bug 的架构改进点记入 Future Improvements、不擅自实现」，且这属于会波及对外数据格式的改动，本次**只做文档化**，代码不动。

#### Regression Verification

- 已在 `pagesense/README.md` 的 "V2.0 新增限制" 中显式写明该危险与强制做法（切换标签页后必须重新 `SCAN_PAGE`，不得复用切换前的 elementId）。
- 同页面内的全部失效保证仍逐项通过：`NAV-01`（同标签页导航）、`NAV-04`（刷新）、`LIFE-02a..e`（DOM 删除）、`LIFE-03`（同名元素重加不猜测）。
- `NAV-09` 作为该限制的常驻探针保留在回归集中，保持 FAIL 以便后续修复后被自动发现。

---

### FINDING-003

Severity: **P2 Major**（对无人值守使用是阻塞级；属于 MV3 平台约束，产品侧可缓解）
Component: Service Worker / Controller Bridge 重连路径
Status: **OPEN**（未修复；建议的缓解手段见下）

#### Description

扩展与 Controller 断线后，是否能够自行恢复，取决于 **Service Worker 是否还活着**：

- Controller 短暂中断（秒级）：SW 还活着，`scheduleReconnect` 的退避定时器仍在，**自动恢复**。
- Controller 中断超过约 30 s：浏览器回收 MV3 Service Worker，退避定时器随 SW 一起消失。此后**扩展不会自行重连**，直到有事件把 SW 唤醒（打开 Popup、切换/导航标签页、浏览器启动等），唤醒后 `init()` 会立即重连（实测 <0.1 s）。

对 Agent Layer 的含义：**Controller 停机超过 30 s 后重新启动，PageSense 不会自动回到 CONNECTED —— 必须有人碰一下浏览器。** 这与"扩展装了就能长期无人值守地对接 Controller"的预期不符。

#### Steps to Reproduce

1. 建立连接（Controller + 扩展）。
2. 停止 Controller，保持 ≥45 s（超过 MV3 的 ~30 s SW 空闲回收阈值）。
3. 用相同 host/port/token 重启 Controller。
4. **不做任何浏览器交互**，等待 25 s 观察是否恢复。
5. 然后打开 Popup（或切标签页）再观察。

#### Expected

理想情况下应从退避（≤30 s）内自动恢复；至少应当在文档中明确"需要一次浏览器交互"。

#### Actual（`evidence-v2-independent/sw-lifecycle.json`，3 次独立复现）

| 场景 | 停机时长 | 是否有唤醒 | 25 s 内自动恢复 | 唤醒后恢复 |
|---|---|---|---|---|
| A. 立即重启 | ~0 s | — | **是**（1.0 s） | — |
| B. 长间隔 | 45 s | 无 | **否**（25 s 内未恢复，扩展状态 `DISCONNECTED`） | — |
| C. 长间隔 | 45 s | 打开 Popup | 否 | **是**（0.0 s，随后 SCAN 得 28 元素） |
| D. 长间隔 | 45 s | 切到 demo 标签页 | 否 | **是**（0.0 s，随后 SCAN 得 28 元素） |

#### Root Cause

MV3 Service Worker 在无事件约 30 s 后被浏览器停止，页面上下文与所有 `setTimeout`/`setInterval` 一并销毁，`scheduleReconnect()` 的退避链因此中断。SW 只有被某个事件（扩展页面打开、标签页导航、`chrome.runtime.onStartup`/`onInstalled` 等）重新启动时才会再次执行 `controller-bridge.js` 的 `init()`；`init()` 在 `autoconnect && token` 为真时会立刻 `connect()`，所以"唤醒即恢复"，但**没有任何机制主动唤醒它**。

这不是实现错误（`init()` 的逻辑正确），而是"重连定时器寄生在会被回收的 SW 上"这一结构性约束。连接期间 20 s 心跳能显著降低被回收的概率（README 已说明），但断线期间没有任何等效保活。

#### Fix

未修复。标准缓解手段是引入 `chrome.alarms`（最小周期 30 s）在断线期间周期性唤醒 SW 并重试连接。**本次不实施**，原因：它会新增 `alarms` 权限，改变 manifest 的权限面，并使既有 `static-check.js` T05（断言 permissions 恰为 `["activeTab","scripting","storage"]`）失效 —— 这属于需要独立评审的设计变更，按验收规范记入 Future Improvements。

#### Regression Verification

- 已作为独立诊断脚本 `acceptance/indep/diag_sw_lifecycle.py` 保留，可随时重跑复现；
- 短间隔自动重连能力仍然成立并已被回归覆盖：`REC-02`（E2E recovery 分组）、`final_smoke.py` 步骤 16–19 全部 PASS；
- 已在 `pagesense/README.md` 的限制清单中补充说明断线超过 SW 回收阈值后需要一次浏览器交互。

---

## 13. Test Infrastructure Issues
| TI-001 | `controller/test_e2e.py` 不是 unittest 模块（只有 `if __name__ == "__main__"`）。`python -m unittest test_e2e` 报 `Ran 0 tests / NO TESTS RAN`（exit 5）。 | 会让"跑了 E2E"变成"一项都没跑"，且不报错。 | 记录；正确运行方式为 `python test_e2e.py`（本次以此方式取得 57/0）。建议后续加 `unittest.main()` 或明确文档化。 |
| TI-002 | `acceptance/browser-pipeline.js` 会**改写** `pagesense/manifest.json`（临时替换 host_permissions），依赖 `finally/catch` 还原。 | 进程被强杀时可能留下被改写的 manifest。本次实测还原正确（diff IDENTICAL）。 | 记录；建议改为写入临时目录的 manifest 副本。 |
| TI-003 | `browser-pipeline.js` E10 仍断言 shipped manifest **不含** `host_permissions` 且 permissions 恰为 `["activeTab","scripting"]`。 | 与 V2.0 manifest 不符，属陈旧断言（该用例在 V2 下必然失败）。 | 记录，未改动既有测试（避免"改断言制造 PASS"）。 |
| TI-004 | 多处 `.log` 文件（`static-check.js.log`、`content-docs-check.js.log`、`browser-pipeline.js.log`）是旧版本产物，内容与当前源码不符。 | 容易误导（例如旧日志称 permissions 仅 activeTab/scripting）。 | 记录；本次所有结论以重新执行结果为准。 |
| TI-005 | `v11/v12/pipeline-run/browser-layout` 依赖"已有一个带扩展的 Edge 在 9224/9226/9229 上运行"。Edge 在无窗口时会自行退出，导致后续套件 `ECONNRESET`。 | 顺序依赖、易误判为产品故障。 | 本次为 v12 单独重启 Edge 后取得 15/0；记录为环境限制。 |
| TI-006 | 本次独立编码期间我自己写出的测试缺陷（全部已修正，不影响产品结论）：把 `params=None` 误期望为 `None`（实际协议归一化为 `{}`）；单字符 href 用例里 `tag="a"` 自身命中了 tag 档；`clampSearchLimit([])` 的 JS 强制转换被误期望为 20；三关键词 AND 的期望顺序未按分数重算；`note()` 递归调用 `_notify`；DOM 探针的文本回退链与 `<option>` rect 规则未对齐 scanner；popup DOM 在后台标签被节流导致读到过期文本；`lastKey` 字段未在探针中暴露。 | 会制造假 FAIL。 | 逐条定位并修正探针（而非放宽断言），修正后仍保留全部严格断言。 |

---

## 14. Documentation Issues

| ID | 问题 | 建议 |
|---|---|---|
| FINDING-002 | `controller-bridge.js:542` 的 SEARCH 响应字段 `indexSize: found.total` —— `found.total` 是**命中数**，不是索引大小。该字段在任何文档中都未出现，也没有任何消费方，因此是"名字错误 + 未文档化"的语义缺陷。 | 删除该字段，或改名（如 `matchTotal` 已有 `total`，可直接移除），或补上真正的索引大小。 |
| DOC-002 | README 未提及 `elementId` 的跨标签页别名风险。 | 已在本次验收中补写（因该行为与文档描述的实际边界不一致）。 |
| DOC-003 | README 未提及 Controller 的单帧大小上限。 | 已在本次验收中补写（BUG-003）。 |
| DOC-004 | README 的搜索字段权重表列出 `placeholder` 三档，但实践中 placeholders 永远被 `text` 回退链遮蔽，该档不可达。 | 建议补一句说明（本次仅记录，未改 README 权重表）。 |
| DOC-005 | README 称 Controller 依赖 `websockets`，但没有说明 `max_size` / 帧上限这类运行期约束。 | 随 BUG-003 的说明一并补齐。 |

---

## 15. Remaining Limitations

只写本次实测确认存在的：

1. **FINDING-001（P3，未修复）**：elementId 无页面作用域，跨标签页复用会别名到另一页面的元素。已文档化。
2. **FINDING-003（P2，未修复）**：Controller 停机超过约 30 s（SW 被回收）后，扩展不会自行重连，需一次浏览器交互唤醒 SW。已文档化；建议以 `chrome.alarms` 保活/重试缓解（属设计变更，未实施）。
3. **真实扩展 Popup 窗口**：本次把 `popup.html` 作为标签页打开来驱动（这样才能用 CDP 观测）。真实弹窗的视觉表现（600px 宽度、Ctrl+K 聚焦、滚动条）只有静态/单测覆盖，未做人工目视确认。
4. **`file://` 页面**：需要用户在扩展详情页手动开启"允许访问文件网址"，无法自动验证；代码路径返回明确提示而非崩溃。
5. **`host_permissions: http://*/* , https://*/*`**：PageSense 可注入任意 http(s) 站点。这是 V2.0 无人值守模式的必要代价且已文档化，但属于应当知悉的权限面。本次**未**在任何真实业务网站上执行会产生副作用的动作（按验收规范，动作副作用只在 `demo.html` 上验证）。
6. **iframe / Shadow DOM / Canvas / 虚拟列表**：与 README 描述一致，未纳入实现范围。
7. **真实网页控制台噪声**：真实站点会有与 PageSense 无关的 console 信息；本次的"无未捕获异常"结论建立在 demo 页与 fixture 页上。
8. **`indep_*` 套件依赖一个可用的桌面 Edge 与图形会话**：无头/无桌面环境下无法执行。

---

## 16. Final Statistics

### 自动测试

```
PASS:     1045
FAIL:        2
BLOCKED:    10
MANUAL:      4
SKIP:        1
```

拆分（可由 §5 的表格逐项对应）：

| 来源 | PASS | FAIL | BLOCKED | SKIP |
|---|---:|---:|---:|---:|
| 既有套件（15 个，本次重跑） | 453 | 1 | 10 | 1 |
| 本次独立套件（5 个） | 592 | 1 | 0 | 0 |
| **合计** | **1045** | **2** | **10** | **1** |

两个 FAIL：

1. `NAV-09`（`indep_e2e.py`）→ **产品发现 FINDING-001（P3）**。
2. `E01`（`browser-pipeline.js`）→ **环境阻断**（`--load-extension` 在 puppeteer 启动的 Edge 154 上不生效），其 E02–E11 共 10 项记为 BLOCKED。**不计为产品缺陷。**

MANUAL（4）：真实业务网站的人工验收；真实 Popup 弹窗的目视确认；Service Worker 回收时机的完整生命周期；`file://` 页面（需人工开启文件访问）。

SKIP（1）：`scanner-unit` U07b（jsdom 不实现 `isContentEditable`，已由真实浏览器覆盖）。

### 缺陷

```
Product Bugs Found:  4
  P0: 0
  P1: 1   (BUG-003)
  P2: 2   (BUG-001, FINDING-003)
  P3: 1   (FINDING-001)

Product Bugs Fixed:  2   (BUG-001, BUG-003)
Product Bugs Open:   2   (FINDING-001 P3、FINDING-003 P2，均已文档化)

Test Bugs Found:            6 个自研测试缺陷（TI-006，全部修正，未放宽断言）
                            + 既有测试 3 项问题（TI-001/002/003）
Documentation Issues:       5  (FINDING-002, DOC-002..DOC-005)
Environment Limitations:    6  (§15.2–§15.4, §15.8, 以及 browser-pipeline 的加载限制)
```

### 代码变更清单（本次验收产生）

| 文件 | 变更 | 原因 |
|---|---|---|
| `controller/server.py` | 新增 `_token_bytes()`；token 比较改为 UTF-8 字节比较 | BUG-001 |
| `controller/server.py` | 新增 `MAX_MESSAGE_SIZE = 64 MiB`；`serve(..., max_size=MAX_MESSAGE_SIZE)` | BUG-003 |
| `pagesense/README.md` | "V2.0 新增限制" 增补 elementId 跨标签页风险、单帧 1 MiB 历史问题与当前上限、断线 >30 s 需一次浏览器交互 | FINDING-001 / BUG-003 / FINDING-003 文档化 |
| `acceptance/indep/*`（新增） | 独立 agent、4 个测试套件、最终 Smoke Test、5 个根因诊断脚本、一键运行器、runner | 本次独立验收资产 |
| `acceptance/evidence-v2-independent/*`（新增） | 截图、JSON 结果、性能数据、诊断数据、控制台日志 | 证据 |

未改动：`pagesense/` 下任何扩展源码（除 README）、`controller/protocol.py`、`controller/pagesense.py`、`controller/cli.py`、`PageSense-V2.0-ACCEPTANCE-REPORT.md`。

---

## 17. Final Verdict

# FAIL

PageSense V2.0 **暂时不能**作为后续 Agent Layer 的稳定 Browser Runtime 基线。

### 判定依据

PASS 条件要求"不存在 P0/P1 未解决问题"。本次验收：
- **P1 已全部修复**（BUG-003 经根因定位、一行修复与全量回归验证；BUG-001 同样已修复）。
- 核心 Runtime 正常：Extension ↔ Python 正常、SCAN 正常、SEARCH 正常、Action 正常、Reconnect 正常、完整回归通过（1045 PASS）。
- 最后执行的最终 Smoke Test 20/20 全过，且全流程无未捕获异常。

但仍有 **1 个 P3 未解决问题（FINDING-001）**，而它恰好命中 Agent Layer 最关键的安全前提：

> 验收规范要求：elementId 失效时"绝对不能根据 text/class/tag 猜测另一个元素"。
> 本次实测：跨标签页复用旧 elementId 时，PageSense 会**静默命中另一个页面上的另一个元素**并执行动作（实测触发了一次页面导航）。

这一行为与"动作必须作用于调用方指定的那个元素"直接冲突。虽然：
- 触发需要切换标签页，而 README 已告诫"运行期间请勿切换标签页"；
- 同一页面内的全部失效保证（DOM 删除 / 导航 / 刷新 / 同名元素重加）**逐项通过**，机制上也没有"按文本猜元素"的代码路径；

但在一个真实的多标签使用环境中，切换标签页是常态而非例外，而失败模式是**静默的错误动作**（而非报错），这对上层 Agent 是最危险的一类失败。因此按"只要存在阻塞 Agent Layer 的问题即 FAIL"的标准判为 FAIL。

### Blocking Issues

1. **FINDING-001（P3）**：`elementId` 缺少页面作用域。跨标签页复用旧 elementId 会别名到另一页面的元素并被静默执行（实测命中链接并触发导航）。修复方向：属性值或协议引入扫描代数 / 页面作用域（`element-map.js` 单点改动或协议扩展），并在不匹配时返回结构化错误。当前状态：已文档化，未修复。
2. **FINDING-003（P2）**：Controller 停机超过约 30 s 后扩展不会自动重连，必须有人唤醒 Service Worker。这使"长时间无人值守"的 Agent Layer 拓扑不可靠。修复方向：`chrome.alarms`（≥30 s 周期）在断线期间唤醒 SW 并重试，或在文档中把"需要一次浏览器交互"写成硬性运维要求。当前状态：已文档化，未修复。
3. **验证覆盖的完整性（MANUAL）**：真实 Popup 弹窗的目视确认、真实业务网站上的行为、`file://` 页面，本次只能部分或无法自动覆盖（§15）。这些不是已确认的缺陷，但在作出"可长期作为基线"的结论前应补齐。Service Worker 的回收时机本身已被 FINDING-003 的专门诊断覆盖。

### 解除阻塞的最小条件

1. 为 `elementId` 引入页面作用域（或在协议/桥接层校验 id 与当前活动标签页的扫描代数一致），使跨页面复用旧 id 返回结构化错误而非静默命中；
2. 为断线期的 Service Worker 提供主动唤醒/重试机制（`chrome.alarms`），使 Controller 长时间停机后扩展仍能自行恢复；若决定不实现，则必须把"需要一次浏览器交互"写入 README 的运维要求；
3. 修复后重跑 `indep_e2e.py`（258 项，`NAV-09` 转为 PASS）、`diag_sw_lifecycle.py`（B 场景转为自动恢复）以及其余 4 个独立套件保持全绿；
4. 补齐 §15 中 MANUAL 项的目视/人工确认。

---

## 附录 A：Future Improvements

以下为验收过程中识别、但**本次不实施**的改进项（按验收规范不擅自实现）：

| # | 改进项 | 依据 | 建议 |
|---|---|---|---|
| FI-01 | 为 `elementId` 增加页面作用域 | FINDING-001 | 属性值改为 `"<scanToken>:<elementId>"`（`element-map.js` 单点改动），或协议 `REQUEST` 增加 `tabId`/`scanId` 并在 SW 侧校验。**注意**：会改变已文档化的 `data-pagesense-id="<elementId>"` 格式，且 `scanner-unit` VT1 直接断言属性值。 |
| FI-02 | 断线期主动唤醒 Service Worker | FINDING-003 | 引入 `chrome.alarms`（≥30 s）在断线期间周期唤醒并重试连接。**注意**：新增 `alarms` 权限会改变 manifest 权限面，并需同步更新 `static-check.js` T05。 |
| FI-03 | 大结果的传输方式 | BUG-003 的根因 | 当前把 `max_size` 放宽到 64 MiB 已消除实际限制（64 MiB ≈ 14 万元素）。若未来要支持超大页面，可考虑分页/分块返回（`total` + `offset`），避免单帧过大。 |
| FI-04 | `indexSize` 字段 | FINDING-002 | 删除或改名；若要保留，应返回真实索引大小。 |
| FI-05 | 搜索结果单帧上限的错误显式化 | BUG-003 | 即使在 64 MiB 下，超大结果仍可能触发协议层关闭。可在 SW 侧对结果字节数做预检并返回结构化错误（如 `RESULT_TOO_LARGE`），把"静默断线"变成"可读错误"。 |
| FI-06 | 单帧容量写入文档/自检 | BUG-003 / DOC-005 | 在 `controller/README.md` 说明运行期上限，并在启动时打印。 |
| FI-07 | Popup placeholder 权重档不可达 | §6.4 观察 1 | 或调整 `SEARCH_SCORES.placeholder`，或在 README 注明该档在现有数据模型下不可达。 |
| FI-08 | `test_e2e.py` 支持 unittest 发现 | TI-001 | 增加 `unittest.main()` 入口或在 README 明确运行方式。 |
| FI-09 | `browser-pipeline.js` 不再改写 shipped manifest | TI-002/TI-003 | 使用临时目录中的 manifest 副本启动测试，并同步更新其陈旧断言（`stats.total===19`、E10 的 permissions 期望）。 |
| FI-10 | 跨标签页动作的防护 | FINDING-001 的纵深防御 | 即使不做 FI-01，也可在 Controller 侧记录"上次 SCAN 的 tabId"，当 `tabId` 变化时要求重新 SCAN。 |

---

## 附录 B：Final Smoke Test

`final_smoke.py`，在一次连续流程内完成，**无任何 mock、不使用 jsdom、不只看 `success` 字段**，每一步都读回真实 DOM。

| # | 步骤 | 结果 | 观测值 |
|---|---|---|---|
| 1 | 全新 Controller 启动 | PASS | `server.connected == False` |
| 2 | 重新加载扩展（`chrome.runtime.reload()`）后自动 CONNECTED | PASS | 4 s 内恢复 |
| 3 | CONNECT：桥接状态与版本 | PASS | `state=CONNECTED, version=2.0.0` |
| 4 | 活动页面为 `demo.html` | PASS | `tabId` + `url` 匹配 |
| 5 | SCAN 返回真实 DOM 数据 | PASS | `stats.total == elements.length` |
| 6 | SCAN 元素与真实 DOM 映射一致 | PASS | 映射数 == `stats.total` |
| 7 | SEARCH 命中且 elementId 指向真实节点 | PASS | 命中节点 `text == "立即沟通"` |
| 8 | 取得 input/click 的 elementId | PASS | 来自真实 `data-pagesense-id` |
| 9 | HIGHLIGHT：1 个 overlay 且矩形贴合 | PASS | 同帧采样 delta ≤ 3px；截图 `final-smoke-highlight.png` |
| 10 | INPUT 后真实 DOM value 正确 | PASS | `value == "AI应用工程师"` |
| 11 | CLICK 使真实计数器 +1 | PASS | `0 → 1` |
| 12 | KEYPRESS Enter 被真实页面记录 | PASS | `#lastKey == "Enter"` |
| 13 | SCROLL down 真实改变 scrollY | PASS | `scrollY > 0` |
| 14 | 再次 SCAN 与真实 DOM 一致 | PASS | stats == elements == mapped |
| 15 | 最终 DOM 状态正确 | PASS | 输入保留、overlay=0、映射 id 无重复 |
| 16 | 停止 Controller 后离开 CONNECTED | PASS | `state != CONNECTED` |
| 17 | 不停留在假连接 | PASS | — |
| 18 | 重启 Controller 后自动 CONNECTED | PASS | 1 s 内恢复 |
| 19 | 重连后再次 SCAN 正常 | PASS | — |
| 20 | 全流程无未捕获异常 / 未处理 rejection | PASS | `final-smoke-console.log` 为空 |

**20 PASS / 0 FAIL**

---

## 附录 C：证据清单

`acceptance/evidence-v2-independent/`

| 文件 | 内容 |
|---|---|
| `popup-connected.png` | Popup 界面显示 `● 已连接` 的截图 |
| `highlight-overlay.png` | 真实页面上的高亮 overlay 截图 |
| `final-smoke-highlight.png` | 最终 Smoke Test 的高亮截图 |
| `indep-e2e-results.json` | 独立 E2E 全部 258 项结果（含分组、详情） |
| `final-smoke-steps.json` | 最终 Smoke Test 20 步结果 |
| `final-smoke-console.log` | Smoke Test 期间浏览器控制台输出（空 = 无异常） |
| `console-errors.log` | 完整 E2E 期间的控制台记录（仅 favicon 404 噪声） |
| `search-performance.json` | 真实浏览器 100/500/1000/5000 元素的 buildIndex/search 实测 |
| `search-performance-unit.json` | jsdom 下的纯逻辑性能数据 |
| `bug003-fix-verify.json` | BUG-003 修复验证 + **真实入站帧字节数** |
| `scan-boundary.json` | BUG-003 边界bisect（元素数 / 文本长度两个维度） |
| `size-vs-count.json` | 「元素数量 vs 负载大小」判别实验 |
| `scan-threshold.json` | 阈值定位 + 大页面 PING-only 对照 |
| `ws-drop-diagnostic.json` | 首轮断开诊断（含 SW 重启判别） |
| `ws-drop-cause.json` / `ws-drop-cause2.json` | close code / 扩展侧状态时间线 / SW target 判别 |
| `large-page-diagnostic.json` | 1000→5000 元素逐档断开记录 |
| `sw-lifecycle.json` | FINDING-003：短/长停机 + 不同唤醒方式的重连实测（3 次复现） |

复现命令：

```bash
cd acceptance/indep

# 独立单元（jsdom，无需浏览器）
node indep_unit.js

# 断线 / Service Worker 生命周期诊断（复现 FINDING-003）
python diag_sw_lifecycle.py

# 独立协议/安全（无需浏览器）
python indep_protocol.py

# 独立真实 E2E（自行启动 demo server + Controller + Edge + 扩展）
bash run_indep_e2e.sh

# 独立 CLI 验收（需要已连上 Controller 的 agent 在 8799）
python indep_cli.py

# 最终 Smoke Test（需要 agent 在 8799）
python final_smoke.py
```

> 环境注意：本机 Edge 154 下，`--load-extension` 只在**直接启动** `msedge.exe` 时生效；由 puppeteer 默认启动器发起的 Edge 会忽略该参数（加 `--enable-unsafe-extension-debugging` 也无效）。因此独立 agent 采用"自行 spawn Edge + `puppeteer.connect()`"的方式，并用 CDP target 列表（而非 Preferences 文件）发现扩展 ID。
