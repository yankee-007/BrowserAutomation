# 当前架构

## 系统边界与模块

系统由 `pagesense/` 扩展和 `controller/` Python 服务组成，`acceptance/` 是测试设施。当前没有模型服务、Planner、数据库或部署编排。

| 模块 | 实际职责 |
| --- | --- |
| `manifest.json` | MV3 入口、2.0.0 版本、`activeTab/scripting/storage/sidePanel/nativeMessaging` 与 HTTP(S) host permissions；`side_panel.default_path` 指向现有界面 |
| `popup/popup.html`、`popup.js`、`popup.css` | 三工作区、元素几何分布、手动/实时扫描、结果查询/检查与 Python 代码生成、主动发送及连接配置；所属窗口内切换/导航后使旧结果与异步响应失效 |
| `shared/constants.js` | Action/Method/错误码、搜索配置、Bridge 配置与消息常量 |
| `content/element-map.js`、`scanner.js` | 三种扫描范围、同文档节点 ID、pageId、真实节点绑定、18 类与属性/正文/CSS 路径提取、按需详情及原生 CSS 唯一解析 |
| `content/element-search.js` | 纯快照索引，多词 AND、结构/分类/视口过滤、offset 分页与真实 indexSize |
| `content/highlighter.js`、`action-executor.js` | 定位/Overlay，五类操作与结构化回执 |
| `content/element-picker.js` | Port 生命周期的页面点选层、命中测试、事件拦截和选择/取消回传 |
| `content/content.js` | 消息路由、重扫与索引更新；实时 Port 订阅和事件合并、统一错误响应 |
| `background/service-worker.js`、`bridge/controller-bridge.js` | Worker 连接管理、认证、心跳/重连、活动 Tab 与协议转发 |
| `bridge/native-bridge.js`、`controller/native_host.py`、`native_client.py` | 浏览器拥有的 Native Port、当前用户 Host、随机回环端口和 Python 客户端；复用原调度/执行层 |
| `controller/install_bridge.py` | 当前用户 Chrome/Edge Host 注册，按安装扩展 ID 设 allowed_origins |
| `controller/server.py`、`protocol.py` | 本地 WebSocket 服务、认证、请求 ID/超时、EXPORT/ACK 内存收件箱与错误码 |
| `controller/pagesense.py`、`cli.py` | `PageSenseClient` 同步 API、惰性 CSS 定位器/页面句柄与人工命令解析 |
| `acceptance/content-files.js` | 从 Popup 和 Bridge 提取注入列表并核对一致性，仅属测试设施 |

## 关键数据流与调用关系

```text
用户 → 原生侧栏 → chrome.tabs / scripting → Content Script → DOM

默认路径：
Python 业务客户端 → 127.0.0.1 随机端口 → Native Host（浏览器启动）
                                           ↕ 长度前缀 JSON
扩展 Native Bridge → 原 Controller Bridge.dispatch → Content Router / Executor → DOM

兼容旧模式：Python Server（8765）↔ WebSocket ↔ 原 Controller Bridge → 同一 DOM 路由
```

注入依赖顺序：`shared/constants.js` → `content/element-map.js` → `scanner.js` → `element-search.js` → `highlighter.js` → `action-executor.js` → `element-picker.js` → `content.js`。Popup 与 Bridge 维护对应列表，测试提取后交叉核对；新增模块时保持一致。

SCAN 建立映射和搜索索引；每次扫描重建快照。无实时订阅时重扫仍清高亮；
Content Router 调用 Scanner 时始终用 WeakMap 保留同文档存活节点 ID，范围切换也保留，
新增 ID 递增、移除 ID 不复用，
使尚未刷新的卡片不会因同页自动重排而命中其他节点。SEARCH 读取最近扫描快照，
不逐次全 DOM 扫描。CSS 条件例外：Content Router 先调用原生 querySelectorAll，
将命中节点已有的映射 ID 传给纯快照 Search 求交，不建立第二套映射。
FIND_ELEMENTS 直接按 CSS/XPath 查询，可限定父容器，只返回 pageId/elementId/referenceId 句柄；READ_ELEMENT 按需读取文本、原始属性或白名单 DOM property，READ_ELEMENTS 一次返回匹配文本列表。节点引用用文档内 WeakRef 注册表绑定原节点，执行前重建当前编号映射，因此不会因扫描编号、插入和重排而改指向。删除/克隆替换或换文档明确报错。get_all 复用已有详情，旧 locator 保留每次重新解析 CSS 的兼容行为。详见[元素 API](element-api.md)。

动作经同一个 Executor 执行，返回包含 success/error、actionId、
耗时及建议重扫等信息。Python 请求按 id 关联，默认超时 10 秒。

侧栏通过 `tabs.connect` 订阅当前文档；Content Router 持有 MutationObserver 与
input/change、scroll/resize 监听，300ms 合并变化后复用 Scanner/Search 并通过 Port
发送完整快照。忽略自身 ID 属性和 Overlay 变动，空闲时不轮询。最后一个 Port 断开时
释放 observer、事件和待执行计时器；侧栏关闭、切页或导航都会断开旧连接。
侧栏打开即自动订阅，没有手动扫描按钮或实时开关；断线自动退避重连。连接代次和 pageRevision 丢弃旧页/旧连接响应。
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

侧栏选择所属窗口的活动 Tab，切换/导航后清空旧结果并丢弃迟到响应；开启实时模式时在新页就绪后重新连接。Controller 仍按当前活动 Tab 转发。文档生成独立 pageId，SCAN/SEARCH/DETAIL 返回该身份，元素记录也带 pageId；原生 CSS 的 RESOLVE_ELEMENT 要求唯一 DOM 节点，无需扫描。新 Python 定位器先解析再带 pageId 调用既有执行层，页面句柄也校验原文档；旧式纯数字 ID 为兼容保留其跨页风险。Element Map 用原节点绑定解析 ID，DOM 上克隆的映射属性不能重定向句柄。Controller 可传 scope 和结构/分页条件，新增 GET_ELEMENT_DETAILS；所有 DOM 工作仍走同一 Content Router。旧 WebSocket 模式下 MV3 Worker 回收后内存计时器消失，长断线自恢复仍有已有缺陷。默认 Native Port 由浏览器维持，启动和恢复单独验证，不把旧缺陷整体标为关闭。

侧栏默认重新扫描当前页面并发送当前范围全部元素，包含其他分页且不受查询影响；也可显式发送选中或筛选结果。Worker 经 Native Port（旧模式经 WebSocket）发 EXPORT，Host 入箱后才返回 EXPORT_ACK；载荷不包含 Token。收件箱线程安全，最多 8 份、
总计 64 MiB，溢出拒绝、不覆盖；业务代码通过 wait_for_export() 消费。它只传数据，不排队执行动作。
UI 等待回执 8 秒；断线/超时不自动重发。详见[工作台说明](element-workbench.md)。

默认 PageSenseClient 只连接浏览器启动的 Host。Host 的回环服务拒绝网页 Origin，随机凭据保存在当前用户运行目录；多会话必须明确选择，同会话单业务客户端。Python 客户端关闭后 Host 和收件箱保留，浏览器/Port 关闭后 Host 退出并清理自己的发现文件。Host 到浏览器 1 MiB 上限在执行前检查；浏览器到 Host / Python 扫描可达 64 MiB。首次 Windows 注册和兼容迁移见[自动桥接](native-bridge.md)与[ADR](decisions/ADR-20261019-c82ab49d1e06-native-bridge.md)。

## 状态、持久化与外部依赖

- `chrome.storage.local`：连接方式/暂停状态及旧模式 host/port、用户输入 token、autoconnect。token 属本机敏感配置，不随治理文档交付。
- 当前用户 AppData：Native Host 启动器、注册配置，以及仅会话存活期间的发现凭据文件；不入 Git。
- 内存：DOM 映射、扫描/搜索快照、Overlay、待响应请求、最近请求/Action 日志。页面刷新、重扫、Popup/Worker 生命周期会影响各自状态；不能把内存状态当作持久任务记录。
- Python：`websockets>=15.0.1`，使用 asyncio 服务与 sync 客户端，无新数据库/Web 框架/LLM SDK；本轮验证 15.0.1 与 17.2，均通过 Python 与真实 Native Messaging 验证。
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

元素工作台的 Chrome 155 与 Python 实际链路证据见 `acceptance/evidence-ui-workbench/`，含旧句柄保护、三种数据发送、生成源码运行及各尺寸截图。旧式数字 ID 风险和 Worker 长断线恢复缺陷仍保留；用户个人浏览器需重新加载。

默认自动桥接和完整重新扫描发送的最新 Chrome 验证见 `acceptance/evidence-native-bridge/`；包含真实 Host 注册与启动、Python 客户端、消息大小边界及进程生命周期。历史独立报告不覆盖这一新增模式。
