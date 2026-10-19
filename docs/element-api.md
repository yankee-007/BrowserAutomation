# 按需 CSS / XPath 元素对象

Python 发出定位条件和操作，插件在当前活动标签页的真实 DOM 中执行。无需预先扫描、打开侧栏结果列表或点击“发送到 Python”。首次桥接安装沿用[自动桥接](native-bridge.md)。侧栏用于探索页面，打开即自动实时扫描，没有手动扫描按钮或实时开关；关闭侧栏释放监听，不影响 Python 通过已连接 Host 主动查询。

## 编写方式

在 `controller/` 目录运行，选择器使用真实页面的属性或侧栏复制的 CSS / XPath：

```python
from pagesense import PageSenseClient

with PageSenseClient() as client:
    button = client.find("css_position", "#search-btn")
    button.click()

    container = client.find("xpath_position", '//*[@id="content"]')
    text = container.get_text()
    info = container.get_all()

    links = container.findall("css_position", "a")
    for link in links:
        print(link.get_text(), link.get("href"))

    paragraphs = container.get_all_texts("p")
    print(paragraphs)
```

`css_position` 支持原生 CSS；`xpath_position` 支持返回元素节点的 XPath。别名为 `css` / `css_selector`、`xpath`，兼容输入拼写 `css_positon`。不支持 Playwright 专用伪选择器、XPath 标量/属性/文本节点或任意 JavaScript。`client.css_position(css)`、`client.xpath_position(xpath)` 是单元素便捷方法；`find_all` 等同于 `findall`。

侧栏复制的 XPath 优先短路径：用最近唯一祖先 ID 作锚点、普通 HTML 标签名，并省略多余的 `[1]`；仅对内联 SVG/MathML 或 XML 文档退回 `local-name()` / `namespace-uri()` 写法。生成后会在页面中校验唯一命中，手写 XPath 不受该格式限制。

## 查询与作用域

- `client.find(by, selector, strict=True)` 立即查询并要求唯一匹配：无匹配抛 `ELEMENT_NOT_FOUND`，多匹配抛 `AMBIGUOUS_SELECTOR`。显式 `strict=False` 时取 DOM 顺序首项。
- `client.findall(by, selector)` 返回 DOM 顺序的元素对象列表，无匹配返回 `[]`。一次最多 10000 个匹配，超过时明确抛 `TOO_MANY_ELEMENTS`，不静默截断。
- `element.find(...)` / `element.findall(...)` 在该容器内查询；XPath 推荐 `.//a`。即使 XPath 使用全局路径或上行轴，也不会返回容器外的节点。
- 查询包含当前实际存在的 DOM，不受侧栏扫描范围、搜索、可见性或分页过滤影响；不会自动加载虚拟列表、递归 iframe / Shadow DOM。
- 仍只面向当前活动标签页，没有新增标签页切换或后台标签页路由。

## 元素方法与返回值

| 方法 | 返回值 / 行为 |
| --- | --- |
| `click()` | 复用原 Action Executor：滚动到节点后 `element.click()`，返回动作回执 |
| `input(value)` / `clear()` / `keypress(key)` | 复用既有输入、清空、按键逻辑 |
| `locate()` / `highlight()` | 既有定位滚动 / 高亮 |
| `get_text()` / `get("text")` | 当前节点文本字符串，优先 innerText，兼容 textContent/value；密码隐藏 |
| `get(name)` / `get_attribute(name)` | 原始 HTML 属性字符串；属性缺失返回 None。例如原始相对 href |
| `get_property(name)` | DOM 标量属性；href/src 可返回解析后的绝对地址，checked 等可返回 bool |
| `get_all()` | 原有 inspect 详情字典：element、text、html、定位器、上下文及截断标志 |
| `get_all_texts(selector, by="css_position")` | 容器内匹配节点的文本列表，一次请求；client 同名方法作用于整页 |

可读取的 DOM property 白名单为 href、src、value、checked、disabled、selected、id、className、tagName、textContent、innerText，不返回函数、节点对象或任意 getter。`get_all()` 不代表递归下载整页；详情保留原有 20000 字符文本/HTML 上限与 `textTruncated` / `htmlTruncated`，子上下文最多 20 项。新增的标量读取若超过 20000 字符，Python 明确抛 `TEXT_TRUNCATED`；批量文本遇任一项截断也报错。批量返回累计最多 200 万字符，超过抛 `RESULT_TOO_LARGE`。

## 节点身份与兼容

`find` / `findall` 查询结果只传递 `{pageId, elementId, referenceId}`，不附带文本、属性或 HTML。Python 元素对象绑定查询时的真实节点，后续动作不再用列表索引重新查找。文档内的独立 WeakRef 引用不随扫描编号变化；重扫、列表插入和节点重排不改变原目标。节点删除/被克隆替换后返回 `ELEMENT_NOT_FOUND`，刷新、导航或切到另一文档返回 `STALE_PAGE`，不会猜测替代元素。

`findall` 返回一次查询的列表快照，不会自动增删列表项；需要最新集合时重新查询。没有自动等待、导航完成判断或动作重放；点击回执仅代表调用已执行。

侧栏扫描和旧 scan/search 共享当前文档的扫描范围与索引。Python 显式 scan(scope=...) 时，侧栏范围控件与结果会同步该范围；新 find/findall 不更改扫描范围，也不依赖该索引。

旧 `client.locator(css)` 保留“每次操作重新解析 CSS”的行为，`client.element(snapshot_element)` 和扫描/发送也保留。旧纯数字 ID 的跨页风险没有被本任务整体修复，优先使用新元素对象。旧 `.text()` / `read_text()` 的截断兼容行为不变，需要显式完整性检查时使用新 `.get_text()`。

## 协议与验证

新增通用方法为 `FIND_ELEMENTS`（by/selector、multiple、strict、可选 scope）、`READ_ELEMENT`（句柄、mode、name）、`READ_ELEMENTS`（容器内批量文本）。请求与回复沿用现有 Native/WebSocket 请求 ID、超时和错误封装。所有动作仍走同一个 Content Router / Action Executor，没有新增业务编排或第二套点击实现。

测试入口：`python -m unittest discover -s controller -p 'test_*.py'`、`node acceptance/element-api-unit.js`、`node acceptance/element-api-browser.js`。Node 需 jsdom / puppeteer-core，真实测试默认独立 Chrome；只创建随机测试 Host 注册和合成 HTTP 页面，结束时关闭自己的进程并移除测试注册。证据在 `acceptance/evidence-element-api/`；不读取个人浏览器页面或凭据。
