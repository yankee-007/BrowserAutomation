# 插件自动桥接与 Python 客户端

默认由浏览器插件启动本地桥接，Python 业务脚本作为客户端连接。无需单独运行 `server.py`，也无需手动复制 Token。

## 首次安装（Windows）

1. 在 Chrome / Edge 扩展管理页重新加载项目的 `pagesense/`，关闭再打开侧栏。新版增加 `nativeMessaging` 权限。
2. 在 `controller/` 执行：

   ```powershell
   python -m pip install -r requirements.txt
   python install_bridge.py
   ```

   安装器只从 Chrome / Edge 的扩展配置中匹配本项目目录，自动取得已安装扩展 ID。若未匹配，在侧栏“Python 对接”复制包含 ID 的安装命令，例如 `python install_bridge.py --extension-id <扩展ID>`。可通过 `--browser edge` 或 `--browser chrome` 仅注册指定浏览器，默认两者都注册。

3. 插件选择“自动连接（推荐）”，点击“重试自动连接”。显示“桥接就绪 · 等待 Python”后，直接运行下面的业务脚本。以后浏览器加载插件时会自动启动桥接。

安装器写入当前用户 `%LOCALAPPDATA%/PageSense/native-host` 的启动器和配置，以及 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.pagesense.bridge` / Chrome 对应注册项。不需要管理员，不修改浏览器资料、历史、扩展安装状态或防护设置。启动器引用当前项目和当前 Python 解释器；移动项目或删除解释器后需重新运行安装器。

## Python 直接使用

在 `controller/` 中运行脚本：

```python
from pagesense import PageSenseClient

with PageSenseClient() as browser:
    page = browser.scan(scope="content")
    print(page["page"]["url"], len(page["elements"]))
    # 使用实际网页的唯一 CSS：
    browser.locator('[data-testid="search-order"]').click()
    text = browser.locator("#status").text()
```

`PageSenseClient()` 不再打开监听端口；`start()` / `with` 发现并连接浏览器已经启动的桥接。退出 `with` 只关闭业务连接，插件和收件箱仍可用。未打开桥接时抛 `BRIDGE_NOT_RUNNING`，不会偷偷启动另一个服务。断开后的操作失败，不自动重发副作用命令；恢复连接后可重新 `start()`。

同一浏览器会话同时允许一个业务客户端，第二个脚本得到 `CLIENT_IN_USE`，不会抢占。若多个浏览器桥接可用，返回 `AMBIGUOUS_BROWSER` 并列出会话 ID；使用 `PageSenseClient(session_id="...")` 明确选择，也可用 `extension_id="..."` 区分扩展。没有唯一目标时不会猜选浏览器。

## 默认发送当前页面全部扫描元素

“Python 对接”的发送范围默认是“当前页面全部扫描元素”。点击时会对侧栏所属窗口的当前页面重新扫描，发送当前扫描范围内的全部结果：不受搜索、分类或分页影响，未预先扫描也能发送；切页或导航过程中丢弃旧异步结果。

```python
from pagesense import PageSenseClient

with PageSenseClient() as browser:
    snapshot = browser.wait_for_export(timeout=120)
    print(snapshot["kind"], len(snapshot["elements"]))
    # 按你的流程选取目标；收件本身不执行操作。
    element = snapshot["elements"][0]
    browser.element(element).locate()
```

可以先点击发送再运行 Python：数据在桥接进程的内存收件箱中等待。未连接 Python 时显示“本地收件箱已收到”；客户端连接后可以消费。最多 8 份、序列化载荷合计 64 MiB，满时明确拒绝，不覆盖旧数据。ACK 仅代表进入本机收件箱，不代表业务已消费、已执行或已保存。`wait_for_export()` 默认等 60 秒，超时抛 `TimeoutError`。

仍可手动选择“当前选中元素”或“当前筛选的全部结果”。全部发送是扫描得到的可见 DOM 元素，默认范围为内容与控件；如需普通容器，请将扫描范围改为“全部可见 DOM”。它不会递归 iframe / Shadow DOM，也不会得到未挂载虚拟列表或 Canvas 绘制内部元素。

## 连接生命周期和协议边界

- Native Messaging 在浏览器和 Host 之间使用长度前缀 UTF-8 JSON。Host 发往扩展单帧最多 1 MiB，扩展发往 Host 最多 64 MiB。大整页扫描走后者，已实际验证超过 1 MiB；超限输入等命令在执行前返回 `REQUEST_TOO_LARGE`，不截断。
- Host 在 `127.0.0.1` 的系统分配端口提供业务客户端连接，拒绝带网页 Origin 的 WebSocket。随机配对凭据只存当前用户 `%LOCALAPPDATA%/PageSense/runtime/*.json`；Python 自动读取，不发送到 UI 或页面，不写入项目。
- Native Host 只允许安装时登记的扩展 origin；浏览器负责启动已注册的 Host。Python 业务脚本不会启动或接管 Host。所有 DOM 操作复用现有 Content Router / Action Executor。
- 关闭业务客户端不会关闭 Host。关闭浏览器/原生 Port 后，Host 退出并删除自己的发现文件；异常强制终止可能留下文件，客户端忽略不可连接的旧记录。浏览器重启产生新的端口和凭据。
- 点击“断开”会暂停插件连接，暂停状态跨 Worker 重启保留；点击“重试自动连接”恢复。启动事件合并为一次初始化，状态查询等待初始化完成。失败时按 30 秒间隔尝试恢复，侧栏也能手动重试；命令不重放。
- 多份浏览器会话和用户显式选择的 `session_id` 是有意的作用域，不自动切换。`PAGESENSE_RUNTIME_DIR` / `runtime_dir` 可用于隔离测试或明确配置的运行目录。

## 兼容旧脚本

原 `server.py` / CLI 和 WebSocket 桥接保留。在插件选择“手动 WebSocket（兼容旧脚本）”，业务代码显式使用 `PageSenseClient(mode="server", port=8765)`，或运行 `python server.py`，再填写该服务的端口与 Token。

默认模式传入自定义 host/port/token 会提示显式选择 `mode="server"`，避免静默忽略旧配置。`PageSenseClient.from_server()` 继续包装已存在的旧服务。旧模式的 Worker 长断线缺陷及纯数字 elementId 跨页风险仍保留；推荐使用 CSS 定位器或包含 pageId 的元素字典。

## 验证与参考

新证据在 `acceptance/evidence-native-bridge/`。Python 3.14 下已通过 52 项 Python 测试，依赖下限 15.0.1 与当前 17.2 均验证，两个版本均完成真实 Native Messaging 链路。真实 Chrome 155、临时配置、独立测试 Host 注册和合成 HTTP 页面覆盖浏览器启动 Host、客户端连接、预先收件、整页重扫、超限命令拒绝、大扫描、客户端退出/重连、页面句柄保护、生成代码实际执行和浏览器退出清理；测试注册只操作随机测试名称，结束时删除自身注册。还包含旧工作台、查询、点选与实时扫描回归。用户个人浏览器的重新加载和主观接受不代称已验证。

设计依照 [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) 与 [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)；不使用 Selenium / Playwright / CDP 执行产品流程。CDP 只用于隔离验收设施。
