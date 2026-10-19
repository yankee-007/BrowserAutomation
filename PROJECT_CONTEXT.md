# 项目上下文：PageSense（auto_browser）

## 目标与当前阶段

PageSense 将用户已打开网页中的交互控件、文本、媒体及语义结构整理为结构化数据，
提供关键字/结构查询、定位、高亮、元素详情与五类基础操作，并通过本地桥接与 Python 客户端
暴露结构化 API。当前磁盘实现为 V2.0.0，属于 Browser Runtime + Controller Transport；
尚无 LLM / Planner / Agent 决策层。

项目记忆与协作规则已初始化。当前界面使用浏览器原生侧栏，点击扩展图标打开；分为页面概览、元素检查、Python 对接三个工作区，支持几何分布图、定位候选、代码生成，默认重新扫描并发送当前页面全部元素，也可发送选中/筛选结果；默认通过 Native Messaging 自动启动已注册的本地 Host，Python 只连接，无需手动 server.py/Token 配对；侧栏打开即自动实时扫描，移除手动扫描按钮与实时开关，切换标签页、刷新或导航后清空旧结果并自动恢复；连接中断自动退避重连。后续工作以用户当前需求和任务记录为准。

## 技术形态与核心能力

- 浏览器侧：Chrome / Edge、Manifest V3、原生 JavaScript / HTML / CSS；manifest 声明最低 Chromium 116。按需注入 Content Script，无前端打包步骤。
- Python 侧：浏览器启动的 Native Host、默认同步客户端 `PageSenseClient`，保留显式 mode="server" 的旧 WebSocket Server 与人工 CLI；依赖为 `websockets>=15.0.1`，本轮验证 15.0.1 与 17.2。Native Host 首次需当前用户注册，安装器支持 Windows Chrome/Edge。
- 测试侧：Node.js、jsdom、puppeteer-core；现有验收资产包含真实 Edge、协议、CLI 与独立验收。
- 主要能力：侧栏自动实时扫描，范围可选 content/interactive/all；四个分组、18 个细分类；
  搜索支持多词 AND、offset 分页、标签/class/属性/精确 ID/视口过滤，以及原生 CSS 与扫描映射求交；
  元素详情按需读取属性、CSS、父子上下文及文本/HTML。实时扫描按 300ms 合并 DOM/输入/滚动/视口事件，
  关闭侧栏释放监听；同文档重扫和范围切换保留存活节点 ID，不复用移除 ID。
- 页面点选：侧栏“在页面选择元素”通过专用 Port 启用覆盖层，悬停预览、点击读取精确节点详情，
  不需先扫描，不受搜索/分页/范围限制；普通选取点击由选择层拦截，Esc/按钮/切页/关闭清理。
  选中面板是选择时快照，iframe/Shadow DOM 仅选外层。

## 核心模块与入口

| 路径 | 职责与入口 |
| --- | --- |
| [pagesense/README.md](pagesense/README.md) | 扩展安装、侧栏使用、协议与限制说明 |
| [pagesense/manifest.json](pagesense/manifest.json) | 扩展版本、权限、原生侧栏与 Service Worker 入口 |
| `pagesense/content/` | Scanner、Element Map、Search、Highlighter、Action Executor、消息路由 |
| `pagesense/popup/` | 原生侧栏复用的扫描结果、搜索、人工操作与 Controller 配置界面；监听所属窗口的标签页变化 |
| `pagesense/background/`、`pagesense/bridge/` | Worker 生命周期、WebSocket 连接与请求转发 |
| [controller/README.md](controller/README.md) | Controller 安装、API、CLI 和协议说明 |
| `controller/native_host.py`、`native_client.py`、`install_bridge.py`、`server.py`、`pagesense.py` | Python 传输服务、客户端、协议与人工命令 |
| `acceptance/`、`acceptance/indep/` | 既有测试与独立验收脚本 |
| `acceptance/evidence-v2-independent/` | 已保存的独立验收证据，不清理或覆盖 |

当前结构详见 [架构](docs/architecture.md)。这里只保留导航与摘要。

## 业务规则、持久化与长期约束

- 默认由浏览器 Native Messaging 启动 Host，在 127.0.0.1 随机端口接受 Python 客户端，配对凭据由当前用户运行目录自动发现；业务 Python 不启动服务。旧模式仍为扩展连接 Python Server，仅允许 `127.0.0.1` / `localhost`、默认端口 8765，需显式 mode="server"。生产路径的 Python 不直接通过 Selenium / Playwright / CDP 驱动浏览器；测试 harness 使用 CDP 属观察与验收设施。
- Bridge 复用原有 Content Script / Action Executor，不另建执行逻辑；默认只操作当前活动标签页。新增 find/findall 支持 CSS/XPath、容器查询及按需读取，返回含 pageId/referenceId 的真实节点句柄，不依赖整页扫描或主动发送；旧 locator API 保留。elementId 与当前 DOM 映射有关，失效时应返回错误，不能猜测替代目标。新定位器和元素字典携带 pageId 保护；旧式纯数字 ID 仍有跨标签页防护缺口，见下表。
- 当前不实现自动决策、Action Queue、search-and-click、批量投递或站点风控规避。副作用验证以自带 demo 为入口；真实提交、消息发送和账户操作需单独明确任务授权。
- `chrome.storage.local` 保存连接方式/暂停状态，以及旧模式 Controller host、port、用户输入 token 和 autoconnect 配置；Native Host 注册/启动器与自动生成的会话发现凭据在当前用户 AppData，凭据不进入项目；扫描结果、映射、索引、最近请求日志主要在内存中。无数据库。不得把 token、浏览器 profile 或真实页面私密数据写入项目记忆。
- `.edge-profile/`、`acceptance/edge-v2-indep-profile/`、已安装依赖、Python 字节码与本机 Agent 权限设置仅忽略，不删除。测试代码、锁文件、报告与证据保持可跟踪。

## 已知问题与易回归区域

以下为 2026-09-29 的[独立验收报告](PageSense-V2.0-INDEPENDENT-ACCEPTANCE-REPORT.md)所记录；本轮未重跑产品测试，不能宣称当前仍已复现或已修复。

| 项目 | 已有证据与限制 |
| --- | --- |
| FINDING-001（P3，OPEN） | 旧式纯数字 elementId 无页面作用域；跨标签页复用旧 ID 可静默命中其他元素并执行。新 `client.locator(css)` 与 `client.element(element)` 已携带 pageId，真实 Chrome 验证换页/刷新后旧句柄返回 STALE_PAGE；不将历史缺陷整体标为已修复。更换标签页、导航、重扫与 ID 格式是易回归区域。 |
| FINDING-003（P2，OPEN） | 旧 WebSocket 模式 Controller 停机约 30 秒以上后 Worker 可能被回收；无法无人值守自恢复，需要一次浏览器交互唤醒。重连、心跳与 Worker 生命周期需真实浏览器验证。 |
| FINDING-002（当前实现已修复） | SEARCH 的 `indexSize` 现在返回整个索引规模，`total` 为过滤后的命中数；元素查询任务通过真实 Python/WebSocket/扩展路径验证。历史报告保持原文。 |
| 既有修复护栏 | 源码可见 UTF-8 token 字节比较和 64 MiB 入站 WebSocket 消息上限；独立报告称 BUG-001、BUG-003 已修复。本轮只核对实现，不重复宣称运行通过。 |
| 覆盖与能力限制 | 不递归 iframe / Shadow DOM，不识别 Canvas 内部元素；虚拟列表限已挂载 DOM；合成事件不等同可信用户输入；Controller 不支持 file://。真实 Popup、剪贴板、下载与真实业务页面人工验收状态未知。 |

独立报告结论为 **FAIL**，统计为 1045 PASS / 2 FAIL / 10 BLOCKED / 4 MANUAL / 1 SKIP；这些是历史数据。此前开发报告称可进入人工验收，两者阶段不同，不能用早期通过数覆盖独立结论。

具体任务进度见 [任务索引](docs/tasks/README.md)，长期决策理由见 [决策索引](docs/decisions/README.md)。已解决问题不持续堆积在本文件。

## 开发与验证入口

使用入口见根 [README](README.md)，按实际目录执行命令，历史文件中的 `Desktop/csss` 为旧位置，不作为本项目当前路径。

- 纯文档初始化只核对路径、占位符、规则完整性与原有文件保护，不触发安装、构建或产品验收。
- 后续按改动选择既有检查：`controller/` 中的 `python -m unittest test_bridge test_cli -v`；根目录的 `node acceptance/v2-search-unit.js` 与 `node acceptance/indep/indep_unit.js` 等。先读脚本副作用与环境要求。
- `controller/test_e2e.py` 必须按脚本直接执行；`python -m unittest test_e2e` 不能证明真实 E2E 已运行。真实验收需 Edge、扩展、Controller、静态 demo 服务与匹配端口。
- demo 服务可从根目录运行 `node acceptance/serve.js 8770`，避免其默认端口 8765 与 Controller 冲突。现有独立 Bash runner 含按端口终止进程的逻辑；运行前先核实进程归属，不能直接终止未知进程。

## 事实边界

- 已核对：当前目录边界、文件结构、manifest、依赖声明、关键源码/注入顺序、现有 README 与验收材料。已阅读用户提供的[开发历史](https://chatgpt.com/share/6ad0f242-1a24-83ea-bd61-d996ff053e9c)中可取得的正文；其中被删节的工具输出和原始附件不可据此恢复。
- 初始化前无 Git 或其他已识别 VCS，未发现适用的既有 AGENTS/CLAUDE/贡献指南；`.claude/settings.local.json` 保留。初始化时为 `master` unborn 且缺提交身份；2026-10-18 用户明确要求将整个项目当前可纳入 Git 的内容保存并推送至 `https://github.com/yankee-007/BrowserAutomation.git` 的 `main`，现已按请求设置分支和远端。实际 HEAD、提交身份与同步状态以 Git 查询为准，创建任务 worktree 前核对完整代码基线；初始化核验不代表后续状态。
- 侧栏验证：独立 Edge 无界面测试实例已加载扩展并打开原生侧栏；demo 扫描/搜索/高亮/点击/输入、标签页切换/刷新后的清理与恢复、320/400/600px 布局已验证，历史证据见 `acceptance/evidence-side-panel/`；改为打开即自动实时扫描后，本任务以独立 Chrome 155 复跑侧栏切换/刷新与窄栏回归，证据见 `acceptance/evidence-element-api/`。工具栏打开行为已通过真实 API 核对配置；用户现有浏览器的重新加载、实际工具栏点击和显示位置尚未人工确认。该验证不替代完整产品验收。
- 实时扫描验证：独立 Edge 155 原生侧栏覆盖动态增删/文本/属性/输入、坐标/视口、稳定 ID、索引同步、节流/空闲、关闭、切换/导航恢复及窄栏布局，历史证据在 `acceptance/evidence-live-scan/`。当前侧栏打开即自动订阅，没有暂停或手动扫描控件，断线自动退避重连；本任务以独立 Chrome 155 复跑 19 项实时回归。操作输入草稿/焦点与 composition 事件已验证，操作系统真实输入法未测；静默 value 赋值、纯 CSS 动画等无 DOM/受监听事件的变化不会触发更新，可显式调用 scan() 或重新查找。用户已有浏览器需重新加载扩展并重开侧栏。
- 元素查询验证：独立 Edge 155 原生侧栏和真实 Python Controller 覆盖内容/控件/全部 DOM 范围、
  257 条完整分页、结构/CSS 查询与错误、元素详情和文本复制载荷、实时 CSS 结果更新、稳定 ID 及窄栏布局；
  5000 条新增正文可扫描并访问末页，证据在 `acceptance/evidence-element-explorer/`。
  设计与后续能力优先级见[元素查询说明](docs/element-explorer.md)。尚未验证真实系统剪贴板，
  文本索引及详情片段上限 20000 字符并标记截断；完整产品独立验收未重跑。
- 页面点选验证：独立 Edge 原生侧栏覆盖无扫描点选、悬停框位置、按钮/链接/勾选框的原操作拦截、
  精确行内目标、克隆旧映射、跨扫描范围/搜索条件、Esc/按钮取消与切页/刷新/关闭/重新打开。
  复制仅验证载荷，选取外层 iframe/Shadow host 与窄栏已验证；
  证据在 `acceptance/evidence-element-picker/`，不替代完整独立验收。
- 元素工作台：三工作区、页面分布、定位器唯一验证、Python 示例实际执行、选中/全部/跨分页筛选发送、收件 ACK/满箱和页面句柄保护已通过真实 Chrome 155 与 Python 3.14/websockets 17.2 验证，42 项 Python 回归通过，查询/点选/实时回归见 `acceptance/evidence-ui-workbench/`。Edge 独立测试进程启动失败，本轮使用 Chrome；系统剪贴板只校验载荷，用户个人浏览器与审美接受未代验。用法见[元素工作台](docs/element-workbench.md)。
- 自动桥接：Native Host 启动、默认 Python 客户端、预先收件、默认整页重新扫描发送、大于 1 MiB 的扫描和命令限额、客户端退出/重连、原始页面句柄保护、生成源码实际执行及 Host 清理已通过真实 Chrome 155 验证，证据在 `acceptance/evidence-native-bridge/`。Windows 安装器根据匹配项目路径的扩展元数据注册当前用户 Host，不读取浏览历史、Cookie 或已有 Token。用法见[自动桥接](docs/native-bridge.md)。
- 未知/未验证：用户浏览器加载状态、其运行进程、完整依赖与全量产品验收、人工接受及发布部署。GitHub 远端已由用户确认；上传快照不代表产品验收或部署。Python 命令可用，不代表 Controller 本轮已运行。
- 本轮检查范围与逐项语义映射见[初始化核验记录](docs/agent/bootstrap-audit.md)。后续工作只依赖本项目文件，不依赖原聊天、工具包或本机缓存。

本文描述当前检出版本的已知情况，不自动代表其他分支或生产部署。修改相关行为时检查本文是否需更新；不要仅刷新日期。
