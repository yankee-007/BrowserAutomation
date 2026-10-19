# ADR-20261019-c82ab49d1e06：由插件启动本地桥接

- Status：Accepted；2026-10-19。用户明确要求实现插件启动桥接、Python 直接调用，并默认发送当前页面完整扫描。
- Context：原默认模式由业务 Python 监听端口，插件填写 Token 连接。用户希望浏览器插件准备连接，业务脚本只获取数据和发送命令。项目保持原生 MV3 / JavaScript 与轻量 Python，不能让扩展直接监听标准 WebSocket 服务。
- Options Considered：继续内嵌 Python Server 可以省一次安装，但仍需业务脚本承担服务和手动配对；常驻独立系统服务会增加生命周期和权限负担；Native Messaging 支持浏览器唤起当前用户已注册的程序，符合目标。
- Decision：默认使用 Native Messaging 唤起 Python Host；Host 复用既有请求关联和有界数据收件箱，在回环随机端口接受业务 Python 客户端。凭据自动发现，单浏览器单客户端，多会话拒绝猜选。保留显式 `mode="server"` 的旧模式。
- Rationale：浏览器拥有桥接生命周期，业务脚本不再开服务或复制 Token；DOM 仍在既有 Executor 执行。安装器只注册当前用户，不需要系统服务、管理员或新第三方运行依赖。原生消息的方向限制明确：扫描可超过 1 MiB，发往浏览器的超限命令必须拒绝。
- Consequences：首次安装需当前用户 Host 注册；移动项目/解释器后需重装。默认 PageSenseClient 语义改变，旧脚本需显式 server 模式。收件只存在 Host 内存，关闭浏览器后不持久化；未知动作结果不自动重试。当前自动安装器仅支持 Windows Chrome/Edge。
- Related Areas：[使用说明](../native-bridge.md)、[当前架构](../architecture.md)、[任务](../tasks/TASK-20261019-c82ab49d1e06-native-bridge.md)。
