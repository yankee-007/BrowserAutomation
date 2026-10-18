# PageSense 项目治理初始化核验

核验日期：2026-10-15（Asia/Shanghai）。本记录仅对应本轮初始化时的文件和 Git 状态，不是后续实时状态表，也不是日常必读依赖。

## 来源、范围与读取方式

- 用户指定目标为当前 `auto_browser` 工作区；初始化前没有 Git，未发现嵌套 Git/其他 VCS 或适用的祖先/目录级 AGENTS、CLAUDE、贡献规范。没有占用业务目录保存工具包。
- 已阅读用户提供的[开发历史](https://chatgpt.com/share/6ad0f242-1a24-83ea-bd61-d996ff053e9c)可取得正文：V1 DOM 扫描 → V1.1 映射/定位/高亮 → V1.2 Action Layer → V2.0 Element Search 与本地 WebSocket Controller → 独立验收。分享页的删节工具输出与原始附件不可恢复，当前实现以本地文件为依据。
- 引导来源：[yankee-007/AgentBootstrapPrompt 固定入口](https://raw.githubusercontent.com/yankee-007/AgentBootstrapPrompt/5b3a0fac123530ad5906d3518b0ccf99629c54aa/agent-project-bootstrap/BOOTSTRAP.md)。版本 **0.4.0**；完整提交 SHA：`5b3a0fac123530ad5906d3518b0ccf99629c54aa`。
- 先以 Git 的只读远程 ref 查询解析 `refs/heads/main`，再重新读取固定 SHA 入口；通过该 SHA 的 GitHub tree 元数据核对入口要求的 14 项文件存在。协议与模板全部从同仓库、同 SHA、同包路径获取到 Agent 临时读取缓存，17 个包内文件逐个与该提交的 Git blob SHA-1 匹配。没有再读取动态 main 内容。
- 协议已完整读取；模板在生成对应文件时读取。Task 模板已核对存在，本轮没有真实任务需要实例化，未将其生成到项目。
- 本轮只新增文档与忽略规则、本地初始化 Git。没有修复缺陷、修改 API/数据格式、安装依赖、启动浏览器/服务、创建业务任务、ADR、worktree、自动化或远端。

## 新增、复用与保留

新增 11 个治理文件：

| 路径 | 用途 |
| --- | --- |
| [AGENTS.md](../../AGENTS.md) | Agent 短入口与本项目范围 |
| [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md) | 当前能力、约束、历史证据与未知项 |
| [README.md](../../README.md) | 根目录使用与协作导航 |
| [.gitignore](../../.gitignore) | 已安装依赖、字节码、既有 profile 与本机权限配置的最小忽略 |
| [docs/architecture.md](../architecture.md) | 当前实际模块、数据流、状态与依赖 |
| [docs/agent/policy.md](policy.md) | 有效策略、授权边界、来源与路径映射 |
| [docs/agent/workflow.md](workflow.md) | 任务身份、状态、checkpoint、验证、交接与维护 |
| [docs/agent/git.md](git.md) | 归属、提交、快照、上传、隔离、集成与清理 |
| [docs/tasks/README.md](../tasks/README.md) | 空的活动任务导航与未来规则 |
| [docs/decisions/README.md](../decisions/README.md) | 空的 ADR 导航与创建门槛 |
| [docs/agent/bootstrap-audit.md](bootstrap-audit.md) | 本轮逐项核验与交付边界 |

原样复用 [pagesense/README.md](../../pagesense/README.md)、[controller/README.md](../../controller/README.md) 和两份已有验收报告，未覆盖任何既有文件。新入口通过链接导航；旧报告中的旧目录和测试结论作为历史保留。

本轮对初始化前 **96 个源代码、文档、测试、证据与本机配置文件**建立并复核 SHA-256，内容一致；依赖目录、Python 字节码、浏览器 profile 不纳入内容哈希核验，也未对其执行修改或清理。`.claude/settings.local.json` 在上述保留范围内。忽略规则只影响今后的 Git 纳入范围，不删除文件或取消跟踪；锁文件、测试、报告、截图和日志证据仍可跟踪。

## 有效策略与实际限制

| 配置 | 有效值 |
| --- | --- |
| GIT_POLICY | detect-and-init |
| REMOTE_POLICY | ask-once |
| TASK_TRACKING_POLICY | adaptive |
| PARALLEL_DEVELOPMENT_POLICY | task-worktree |
| AUTO_COMMIT_POLICY | verified-owned-units |
| RECOVERY_COMMIT_POLICY | on-handoff |
| AUTO_PUSH_POLICY | on-request |
| HUMAN_VERIFICATION_POLICY | criteria-based |
| INTEGRATION_POLICY | squash-on-completion |

没有发现既有项目策略，因此采用工具包默认值；不是覆盖既有约定。默认单 Agent、单工作区单写入者；隔离不表示自动委派。初始化保留当前工作区，之后独立修改按策略建任务分支/worktree，并由一个执行者串行集成。

**当前不能立即使用 worktree**：`git init` 遵循机器既有默认值建立本地 `master`，尚无 HEAD/完整代码基线，Git 提交身份未配置，未暂存或提交任何内容。不能为得到干净基线自动提交原目录所有文件，也不能从空基线假定取得业务代码。后续先在适用授权下补真实身份与完整可取得的代码快照，保留用户内容；无 Git/基线或禁令时的降级规则已在策略、入口、上下文与 Git 协议明确。

远端服务/账号/仓库/ref/部署副作用尚未确认；本轮无上传请求，没有配置或推送 remote。后续按请求的项目快照范围、测试不作为备份门槛、禁止强推与多 worktree 覆盖限制均已落地；这不构成本轮外部操作授权。

## 最低语义逐项核验

以下逐项对照固定版本 memory 协议；结果均为“已落入本项目长期文档并核对”。Task 当前无实例，核验的是未来规则，不创建虚假任务验收。

| 最低语义 | 实际路径与章节 | 核验结果 |
| --- | --- | --- |
| 入口与职责 | `AGENTS.md`；`policy.md` 的“文档路径映射”；根 `README.md` | 可定位上下文、策略、架构、任务/ADR；按需加载，无重复规范副本 |
| 策略条件 | `policy.md` 的“有效策略”与冲突行为表；`workflow.md` 的“Session 与任务开始” | always/adaptive/disabled、Git/提交/恢复/远端禁用优先级、关闭能力的恢复限制齐全，当前 adaptive 一致 |
| 任务身份与状态 | `workflow.md` 的“标识、状态与最小记录” | 沿用 ID、日期+12 位随机十六进制及冲突检查；六种标准状态、带时区更新时间、阻碍单列 |
| 任务最小记录 | 同上 Identity 至 Handoff/Closure 表 | 需求/澄清/范围/标准、staged/unstaged/untracked 边界、依赖、核验快照、证据/缺口、恢复与结果限制齐全 |
| 工作区保护 | `git.md` 的“基线与修改归属”；`workflow.md` 的“接力、并行与集成” | 先查真实文件/Git、保留用户内容；混合归属不自动提交；明确快照请求与单写入者规则完整 |
| 任务隔离与集成 | `git.md` 的“任务分支与工作区”“串行集成与主线历史”“清理与恢复”；`policy.md` 的“项目入口与验证方式” | 实际目标 master、task 命名、串行 squash、依赖/共享资源/验证/清理/内部历史边界齐全；初始化与无基线例外未伪造可用性 |
| 多工作区备份 | `git.md` 的“按请求保存项目快照”；`policy.md` 多 worktree 段落 | 协调写入者、保留任务分支、仅上传授权 refs；只推集成分支不代表所有任务均备份 |
| Git 与敏感边界 | `git.md` 的“Commit 与恢复”“按请求保存项目快照”“Secret 与上传范围”“Push” | 按策略、完整项目快照、质量非备份门槛、目标/ref/凭据保护、有限历史检查、不伪造身份/绕 hook/强推、失败保留完整 |
| 恢复与落盘 | `workflow.md` 的“Session 与任务开始”“关键阶段与 checkpoint” | 重要修改前恢复摘要与偏差、重要阶段保存、文档/本地代码/跨电脑取得分层；不承诺崩溃收尾 |
| 验证与事实 | `workflow.md` 的“验证与人工接受”；上下文的“事实边界” | 事实/推断/未知、范围/版本/环境、行为变化后旧证据失效、未运行不写通过齐全 |
| 交付与授权 | `policy.md` 的“策略依据与操作范围”；`workflow.md` 的 checkpoint/交付段；`git.md` Push | 实际目标/分支/内容/任务阶段/副作用限定授权；文档、本地快照、远端取得分别报告 |
| 生命周期与维护 | `workflow.md` 的“文档维护与完成”；`docs/tasks/README.md` | done 依完成标准；先更新 Task 再删除活动行，核对 ID 已移除且文件原位保留；仅更新受影响文档，不虚构 ADR/历史 |

表中的 `policy.md`、`workflow.md`、`git.md` 指当前同目录文件；路径均在本项目内。

## 文档与保护检查

- 入口能定位实际文件；生成内容无未替换适配点；工作/Git 模板规范正文完整保留，补充了实际 master、无 HEAD/身份与测试副作用边界。
- 任务与决策索引为空；本轮没有 Task/ADR 实例，不把已知缺陷或历史建议登记成正在执行的任务。
- 根入口、策略、workflow、Git、任务索引对 adaptive/task-worktree 与无基线限制保持一致；提交和远端禁令优先级未因恢复/集成默认值放宽。
- 文档 Markdown 相对路径及锚点已核对；来源固定 SHA 仅供追溯，所有必要规则已落地，正常接力不依赖原聊天、工具包、外部协议/模板或私有 Session。
- 原有文件哈希一致；新增文档与忽略规则的路径、格式及具体凭据模式已检查。本轮没有审计所有业务源码秘密或浏览器数据，有限检查不声称全项目无秘密。
- 本轮未运行任何产品单元测试、E2E、浏览器或服务器；未将历史报告的测试结果写成本轮通过。已知 FAIL 与人工覆盖缺口见上下文，保持未解决状态。

## 常规启动读取规模

没有已知任务 ID 时读取下列四份文档；已有 Task ID 则直接读取对应任务，任务跟踪按有效策略判断。执行重要修改前再按需加载工作/Git 协议与架构。

| 文件 | 行数 | 字符数 | UTF-8 字节 |
| --- | ---: | ---: | ---: |
| `AGENTS.md` | 23 | 1203 | 2807 |
| `PROJECT_CONTEXT.md` | 72 | 4158 | 7600 |
| `docs/agent/policy.md` | 94 | 5908 | 12278 |
| `docs/tasks/README.md` | 18 | 756 | 1724 |
| 合计 | — | 12025 | 24409 |

这些是文本规模指标，不等于 token 数，也不推算节省比例。根入口为 23 行；后续无需每次会话重新测量。不确定是否自动加载规则的 Agent 必须显式读取 `AGENTS.md`，包括新聊天、其他编码工具和跨电脑接力；无需重新运行初始化。

## 交付状态与停止点

- **文档初始化：完成。** 已核对最低语义、路径、策略一致性、模板适配、来源独立性及原有内容保护；没有待补的治理语义。
- **本地 Git：已初始化，尚未提交。** 当前分支 master、无 HEAD/暂存内容；身份缺失，既有业务文件仍在原目录且未跟踪。文档保存不代表代码已经形成版本快照。
- **远端同步：未配置、未执行。** 无目标/ref 与上传请求，其他电脑尚不能据此取得完整项目。
- **未决事项：** 真实 Git 身份、完整代码基线与将来需要的远端目标；产品运行/人工验收仍未知，独立报告中的未解决问题保持原状态。这些不阻碍本轮文档初始化。
- **停止点：** 初始化完成即停止，不启动业务开发、修复或验收。后续从 [AGENTS.md](../../AGENTS.md) 恢复，等待用户给出下一项实际任务。
