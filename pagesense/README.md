# PageSense V2.0

PageSense 是一个基于 **Chrome / Edge + Manifest V3 + 原生 JavaScript** 的浏览器页面 DOM 感知工具。

它扫描当前网页中的交互控件、文本、媒体和语义结构，经过可见性过滤和信息提取后，
输出结构化 JSON，在侧栏中展示分页卡片，支持关键字/结构查询、定位与详情检查。

**V1.1** 在此基础上建立 `elementId → 真实 DOM` 的显式映射，并提供元素**定位（scrollIntoView）**与**高亮（独立 Overlay）**能力，属于 Browser Agent 的「感知与定位层」。

**V1.2** 在此基础上增加 **Action Layer（人工操作层）**：点击、文本输入、清空、按键、页面滚动五类页面操作，统一结构化操作回执与 Action Log。

**V2.0** 增加两大能力：

- **Element Search（元素搜索）**：把扫描结果建成搜索索引，提供字段覆盖、多关键词 AND、
  相关度排序、结果数量限制的正式搜索能力
- **Controller Bridge（Python 通信层）**：扩展通过 WebSocket 连接本地 Python Controller，
  让 Python 以 `scan() / search() / click()` 等结构化 API 驱动浏览器

> V2.0 **不包含 LLM / Agent / Planner**。它只提供 **Browser Runtime + Controller Transport**：
> 感知、搜索、定位、操作、传输。谁来决定点什么，是使用者的责任。

---

## 元素工作台

侧栏分为“页面概览 / 元素检查 / Python 对接”。概览显示页面几何分布、搜索和分页列表；
点选网页或从列表“检查 / Python”进入统一检查器，查看完整 HTML（可折叠、语法高亮）、唯一定位候选、属性、层级和坐标，
并复制可运行的 Python 代码。“Python 对接”可发送选中元素、完整扫描或跨分页的筛选结果，
后端使用 `wait_for_export()` 收件，用 `client.element(element)` 或 `client.locator(css)` 操作。默认发送当前页面全部扫描元素，会先重新扫描、不受查询或分页影响。

插件默认通过 Native Messaging 自动启动本地桥接。首次按[自动桥接](../docs/native-bridge.md)注册后，Python 直接使用 PageSenseClient()，无需单独启动 server.py 或手动配对 Token。旧模式在连接方式中保留。

完整使用流程、发送范围与定位限制见[元素工作台说明](../docs/element-workbench.md)。

Python 可直接 `find("css_position", css)` / `find("xpath_position", xpath)`，`findall` 返回元素对象列表；支持容器查询和 get_text/get/get_all，无需先发送元素。侧栏可复制、验证 CSS 与 XPath 并生成 find 示例。详见[按需元素 API](../docs/element-api.md)。

## 安装（加载已解压的扩展程序）

### Chrome

1. 打开 `chrome://extensions/`
2. 打开右上角的 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目的 `pagesense` 目录（即包含 `manifest.json` 的目录）

### Edge

1. 打开 `edge://extensions/`
2. 打开左下角的 **开发人员模式**
3. 点击 **加载解压缩的扩展**
4. 选择本项目的 `pagesense` 目录

> 如需扫描本地 `file://` 页面：在扩展管理页找到 PageSense → 详情 → 打开 **允许访问文件 URL (Allow access to file URLs)**。

---

## 使用

1. 打开任意普通网页（例如 `https://example.com`）
2. 点击浏览器工具栏中的 **PageSense** 图标，在浏览器原生侧栏打开界面；操作网页时侧栏保持打开
3. 侧栏自动开始实时扫描；可选择 **扫描范围**（默认页面内容），范围变化后自动更新
   - 也可直接点击 **在页面选择元素**，到网页中悬停并点击目标，无需先扫描
4. 浏览元素卡片，或使用：
   - **搜索框**（V2.0 Element Search）：按文本 / 标签 / placeholder / aria-label /
     title / value / alt / id / class / role / href 搜索，支持多关键词 AND 与相关度排序；
     `Ctrl+K` 聚焦、`×` 清空，状态行显示「扫描元素 / 搜索结果」数量
   - **分类**：交互控件 / 文本内容 / 图片媒体 / 页面结构，展开“细分类型”选择 18 种类型
   - **结构筛选**：展开“按标签 / class / ID / CSS / 属性筛选”，条件可与关键字和分类取交集
   - **分页**：每页 50/100 条，可通过上一页/下一页访问全部命中，不再只显示前 100 条
5. 点击 **复制 JSON** 复制完整扫描结果，或点击 **导出 JSON** 下载文件
6. 每张元素卡片上的 **定位** / **高亮**：
   - **定位**：页面平滑滚动，使该元素居中显示
   - **高亮**：定位后在元素上叠加 PageSense 高亮框，标签显示 `#elementId <tag> 文本`
   - 底部 **取消高亮** 可随时移除高亮框
7. **V1.2 元素操作**（按元素能力显示）：
   - 按钮 / 链接卡片上的 **点击**：对真实元素执行 DOM `click()`
   - 输入框卡片上的文本框 + **输入 / 清空 / Enter**：写入文本、清空或发送按键
   - 全局 **页面滚动 ↑/↓ 500px**
   - **Action Log**：展开可查看本次侧栏生命周期最近 20 条操作记录
   - 操作成功后若页面可能变化，顶部会提示重新扫描

导出文件名格式：

```
pagesense_<domain>_<YYYY-MM-DD>_<HHMMSS>.json
```

### 从旧版更新

在扩展管理页找到 PageSense，点击 **重新加载/刷新**，再点击工具栏的 PageSense 图标即可打开侧栏。已有扫描、搜索、定位、高亮、人工操作和 Controller 配置入口都保留；侧栏可拖动边界调整宽度，底部按钮固定，内容区域独立滚动。

切换活动标签页、刷新或导航时，侧栏更新当前页面信息并清空旧扫描结果；页面就绪后自动获取新结果。另一个浏览器窗口的活动标签页不会改变当前侧栏的操作对象。

### 自动实时扫描

侧栏打开即自动扫描，没有“扫描当前页面”按钮或实时开关。页面增删元素、文本/属性变化、input/change、滚动和视口变化会按 300ms 合并后更新。空闲时不轮询；自身映射属性与高亮层不触发反馈循环。

实时更新同步统计、坐标、搜索索引和 JSON，并保留筛选、存活节点输入草稿、焦点与组词状态。切换范围、标签页、刷新或导航后自动恢复；连接中断时自动退避重连。关闭侧栏释放 Port、Observer、事件和计时器。

扫描只覆盖已挂载 DOM，不递归 iframe/Shadow DOM，不识别 Canvas 内部。未发事件的静默 value 赋值和纯 CSS 动画可能不会触发更新；Python 可直接按需读取当前 DOM，或显式调用 scan() 获取新快照。扫描不会自动执行页面动作。

### 页面内容、结构查询与详细检查

**页面点选**：点击“在页面选择元素”后，网页显示十字光标、目标边框与标签。
点击目标会退出选择，在侧栏“选中元素”面板直接显示整个元素 HTML、属性、CSS、父子层级和文本，
可复制 CSS、XPath 与文本；此面板不受搜索、分页或扫描范围限制，普通 div/span 也能点选。
选取点击会被选择层拦截，不触发普通按钮点击、链接导航或勾选框切换。
按 Esc（页面或侧栏均可）或再次点击按钮取消；切页、导航、关闭侧栏时也会清理选择层和监听。

选中信息是选择时快照，不自动随实时扫描刷新，复制使用该快照；需要最新信息时重新点选。
“清除”移除所选面板。iframe/Shadow DOM 只能选择当前文档可见的外层元素，不递归内部；
Canvas 只检查外壳。点选沿用详情片段长度与密码值隐藏规则。

扫描范围可选“页面内容”（控件、正文、媒体、列表/表格/区域等）、“仅交互控件”、
“全部可见 DOM”（包含普通容器）。页面内容模式聚合语义文本块，不重复扫描其普通行内子节点；
纯容器的子树预览不重复进入正文索引。隐藏祖先和扩展自身 Overlay 下的节点会排除。

可使用以下组合查询：

- 标签名：`p, h2`；class：`card featured`（同时包含两个完整 class token）；HTML ID 精确匹配。
- 属性 JSON：`{"data-testid":"price"}`；值为 null 表示属性存在。
- CSS：`article.card > p.price[data-kind="price"]`，与浏览器原生 querySelectorAll 语法一致。
- “仅视口内”与上述条件、关键字、分类共同取交集。CSS 结果只覆盖当前扫描范围，
  查找布局容器时选择“全部可见 DOM”；语法错误明确显示。

分类按钮的数字是本次扫描计数，列表显示所有查询条件下的总命中数、当前区间和页码。
导出/复制 JSON 保存完整扫描快照，包含所有页，不是当前筛选结果子集。

卡片提供可复制的唯一 CSS 路径；“元素详情”按需读取全部属性、当前匹配数量、
父级最多 8 层、直接子元素最多 20 个、当前文本与 HTML 片段，已映射的父子节点可定位。
HTML 以只读代码视图显示，标签、属性、字符串和文本分色高亮，子元素可逐层折叠，
也可一键展开/折叠全部；显示前去除脚本、样式和扩展映射，内容始终转义。卡片预览最多 300 字符，
正文索引、详情文本和 HTML 各最多 20000 字符，超出会显示长度/截断标记；
“复制文本”读取当前详情文本，受同一片段限制。密码值隐藏。

具体分类、查询语义、范围限制及下一阶段能力分析见[页面内容与元素查询](../docs/element-explorer.md)。

侧栏显示在浏览器设置的位置。Edge 使用其原生侧栏；Chrome 若显示在左侧，可在设置的外观选项中把侧边栏位置改为右侧。扩展无法强制覆盖浏览器的左右位置偏好，参见 [Chrome Side Panel 文档](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)。

---

## 使用 demo.html 测试

项目自带测试页 `test/demo.html`，包含：

- 普通链接、普通按钮、disabled 按钮
- input / textarea / select / option
- contenteditable 元素
- 仅含 aria-label 的按钮
- `display:none` / `visibility:hidden` / `opacity:0` / `hidden` / 零尺寸元素（应被过滤）
- 需要向下滚动才能看到的按钮（验证 visible 与 inViewport 的区别）
- **动态 DOM 场景（V1.1）**：可删除 / 恢复的目标按钮、动态新增按钮（验证定位失效检测）
- **Action Layer 场景（V1.2，第 10 节）**：点击计数按钮、文本输入框（实时回显与
  input/change 事件计数）、textarea、contenteditable、按键记录、禁用按钮

测试方法：

1. 在浏览器中直接打开 `test/demo.html`（若通过 file:// 打开，需先开启「允许访问文件 URL」），或把它放在任意本地静态服务器上访问
2. 点击扩展图标 → 等待自动实时扫描结果
3. 预期结果：
   - 隐藏元素不出现在列表中，统计区「已过滤隐藏」数量增加
   - 页面底部按钮初始显示「视口外」徽标；滚动到底部后重新扫描，变为「视口内」
   - 搜索「沟通」只显示「立即沟通」按钮
   - 筛选 Button / Link / Input 时分类正确
4. V1.1 动态失效实验：
   - 扫描后对「动态目标按钮」点 **高亮**，页面滚动并出现高亮框
   - 点页面上的 **删除目标按钮**，再点该卡片的 **定位 / 高亮**
   - 预期：提示「元素已不存在，请重新扫描」（ELEMENT_NOT_FOUND），不会定位到同名的其他元素
   - 点 **恢复目标按钮** 后需重新扫描，才会再次出现该元素
5. V1.2 Action 实验（第 10 节）：
   - 在「Action 输入测试」框的卡片文本框中输入 `PageSense Test` → 点 **输入**，
     页面「当前值」实时更新且事件计数增加
   - 点「测试点击」卡片的 **点击** → 点击次数 +1
   - 点 **Enter** → 页面「最后按键」显示 Enter；点 **清空** → 输入框为空
   - 对「禁用按钮」点 **点击** → 返回 ELEMENT_DISABLED，计数不变

---

## 当前能力（V1）

- 扫描当前标签页的页面基本信息：title、url、domain、viewport、scroll
- 识别可交互元素：`a`、`button`、`input`、`textarea`、`select`、`option`、
  `[role="button"]`、`[role="link"]`、`[role="textbox"]`、`[contenteditable="true"]`
- 可见性过滤：`display:none`、`visibility:hidden`、`opacity:0`、零尺寸、
  `hidden` 属性、已脱离 DOM；`<option>` 的可见性跟随其所属 `<select>`
- 区分 **visible（已渲染）** 与 **inViewport（在当前可视区域）**
- 元素数据模型：PageSense 自有递增 `elementId`、tag、text、id、className、
  name、type、role、href、placeholder、ariaLabel、title、disabled、
  contentEditable、visible、inViewport、position（viewport 坐标 + pageX/pageY 页面绝对坐标）
- 文本提取优先级：innerText → value → aria-label → placeholder → title → alt，
  归一化空白并限制 300 字符
- 侧栏卡片列表、关键字搜索、类型筛选
- 一键复制完整 JSON（含剪贴板降级方案）
- 导出 JSON 文件（Blob 下载，无需额外权限）
- 浏览器内部页面 / 商店页面 / 无 Content Script / 超时等场景给出友好错误信息，
  并在「开发日志」中保留具体错误

---

## V1.1 新增能力：Mapping / 定位 / 高亮

- **elementId → DOM 显式映射**：扫描时在真实元素上写入命名空间属性
  `data-pagesense-id="<elementId>"`，JSON 中的 elementId 可精确找回被扫描的那个 DOM 节点
- **LOCATE_ELEMENT（定位）**：`scrollIntoView({ behavior: "smooth", block: "center" })`，
  把元素滚动到视口中央
- **HIGHLIGHT_ELEMENT（高亮）**：先定位，再在页面上叠加 PageSense 自有的 fixed 定位
  Overlay（`data-pagesense-overlay`），带蓝色边框与标签 `#id <tag> 文本`
- **CLEAR_HIGHLIGHT（取消高亮）**：移除 Overlay；无高亮时调用也安全成功
- **单 Overlay 约束**：同时只存在一个高亮，高亮新元素会自动替换旧的
- **滚动 / 缩放跟随**：`scroll`（含内部滚动容器，capture 阶段）与 `resize` 经
  `requestAnimationFrame` 节流后重新计算 Overlay 位置
- **扫描失效检测**：元素被删除（`!isConnected`）时 Overlay 自动移除；再次定位 / 高亮
  返回 `ELEMENT_NOT_FOUND`，明确提示重新扫描，绝不猜测同名元素
- 侧栏卡片按钮通过 **事件委托（event delegation）** 绑定，动态列表不堆积监听器

---

## V1.2 新增能力：Action Layer

- **CLICK_ELEMENT（点击）**：经 Element Map 解析真实元素，检查 `disabled` /
  `aria-disabled`，必要时滚动到元素，再执行标准 DOM `element.click()`；
  不使用 CDP、坐标模拟或鼠标轨迹
- **INPUT_ELEMENT（输入）**：对 `<input>` / `<textarea>` 通过对应 prototype 的
  **原生 value setter** 更新值（兼容 React/Vue 受控组件），focus 后触发
  `input` / `change` 事件；对 `contenteditable` 元素写入文本并触发 `input`；
  执行后回读实际值，未改变则返回 ACTION_FAILED
- **CLEAR_ELEMENT（清空）**：复用输入逻辑写入空字符串，不重复实现
- **KEYPRESS_ELEMENT（按键）**：focus 后触发标准 `keydown` / `keyup`
  （不触发已废弃的 `keypress` 事件）；键名白名单：
  `Enter Escape Tab ArrowUp ArrowDown ArrowLeft ArrowRight Backspace Delete Space`，
  非法键返回 INVALID_KEY
- **SCROLL_PAGE（滚动）**：支持 up / down / left / right，amount 必须满足
  `0 < amount ≤ 5000`；返回 before / after 位置，已到边界时 `moved:false`
  不算异常
- **统一操作回执**：每个结果含 `success`、`action`、`actionId`（act_ 前缀轻量 ID）、
  `timestamp`、`durationMs`、`elementId`、`rescanRecommended`
- **Action Log**：侧栏内保留本次生命周期最近 20 条操作
- 所有变更类 Action（点击 / 输入 / 清空 / 状态类按键）返回
  `rescanRecommended: true`，侧栏提示重新扫描；Action 开始时自动清除旧高亮

### Action 请求 / 响应示例

请求：

```json
{ "action": "PAGESENSE_INPUT_ELEMENT", "elementId": 16, "value": "AI应用工程师" }
```

成功响应：

```json
{
  "success": true,
  "action": "PAGESENSE_INPUT_ELEMENT",
  "actionId": "act_lz4abc_a1b2c3",
  "timestamp": 1720000000000,
  "durationMs": 3,
  "elementId": 16,
  "value": "AI应用工程师",
  "rescanRecommended": true
}
```

失败响应（元素已删除）：

```json
{
  "success": false,
  "action": "PAGESENSE_CLICK_ELEMENT",
  "actionId": "act_lz4def_d4e5f6",
  "timestamp": 1720000001000,
  "durationMs": 0,
  "elementId": 18,
  "error": {
    "code": "ELEMENT_NOT_FOUND",
    "message": "元素已不存在，页面内容可能已变化，请重新扫描页面。"
  }
}
```

### elementId 生命周期（V1.2 同样适用）

- elementId **不是永久 ID**，仅在**最近一次 PageSense 扫描结果所对应的 DOM 状态**中有效
- 侧栏/Controller 同文档重扫与切换扫描范围时，清理旧映射并重建索引，保留存活节点 ID，新增节点递增编号；移除 ID 不复用，隐藏或超出范围的节点不再映射
- 无实时订阅的扫描仍清高亮；实时更新保留高亮（动作执行仍按原规则清高亮）。数字可能不连续，不应假设 ID 等于列表序号
- 页面动态变化导致原 DOM 消失后，旧 elementId 立即失效，需要重新扫描获取新结果
- 重新扫描后，请以新卡片上的 elementId 为准

## V2.0 新增能力：Element Search

关键字/属性搜索**针对最近一次扫描结果**，不重新遍历 DOM；可选 CSS 条件由 Content Router
查询当前 DOM 并与扫描映射求交：

```
SCAN_PAGE  →  Structured Elements  →  Search Index  →  Search
```

搜索逻辑集中在独立模块 `content/element-search.js`（`buildIndex` / `search` /
`clearIndex` / `getIndexInfo`），侧栏与 Content Script 共用同一份实现，
因此侧栏的搜索结果与 `SEARCH_ELEMENTS` 的结果永远一致。

### 搜索覆盖字段

`text`、`value`、`placeholder`、`aria-label`、`title`、`alt`、`tag`、`role`、
`id`、`className`、`href`（仅合理文本匹配）。

### 文本标准化

统一走 `normalizeSearchText()`：去首尾空白 → 折叠连续空白（含全角空格）→ 转小写。
中文没有大小写，因此不会被破坏：

```
"  AI   工程师 "   →   "ai 工程师"
"立即沟通"          →   "立即沟通"
```

### 匹配与排序

每个关键词取**命中字段中的最高分档**，多关键词分数相加。
排序规则：分数降序 → `elementId` 升序作为稳定 tie-break。首次扫描时 ID 对应 DOM 顺序；
实时更新保留存活节点 ID，因此同分排序可能不同于变化后的 DOM 顺序。

| 字段 | exact | startsWith | contains |
|---|---:|---:|---:|
| text | 100 | 80 | 60 |
| aria-label | 55 | 45 | 30 |
| placeholder | 50 | 40 | 25 |
| title / value | 45 | 35 | 22 |
| alt | 40 | 30 | 20 |
| id | 45 | 30 | 20 |
| role | 40 | 28 | 18 |
| tag | 35 | 25 | 18 |
| className | 25 | 22 | 20 |
| href | 12 | 11 | 10 |

> `href` 只在关键词长度 ≥ 2 时参与匹配。否则搜索单字母 `a` 会命中页面上每一条链接，
> 把真正的文本命中淹没。

### 多关键词（AND）

```
搜索：AI 工程师
```

只有**两个词都命中**的元素才返回：

```
AI应用工程师   →  ai(80) + 工程师(60) = 140   ✅
AI产品经理     →  缺少「工程师」              ❌
```

### 空 query

**空 query 返回最近一次扫描的全部元素**（`score: 0`、`matchedFields: []`，保持 DOM 顺序），
不报错。这是固定语义。

### limit

Controller 每页默认 `20`，最大 `100`，超出会被夹取；非法值回退默认值。
使用 `offset`（从 0 开始）获取后续页；`total` 为全部命中数，`returned` 为本页条数，
`truncated` 表示本页之后仍有结果，`indexSize` 为整个索引规模，而非命中数。
侧栏每页 50/100 条，无总计 100 条限制。

### 索引生命周期

索引与**最近一次扫描**绑定：

```
SCAN_PAGE  →  旧索引销毁  →  建立新索引
```

重新扫描后，属于旧 DOM 的 elementId 不会被搜索返回。
索引失效时搜索返回 `NO_SCAN_DATA`，提示重新扫描。

### 搜索结果仍使用 elementId

搜索返回的 `elementId` 就是 V1.1 Element Map 里的那个 id，
后续 `HIGHLIGHT` / `CLICK` 直接复用，**不建立第二套 DOM 映射**：

```json
{
  "elementId": 53,
  "score": 100,
  "matchedFields": ["text"],
  "element": { "tag": "a", "text": "立即沟通", "role": null,
               "visible": true, "inViewport": true }
}
```

### 侧栏搜索 UI

- 顶部搜索框：`搜索页面元素…（Ctrl+K）`
- `Ctrl+K` 聚焦搜索框；搜索框内的 `Escape` 清空（与浏览器侧栏环境无冲突，
  快捷键作用域是侧栏文档本身）
- `×` 按钮清空搜索，恢复全部扫描元素
- 状态行始终说明当前是**全量**还是**搜索结果**：
  ```
  扫描元素：186 个 · 搜索结果：4 个
  ```
- 结果卡片显示 `匹配：text · score: 100`
- 搜索与类型筛选（全部 / Button / Link / Input / Other）是 **AND** 关系：
  `query = 搜索` + `type = Button` 只显示包含「搜索」的 Button

### SEARCH_ELEMENTS Action

请求：

```json
{ "action": "PAGESENSE_SEARCH_ELEMENTS", "query": "立即沟通", "limit": 20 }
```

响应：

```json
{
  "ok": true,
  "data": {
    "query": "立即沟通",
    "total": 2,
    "returned": 2,
    "truncated": false,
    "limit": 20,
    "durationMs": 1,
    "results": [
      { "elementId": 53, "score": 100, "matchedFields": ["text"] }
    ]
  }
}
```

---

## V2.0 新增能力：Controller Bridge

### 架构

```
Python Controller          （WebSocket Server）
      │  ws://127.0.0.1:8765
      ▼
PageSense Extension        （WebSocket Client，由 Service Worker 持有）
      │  chrome.tabs.sendMessage
      ▼
Content Script             Scanner / Element Search / Highlighter / Action Executor
      ▼
Browser DOM
```

**为什么扩展是 client**：浏览器扩展无法监听本地端口，MV3 也禁止常驻后台页，
因此 Controller 只能是 Server，PageSense 只能是 Client。

**为什么 WebSocket 在 Service Worker**：侧栏可能随时被用户关闭，关闭后其文档即销毁，
不能持有长连接。连接、重连、心跳全部由 `background/service-worker.js` +
`bridge/controller-bridge.js` 负责。

### 连接状态

```
DISCONNECTED   未连接
CONNECTING     连接中
CONNECTED      已连接
ERROR          连接异常
```

侧栏的 **Controller** 面板（可折叠）显示状态圆点、`127.0.0.1:8765`、
端口与 token 输入框、`连接 Controller` / `断开` 按钮，以及最近 20 条请求：

```
23:41:01 SCAN_PAGE success 28 elements
23:41:03 SEARCH_ELEMENTS success 2 results
23:41:07 HIGHLIGHT_ELEMENT success #53
```

请求日志只存在于内存，不把页面内容写入 storage。

### 自动重连

指数退避，最大 30 秒，绝不紧循环：

```
1s → 2s → 5s → 10s → 30s → 30s → ...
```

* Controller 关闭：扩展进入 `DISCONNECTED`，按退避重试
* Controller 重启：扩展**自动恢复 `CONNECTED`**，无需重启浏览器
* 扩展重新加载：Service Worker 重新启动并自动重建连接
* 用户点击「断开」：停止自动重连，直到再次手动连接

### 心跳

扩展每 20 秒发送应用层心跳，既用于探活，也用于在 Controller 会话期间
维持 MV3 Service Worker 不被回收。

### 桥接不是第二套 Action

WebSocket **只是传输层**。收到 `CLICK_ELEMENT` 后，bridge 把它翻译成 V1.2 的
Content Script Action，由同一个 Action Executor 执行：

```
WebSocket → bridge → chrome.tabs.sendMessage(CLICK_ELEMENT) → Action Executor
```

bridge 里没有任何 `element.click()` / `dispatchEvent` / `querySelector`，
因此不存在两套行为不一致的 Action。

### 活动页面与权限

* 默认操作**当前窗口的活动标签页**，返回 `tabId` / `url` / `title`
* 无活动页面 → `NO_ACTIVE_TAB`
* `chrome://`、`edge://`、`about:`、扩展页面、应用商店等不可注入页面 → `RESTRICTED_PAGE`，
  Service Worker 不会崩溃
* 首次请求时若 Content Script 尚未注入，Service Worker 会按依赖顺序注入：
  ```
  constants → element-map → scanner → element-search
            → highlighter → action-executor → content
  ```
  重复注入有 listener guard 保护，连续 20 次 SCAN 不会出现一个请求两个响应

### 协议方法

```
PING  GET_STATUS  SCAN_PAGE  SEARCH_ELEMENTS
LOCATE_ELEMENT  HIGHLIGHT_ELEMENT  CLEAR_HIGHLIGHT
CLICK_ELEMENT  INPUT_ELEMENT  CLEAR_ELEMENT  KEYPRESS_ELEMENT  SCROLL_PAGE
```

请求 / 响应信封：

```json
{ "id": "req_001", "type": "REQUEST", "method": "SCAN_PAGE", "params": {} }
```

```json
{ "id": "req_001", "type": "RESPONSE", "success": true, "result": {} }
```

```json
{ "id": "req_001", "type": "RESPONSE", "success": false,
  "error": { "code": "NO_ACTIVE_TAB", "message": "没有可操作的活动页面。" } }
```

每个请求有唯一 id，响应按 id 关联而不依赖到达顺序；每个请求有超时（默认 10s）。
V2.0 一次一个 Action，无 Action Queue。

### 认证

Controller 启动时用 `secrets.token_hex(8)` 生成随机 token，扩展在 `HELLO` 中提交：

```json
{ "type": "HELLO", "protocol": "pagesense/1", "client": "extension",
  "version": "2.0.0", "token": "<用户输入的 token>" }
```

```json
{ "type": "HELLO_ACK", "success": true }
```

token 错误 → `HELLO_ACK { success: false, error.code: UNAUTHORIZED }`，服务端关闭连接。
**源码中不存在任何硬编码 token**：token 只来自 `server.py` 每次启动的随机生成，
或用户在扩展里手工输入。

---

## V2.0 新增能力：Python Controller

详见 [`../controller/README.md`](../controller/README.md)。

```bash
cd controller
pip install -r requirements.txt
python server.py
```

```
PageSense Controller
Listening: 127.0.0.1:8765
Token: 3F9A21C4B7E05D18

Waiting for extension...
```

然后打开侧栏 → Controller 面板 → 填入 token → 连接，即可：

```
> scan
28 elements

> search 搜索

#18 BUTTON
搜索
score=100
matched=text

> input 16 AI应用工程师
SUCCESS (#16)

> click 18
SUCCESS (#18)
```

Python API：

```python
state   = client.scan()
results = client.search("搜索职位")
client.input(results["results"][0]["elementId"], "AI应用工程师")
client.highlight(element_id)
client.click(element_id)
client.clear(element_id)
client.keypress(element_id, "Enter")
client.scroll("down", 500)
```

CLI 是**完全人工**的：没有自然语言解析、没有 LLM、没有自动执行。
也**故意不提供** `click "立即沟通"` 这类 search-and-click 复合命令 —— 那会在
用户没有确认目标的情况下产生误操作。流程被强制拆成 `search`（人看结果）→
`click <elementId>`（人指定目标）。

---

### Overlay 安全与侧栏关闭行为

- Overlay 始终 `pointer-events: none`，不会拦截用户对页面的任何点击
- Overlay 是 PageSense 独立创建的元素，**不修改网页元素自身的 border / outline / style**
- 清理时只移除 PageSense 自己创建的内容
- **侧栏关闭后高亮继续存在**（Content Script 生命周期独立于侧栏）；再次打开侧栏并重新扫描会清除旧高亮，随后可以定位、重新高亮或取消高亮

---

## 当前限制

- **浏览器内部页面无法读取**：`chrome://`、`edge://`、`about:`、扩展页面，以及
  Chrome 网上应用店 / Edge 加载项商店等禁止注入的页面
- **跨域 iframe 可能无法直接扫描**：同源 iframe 内的元素可被 document 遍历到，
  跨域 iframe 受同源策略隔离，V1 不做注入
- **Shadow DOM 当前版本可能无法完整扫描**：`querySelectorAll` 不穿透 closed
  shadow root；open shadow root 也不会被自动递归
- **Canvas / WebGL 中不存在普通 DOM 元素**：绘制在画布上的按钮无法被识别
- **复杂虚拟列表只能读取当前实际挂载的 DOM**：未渲染的列表项不存在于文档中
- 侧栏自动实时更新受监听变化；关闭侧栏释放监听，最近导出的快照不会自动更新
- Content Script 按需注入；侧栏打开期间持有实时订阅，关闭后释放监听
- **受控组件兼容性**：V1.2 已使用原生 value setter 并触发 input/change，但极少数
  自定义控件可能仍有额外的框架内部事件，需按具体页面验证
- **contenteditable 仅支持简单纯文本**：复杂富文本编辑器（格式、图片、协同编辑）
  不在 V1.2 范围内
- 合成的 KeyboardEvent 属于非可信事件，少数只接受可信按键的页面可能不响应
  （浏览器安全设计，V1.2 不做绕过）

### V2.0 新增限制

- **搜索只覆盖最近一次扫描结果**：侧栏实时扫描会同步更新索引；无侧栏时 Python 查询索引需先 scan；
  索引失效后搜索返回 `NO_SCAN_DATA`
- **关键字搜索是子串匹配**：不做分词、拼音、模糊匹配、纠错、同义词或正则 / XPath；
  CSS 选择器通过独立结构条件支持，不将关键字自动猜成选择器
- **Controller 只操作当前活动标签页**：不支持指定其他标签页或后台标签页；
  运行期间请勿切换标签页
- **同一时刻只支持一个 Controller 会话**：新连接会顶替旧连接
- **Controller 只允许回环地址**：V2.0 不支持远程 Controller
- **`file://` 页面不在 host_permissions 范围内**：Controller 无法注入，
  需启用文件访问权限并通过侧栏自动扫描
- 页面导航后旧句柄失效；重新 find/findall 可直接定位，旧搜索索引需重新 SCAN_PAGE
- Controller **没有 Action Queue / 批量执行 / 自动重试编排**：一次一个请求
- Service Worker 被浏览器回收时连接会断开，恢复后按退避策略自动重连
  （连接期间的心跳会显著降低被回收的概率，但不能完全避免）
- **断线超过约 30 秒后需要一次浏览器交互才会恢复**（V2.0 验收实测，3 次复现）：
  Controller 短暂中断（秒级）时扩展会自动重连；一旦中断超过 MV3 的 Service Worker
  空闲回收阈值（约 30 秒），SW 连同它的重连定时器一起被浏览器销毁，此后扩展**不会
  自行重连** —— 直到有事件唤醒 SW（打开侧栏、切换/导航标签页、浏览器启动等）。
  唤醒后会在 0.1 秒内恢复 CONNECTED。因此**不要依赖扩展在 Controller 长时间停机后
  自行回归**；如需长期无人值守，请在重启 Controller 后打开一次侧栏。
- **elementId 没有页面作用域，跨标签页复用是危险的**：`data-pagesense-id` 是写在
  页面元素上的属性，只要该页面在本次浏览器会话中被扫描过就会保留。若在标签页 B
  扫描拿到 elementId，切回标签页 A 后再用这个 id 发动作请求，Controller 会在
  **当前活动标签页 A** 上解析它，从而命中 A 上恰好占用同一 id 的**另一个元素**
  （已实测可复现：旧 id 命中了 A 页面上的一个链接并触发了导航）。
  这与「运行期间请勿切换标签页」是同一条约束：**切换标签页后必须重新 `SCAN_PAGE`，
  不要复用切换前拿到的 elementId。**
- **单次响应帧超过 1 MiB 曾会切断连接**：V2.0 验收中修复（`controller/server.py`
  的 `MAX_MESSAGE_SIZE`）。`websockets.serve()` 默认 `max_size=1 MiB`，而
  `SCAN_PAGE` 在约 2500 个交互元素的页面上就会超过该值，服务端会以
  1009 关闭连接，调用方看到 `NOT_CONNECTED`。现已放宽到 64 MiB
  （与 Chrome 对扩展消息的限制一致）。

---

## 项目结构

```
pagesense/
├── manifest.json          # Manifest V3 配置
├── README.md
├── icons/                 # 16/32/48/128 扩展图标
├── background/
│   └── service-worker.js  # V2.0 MV3 Service Worker：持有 Bridge、响应侧栏控制
├── bridge/
│   └── controller-bridge.js # V2.0 WebSocket client：握手/重连/心跳/方法分发
├── popup/
│   ├── popup.html         # 侧栏结构（含 Controller 面板）
│   ├── popup.css          # 侧栏样式（随浏览器侧栏宽度调整）
│   └── popup.js           # 注入、消息通信、渲染、搜索、复制、导出、Bridge 控制
├── content/
│   ├── content.js         # 消息桥：侧栏/Controller ↔ Scanner / Search / Highlighter / Executor
│   ├── scanner.js         # 独立的 DOM 扫描与序列化逻辑
│   ├── element-search.js  # V2.0 Element Search：索引、匹配、排序
│   ├── element-map.js     # elementId <-> DOM 映射（data-pagesense-id）
│   ├── highlighter.js     # 定位与 Overlay 高亮（滚动/缩放跟随）
│   └── action-executor.js # V1.2 Action Layer：点击/输入/清空/按键/滚动
├── shared/
│   └── constants.js       # Action、搜索权重、Bridge 常量、选择器、错误码（唯一事实来源）
└── test/
    └── demo.html          # 本地测试页（含动态 DOM、Action 与搜索场景）

controller/                # V2.0 Python Controller（与 pagesense/ 同级）
├── server.py              # WebSocket Server（仅回环地址）+ token 认证
├── protocol.py            # 信封、方法名、错误码
├── pagesense.py           # PageSenseClient 高级 API
├── cli.py                 # 人工交互 CLI（无 LLM）
├── test_bridge.py         # 协议/传输单元测试
├── test_e2e.py            # 真实扩展 <-> Python E2E
└── requirements.txt       # 仅 websockets
```

设计说明：

- Content Script 不使用 ES Module（MV3 经典脚本兼容性最好），七个文件按
  `constants.js → element-map.js → scanner.js → element-search.js →
  highlighter.js → action-executor.js → content.js` 顺序注入，
  通过 window 命名空间通信，并有重复注入保护
- 侧栏与 Bridge 使用**同一份** CONTENT_FILES 顺序，保证两边驱动的是同一个
  Content Script
- 选择器、Action、搜索权重、Bridge 常量集中在 `shared/constants.js`，
  不在多处硬编码
- 扩展侧不使用 React / Vue / TypeScript / Webpack / Vite，零第三方依赖；
  Controller 侧只依赖 `websockets`

---

## 权限说明

| 权限 | 用途 | 为什么必要 |
|---|---|---|
| `activeTab` | 点击扩展图标后访问当前页面 | V1 起的能力，保持最小化 |
| `scripting` | 按需注入 Content Script | V1 起的能力，不常驻注入 |
| `storage` | 保存 Controller 的 host / port / token | MV3 Service Worker 会被浏览器随时回收，连接配置必须持久化，否则每次回收都要用户重新输入 |
| `sidePanel` | 在浏览器原生侧栏展示 PageSense | 配合 `side_panel.default_path` 和工具栏图标打开侧栏 |
| `host_permissions: http://*/*, https://*/*` | 在活动标签页注入 Content Script | V1.2 之前由用户点击触发（activeTab 生效）；V2.0 的 Controller 是**无人值守**的，注入时没有用户手势，`activeTab` 无法授权 |

**未申请**：`debugger`、`cookies`、`webRequest`、`tabs`、`history`、
`management`、`downloads`、`browsingData`、`privacy`。

`tabs` 权限不需要：`http/https` 的 `host_permissions` 已足以读取对应标签页的
`url` / `title`；而读不到 URL 的页面（`edge://`、`chrome://`、应用商店）
正是必须拒绝注入的页面。

---

## 安全边界（V2.0）

- **只监听回环地址**：Controller 拒绝绑定 `0.0.0.0` 或任何非 `127.0.0.1` /
  `localhost` 的地址，不暴露局域网
- **每次连接都要 token**：token 由 Controller 每次启动随机生成，
  扩展源码中不存在硬编码 token
- **扩展永远是 client**：不接受任何入站连接
- **只有一个人工/受控入口**：CLI 每条命令都由人输入，没有自然语言与自动决策
- 仍然**不做**：验证码绕过、反爬绕过、DevTools 检测绕过、浏览器指纹伪装、
  `navigator.webdriver` 隐藏、批量账号操作

---

---

## 未来方向（V2.1 / V3，当前未实现）

以下能力在 V2.0 **明确未实现**：

- **LLM / Agent / Planner**：自然语言理解、任务规划、自动决策
  （未引入 OpenAI / DeepSeek / Qwen / Ollama / LangChain / LangGraph）
- **Action Queue**：`Action ↓ Observe ↓ Action` 的串行编排与任务状态机
- **自动任务**：自动登录、自动投递、自动填写提交等
- **自动元素选择**：`click "立即沟通"` 这类 search-and-click 复合命令

V2.0 只提供 **Browser Runtime（感知/搜索/定位/操作）+ Controller Transport**，
把「决定做什么」留给使用者或未来的独立 Agent 层。

其他方向：

- Element Search 的模糊匹配、拼音、同义词与字段权重可配置
- Shadow DOM 与 iframe 的递归扫描
- 更多语义角色、表单控件与页面类型识别（pageType）、元素分组与摘要
- 更完整的富文本编辑器兼容
