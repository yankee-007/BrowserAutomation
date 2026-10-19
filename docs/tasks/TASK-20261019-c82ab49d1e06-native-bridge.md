# TASK-20261019-c82ab49d1e06：插件自动桥接与默认整页发送

- 状态：done；更新时间：2026-10-19（Asia/Shanghai）；唯一写入者：当前 Agent。
- 需求：插件通过 Native Messaging 启动本地桥接；Python 默认为客户端，直接获取数据和发送基础操作；发送默认选当前页面全部扫描元素，无扫描时自动扫描。不额外要求启动 server.py 或手动 Token 配对。
- 基线：`b72a672`，main 无未提交内容。任务分支 `task/20261019-c82ab49d1e06-native-bridge`，同级 worktree `BrowserAutomation-native-bridge`；集成目标 main，无依赖任务。
- 范围：原生 MV3、轻量 Python、本机当前用户 Native Messaging 注册及说明。保留显式旧 WebSocket 服务模式；不加入业务决策或批量动作。
- 完成标准：实际浏览器启动 Native Host，Python 默认连接并完成扫描/唯一定位/操作/收件；完整跨分页发送、页面切换保护、客户端退出和重连、无 Host 引导、权限和消息边界有测试；旧模式回归；320/400/600px 可用。
- 设计：沿用工作台色板、系统字体、左对齐和紧凑表单，不重新设计视觉系统。对接页默认显示自动桥接状态与首次安装命令，端口/Token 收到兼容模式中；明确“桥接就绪”和“Python 已连接”，避免未运行 Python 时误报连接。
- 方案：浏览器 Native Port → Python 原生 Host → 回环 WebSocket → 业务 Python 客户端。凭据自动生成并仅存当前用户运行目录；发现多个浏览器会话时拒绝猜选。复用既有 Content Router / Action Executor；Host 收件只传数据。
- 快照：已实现 Native Host / 本地客户端 / 当前用户注册器、插件自动启动和状态区分、原生消息边界、客户端重连与单客户端占用保护。默认整页发送会先重新扫描，包含跨分页结果、不受查询影响。旧服务器需显式 mode="server"，UI 在兼容模式中提供端口与 Token。已找到当前项目已安装扩展的注册元数据，集成后可为其安装主目录桥接，不读取历史或凭据。
- 验证：真实 Chrome 155 从已注册的测试 Native Host 启动、Python 客户端扫描/操作/预先收件、默认完整重扫、超过 1 MiB 的扫描、超限命令拒绝、旧句柄、客户端退出/重连、复制源码实际执行和浏览器退出清理均已通过；52 项 Python 回归在 websockets 15.0.1 与 17.2 均通过。旧模式工作台与 5000 元素查询回归已通过。证据在 acceptance/evidence-native-bridge/；启动去重、状态初始化竞争、模式切换草稿保留与断开待响应清理已补充单测。最新 Native 链路与旧工作台/查询/点选/实时五套实际浏览器测试均通过；JS 单测和语法检查、差异检查通过，源码检查对应本任务成果；集成版本按 Git 与证据哈希核对。
- 交付：当前唯一执行者形成任务成果并串行 squash 至 main，具体提交通过本 Task ID 查询。已更新安装/SDK/工作台说明、当前架构、上下文和 Native Bridge ADR。当前用户安装器随后从 main 运行，为已匹配项目目录的扩展注册主目录启动器；实际安装结果在交付时核验，不将用户重新加载或主观接受写为已完成。本轮没有推送请求。
- 恢复入口：[自动桥接](../native-bridge.md)、acceptance/evidence-native-bridge/、本任务分支。用户仍需在自己的浏览器重新加载扩展以取得 nativeMessaging 权限；未通过 UI 自动化操作其个人浏览器。旧模式历史独立 FAIL、纯数字 ID 及长断线问题不据此关闭。
