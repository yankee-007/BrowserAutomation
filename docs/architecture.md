# 当前架构

## 系统边界与模块

系统由 `pagesense/` 扩展和 `controller/` Python 服务组成，`acceptance/` 是测试设施。当前没有模型服务、Planner、数据库或部署编排。

| 模块 | 实际职责 |
| --- | --- |
| `manifest.json` | MV3 入口、2.0.0 版本、`activeTab/scripting/storage/sidePanel` 与 HTTP(S) host permissions；`side_panel.default_path` 指向现有界面 |
| `popup/popup.html`、`popup.js`、`popup.css` | 原生侧栏界面、手动/实时扫描、结果展示/搜索/过滤、人工 Action、连接配置；所属窗口内切换/导航后使旧结果与异步响应失效 |
| `shared/constants.js` | Action/Method/错误码、搜索配置、Bridge 配置与消息常量 |
| `content/element-map.js`、`scanner.js` | 三种扫描范围、同文档节点 ID、18 类与属性/正文/CSS 路径提取、按需详情 |
| `content/element-search.js` | 纯快照索引，多词 AND、结构/分类/视口过滤、offset 分页与真实 indexSize |
| `content/highlighter.js`、`action-executor.js` | 定位/Overlay，五类操作与结构化回执 |
| `content/element-picker.js` | Port 生命周期的页面点选层、命中测试、事件拦截和选择/取消回传 |
| `content/content.js` | 消息路由、重扫与索引更新；实时 Port 订阅和事件合并、统一错误响应 |
| `background/service-worker.js`、`bridge/controller-bridge.js` | Worker 连接管理、认证、心跳/重连、活动 Tab 与协议转发 |
| `controller/server.py`、`protocol.py` | 本地 WebSocket 服务、认证、请求 ID/超时、信封与错误码 |
| `controller/pagesense.py`、`cli.py` | `PageSenseClient` 同步 API 与人工命令解析 |
| `acceptance/content-files.js` | 从 Popup 和 Bridge 提取注入列表并核对一致性，仅属测试设施 |

## 关键数据流与调用关系

```text
用户 → 原生侧栏 → chrome.tabs / scripting → Content Script → DOM

人工 CLI / PageSenseClient
        ↓
Python Controller（WebSocket Server，默认 127.0.0.1:8765）
        ↕ HELLO/token、REQUEST/RESPONSE、HEARTBEAT
扩展 Service Worker → Controller Bridge（WebSocket Client）
        ↓ 按需注入、tabs.sendMessage
Content Script Router → Scanner / Search / Highlighter / Action Executor
        ↓
网页 DOM
```

注入依赖顺序：`shared/constants.js` → `content/element-map.js` → `scanner.js` → `element-search.js` → `highlighter.js` → `action-executor.js` → `element-picker.js` → `content.js`。Popup 与 Bridge 维护对应列表，测试提取后交叉核对；新增模块时保持一致。

SCAN 建立映射和搜索索引；每次扫描重建快照。无实时订阅时重扫仍清高亮；
Content Router 调用 Scanner 时始终用 WeakMap 保留同文档存活节点 ID，范围切换也保留，
新增 ID 递增、移除 ID 不复用，
使尚未刷新的卡片不会因同页自动重排而命中其他节点。SEARCH 读取最近扫描快照，
不逐次全 DOM 扫描。CSS 条件例外：Content Router 先调用原生 querySelectorAll，
将命中节点已有的映射 ID 传给纯快照 Search 求交，不建立第二套映射。
动作经同一个 Executor 执行，返回包含 success/error、actionId、
耗时及建议重扫等信息。Python 请求按 id 关联，默认超时 10 秒。

侧栏通过 `tabs.connect` 订阅当前文档；Content Router 持有 MutationObserver 与
input/change、scroll/resize 监听，300ms 合并变化后复用 Scanner/Search 并通过 Port
发送完整快照。忽略自身 ID 属性和 Overlay 变动，空闲时不轮询。最后一个 Port 断开时
释放 observer、事件和待执行计时器；侧栏关闭、切页或导航都会断开旧连接。
实时开关只存在于本次侧栏会话；连接代次和 pageRevision 丢弃旧页/旧连接响应。
侧栏保存存活节点的操作输入草稿、焦点和滚动位置，再重绘更新后的卡片；
composition 期间仅保留最新待更新快照，组词结束后再重绘。

侧栏默认 content 范围，提供分组/细分类与查询条件、每页 50/100 条和完整总数。
CSS 条件经带代次的异步查询取得当前映射集合，页面变化后重新匹配；过时响应被丢弃。
详情展开时调用 GET_ELEMENT_DETAILS 读取当前 DOM；属性、CSS、父子上下文和
文本/HTML 片段不随每次扫描反复展开。Scanner 的 CSS 路径利用唯一 ID 或缓存的祖先/
nth-of-type 路径，避免对每个节点重复全页试探选择器；正文索引最多 20000 字符，
结构容器只索引自身文字，减少父子重复。

页面点选使用独立 `pagesense-element-picker` Port；Router 交给 Picker 管理单文档单会话。
Picker 的全视口透明选择层捕获指针点击，临时关闭其命中属性后以 elementFromPoint 取下方节点，
预览框/标签均不接收事件；这样 iframe 内部点击也只选择外层。按需复用 Scanner.inspectTarget，
分配同文档 ID 并读取现有详情，不全页扫描、不改变范围/索引。
侧栏独立显示所选快照，通过连接代次/pageRevision 防止迟到结果，Esc 和页面/侧栏关闭清理监听与 Overlay。
选中快照不跟随实时扫描刷新；点选节点若在后续扫描范围之外，其临时映射可能被清理。

侧栏选择所属窗口的活动 Tab，切换/导航后清空旧结果并丢弃迟到响应；开启实时模式时在新页就绪后重新连接。Controller 仍按当前活动 Tab 转发，elementId 不包含页面作用域；Controller 结构未提供跨标签页旧 ID 防误用保证。Controller 可传 scope 和结构/分页条件，新增 GET_ELEMENT_DETAILS；所有 DOM 工作仍走同一 Content Router。MV3 Worker 回收后内存计时器消失，长断线自恢复仍有已有缺陷。

## 状态、持久化与外部依赖

- `chrome.storage.local`：连接 host/port、用户输入 token、autoconnect。token 属本机敏感配置，不随治理文档交付。
- 内存：DOM 映射、扫描/搜索快照、Overlay、待响应请求、最近请求/Action 日志。页面刷新、重扫、Popup/Worker 生命周期会影响各自状态；不能把内存状态当作持久任务记录。
- Python：`websockets`，无数据库/Web 框架/LLM SDK；当前代码调用 `websockets.asyncio.server.serve`，清单下限是否覆盖该 API 未在本轮验证。
- 浏览器：真实 Chrome/Edge API、DOM 与本地 WebSocket；64 MiB 是 Python 当前入站消息上限，不宣称端到端无限容量。
- 测试：jsdom / puppeteer-core、Edge 可执行文件、可用端口、临时 profile 和静态页面服务器。代码路径不直接依赖测试中的 CDP。

## 验证依据与未确定内容

依据为当前 manifest、Worker/Bridge、Content Router、Python Server/API、两个既有 README 和验收资产。当前实现与历史演进摘要见[上下文](../PROJECT_CONTEXT.md)。

侧栏入口与生命周期已在独立 Edge 无界面实例中验证，含 demo 扫描/搜索/高亮、切换与刷新清理和窄栏布局；证据见 `acceptance/evidence-side-panel/`。真实工具栏点击和用户浏览器中的显示位置待人工确认。既有独立验收的 FAIL、Controller 跨标签页旧 ID 风险及长断线问题仍保持原状态；indexSize 语义已在当前元素查询任务修复。现有报告含旧目录 `csss`，不迁移或改写历史报告。

实时模式的动态更新、节流、稳定 ID、草稿/焦点、暂停/关闭和切换/导航恢复已在独立 Edge 原生侧栏验证；
证据见 `acceptance/evidence-live-scan/`，不替代完整 Controller 或用户个人浏览器验收。

元素查询的三种范围、分页、CSS/属性/标签/class、详情、实时 CSS 更新与 Python/WebSocket 路径
见 `acceptance/evidence-element-explorer/`，设计与后续优先级见[元素查询说明](element-explorer.md)。

页面点选与其生命周期证据见 `acceptance/evidence-element-picker/`；仅在合成测试页面与独立配置中验证，
未在用户个人浏览器代为重新加载扩展。

本文仅记录真实存在的当前结构。空项目可明确尚未形成架构，不要求预设 UI、服务、模型或存储层。长期选择的理由见 [决策记录](decisions/README.md)。
