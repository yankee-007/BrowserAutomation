# 项目协作策略

协议来源版本：Agent Project Bootstrap 0.4.0。版本仅用于识别和明确升级，不自动重跑初始化。

来源：[AgentBootstrapPrompt 固定入口](https://raw.githubusercontent.com/yankee-007/AgentBootstrapPrompt/5b3a0fac123530ad5906d3518b0ccf99629c54aa/agent-project-bootstrap/BOOTSTRAP.md)。完整提交 SHA：`5b3a0fac123530ad5906d3518b0ccf99629c54aa`；工具包版本 `0.4.0`。先以 Git 远程 ref 查询解析 main，重新读取该提交入口；协议与模板从同一提交获取，临时缓存按该提交的 Git blob SHA-1 核验。

来源记录仅供追溯，不是日常 Session 的外部读取依赖。无法核验来源提交时明确记录未知，不写入本机工具包或缓存绝对路径。

## 有效策略

下表记录本项目的有效策略，具体依据与操作范围见后文。不得通过修改本文件自行获得权限。

| 配置 | 生效值 | 含义 |
| --- | --- | --- |
| GIT_POLICY | detect-and-init | 已有 Git 复用；无 Git 且范围明确、无其他 VCS 约束时本地初始化 |
| REMOTE_POLICY | ask-once | 首次确认目标和分支；后续用户要求推送时沿用已确认目标，不按任务或文件重复询问；可选 existing-only、private-auto、disabled |
| TASK_TRACKING_POLICY | adaptive | 复杂、跨阶段、易中断、并行或需接力的任务建立记录；简单修改可不建 |
| PARALLEL_DEVELOPMENT_POLICY | task-worktree | 独立修改任务先建分支与 worktree，即使只有一个 Session；每个工作区一个写入者，集成分支仅接收成果 |
| AUTO_COMMIT_POLICY | verified-owned-units | 日常自动提交归属清楚且符合该逻辑单元验证要求的内容；用户明确要求推送时按项目快照规则保存当前状态 |
| RECOVERY_COMMIT_POLICY | on-handoff | 需交接时可保存明确标注的未完成工作；分支和副作用须符合项目约定 |
| AUTO_PUSH_POLICY | on-request | 用户要求推送时提交并同步整个项目可纳入 Git 的当前状态，包括已有修改和未完成内容；测试或人工验收不是备份门槛 |
| HUMAN_VERIFICATION_POLICY | criteria-based | 根据验收标准、主观要求和 Agent 验证能力决定是否需要人工确认 |
| INTEGRATION_POLICY | squash-on-completion | 满足集成条件后向已确认目标串行 squash，按任务形成成果提交；既有集成约定或用户限定优先 |

可将提交、恢复提交、推送策略改为 `ask` 或 `disabled`；任务跟踪可改为 `always` 或 `disabled`。关闭跟踪后必须说明跨 Session 恢复能力下降，不能仍承诺完整交接。`existing-only` 禁止新建远端但不自动授予上传权限；`private-auto` 仅在服务、账号/组织、名称与范围已确认时自动创建私有仓库。未识别的取值或相互冲突的配置需澄清，不静默采用更宽松策略。

`task-worktree` 是工作区安排，不自动委派其他 Agent，也不要求新建 Session。独立任务按需求范围识别，澄清、修正和未完成任务的接力沿用原任务；纯讨论/查询/审查通常不建分支。轻量任务可以不建 Task 文件，但仍使用独立任务工作区，以唯一分支和交付摘要追溯。已有 `single-writer` 保留其串行、按需隔离方式；已有 `follow-existing` 保留项目集成方式，不由初始化自动改成新默认。

集成目标采用项目已确认的 main 或其他集成分支，不重命名既有分支；目标未知时只暂停集成。`squash-on-completion` 默认将集成纳入修改任务的交付条件，但用户要求仅开发、评审或等待接受时遵循其范围。该策略仅允许集成当前任务，不允许合并未知任务、绕过提交/验收禁令、上传或部署。

`on-request` 在用户明确要求推送时保存项目快照，该请求覆盖必要的快照提交和整个项目当前内容，不限本轮任务，不逐项申请批准；遵循既有忽略规则并保护凭据。没有推送请求或持续授权时不自行上传。若项目已有 `authorized-milestones`，保留其按已授权且验证的里程碑自动推送的约定，不因初始化重置；用户明确改为按请求备份时再调整。

`REMOTE_POLICY=disabled` 时不因自动推送策略而执行远端操作；恢复提交也不得绕过项目明确禁止提交的约定。明确的用户新指示可调整相关范围，但无回复或任务文本不能代替授权。

具体冲突按以下规则处理，不要求用户重答整张表：

| 条件 | 实际行为 |
| --- | --- |
| TASK_TRACKING_POLICY=disabled | 不创建/更新任务记录和活动表；初始化可保留注明停用的导航章节，既有记录原样保留；仍核对文件并报告恢复入口及能力下降 |
| TASK_TRACKING_POLICY=always / adaptive | 分别为所有实际任务 / 满足复杂度条件的任务保留完整最低记录；不登记模板示例 |
| GIT_POLICY=disabled 或项目禁止 Git 写入 | 不初始化、暂存、提交或推送；许可的只读核对和文件保存可继续 |
| task-worktree 但无可用 Git/基线，或禁止创建分支/worktree | 不伪造隔离或偷偷改为共享并行；说明限制，只有确认单写入者且允许时才在现有目录保存文件，恢复 Git 条件后再安排隔离 |
| TASK_TRACKING_POLICY=disabled / adaptive 的轻量任务 | 不因工作区隔离强制创建 Task/活动表；仍核对唯一任务分支、基线、目标与依赖，并在许可的提交及交付摘要中追溯 |
| AUTO_COMMIT_POLICY=disabled | 不自动创建普通或恢复提交；RECOVERY_COMMIT_POLICY=on-handoff 不能覆盖禁令 |
| AUTO_COMMIT_POLICY=disabled / ask，或任务尚未满足集成条件 | 不由 squash 默认值绕过约定；保留任务分支和成果，已有适用提交/集成授权直接使用 |
| AUTO_COMMIT_POLICY=ask 或 RECOVERY_COMMIT_POLICY=ask | 相应提交须有适用明确授权；恢复提交同时满足两者，已有授权不重复询问 |
| RECOVERY_COMMIT_POLICY=disabled | 不自动创建恢复提交，普通提交仍按其策略判断 |
| REMOTE_POLICY=disabled 或 AUTO_PUSH_POLICY=disabled | 不自动推送；前者同时禁用其他远端操作，后者不替代远端读取策略 |
| AUTO_PUSH_POLICY=on-request 且 Git/提交/远端允许 | 明确推送请求下保存全部已跟踪文件的当前内容及删除、未忽略的新文件和已有修改；无需测试或人工验收先通过，任务完成状态单独判断 |

多 worktree 的项目备份需逐个说明实际覆盖：各任务写入者协调保存快照，未完成内容保留在任务分支，不为备份提前合入集成分支。任务备份分支须在已确认的同仓库 ref 范围内；若仅允许推送 main，其他任务可先保存本地并报告尚未远端备份，不能将“main 已推送”描述为全部任务已备份。内容授权不逐文件重问，缺少的分支范围只影响相应上传。

GIT_POLICY 可显式设为 `disabled`；启用 Git 时仍遵循既有项目检测/初始化约定。关闭提交不阻止安全文件保存，关闭推送不意味着另一台电脑已取得代码。无法解释的其他配置只阻塞相关动作，不采用较宽松取值。

## 策略依据与操作范围

初始化阶段，用户要求对当前 `auto_browser` 项目执行初始化，保留既有规范与未提交修改，完成后停止。识别时没有找到既有项目协作协议或等价治理文档，采用本表默认值；两份子目录 README、两份验收报告、测试资产和本机配置均原样复用/保留。该阶段范围不限制后续用户明确提出的任务，历史提示词不自动授予业务开发权限。

初始化阶段只新增治理文档、最小忽略规则并在目标根本地初始化 Git，未开始业务任务。初始化在指定工作区由当前 Agent 串行执行，没有自动迁移现有业务工作。当时 Git 身份缺失，因此没有暂存或提交既有内容，也没有伪造身份；历史核验见 `bootstrap-audit.md`。

2026-10-18 用户明确要求推送整个项目，指定 `https://github.com/yankee-007/BrowserAutomation.git` 和 `main`，并提供将分支改名为 `main` 的命令。已核对该仓库存在、为公开仓库，当前 GitHub 登录具有写入权限；`origin` 的实际 push URL 为上述唯一目标，允许 ref 为 `refs/heads/main`。内容范围包括现有源码、文档、测试、报告及证据，遵循忽略规则与凭据保护；授权包含必要的首次快照提交，不包含强推、其他 ref、持续自动上传或部署。当前待上传文件中没有 CI/部署工作流；不把上传授权扩展为发布操作。

授权记录只记录用户或有效项目约定明确允许的范围，至少能定位实际远端、允许分支、允许内容、适用任务/阶段、已知推送副作用及授权依据。单次交付结束后不自动延伸至下一轮；持续授权明确记录其边界。未授权时明确写“待确认”；有登录能力不等于有操作授权。已有适用授权直接使用，不重复询问。

按请求备份时，用户要求“推送/同步项目”默认指整个项目当前可纳入 Git 的状态，包含未完成或未验收内容，不再另求每项任务的内容授权；既有目标和分支可直接沿用。用户若限定具体文件或任务则遵循该范围。新建仓库、变更目标、强推、部署等动作另按实际指示处理。

## 项目入口与验证方式

验证入口在 [PROJECT_CONTEXT 的开发与验证入口](../../PROJECT_CONTEXT.md#开发与验证入口)；人的操作说明复用 [扩展 README](../../pagesense/README.md) 和 [Controller README](../../controller/README.md)。按改动选择既有检查，不将历史 PASS 数字当作本轮结果。本轮仅做文档与内容保护检查，范围见[核验记录](bootstrap-audit.md)。

本地集成分支采用用户指定的 `main`；初始化时的 `master` 无提交状态仅为历史记录。用户本次推送请求已授权在原目录由当前唯一写入者保存完整项目快照，无需从空基线创建 worktree。实际 HEAD、提交身份与远端同步状态通过 Git 核对，不把未完成的提交或推送描述为成功。首次快照须使用真实身份；取得完整代码提交后再安排后续任务隔离。

具备基线后，独立修改任务从已确认的集成分支具体完整提交建立 `task/<task-id>-<slug>`；轻量任务使用唯一随机标识，先查冲突。默认由当前唯一集成执行者在取得写入权后串行 squash 到 `main`，其他 Session 只交付其任务成果；交接先确认上一写入者停止，无执行层互斥时不同时集成。不得通过清空原目录来制造干净的集成工作区。远端允许分支为 `main`，推送仍需适用的明确请求。

本节适配时记录实际集成分支、任务分支命名、串行集成的执行方式及允许的远端分支范围。最轻量方式是指定一个集成执行者，无需常驻服务；多个 Session 自行集成时需要可验证的互斥执行方式，Markdown 状态、Task Owner、超时和 `git worktree lock` 都不能代替写入锁。

## 文档路径映射

默认根入口为 `AGENTS.md`、上下文为 `PROJECT_CONTEXT.md`、架构为 `docs/architecture.md`；协议在 `docs/agent/`，任务在 `docs/tasks/`，决策在 `docs/decisions/`。

| 职责 | 本项目实际路径/章节 |
| --- | --- |
| Agent 常驻入口 | [AGENTS.md](../../AGENTS.md) |
| 当前项目与未知项 | [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md) |
| 人的入口 | [README.md](../../README.md)，复用 `pagesense/README.md`、`controller/README.md` |
| 架构 | [docs/architecture.md](../architecture.md) |
| 有效策略与范围 | 本文件的“有效策略”“策略依据与操作范围”“项目入口与验证方式” |
| 任务、验证与交接 | [docs/agent/workflow.md](workflow.md) |
| Git 工作、交付与隔离 | [docs/agent/git.md](git.md) |
| 任务导航 | [docs/tasks/README.md](../tasks/README.md)，当前无登记任务 |
| 决策导航 | [docs/decisions/README.md](../decisions/README.md)，当前决策以索引为准 |
| 本轮范围与语义核验 | [docs/agent/bootstrap-audit.md](bootstrap-audit.md)，仅供初始化追溯，非日常必读 |

后续按实际路径读取。凭据、机器专属临时路径与活跃进程信息不写入共享策略。
