# PageSense V2.0 开发与验收报告

- **项目**：PageSense（Chrome / Edge + Manifest V3 + 原生 JavaScript）
- **版本**：1.2.0 → **2.0.0**
- **日期**：2026-09-29
- **验收环境**：Microsoft Edge 154.0.4258.37 / Chromium 154 · Python 3.14.6 · websockets 17.1 · Node v24.18.0
- **结论**：**可以进入 V2.0 人工验收**

---

## 1. 架构

```
Python Controller                    controller/server.py
      ↕                              ws://127.0.0.1:8765  (WebSocket Server)
   WebSocket
      ↕
Extension Service Worker             background/service-worker.js
      ↕                              bridge/controller-bridge.js (WebSocket Client)
   chrome.tabs.sendMessage
      ↕
Content Script                       content/content.js
      ├── scanner.js                 SCAN
      ├── element-search.js          SEARCH
      ├── highlighter.js             LOCATE / HIGHLIGHT
      └── action-executor.js         CLICK / INPUT / CLEAR / KEYPRESS / SCROLL
      ↕
   Browser DOM
```

扩展永远是 **client**，Python 永远是 **server**（扩展无法监听端口，MV3 也禁止常驻后台页）。
长连接由 Service Worker 持有，Popup 只通过 `chrome.runtime.sendMessage` 控制。

桥接是**纯传输层**：收到 `CLICK_ELEMENT` 后翻译成 V1.2 的 Content Script Action，
由同一个 Action Executor 执行，不新建第二套 Action。

---

## 2. 修改文件

### 新增

| 文件 | 说明 |
|---|---|
| `pagesense/content/element-search.js` | V2 Element Search：索引、匹配、排序 |
| `pagesense/bridge/controller-bridge.js` | WebSocket client：握手 / 重连 / 心跳 / 方法分发 |
| `pagesense/background/service-worker.js` | MV3 Service Worker：持有 Bridge、响应 Popup 控制 |
| `controller/server.py` | WebSocket Server（仅回环地址）+ token 认证 |
| `controller/protocol.py` | 信封、方法名、错误码 |
| `controller/pagesense.py` | `PageSenseClient` 高级 API |
| `controller/cli.py` | 人工交互 CLI（无 LLM） |
| `controller/requirements.txt` | 仅 `websockets` |
| `controller/README.md` | Controller 使用文档 |
| `controller/test_bridge.py` | 桥接协议单元测试 |
| `controller/test_cli.py` | CLI 单元测试 |
| `controller/test_e2e.py` | 真实扩展 ↔ Python E2E |
| `acceptance/serve.js` | demo 静态服务器 |
| `acceptance/content-files.js` | 注入清单唯一事实来源 |
| `acceptance/v2-browser-agent.js` | E2E 浏览器侧 agent |
| `acceptance/v2-search-unit.js` | V2 搜索单元测试 |
| `acceptance/v2-popup-ui.js` | V2 Popup UI 测试 |

### 修改

`pagesense/manifest.json`（1.2.0 → 2.0.0）、`pagesense/shared/constants.js`、
`pagesense/content/content.js`、`pagesense/popup/{popup.html,popup.css,popup.js}`、
`pagesense/README.md`

### 未改动（V1 稳定模块原样保留）

`content/scanner.js`、`content/element-map.js`、`content/highlighter.js`、
`content/action-executor.js`

### 测试适配（未删除任何测试）

`static-check.js`、`popup-ui.js`、`content-docs-check.js`、`pipeline-run.js`、
`v11-browser.js`、`v12-browser.js`

---

## 3. Search

- **字段**：`text / value / placeholder / aria-label / title / alt / tag / role / id / className / href`
- **标准化**：`normalizeSearchText()` = trim → 折叠连续空白（含全角空格）→ 小写。
  中文没有大小写，因此不被破坏
- **多关键词**：按空格切分，**AND** 语义（每个词都必须命中），分数为各词最高档之和
- **排序**：分数降序 → `elementId` 升序（DOM 顺序）作为稳定 tie-break
- **limit**：默认 20，上限 100，超出夹取；返回 `total` 与 `truncated`
- **空 query**：返回最近一次扫描的全部元素（score 0，DOM 顺序），不报错 —— 语义已在 README 固定
- **生命周期**：索引与最近一次 SCAN 绑定，重扫即销毁重建；索引失效返回 `NO_SCAN_DATA`
- **性能**：1000 元素 build 2ms / search 1ms

### 相关度权重

| 字段 | exact | startsWith | contains |
|---|---:|---:|---:|
| text | 100 | 80 | 60 |
| aria-label | 55 | 45 | 30 |
| placeholder | 50 | 40 | 25 |
| title / value | 45 | 35 | 22 |
| alt | 40 | 30 | 20 |
| id | 45 | 30 | 20 |
| role | 40 | 28 | 18 |
| tag | 35 | 25 | 18 |
| className | 25 | 22 | 20 |
| href | 12 | 11 | 10 |

> `href` 仅在关键词长度 ≥ 2 时参与匹配，否则搜索单字母 `a` 会命中页面上每一条链接。

### Search Index 模块职责

`content/element-search.js` 独立导出：

```javascript
buildIndex(elements, scannedAt)   // 建立索引
search(query, options)            // 查询（含 type 过滤、limit）
clearIndex()                      // 销毁索引
getIndexInfo()                    // { valid, size, indexedAt }
```

---

## 4. WebSocket Protocol

### 请求 / 响应

```json
// Python → Extension
{ "id": "req_001", "type": "REQUEST", "method": "SEARCH_ELEMENTS",
  "params": { "query": "立即沟通", "limit": 20 } }
```

```json
// Extension → Python
{ "id": "req_001", "type": "RESPONSE", "success": true,
  "result": { "total": 1, "results": [
    { "elementId": 4, "score": 100, "matchedFields": ["text"] } ] } }
```

```json
// 错误
{ "id": "req_002", "type": "RESPONSE", "success": false,
  "error": { "code": "RESTRICTED_PAGE",
             "message": "当前页面不允许扩展注入（RESTRICTED_SCHEME:edge:）。" } }
```

### HELLO 握手

```json
{ "type": "HELLO", "protocol": "pagesense/1", "client": "extension",
  "version": "2.0.0", "token": "<用户输入的 token>" }
```

```json
{ "type": "HELLO_ACK", "success": true }
```

### 方法

`PING` · `GET_STATUS` · `SCAN_PAGE` · `SEARCH_ELEMENTS` · `LOCATE_ELEMENT` ·
`HIGHLIGHT_ELEMENT` · `CLEAR_HIGHLIGHT` · `CLICK_ELEMENT` · `INPUT_ELEMENT` ·
`CLEAR_ELEMENT` · `KEYPRESS_ELEMENT` · `SCROLL_PAGE`

请求 id 唯一、响应按 id 关联（不依赖到达顺序）、每请求 10s 超时。

---

## 5. Python API

```python
scan()                                  # page / stats / elements / tabId / url / title
search(query, limit=None)               # { total, results: [...] }
locate(element_id)
highlight(element_id)
clear_highlight()
click(element_id)
input(element_id, value)
clear(element_id)
keypress(element_id, key)
scroll(direction, amount)
ping()
get_status()
start() / stop() / wait_for_extension(timeout)
```

失败抛出 `protocol.PageSenseError`，`err.code` 为协议错误码。

---

## 6. 自动测试

| ID | 测试 | 状态 | 实际证据 |
|---|---|---|---|
| static-check | 静态架构 / 安全 / 权限（T01–T48b） | **72 PASS / 0 FAIL** | `STATIC CHECK SUMMARY: ALL PASS` |
| scanner-unit | V1 Scanner | **32 PASS / 0 FAIL** | `SCANNER UNIT SUMMARY: ALL PASS` |
| highlighter-unit | V1.1 Mapping / 高亮 | **10 PASS / 0 FAIL** | `HIGHLIGHTER UNIT SUMMARY: ALL PASS` |
| action-unit | V1.2 Action | **33 PASS / 0 FAIL** | `ACTION UNIT SUMMARY: ALL PASS` |
| popup-ui | Popup 搜索 / 筛选 | **20 PASS / 0 FAIL** | `POPUP UI SUMMARY: ALL PASS` |
| content-docs-check | 文档 / 布局 / 权限一致性 | **40 PASS / 0 FAIL** | `CONTENT/DOCS SUMMARY: ALL PASS` |
| v2-search-unit | V2 Search 正确性 + 性能 | **73 PASS / 0 FAIL** | `V2 SEARCH UNIT SUMMARY: ALL PASS` |
| v2-popup-ui | V2 Popup UI + Controller 面板 | **32 PASS / 0 FAIL** | `V2 POPUP UI SUMMARY: ALL PASS` |
| test_bridge | 桥接协议单元测试 | **15 tests OK** | 信封 / id / 乱序 / 超时 / token / 绑定 |
| test_cli | CLI 命令与无自动化 | **20 tests OK** | `Ran 20 tests ... OK` |
| pipeline-run | V1 真实扩展管线 | **8 PASS / 0 FAIL** | `PIPELINE RUN SUMMARY: ALL PASS` |
| v11-browser | V1.1 真实浏览器 | **9 PASS / 0 FAIL** | `V1.1 BROWSER SUMMARY: ALL PASS` |
| v12-browser | V1.2 真实浏览器 | **15 PASS / 0 FAIL** | `V1.2 BROWSER SUMMARY: ALL PASS` |

---

## 7. Extension ↔ Python E2E

**真实 Microsoft Edge 154 + 真实 PageSense 扩展 + 真实 Python Controller**
**57 PASS / 0 FAIL**

| ID | 项目 | 结果 |
|---|---|---|
| E2E-01 | CONNECT + HELLO/HELLO_ACK；Popup 显示 CONNECTED / 2.0.0 / 127.0.0.1:8765 | PASS |
| E2E-02 | PING → PONG（携带扩展版本） | PASS |
| GET_STATUS | 返回连接状态 + 活动页面 | PASS |
| E2E-03 | SCAN 返回真实 page / stats / 28 elements / tabId / url / title | PASS |
| E2E-04 | SEARCH（中文 / 空 query / limit / 无结果 / matchedFields） | PASS |
| E2E-05 | HIGHLIGHT 真实出现 Overlay=1；CLEAR_HIGHLIGHT 后 =0 | PASS |
| E2E-06 | INPUT 后真实 `input.value === "Python Controller"`；contenteditable 同样生效 | PASS |
| E2E-07 | CLICK 使 demo 计数器 +1（连续 5 次精确） | PASS |
| E2E-08 | KEYPRESS 页面记录 `lastKey === "Enter"` / `"ArrowDown"`；非法键 INVALID_KEY | PASS |
| E2E-09 | SCROLL 真实 `scrollY` 变化；非法 direction → INVALID_VALUE | PASS |
| E2E-10 | 关闭 Server → 扩展离开 CONNECTED；重启 → **自动恢复 CONNECTED** | PASS |
| E2E-11 | `chrome.runtime.reload()` → **自动重建 WebSocket**，未重启浏览器 | PASS |
| E2E-12 | `edge://extensions` 上 SCAN → RESTRICTED_PAGE，Controller 不崩溃 | PASS |
| PROTO-01..04 | UNKNOWN_METHOD / INVALID_ELEMENT_ID / ELEMENT_NOT_FOUND / 请求日志 | PASS |
| QUEUE-01/02 | 逐个请求逐个响应、actionId 唯一 | PASS |

### 真实 CLI 会话

`python server.py` → 浏览器扩展连接 → 人工输入命令：

```
PageSense Controller
Listening: 127.0.0.1:8765
Token: CLITESTTOKEN0001

Waiting for extension...

输入 help 查看命令。

>
PageSense connected
version=2.0.0
> scan
28 elements
> search 立即沟通
1 results

#4 BUTTON
立即沟通
score=100
matched=text

> search Action 输入测试
1 results

#25 INPUT
Action 输入测试
score=140
matched=text

> highlight 4
SUCCESS (#4)
> input 25 AI应用工程师
SUCCESS (value="AI应用工程师")
> click 4
SUCCESS (#4)
> status
connected=True version=2.0.0 endpoint=ws://127.0.0.1:8765
active tab #1427752456 http://127.0.0.1:8770/test/demo.html
> quit
Bye.
```

---

## 8. Security

### localhost

- `ControllerServer` 硬性拒绝 `0.0.0.0` / 局域网 IP / 主机名，只接受 `127.0.0.1` 与 `localhost`
- `test_bridge.TestSecurity` 实测：非回环地址抛 `ValueError`；默认绑定后外部 IP 无法建立连接
- 扩展源码中不存在 `0.0.0.0`（静态检查 T40b 断言）

### token

- Controller 每次启动用 `secrets.token_hex(8)` 生成随机 token，`secrets.compare_digest` 比较
- token 错误 → `HELLO_ACK { success: false, error.code: UNAUTHORIZED }` 并关闭连接
- **源码中不存在 token 字面量**（静态检查 T41 断言）
- token 仅来自用户输入并存入 `chrome.storage.local`（T41b）

### permissions

| 权限 | 用途 | 为什么必要 |
|---|---|---|
| `activeTab` | 点击扩展图标后访问当前页面 | V1 起的能力，保持最小化 |
| `scripting` | 按需注入 Content Script | V1 起的能力，不常驻注入 |
| `storage`（新增） | 保存 Controller 的 host / port / token | MV3 Service Worker 会被随时回收，连接配置必须持久化，否则每次回收都要用户重新输入 |
| `host_permissions: http://*/*, https://*/*`（新增） | 在活动标签页注入 Content Script | V1.2 之前由用户点击触发（activeTab 生效）；V2 的 Controller 是**无人值守**的，注入时没有用户手势，`activeTab` 无法授权 |

**未申请**：`debugger`、`cookies`、`webRequest`、`tabs`、`history`、`management`、
`downloads`、`browsingData`、`privacy`。

### 数据

请求日志只在扩展内存中保留最近 20 条 method / 时间 / 结果，页面内容不写入 storage。

---

## 9. V1 / V1.1 / V1.2 回归

全部重跑通过，**零回归**：

| 范围 | 测试 | 结果 |
|---|---|---|
| Scanner / Mapping | scanner-unit + pipeline-run | 32 + 8 PASS |
| Highlight / Locate | highlighter-unit + v11-browser | 10 + 9 PASS |
| Action Executor | action-unit + v12-browser | 33 + 15 PASS |
| Popup | popup-ui + v2-popup-ui | 20 + 32 PASS |
| 20×Scan | pipeline-run E08 | PASS |
| 20×CLICK / 20×INPUT | v12-browser V12-20C / V12-20I | PASS |
| DOM removal / disabled | v12-browser E2E-06 / V12-D | PASS |
| scroll / keyboard | v12-browser E2E-05 / E2E-03 | PASS |

---

## 10. 发现的问题

### 产品问题

1. **Controller 无法在无用户手势时注入** —— V1.2 之前靠点击扩展图标触发 `activeTab`，
   V2 的 Python 侧是无人值守的，`activeTab` 无法授权。→ 必须新增 `host_permissions`。
2. **Popup 不能持有长连接** —— MV3 Popup 关闭即销毁；且扩展不能作为 WebSocket Server。
   → 连接必须归 Service Worker，方向必须是扩展连 Python。
3. **`content.js` 对 `element-search.js` 产生静默强依赖** —— 部分注入时会抛 TypeError 而非明确错误。

### 测试问题

4. `v11-browser.js` 的 `VT0b` 期望 23 个元素，是 V1.1 时代的陈旧断言
   （V1.2 demo 增加第 10 节后实际为 28）。
5. `pipeline-run.js` / `v11-browser.js` / `v12-browser.js` **各自硬编码了一份注入文件清单**，
   V2 新增模块后三份同时过期。
6. `content-docs-check.js` 的 `R14` 断言 `permissions.length === 2`、
   `R15` 依赖已被改写的旧章节。
7. `static-check.js` 的 `T05` 断言权限集合恰为 2 项、`T13b` 断言六文件注入顺序 —— V2 必然改变。
8. 本次新写的 E2E 断言中有 4 处期望错误（详见第 11 节第 8 条）。
9. E2E 浏览器 agent 用 `url.includes("/test/demo.html")` 找页面，命中了上一轮遗留的
   **死标签页**（8765 静态服务器已关闭，页面为错误页），导致扫描到 0 个元素。

### 浏览器限制

10. 无 `tabs` 权限时，`edge://` 等页面的 `tab.url` 为空 —— 该集合恰好等于
    「必须拒绝注入」的集合，因此 `inspectUrl("")` 判为 restricted，无需申请 `tabs`。
11. MV3 Service Worker 会被浏览器随时回收；心跳只能显著降低概率，无法完全避免。
12. `chrome-extension://` 页面上的 SCAN 会被 `inspectUrl` 按 `RESTRICTED_SCHEME` 正确拦截。

---

## 11. 已修复

1. 新增 `host_permissions: http://*/*, https://*/*` 并在 README 说明必要性（仅 http/https，不含 file://）。
2. 连接、重连、心跳全部放进 Service Worker；Popup 只用消息控制。
3. `content.js` 的索引构建改为显式依赖的 `NO_SCAN_DATA` 语义。
4. `VT0b` 期望值更正为 28，并注释说明 23 + 5 的来源。
5. **新增 `acceptance/content-files.js`**：从 `popup/popup.js` 与 `bridge/controller-bridge.js`
   读取注入清单并交叉校验，三个浏览器测试改为引用它 —— 这类漂移不会再发生。
6. `R14` 改为「manifest 每个权限都在 README 有说明 + host_permissions 有用途」；
   `R15` 改为断言 V2 明确声明不实现 LLM / Agent / Action Queue / 自动任务。
7. `T05` / `T13b` / `T10` 更新为 V2 事实，并新增 T35–T48b 共 **46 项 V2 静态检查**。
8. 4 处 E2E 期望修正：
   - `matchedFields` 应为 `text`（scanner 的 text 会回退到 placeholder，精确匹配优先 text）
   - `HIGHLIGHT` / `LOCATE` 用的是 V1.1 契约 `{success, elementId}`，不是 V1.2 信封
   - 同分排序用例设计有误（其中一个元素实际是 prefix 命中）
   - 搜索性能检查对注释里的英文单词 `document.` 误报，改为剥离注释后再检测
9. E2E agent 改为精确匹配 `DEMO_URL` 并清理陈旧标签页。
10. agent 端口占用时自动顺延并在 READY 行回报真实端口；
    `ControllerServer.start()` 现在会把绑定失败的原因抛出，而不是静默超时。
11. CLI `input` 命令支持带空格的值；非法 elementId 与协议错误被捕获并打印，不会中断 REPL。

---

## 12. MANUAL（人工验收）

```bash
# 1) 启动静态服务器（demo 页）
cd acceptance && node serve.js 8765

# 2) 启动 Controller
cd controller && pip install -r requirements.txt && python server.py
#    记下打印的 Token

# 3) 浏览器加载 pagesense/ 扩展
#    edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选择 pagesense 目录
#    打开 http://127.0.0.1:8765/test/demo.html

# 4) 点扩展图标 → 展开 Controller 面板 → 填 Token → 点击「连接 Controller」
#    期望：● 已连接  127.0.0.1:8765
#          终端出现 "PageSense connected  version=2.0.0"

# 5) Popup 内验证 Element Search
#    Ctrl+K 聚焦 → 输入「沟通」→ 期望只剩「立即沟通」卡片
#    卡片显示「匹配：text · score: 60」
#    状态行显示「扫描元素：28 个 · 搜索结果：1 个」
#    点 × 恢复全部；再试 类型=Button + 输入「搜索」验证 AND 逻辑

# 6) 终端验证 CLI
> scan                    → 28 elements
> search 沟通             → #4 BUTTON / 立即沟通 / score=60 / matched=text
> highlight 4             → SUCCESS (#4)，浏览器出现蓝色高亮框
> input 25 AI应用工程师    → SUCCESS，demo 输入框回显 AI应用工程师
> click 4                 → SUCCESS

# 7) 断线重连
#    Ctrl+C 停掉 server.py → Popup 圆点变灰、显示未连接
#    重启 server.py（使用同一 --token）→ 期望自动恢复 ● 已连接，无需重启浏览器

# 8) 受限页面
#    切到 edge://extensions → 终端执行 scan
#    期望：ERROR RESTRICTED_PAGE，Controller 不崩溃
```

> **端口注意**：WebSocket 使用 8765，因此 demo 静态服务器若也需 8765，
> 请先关闭 Controller；或把 demo 放到其它端口（`node serve.js 8770`）。

---

## 13. 当前限制

- Controller 只操作**当前活动标签页**，不支持指定 tabId 或后台标签；
  运行期间切换标签页会打到切换后的页面
- 同一时刻只支持一个 Controller 会话（新连接顶替旧连接）
- 搜索只覆盖最近一次扫描结果；页面变化后必须重新扫描
- 搜索是子串匹配，不做分词 / 拼音 / 模糊 / 纠错 / 正则 / XPath / CSS 选择器表达式
- 只监听回环地址，不支持远程 Controller
- `file://` 不在 `host_permissions` 范围内，Controller 无法注入（Popup 手动扫描仍可用）
- 页面导航后旧的 elementId 全部失效，必须重新 `SCAN_PAGE`
- Service Worker 被回收时连接断开，靠指数退避重连恢复（心跳降低概率但不能根除）
- 跨域 iframe、Shadow DOM、Canvas/WebGL 内容与 V1 一致，仍不在扫描范围
- `acceptance/.edge-profile/` 与 `acceptance/node_modules/` 为测试产物，非交付内容

---

## 14. 尚未实现

以下能力在 V2.0 **明确未实现**：

| 类别 | 具体项 |
|---|---|
| LLM | OpenAI / DeepSeek / Qwen / Ollama |
| Agent 框架 | LangChain / LangGraph |
| Agent / Planner | 自然语言理解、任务规划、自动决策 |
| Action Queue | `Action ↓ Observe ↓ Action` 串行编排、任务状态机 |
| 批量执行 | 一次提交多个 Action |
| 自动任务 | 自动登录、自动投递、自动填写提交 |
| 自动元素选择 | `click "立即沟通"` 这类 search-and-click 复合命令 |

V2.0 只交付 **Browser Runtime（感知 / 搜索 / 定位 / 操作）+ Controller Transport**，
把「决定做什么」留给使用者或未来的独立 Agent 层。

CLI **故意不提供** search-and-click：自动「搜索 → 选第一条 → 点击」会在用户
没有确认目标的情况下产生误操作。流程被强制拆成 `search`（人看结果）→
`click <elementId>`（人指定唯一目标）。

---

## 15. 最终结论

**可以进入 V2.0 人工验收。**

- 全部 **355 项**自动检查通过，其中包含 **57 项真实 Edge ↔ Python E2E**、
  **20 项 CLI 单元测试**、**15 项桥接协议测试**
- 三个浏览器验收套件（V1 / V1.1 / V1.2）全部重跑通过，**零回归**
- 无已知阻塞缺陷

### 验收清单对照

- [x] version 2.0.0
- [x] V1/V1.1/V1.2 无回归
- [x] Element Search 独立模块
- [x] 中文搜索正常
- [x] 多关键词正常
- [x] 搜索相关度排序正常
- [x] Search + Filter 正常
- [x] `SEARCH_ELEMENTS` 协议完成
- [x] Python WebSocket Server 完成
- [x] 只监听 localhost
- [x] Token 验证完成
- [x] Extension Bridge 完成
- [x] Service Worker 生命周期处理
- [x] 自动重连
- [x] Controller 状态 UI
- [x] Python PageSenseClient
- [x] Python CLI
- [x] `scan()` / `search()` / `locate()` / `highlight()` / `click()` /
      `input()` / `clear()` / `keypress()` / `scroll()`
- [x] Request ID
- [x] Timeout
- [x] 真实 Extension ↔ Python E2E
- [x] Reconnect E2E
- [x] Restricted Page E2E
- [x] README 完成
