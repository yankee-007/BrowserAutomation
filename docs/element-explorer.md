# 页面内容与元素查询

PageSense 当前是可见 DOM 的检查、检索和人工定位工具。侧栏默认扫描内容；Controller
也可显式选择范围。它读取浏览器已渲染的 DOM，不是重新请求页面源代码的 Python 爬虫。

## 已实现的使用方式

| 维度 | 当前能力 |
| --- | --- |
| 扫描范围 | 页面内容（默认侧栏）、仅交互控件、全部可见 DOM（含普通容器） |
| 分类 | 交互、文本、媒体、结构四组；18 个细分类，各自显示扫描计数 |
| 关键字 | 多词 AND，相关度排序；卡片预览 300 字符，正文索引最多 20000 字符并标记截断 |
| 结构查询 | 标签（多个逗号分隔）、class（空格分隔，全部 token 匹配）、精确 HTML ID、属性 JSON、CSS 选择器 |
| 组合条件 | 关键字、分类、结构条件、仅视口内均取交集 |
| 结果数量 | 侧栏每页 50/100，显示全量命中数与页码；Controller limit 每页最多 100，offset 可访问后续页，无总计 100 条上限 |
| 元素详情 | 原始属性、唯一 CSS 路径及当前匹配数、父级最多 8 层、直接子元素最多 20 个、文本/HTML 片段 |
| 人工定位 | 卡片定位/高亮、复制 CSS、复制当前文本；父子上下文中已映射的元素也可定位 |
| 页面点选 | 无需扫描，悬停预览、点击后独立显示精确目标详情，可选普通容器；Esc/按钮取消，关闭或切页清理 |
| 实时更新 | 复用原观察与节流；更新 CSS 匹配集合、索引与计数，保留页码/输入草稿；输入法 composition 结束后更新 |
| Python | scan(scope=...)、search(..., offset/tag/class_name/attrs/selector/...)、inspect(element_id) |

主分组与细分类计数来自本次完整扫描；列表总数来自全部查询条件，二者口径不同。
搜索结果分页只限制渲染量，复制/导出 JSON 仍保存整个扫描快照，而非当前页或筛选子集。

页面点选通过独立 Port 会话覆盖当前页面，命中测试采用原生 elementFromPoint。
选择层拦截选取点击，不转发业务点击；iframe 或 Shadow DOM 只选其外层元素。
选中节点按需分配同文档 ID，直接复用详情读取，不修改搜索结果或扫描范围；
若网页克隆了扩展映射属性，点选会清除同一 ID 的其他旧属性，确保显式目标解析准确。
所选面板为选择时快照，复制 CSS/文本也来自该快照；实时扫描不自动刷新它。
导航/切页清空快照，普通扫描也按原生命周期重置；该节点若不在后续扫描范围内，
后续重扫会移除其映射，因此不要将点选 ID 作为永久动作引用。

## 分类与文本处理

- 交互：按钮、链接、输入框、选择框、勾选/切换、可编辑内容、其他控件。
- 文本：标题、段落、标签/说明、普通文本。
- 媒体：图片、音视频/图形（包括 Canvas/SVG 的 DOM 外壳，不识别内部绘制内容）。
- 结构：列表、表格、区域、表单、其他。

“页面内容”保留语义文本块、媒体、结构和交互节点；普通文本使用有直接文字的元素，
语义文本块的普通行内子节点不重复列出，交互子节点仍可独立操作。纯布局容器不默认加入。
“全部可见 DOM”便于检查这类容器，但依然排除 script/style/template/head 等非页面内容。
隐藏祖先和扩展 Overlay 下的节点不扫描。

结构元素的卡片可显示子树文字预览，关键字索引只使用其直接文字，避免区域、表格等
祖先反复命中同一段正文。标签/class/属性过滤不受此规则影响。

## 选择器与快照边界

例如在侧栏 CSS 条件输入：

```css
article.card > p.price[data-kind="price"]
```

这对应 Beautiful Soup 的 `soup.select(...)` 用法。按 class 筛选遵循单独 token 语义，
`card featured` 要求同时具有两个 class，而非模糊子串。属性条件示例：
`{"data-testid":"price","aria-label":null}`，其中 null 表示该属性存在。

CSS 由页面原生 querySelectorAll 执行，再与当前扫描映射求交；状态行同时给出 DOM
匹配数和本次范围的结果数。未扫描到的节点不会凭查询自动进入结果，也不自动执行动作。
若需要匹配普通 div/span 容器，先切换“全部可见 DOM”。语法错误明确显示，不回退为关键字猜测。

生成路径优先使用当前唯一 ID，否则采用带 nth-of-type 的祖先路径，ID 和标签按 CSS.escape
转义。它是当前页面的定位路径，页面重排后可能变化，不保证跨版本长期稳定。
与控制器共享的同文档重扫/范围切换保留存活节点 ID，移除 ID 不复用，隐藏或超出范围则
不再映射。导航后仍需获取新快照；现有跨标签页 ID 误用风险尚未由页面作用域解决。

详情按需读取当前 DOM，与卡片的扫描时间可能不同。HTML 以文本显示，移除脚本、样式、
扩展内部映射和 Overlay；密码值隐藏。详情文本/HTML 各显示最多 20000 字符并报告原长度、
截断标记；复制文本使用当前详情文本，同样受此片段长度约束。

## 后续优先级

本轮没有把以下能力伪装为已实现。它们会直接影响工具下一阶段的可用性：

1. 页面作用域/文档版本与 elementId 绑定，阻止跨标签页或导航后的误用。
2. 变更差量与增量扫描，减少超大页在实时模式下全量扫描、序列化与索引重建的成本。
3. 可访问名称、关联 label、角色/状态及可操作性解释，区分“DOM 存在”与“用户可操作”。
4. 显式的 iframe / open Shadow DOM 上下文选择及作用域标识；不能仅扩大 selector 冒充递归支持。
5. 字段提取预览、当前筛选结果导出、定位规则保存与匹配数量诊断；保留人工确定目标的流程。

目前虚拟列表只覆盖挂载节点，closed Shadow DOM、跨源 iframe 与 Canvas 内部内容均不支持；
没有自动翻页抓取、批量业务操作、LLM 或 Planner。

## 设计资料

- [Beautiful Soup 官方文档：搜索与 CSS selectors](https://www.crummy.com/software/BeautifulSoup/bs4/doc/#css-selectors)
- [MDN：querySelectorAll](https://developer.mozilla.org/en-US/docs/Web/API/Document/querySelectorAll)
- [MDN：CSS.escape](https://developer.mozilla.org/en-US/docs/Web/API/CSS/escape_static)
- [MDN：DOM TreeWalker](https://developer.mozilla.org/en-US/docs/Web/API/Document/createTreeWalker)

本轮采用浏览器原生 DOM API 和既有 Scanner/Element Map/Search，没有引入 bs4 到浏览器，
也没有新增运行依赖。测试和证据见 `acceptance/evidence-element-explorer/`。
