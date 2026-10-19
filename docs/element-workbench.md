# 元素工作台与 Python 自动化

PageSense 使用已经打开的浏览器页面。插件负责读取 DOM 和执行基础操作，Python 负责你编写的流程。无需 Selenium / Playwright 驱动或前端构建。

## 默认自动连接

首次按[自动桥接说明](native-bridge.md)安装当前用户本地桥接，再重新加载扩展。浏览器会自动启动桥接，Python 使用 `PageSenseClient()` 作为客户端，不再单独运行 server.py 或复制 Token。

## 从页面选取到代码

1. 更新代码后，在浏览器扩展管理页重新加载 `pagesense/`，关闭再打开侧栏。
2. 点击“在页面选择元素”，在网页悬停查看边框，再点击目标。此点击被选择层拦截，不执行原按钮操作；Esc 取消。
3. “元素检查”显示目标文本、定位器、坐标、属性和父子层级，并把整个元素 HTML 渲染为只读代码视图：标签、属性、字符串和文本分色高亮，子元素可逐层折叠，也可一键展开/折叠全部。代码视图使用转义文本，不执行页面脚本。
4. 推荐定位器优先考虑 `data-testid`、`data-test`、`data-qa`、唯一 ID 和名称属性。候选项显示选择时的匹配数；DOM 路径容易受结构变化影响。
5. 可选择 CSS / XPath，编辑表达式或复制定位器，并点击“验证并高亮”。仅唯一匹配才更新检查器并高亮；零命中、多命中和语法错误分别提示，不执行点击。XPath 优先输出短路径：使用最近唯一祖先 ID 作锚点、普通 HTML 标签名，并省略多余的 `[1]`；仅对内联 SVG/MathML 或 XML 文档退回命名空间写法，生成后会在页面中校验唯一命中。
6. 选择 Python 操作并复制代码。先打开插件并确认桥接就绪，再在 `controller/` 运行该客户端脚本。支持读取文本、点击、输入、清空、Enter 和定位。默认代码不含手动服务启动或 Token 配对步骤。

```python
from pagesense import PageSenseClient

with PageSenseClient() as client:
    target = client.find("css_position", '[data-testid="search-order"]')
    target.click()
    client.find("css_position", 'input[name="order"]').input("PS-1001")
    text = client.find("css_position", "#status").get_text()
    print(text)
```

选择器由网页实际属性决定，示例不代表任何站点已有这些元素。`find` / `findall` 接受 css_position 或 xpath_position，支持容器查询和按需读取，不含自动等待或动作重试。旧 locator() 仍仅支持原生 CSS。完整方法见[按需元素 API](element-api.md)。

## 查看页面分布

“页面概览”打开即自动实时扫描，没有手动扫描按钮或实时开关，默认范围是内容与控件。分布图默认展示当前视口，可切换整页缩略；虚线框标出扫描时的视口。色块对应真实页面坐标，控件、文本、媒体和结构有颜色及文字图例。鼠标点击或键盘方向键选色块、Enter/空格确认，可定位并进入检查器。完整数据可通过分类、搜索、结构条件和分页访问。

单张分布图最多展示前 800 个范围内元素并说明限制；完整扫描和发送没有此数量截断。长页面的整页缩略会压缩显示比例，可使用当前视口或列表精确检查。图与检查器均为快照；实时扫描会更新概览，选中元素快照需要重新选择/验证。

## 主动发送到 Python

发送是可选功能；find/findall 和元素方法可直接请求插件，无需预先发送元素包。

“Python 对接”提供首次安装命令、自动连接状态、客户端收件代码和发送范围。连接成功后指南及配置自动收起，仍可手动展开修改。

- **当前选中元素**：发送原目标及其详情、候选定位器。
- **当前页面全部扫描元素（默认）**：点击时重新扫描，发送当前范围全部结果，不受搜索或分页影响；侧栏自动扫描，无需预先操作。
- **当前筛选的全部结果**：发送关键字、分组、属性和 CSS 条件共同命中的全部元素，包含其他分页。

载荷包含 `kind`、`pageId`、页面、时间、扫描/筛选设置和 `elements`；选中模式附带 `details`。元素包括 `elementId`、`pageId`、CSS、文本、属性和坐标。发送设置不包含连接 Token。页面内容只在本地连接传输，收件箱只在内存保存。

```python
from pagesense import PageSenseClient

with PageSenseClient() as client:
    snapshot = client.wait_for_export(timeout=120)
    print(snapshot["page"]["url"], len(snapshot["elements"]))
    # 根据你自己的流程选择需要的元素；收件本身不执行操作。
    element = snapshot["elements"][0]
    client.element(element).locate()
    text = client.element(element).text()
```

`PageSenseClient` 默认连接浏览器已经启动的桥接，同一浏览器会话一次连接一个业务脚本。Python 也可主动 `client.scan(scope="content")` 或 `client.search(...)` 取得数据。

Python 未运行时也可发送，显示“本地收件箱已收到”，客户端随后连接可获取。“Python 已收到”表示后端确认载荷已进入收件箱，未承诺已执行、已持久化或已被业务代码消费。收件箱最多 8 份、总计 64 MiB；满时明确拒绝，调用 `wait_for_export()` 消费后可再次发送。等待默认 60 秒，超时抛 `TimeoutError`；浏览器关闭、Host 退出或暂停自动连接会丢失该 Host 未消费内容；仅关闭业务客户端会保留收件箱。断线或 8 秒未确认时显示错误；后端可能已收到但回执丢失，插件不会自动重发。

## 定位和句柄的区别

- `client.locator(css)` 每次操作重新查询当前活动页面，恰好一个 DOM 节点才能执行。解析与动作之间会携带 `pageId` 校验；期间换页会返回 `STALE_PAGE`。
- `client.element(element)` 使用快照中 `elementId + pageId` 绑定原文档。切换到其他标签页或刷新导航后会失败；节点移除也会失败，不猜测替代目标。克隆 `data-pagesense-id` 属性不能冒充原节点。
- 旧版 `client.click(数字ID)` 等接口为兼容保留，没有页面保护。推荐传整个元素字典或使用 `locator()`，不要将数字 ID 存作跨页面定位器。
- `text()` / `read_text()` 把文本读入 Python，最多 20000 字符；`inspect()` 提供截断标记。它们不操作系统剪贴板。侧栏“复制文本”使用浏览器剪贴板。
- 不进入 iframe / Shadow DOM 内部，不识别 Canvas 绘制内容；虚拟列表仅包含已挂载节点。合成点击/按键不保证与真实用户输入等效，网页可能拒绝。

## 设计参考与验证

交互参考 [Chrome DevTools 检查模式](https://developer.chrome.com/docs/devtools/inspect-mode)；定位 API 参考 [Playwright 的唯一匹配规则](https://playwright.dev/python/docs/locators#strictness)与[开源 Locator 实现](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/client/locator.ts)。本项目按原生 DOM 和既有 Action Executor 实现所需子集，未引入 Playwright 运行时或其自动等待功能。

真实 Chrome 155、临时配置和合成网页的证据在 [`acceptance/evidence-ui-workbench/`](../acceptance/evidence-ui-workbench/)。包含点选、CSS 验证、Python 动作、三种发送、收件压力、旧句柄防误操作、复制源码实际运行及 320/400/600px 布局；另有查询、点选和实时扫描回归。默认 Edge 在本机启动独立测试进程失败，改用 Chrome 完成验证；这不替代用户个人 Edge 环境和全量独立验收。

自动桥接与新默认发送的最新验证见 `acceptance/evidence-native-bridge/`；旧服务器模式需显式 `PageSenseClient(mode="server")`，详见[自动桥接](native-bridge.md)。
