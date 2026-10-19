# 设计决策记录

已登记的实际架构决策见下表。

| ID | 决策 | 状态 | 相关领域 | 文件 |
| --- | --- | --- | --- | --- |
| ADR-20261019-c82ab49d1e06 | 插件启动本地桥接，Python 默认作为客户端 | Accepted | 传输、安装、SDK | [决策](ADR-20261019-c82ab49d1e06-native-bridge.md) |

## 创建门槛

至少涉及一项重要影响：跨模块架构、数据模型、长期接口、实质方案取舍、值得避免的真实失败方案，或显著兼容/回归风险。简单代码写法、普通 UI 布局或未经讨论的技术选择不机械生成 ADR。

使用项目已有 ID；无约定时可用 `ADR-<YYYYMMDD>-<12位随机十六进制>`，检查可见冲突。文件包含标题及 Status、Context、Options Considered、Decision、Rationale、Consequences、Related Areas；只有存在真实证据时才增加 Failed Approaches。

状态采用 Proposed、Accepted、Deprecated、Superseded。Agent 提议不能冒充已接受决定；被替代时保留原记录并链接后继决策，不重写过去理由。

当前架构见 [architecture](../architecture.md)，任务执行细节放在 [任务记录](../tasks/README.md)，避免重复记录。

既有 WebSocket 模式继续保留兼容；本次记录仅追溯用户授权的新默认连接方式，不倒填历史决策。
