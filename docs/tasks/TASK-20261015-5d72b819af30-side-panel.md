# TASK-20261015-5d72b819af30：浏览器侧栏界面

- 状态：done（实现与相关验证完成）；更新时间：2026-10-16（Asia/Shanghai）。
- 需求：点击 PageSense 图标，在浏览器原生侧栏显示现有界面；适配窄栏，浏览网页时保持可用。
- 完成标准：侧栏入口生效；扫描、搜索、定位和人工操作可用；切换/导航后不再显示旧页结果；布局无横向溢出；提供对应验证与重新加载说明。
- 范围：manifest、Worker 侧栏配置、现有 popup 目录内的界面与生命周期、相关验收和当前文档。浏览器侧栏左右位置由浏览器设置控制。
- 基线：master unborn、无 HEAD，全部原有项目文件未跟踪；没有可用提交基线，未新建分支/worktree，未暂存、提交或上传原有内容。
- 工作区：当前项目原目录；当前 Agent 单写入者，无委派；按 policy.md 无基线例外保存文件。集成目标 master，Git 集成暂不可用。
- 保护：修改前已保存相关原文件的本地临时副本；其余既有内容保持原样。
- 实现快照：manifest 新增 sidePanel 和全局侧栏入口，移除 action.default_popup；Worker 设置 openPanelOnActionClick；复用现有界面，适配侧栏宽高和固定底栏。侧栏固定所属窗口，切换/导航/关闭标签页后清空旧结果，用 pageRevision 丢弃迟到的扫描/动作响应。原注入列表、Controller 和页面动作执行器不变。
- 验证：真实 Edge 155 独立无界面实例已打开原生侧栏，demo 扫描 28 元素，搜索/高亮/点击/输入及切换/刷新清理通过；320/400/600px 无横向溢出，底栏可见；已逐张检查窄栏截图并修正端口标签和底栏文字换行。`v2-popup-ui.js`（含新增 10 个生命周期断言）、`popup-ui.js`、`static-check.js`、`content-docs-check.js`、`v2-search-unit.js` 与 `indep/indep_unit.js` 均通过（后者 199 PASS / 0 FAIL）。改后源文件语法检查通过，已对照修改前副本审阅差异。浏览器证据保存时间、版本与产品源文件 SHA-256 记录于 results.json。
- 证据：`acceptance/evidence-side-panel/results.json` 与 panel-320/400/600.png；复现脚本 `node acceptance/side-panel-browser.js acceptance/evidence-side-panel` 使用系统分配的本地端口和新建临时 profile，仅关闭本脚本创建的浏览器与服务。Worker 中直接执行 open 被用户手势限制拒绝，改为在临时扩展文档中发送真实点击后打开原生侧栏；未弱化产品中的浏览器权限限制。
- 验证边界：已读取真实 API 确认工具栏点击打开配置，未模拟浏览器工具栏本身的点击。用户浏览器需重新加载扩展；侧栏左右由浏览器偏好控制，实际工具栏点击与位置待用户使用时确认。Controller 完整验收及历史独立 FAIL 不在本任务修复范围。
- 恢复：从本任务文件与实际文件继续；未提交的文件没有 Git 恢复快照，尚无跨电脑备份。
- 交付：代码、当前文档、验收脚本与证据均保存在本地。Git 仍为 master unborn，未建立可用 worktree、未提交、未合并、未推送；未把现有全项目内容擅自创建为基线。用户在扩展管理页重新加载后点击 PageSense 即可使用；这一步尚未在用户现有浏览器中代为执行，不宣称人工验收或发布完成。
