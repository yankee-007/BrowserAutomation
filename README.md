# BrowserAutomation

PageSense Chrome / Edge Manifest V3 扩展与本地 Python Controller：扫描网页 DOM、搜索元素、定位/高亮并执行基本页面操作。当前实现为 V2.0.0，尚不含 LLM / Planner。

侧栏打开即自动实时扫描交互控件、文本、媒体与语义结构，没有手动扫描或实时开关；支持 18 种细分类、分页搜索、
标签/class/属性/CSS 查询和元素详情。新增三工作区、页面分布图、可复制的 Python 定位代码，
默认发送当前页面全部扫描元素，也可发送选中或筛选结果。插件自动启动本地桥接，Python 默认直接连接，见[自动桥接说明](docs/native-bridge.md)与[元素工作台](docs/element-workbench.md)。

Python 推荐使用 [find / findall 元素对象 API](docs/element-api.md)：CSS/XPath 单/多元素、容器查询、按需读取文本和属性，不需要扫描或发送整页元素。

**当前质量状态**：既有[独立验收报告](PageSense-V2.0-INDEPENDENT-ACCEPTANCE-REPORT.md)结论为 FAIL；旧式纯数字 elementId 的跨标签页风险与长断线自恢复问题仍存在；新定位器和页面句柄会校验 pageId。本次侧栏相关检查通过，不替代全量产品验收。

## 使用与开发

1. 按[扩展使用文档](pagesense/README.md)加载整个 `pagesense/` 目录；扩展本身不需要前端构建。
2. 点击工具栏的 PageSense 图标打开侧栏。更新后先在扩展管理页重新加载并重开侧栏。首次在 `controller/` 执行 `python -m pip install -r requirements.txt` 和 `python install_bridge.py`，回到插件重试自动连接。此后由插件启动桥接，业务 Python 使用 `with PageSenseClient() as browser:` 直接获取数据和操作，无需手动启动服务或 Token 配对。详见[安装与 Python 示例](docs/native-bridge.md)。
3. 测试页面为 [demo.html](pagesense/test/demo.html)。需要 HTTP 服务时，可从项目根运行 `node acceptance/serve.js 8770`，然后在浏览器打开 `http://127.0.0.1:8770/test/demo.html`。Controller 默认使用 8765；两个服务不要占同一端口。
4. 测试脚本在 `acceptance/` 与 `controller/`，环境要求和已知运行陷阱见[上下文的验证入口](PROJECT_CONTEXT.md#开发与验证入口)。侧栏可通过 `node acceptance/side-panel-browser.js acceptance/evidence-side-panel` 在独立 Edge 测试实例中验证，使用全新临时浏览器配置与自带 demo 页面。

保留[开发验收报告](PageSense-V2.0-ACCEPTANCE-REPORT.md)与独立报告原文；历史报告中的旧项目目录和扩展 ID 不作为当前安装信息。

## 项目记忆与协作

- [Agent 工作入口](AGENTS.md)
- [当前项目上下文](PROJECT_CONTEXT.md)
- [当前架构](docs/architecture.md)
- [活动任务](docs/tasks/README.md)
- [设计决策](docs/decisions/README.md)

后续 Agent 从项目入口恢复工作；不自动读取入口的工具需显式要求读取。更换 Session 或电脑无需重新初始化项目记忆，仍需取得代码及配置必要环境。

后续修改按项目有效策略执行：默认独立任务先建分支和 worktree，补充消息沿用原任务；集成分支 `main` 仅接收成果，由一个执行者串行集成，默认 squash。不自动开始下一任务或启动其他 Agent。

Git 集成分支为 `main`，已确认远端为 [yankee-007/BrowserAutomation](https://github.com/yankee-007/BrowserAutomation)。用户已要求保存并推送整个项目当前可纳入 Git 的内容；浏览器配置、已安装依赖与本机敏感设置按忽略规则保留在本地。提交及同步状态用 `git status --short --branch` 与 `git log -1` 核对，创建任务 worktree 前确认已有完整代码提交基线。初始化来源与历史核验见[初始化核验记录](docs/agent/bootstrap-audit.md)。
