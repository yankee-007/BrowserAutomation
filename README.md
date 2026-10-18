# BrowserAutomation

PageSense Chrome / Edge Manifest V3 扩展与本地 Python Controller：扫描网页 DOM、搜索元素、定位/高亮并执行基本页面操作。当前实现为 V2.0.0，尚不含 LLM / Planner。

侧栏支持手动/实时扫描交互控件、文本、媒体与语义结构，18 种细分类、分页搜索、
标签/class/属性/CSS 查询和元素详情，见[页面内容与元素查询](docs/element-explorer.md)。

**当前质量状态**：既有[独立验收报告](PageSense-V2.0-INDEPENDENT-ACCEPTANCE-REPORT.md)结论为 FAIL；Controller 跨标签页元素 ID 与长断线自恢复问题未解决。本次侧栏相关检查通过，不替代全量产品验收。

## 使用与开发

1. 按[扩展使用文档](pagesense/README.md)加载整个 `pagesense/` 目录；扩展本身不需要前端构建。
2. 点击工具栏的 PageSense 图标打开浏览器侧栏。由旧版更新时，先在扩展管理页重新加载 PageSense。按[Controller 使用文档](controller/README.md)准备 Python 依赖，并在 `controller/` 运行 `python server.py`。将本次启动生成的 token 填入侧栏的 Controller 面板；不要把 token 写入共享文档。
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
