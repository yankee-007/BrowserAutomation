# PageSense Controller

PageSense V2.0 的 **Python 侧 Controller**：一个本地 WebSocket 服务，把浏览器里的
PageSense 扩展暴露成一组可编程的 Python 接口。

它只做两件事：**传输** 与 **结构化 API**。
浏览器 DOM 的读取与操作全部仍由 PageSense 扩展完成 —— Controller 不使用
Selenium / Playwright / CDP，也不直接接触浏览器。

```
Python Controller  (WebSocket Server, 127.0.0.1:8765)
        ↕  ws
PageSense Extension (WebSocket Client, Service Worker)
        ↕  chrome.tabs.sendMessage
Content Script: Scanner / Element Search / Highlighter / Action Executor
        ↕
      Browser DOM
```

---

## 安装

```bash
cd controller
pip install -r requirements.txt
```

依赖只有 `websockets` 一个库。不需要数据库、消息队列、Web 框架或 LLM SDK。

---

## 启动

```bash
python server.py
```

输出：

```
PageSense Controller
Listening: 127.0.0.1:8765
Token: 3F9A21C4B7E05D18

Waiting for extension...

输入 help 查看命令。

>
```

> **token 每次启动随机生成**，不会写进任何源码。把这一行的 token 复制到
> 侧栏“Python 对接”的连接配置里，点击「连接 Python」。

可选参数：

```bash
python server.py --port 8765          # 端口（默认 8765）
python server.py --token MYTOKEN      # 固定 token（便于反复调试）
python server.py --timeout 10         # 单请求超时秒数（默认 10）
python server.py --no-cli             # 只启动服务，不进入交互 CLI
```

`python cli.py` 与 `python server.py` 等价。

---

## 连接扩展

1. 浏览器加载 `pagesense/` 扩展（见上级 README）
2. 打开 PageSense 侧栏 → **Python 对接** → 展开 **连接本地 Python**
3. 填入 `server.py` 打印的 token，确认端口是 `8765`
4. 点击 **连接 Python**

连接成功后：

```
Controller
● 已连接
127.0.0.1:8765
```

Controller 端同时打印：

```
PageSense connected
version=2.0.0
```

连接状态只有四种：`DISCONNECTED` / `CONNECTING` / `CONNECTED` / `ERROR`。

---

## 先选元素，再写 Python

侧栏点选元素后可复制完整 Python 脚本，不需要先扫描。`client.locator(css)` 每次操作
重新解析原生 CSS，要求唯一匹配，并将页面身份传入 Action Executor。它不包含自动等待或重试。

```python
target = client.locator('[data-testid="search-order"]')
target.click()
client.locator('input[name="order"]').input("PS-1001")
text = client.locator("#status").text()
```

侧栏还可主动发送选中元素、整个扫描或筛选后的全部结果：

```python
snapshot = client.wait_for_export(timeout=120)
element = snapshot["elements"][0]  # 业务代码自行选择目标
client.element(element).locate()
text = client.element(element).text()
```

这些示例使用已经启动且连接的 `client`。每个 `PageSenseClient` 自带本地服务，
同端口不要与 `server.py` 同时启动。完整启动代码和 UI 流程见[元素工作台](../docs/element-workbench.md)。

`client.element(element)` 和接受字典的 `click/inspect/input/clear/keypress/locate/highlight`
携带 `pageId`，换页返回 `STALE_PAGE`。兼容旧式数字 ID 的接口仍不防跨页面误用；
请传整个元素字典或使用 `locator()`。`read_text(element)` / `element.text()` 返回最多
20000 字符，不操作系统剪贴板；`inspect()` 可查看截断标记。

主动发送的协议为 `EXPORT {id, data}` / `EXPORT_ACK {id, success, error?}`，仅在认证连接上使用；
ACK 表示进入内存收件箱，尚未执行。最多 8 份及总计 64 MiB，满时拒绝而不覆盖；
`wait_for_export()` 默认等待 60 秒，超时抛 `TimeoutError`。停止服务后收件箱丢失。
新 `RESOLVE_ELEMENT {selector}` 返回详情、候选定位器与页面句柄；零/多命中分别为
`ELEMENT_NOT_FOUND` / `AMBIGUOUS_SELECTOR`，无效 CSS 为 `INVALID_SELECTOR`。

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
