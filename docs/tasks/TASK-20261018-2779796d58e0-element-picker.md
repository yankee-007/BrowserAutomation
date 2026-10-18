# TASK-20261018-2779796d58e0：页面点选元素

- 状态：done（实现与相关自动验证完成）；更新时间：2026-10-18（Asia/Shanghai）。
- 需求：侧栏增加按钮，在网页中直接选择元素并显示信息。
- 完成标准：无需预先扫描；悬停框预览，点击显示所选精确节点的属性/CSS/层级/文本/HTML；
  选取点击阻止普通页面点击操作；支持 Esc/按钮取消；普通非交互元素也能选；
  切页、导航、关闭侧栏后移除监听和覆盖层，丢弃旧响应；原扫描/查询/实时能力保持可用。
- 基线/工作区：master unborn，无 HEAD/暂存，全部既有成果未跟踪。沿用 policy.md 无基线单写入例外，
  本 Agent 唯一写入者，不委派；修改前保存涉及文件临时副本。Git 隔离/集成条件缺失，不擅自提交整个项目。
- 实现：按需注入独立 Picker 模块，用专用 tabs.connect Port 管理会话；全视口透明选择层捕获指针，
  临时穿透自身后通过 elementFromPoint 命中下层目标，pointer-events:none 的预览框跟随目标。
  复用 Scanner 按需详情与节点 ID，显式点选清除其他节点上克隆的同 ID 属性，避免显示克隆目标。
  所选信息独立显示为选择时快照，不受扫描范围/分页/搜索条件影响；不改变网页业务状态。
- 生命周期：页面或侧栏 Esc、按钮取消，选择结束、切页/导航/关闭侧栏均移除选择层、监听和待执行帧；
  连接代次/pageRevision 丢弃迟到响应。所选快照可复制 CSS/文本或清除，不自动跟随实时扫描刷新。
  Popup/Bridge 注入顺序一致，静态断言增加 Picker 依赖位置，未增加权限/依赖/Controller 方法。
- 保护边界：仍只检查当前顶层文档，不递归 iframe/Shadow DOM；Canvas 只检查外壳。
- 自动验证：真实 Edge 155 原生侧栏 14 组通过：无扫描启用、悬停边框坐标、精确节点信息、
  按钮/链接/勾选框普通原操作拦截与恢复、iframe/Shadow host 外层、页面/侧栏 Esc、按钮取消与重复会话、
  克隆映射、跨扫描范围和搜索条件、复制载荷、实时监听无自身循环及所选快照保留、
  320/400/600px 无横向溢出、清除/切页/刷新/内部页/关闭/重新打开生命周期。
  已逐张检查悬停预览、所选详情和按钮所在窄栏截图。
- 回归：元素查询真实浏览器/Python/WebSocket 12 组、手动侧栏 11 组、实时侧栏 20 组通过。
  scanner-unit、highlighter-unit、action-unit、popup-ui、v2-popup-ui、v2-search-unit、
  static-check、content-docs-check、element-explorer-unit 均 exit 0；修改脚本语法/差异空白检查通过。
  测试仅使用新建临时 profile、系统分配 loopback 端口和自己的服务；没有操作用户个人浏览器或系统剪贴板。
- 证据：`acceptance/evidence-element-picker/results.json`（14 组、时间/版本/源文件 SHA-256）、
  hover-preview.png、picked-320/400/600.png、regression.txt，以及 explorer/manual/live-regression/。
  已核对四份 JSON 的源文件哈希与最终代码匹配，运行时 errors 均为空。
  复现：`node acceptance/element-picker-browser.js acceptance/evidence-element-picker`。
- 测试修正：新增独立详情区后，原元素查询测试的通用 .inspector-body 命中了隐藏点选区，
  已限定在 #elementList 中；异步复制文本改为等待复制载荷。内部页 URL 在当前最小权限下可能不可见，
  改为验证清理与不支持状态。重新打开测试需先将辅助标签页置前；一次后台点击等待停滞时已仅终止
  经 PID/命令行与父子关系核实的本测试 Node 及其 12 个子进程，随后修正并完整通过。
  悬停截图使用 captureBeyondViewport:false，避免独立原生侧栏测试环境截图表面平铺；未修改产品渲染行为。
- 文档：扩展 README、元素查询说明、项目上下文、架构与任务导航已同步。旧独立报告保持原文，
  未重跑完整独立验收，不将相关通过数描述为整个产品通过。
- 验证边界：选取外层 iframe/Shadow host，不进入内部；不保证阻止页面此前安装的所有全局捕获处理器，
  只在测试页验证普通业务事件和默认动作拦截。复制仅验证载荷，真实系统剪贴板和用户浏览器尚未人工验收。
  所选信息是详情片段快照，沿用 20000 字符限制；后续重扫可能清理范围外点选节点的临时映射。
- 交付：成果本地保存，用户需重新加载扩展并重开侧栏。Git 仍为 master unborn，
  未建任务分支/worktree、未暂存/提交/集成/推送。按无基线单写入例外交付，不擅自提交既有整个项目。
  无 Git 快照或远端备份；从本记录、实际文件与证据恢复。
