# PageSense Controller

PageSense V2.0 的 **Python 侧 Controller**：一个本地 WebSocket 服务，把浏览器里的
PageSense 扩展暴露成一组可编程的 Python 接口。

默认由插件通过 Native Messaging 启动本地桥接，业务 Python 是客户端。它只提供**传输**与**结构化 API**。
浏览器 DOM 的读取与操作全部仍由 PageSense 扩展完成 —— Controller 不使用
Selenium / Playwright / CDP，也不直接接触浏览器。

```text
Python 业务客户端 ↔ 本地 Host（浏览器启动）↔ Native Messaging ↔ 扩展 → DOM
兼容旧模式：Python Server ↔ WebSocket ↔ 扩展 → DOM
```

---

## 安装

```bash
cd controller
pip install -r requirements.txt
```

依赖只有 `websockets` 一个库。不需要数据库、消息队列、Web 框架或 LLM SDK。

---

## 默认：插件启动桥接，Python 直接连接

首次在本目录运行 `python install_bridge.py`，重新加载插件并点击“重试自动连接”。
安装器会匹配本项目已安装扩展的 ID；也可从插件复制带扩展 ID 的安装命令。
仅注册当前用户的 Chrome / Edge Native Messaging Host，不需要管理员。

之后打开插件，直接运行自己的 Python 脚本：

```python
from pagesense import PageSenseClient

with PageSenseClient() as client:
    page = client.scan(scope="content")
    print(len(page["elements"]))
    # 用真实网页的唯一 CSS：
    client.locator('[data-testid="search-order"]').click()
```

`PageSenseClient()` 只连接浏览器自动启动的 Host，不监听端口，不需 server.py、手动 Token 或
`wait_for_extension()`。关闭业务脚本保留浏览器桥接，断线不重放命令；可重新 start() 连接。
同一浏览器会话限一个业务客户端，多个浏览器需通过 session_id / extension_id 明确选择。

## 发送当前页面全部扫描元素

插件“发送到 Python”默认会重新扫描当前页面，并发送当前扫描范围内全部元素，包含其他分页、
不受搜索过滤影响。未手动扫描也可以直接发送，Python 未运行时先保存在本地 Host 的内存收件箱。

```python
from pagesense import PageSenseClient

with PageSenseClient() as client:
    snapshot = client.wait_for_export(timeout=120)
    print(snapshot["page"]["url"], len(snapshot["elements"]))
    element = snapshot["elements"][0]  # 业务代码自行选择目标
    client.element(element).locate()
    text = client.element(element).text()
```

ACK 只表示入箱，不代表已执行；最多 8 份、总计 64 MiB，满时拒绝不覆盖。
收件默认等 60 秒，超时抛 TimeoutError；关闭浏览器/Host 会丢失未消费数据。
扫描结果可超过 1 MiB；发往插件的单条命令受 Native Messaging 1 MiB 上限约束，超限执行前拒绝。

## 定位与读取

`client.locator(css)` 每次操作解析原生 CSS，恰好一个节点才能执行，无需先扫描；不含自动等待。
支持 click/input/clear/keypress/locate/highlight/inspect/text。`client.element(element)` 固定快照
中的 elementId + pageId；换页返回 STALE_PAGE，不猜测替代目标。旧式纯数字 ID 仍保留跨页风险。
`read_text(element)` / `element.text()` 返回最多 20000 字符，不操作系统剪贴板；inspect() 可查截断标记。

## 兼容：手动 WebSocket 服务与 CLI

旧方式保留：运行 `python server.py`（或 `python cli.py`），在插件选择“手动 WebSocket（兼容旧脚本）”，
填入端口和该服务打印的 Token。原参数 --host / --port / --token / --timeout / --no-cli 不变。
若业务代码需要自行启动旧服务，使用 `PageSenseClient(mode="server", port=8765)`；from_server() 仍可包装已有服务。
默认模式使用自定义 host/port/token 会要求显式选择 server 模式，不会静默忽略配置。

完整安装、生命周期、多会话、协议与验证见[自动桥接说明](../docs/native-bridge.md)和[元素工作台](../docs/element-workbench.md)。

## CLI 命令

CLI 是**完全人工**的：每条命令由人输入，映射到一个协议方法。
没有自然语言解析、没有 LLM 决策、没有自动执行。

```
  scan                        扫描当前活动页面
  search <query>              在最近一次扫描结果中搜索元素
  locate <elementId>          滚动到元素
  highlight <elementId>       高亮元素
  clear-hl                    取消高亮
  click <elementId>           点击元素
  input <elementId> <value>   输入文本
  clear <elementId>           清空输入
  keypress <elementId> <key>  发送按键
  scroll <up|down|left|right> [amount]
  status                      连接与活动页面状态
  ping                        连通性检查
  help / quit
```

典型流程：

```
> scan
28 elements

> search 搜索
3 results

#18 BUTTON
搜索
score=100
matched=text

#16 INPUT
搜索职位、公司
score=60
matched=text

#19 BUTTON
搜索职位
score=80
matched=text

> input 16 AI应用工程师
SUCCESS (#16)

> click 18
SUCCESS (#18)
```

### 为什么没有 `click "立即沟通"`

V2.0 **故意不提供** search-and-click 之类的复合命令。
自动「搜索 → 选第一条 → 点击」会在用户没有确认目标的情况下产生误操作。
流程被强制拆成两步：

```
search <query>      ← 人看到结果
click <elementId>   ← 人指定唯一目标
```

未来的 Agent 层可以自己实现选择策略，但那不是 V2.0 的职责。

---

## Python API

页面内容扫描、分页与结构定位示例：

```python
snapshot = client.scan(scope="content")  # interactive / content / all
page3 = client.search("价格", limit=100, offset=200, tag="p", class_name="price")
matches = client.search("", selector="article.card > p.price",
                        attrs={"data-kind": "price"}, in_viewport=True)
details = client.inspect(matches["results"][0]["elementId"])  # 人确定目标后读取详情
```

`search` 还可使用 `category`（分组或细分类）、`dom_id`（精确 HTML ID）。
多个条件取交集；class_name 的空格分隔 token 必须全部匹配。每页 limit 最多 100，
offset 无总计 100 条限制；返回 total/returned/offset/truncated 与真实 indexSize。
详情包含当前属性、唯一 CSS、父子上下文与文本/HTML 片段，截断有明确标记。
旧的位置参数 scan(timeout)、search(query, limit, timeout) 保持兼容；新参数使用关键字。
不传 scope 时复用当前文档已有扫描范围（文档首次默认为 interactive），建议显式指定。
同一文档重扫/范围切换保留存活节点 ID；导航或切页后仍必须取得新结果。
完整语义与限制见[元素查询说明](../docs/element-explorer.md)。

```python
from pagesense import PageSenseClient

client = PageSenseClient(token="<server.py 打印的 token>").start()
client.wait_for_extension(timeout=60)

state   = client.scan()                       # page / stats / elements
results = client.search("立即沟通")            # {"total": n, "results": [...]}
client.locate(element_id)
client.highlight(element_id)
client.clear_highlight()
client.click(element_id)
client.input(element_id, "AI应用工程师")
client.clear(element_id)
client.keypress(element_id, "Enter")
client.scroll("down", 500)
client.ping()
client.get_status()
client.stop()
```

`search()` 的 `results[i]` 形如：

```python
{
  "elementId": 18,
  "score": 100,
  "matchedFields": ["text"],
  "element": {"tag": "button", "text": "搜索", "role": None,
              "visible": True, "inViewport": True}
}
```

失败时抛出 `protocol.PageSenseError`，`err.code` 是协议错误码
（`ELEMENT_NOT_FOUND` / `INVALID_ELEMENT_ID` / `ELEMENT_DISABLED` /
`RESTRICTED_PAGE` / `NO_ACTIVE_TAB` / `REQUEST_TIMEOUT` / `UNKNOWN_METHOD` …）。

作为上下文管理器使用也可以：

```python
with PageSenseClient(token="...") as client:
    client.wait_for_extension()
    print(client.scan()["stats"])
```

---

## 协议

### HELLO 握手

扩展连上后立刻发送（唯一的未认证消息）：

```json
{
  "type": "HELLO",
  "protocol": "pagesense/1",
  "client": "extension",
  "version": "2.0.0",
  "token": "3F9A21C4B7E05D18"
}
```

Controller 校验 token 与协议版本：

```json
{ "type": "HELLO_ACK", "success": true }
```

失败：

```json
{ "type": "HELLO_ACK", "success": false,
  "error": { "code": "UNAUTHORIZED", "message": "token 校验失败。" } }
```

### 请求 / 响应

```json
{ "id": "req_001", "type": "REQUEST", "method": "SEARCH_ELEMENTS",
  "params": { "query": "立即沟通", "limit": 20 } }
```

```json
{ "id": "req_001", "type": "RESPONSE", "success": true,
  "result": { "total": 2, "results": [ ... ] } }
```

```json
{ "id": "req_002", "type": "RESPONSE", "success": false,
  "error": { "code": "NO_ACTIVE_TAB", "message": "没有可操作的活动页面。" } }
```

* 每个请求有唯一 `id`（`req_001`、`req_002` …），响应**按 id 关联**，
  不依赖消息到达顺序
* 每个请求有超时（默认 10s），超时抛 `REQUEST_TIMEOUT`，不会无限等待
* V2.0 一次只发一个 Action：`request → response → next request`，无 Action Queue

### 方法

| method | 说明 |
|---|---|
| `PING` | 连通性检查 |
| `GET_STATUS` | 连接状态 + 活动页面 |
| `SCAN_PAGE` | 扫描活动页面 |
| `SEARCH_ELEMENTS` | 在最近一次扫描结果中搜索 |
| `GET_ELEMENT_DETAILS` | 按 elementId 读取当前属性、CSS 路径、文本/HTML 与父子上下文 |
| `LOCATE_ELEMENT` | 滚动到元素 |
| `HIGHLIGHT_ELEMENT` | 高亮元素 |
| `CLEAR_HIGHLIGHT` | 取消高亮 |
| `CLICK_ELEMENT` | 点击 |
| `INPUT_ELEMENT` | 输入文本 |
| `CLEAR_ELEMENT` | 清空输入 |
| `KEYPRESS_ELEMENT` | 发送按键 |
| `SCROLL_PAGE` | 页面滚动 |

### 心跳

扩展每 20 秒发送一次应用层心跳（用于维持 MV3 Service Worker 存活）：

```json
{ "type": "HEARTBEAT", "ts": 1720000000000 }
{ "type": "HEARTBEAT_ACK", "ts": 1720000000000 }
```

---

## 安全

* **只监听回环地址**：`ControllerServer` 拒绝 `0.0.0.0` / 局域网 IP / 主机名，
  只接受 `127.0.0.1` 与 `localhost`。V2.0 不支持远程 Controller。
* **连接前必须通过 token 校验**：token 由 `secrets.token_hex(8)` 每次启动随机生成，
  不在源码、配置或扩展里硬编码；使用 `secrets.compare_digest` 比较。
* **扩展始终是 client**：浏览器扩展无法监听端口，MV3 也禁止常驻后台页，
  因此架构上不存在「扩展开端口等连接」的方向。
* **请求日志只在内存**：扩展只保留最近 20 条请求的 method/时间/结果，
  不把页面内容写入 storage。

---

## 测试

```bash
# 协议 / 传输单元测试（无需浏览器）
python -m unittest test_bridge -v

# 真实扩展 <-> Python E2E（需要已启动的 Edge + 扩展 + demo 静态服务器）
python test_e2e.py
```

---

## 当前限制

* 只操作**当前活动标签页**，不支持指定 tabId 或后台标签页
* 不支持多浏览器实例同时连接（同一时刻只有一个 Controller session）
* 无 Action Queue、无批量执行、无重试编排
* 不支持远程 Controller（设计上仅回环地址）
* `file://` 页面未在 `host_permissions` 范围内，Controller 无法注入
* **不包含任何 LLM / Agent / Planner**：V2.0 只提供 Browser Runtime + Transport
