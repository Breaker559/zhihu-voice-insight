知乎发言画像 v2.7.0 代码检查（2026-10-24）

检查提交：`29def6115c2b967d47ee5584bf2b127f7292beda`。仓库已拉到当前目录，`main` 跟踪 `origin/main`。插件源码未修改；本目录保存检查报告和复现材料。

结论：发现并在本地 Chromium 中复现了 12 项问题。最应优先处理的是作者归属、摘要参与屏蔽判定、白名单按钮和配置缓存。P1 表示建议优先修复，P2 表示后续应修复；这不是线上发生频率或安全漏洞等级。

验证方式：Python Playwright + Chromium 147.0.7727.15，构造知乎卡片 DOM，模拟 GM 存储与接口响应。按钮、启动、观察器和关闭模式使用脚本实际启动流程；纯数据检查通过仅在测试内暴露内部函数执行。所有网络请求均使用本地样本，没有调用知乎真实接口或付费模型。验证了代码在这些条件下的行为，尚未验证当前知乎线上 DOM、登录态、签名和 Tampermonkey 权限差异。

| 编号 | 优先级 | 问题 | 已复现的结果 |
| --- | --- | --- | --- |
| R01 | P1 | HTML 兜底混入其他作者 | 请求 alice，却返回 other 的资料并包含 other 的回答 |
| R02 | P1 | 摘要长度被用于自动屏蔽 | 10 条只有 30 字摘要的记录命中“短句灌水” |
| R03 | P2 | “不再屏蔽”按钮无效 | 点击后白名单仍为空，回答仍折叠 |
| R04 | P2 | 改设置仍复用旧统计缓存 | 展开改为 10 条仍显示 5 条；开启 AI 后没有待分析正文 |
| R05 | P2 | 页面静止时扫描自我触发 | 空白页 3.9 秒内仍重写悬浮按钮 3 次，持续调度扫描 |
| R06 | P2 | 列表接口失败不触发兜底 | 资料成功、列表 403 时，没有 HTML 请求并缓存空结果 |
| R07 | P2 | 7／30 天统计截断却显示为总量 | 样本中实际近期有 60 条，仅请求第一页并显示 20 条 |
| R08 | P2 | 默认行为与文档不一致 | 全新配置直接折叠命中回答，文档写的是“仅标记” |
| R09 | P2 | 悬停卡片无法交互 | 卡片始终 pointer-events:none，鼠标命不中内部链接 |
| R10 | P2 | 关闭后旧请求仍回填面板 | mode=off 后，未完成请求回来仍插入一条面板 |
| R11 | P2 | 空 AI 结果被当成有效零分 | 返回 {}，七个维度全部缺失，仍缓存 score=0 |
| R12 | P2 | AI 缓存不区分模型或文本 | 从 model-a 改为 model-b 并换文本，仍返回 model-a 缓存 |

1. **R01：HTML 兜底必须严格验证作者归属。** [源码 L504–L510](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L504-L510)。`extractFromJson` 遍历整棵页面 JSON，收集所有回答、文章与 people；后续直接截取答案列表，没有按作者过滤。资料匹配条件中的 `|| (p.id && p.name)` 又允许任意完整用户抢先命中。只要初始数据包含其他用户或回答，就可能用别人的数据标注、折叠目标作者，开启文本评估后也可能提交错误的样本。应先准确定位目标 token／id，再按其内容列表或 author 字段过滤、按类型和 id 去重；无法确认归属时显示数据不可用。

2. **R02：不应把摘要字数当作正文长度执行短文规则。** [源码 L379–L380](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L379-L380)，[判定 L459–L460](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L459-L460)。`measure` 已标出 `approx`，但平均值与短文判定没有使用该标识。复现中所有记录都是摘要，仍触发“短句灌水”。平均长度应附带完整性信息；短文规则只采用正文长度可靠且数量足够的样本，否则显示无法判定或先补取正文。仅在展开列表前显示 ≈ 无法避免误折叠。

3. **R03：折叠条缺少事件处理所需的作者 token。** [源码 L1251–L1252](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L1251-L1252)，[按钮生成 L873–L878](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L873-L878)。点击处理只向上查找 `[data-zvi-inline]`，而 `.zvi-bar` 是内容容器的直接子元素，不在该面板内，所以 `token=null`，白名单分支永远不执行。给折叠条／按钮保存 token，或统一从最近的已标注卡片取 token；添加白名单后恢复该作者全部卡片。

4. **R04：缓存的数据与配置耦合，但缓存有效性只看时间。** [源码 L567–L573](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L567-L573)。缓存的是已经按 `showLimit`、`snipChars`、`includeArticles`、`countMode`、`exactLength` 和 AI 开关裁剪计算后的结果；保存设置后的 `rescan` 不使其失效。默认缓存 30 分钟，因此新设置可能长期看起来不生效。建议数据缓存与展示计算分离，或为影响结果的配置生成版本签名并精确失效。已经截掉的正文需要重新请求，不能靠重新渲染补回来。

5. **R05：MutationObserver 被插件自己的 UI 更新反复唤醒。** [源码 L1094–L1097](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L1094-L1097)，[调度 L1344–L1349](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L1344-L1349)，[观察器 L1381–L1384](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L1381-L1384)。观察整页 childList；每次扫描后 `updateFab` 无条件重写 `innerHTML`；这次变化又安排下一次扫描，形成约 1.2 秒的循环。空白页没有网络请求也复现了循环，长信息流还会额外遍历全部作者链接与去重面板。忽略插件自身节点的变化、数量未变化时不写 DOM，并针对新增内容增量扫描。

6. **R06：接口错误与真实空列表混为一谈。** [源码 L492–L500](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L492-L500)。HTML 兜底要求“回答空 + 文章空 + 资料无名字”同时成立；资料接口成功但列表接口被拦时不会兜底。`jsonOf` 又丢失状态码，最终空统计没有 error，被当作成功缓存。应为每个接口保留成功、空、失败三种状态，按失败的数据源补取；失败不得缓存成“作者没有发言”，可使用短暂失败退避避免重试风暴。

7. **R07：有限样本不能展示成完整的时间窗口统计。** [源码 L480–L490](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L480-L490)，[统计 L384–L387](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L384-L387)。回答和文章各请求一页、各最多 20 条，忽略 `paging.is_end/next`；只统计这些记录，却以“近 7 天 N 条／30 天 N 条”展示。完整采集并非必须：低成本修法是标注“样本内／至少 N 条”，并明确平均间隔只针对样本。需要精确窗口总数时，再按时间分页至覆盖 30 天，并设置请求预算、部分成功状态和限速。

8. **R08：全新安装会自动折叠。** [源码 L49](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L49)，[README L93](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/README.md#L93)。代码默认 `action:'collapse'`，文档在两处明确承诺默认仅标记。新用户会在未选折叠前丢失可见正文。建议将默认值改为 `mark`，保留已有用户明确保存的动作设置。

9. **R09：悬停卡片一直关闭鼠标命中。** [源码 L1286–L1289](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L1286-L1289)。显示时仅设置 opacity，没有恢复 `pointer-events`。卡片内虽生成了回答链接和 mouseenter/mouseleave 监听，但鼠标无法进入卡片，链接不可点击。显示时启用 pointer-events，隐藏时关闭；同时增加视口边界判断，避免底部作者的卡片超出屏幕。

10. **R10：旧扫描没有生命周期失效检查。** [源码 L1080–L1084](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L1080-L1084)。切换关闭或重新扫描只清理现有 DOM，尚未完成的 Promise 仍会调用 `renderInline`。本地模拟请求延迟 1 秒，在读取中关闭插件，响应后仍出现面板；该复现中没有重新折叠，因此不声称关闭后一定会折叠。建议每轮扫描生成 generation id，回填前检查模式、generation、节点连接状态和作者身份，并取消可取消的请求。

11. **R11：可解析 JSON 不代表有效评估。** [源码 L777–L782](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L777-L782)，[评分 L750–L767](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L750-L767)。`{}` 为真值，能通过解析检查，所有维度缺失时评分返回 0，并按成功缓存 7 天。应校验对象形状、维度覆盖和数值类型；全部缺失时必须返回评估失败。部分缺失是否接受应有明确规则，不能让“无结果”看起来像低分结论。

12. **R12：AI 缓存键不体现评估输入。** [源码 L770–L775](https://github.com/Breaker559/zhihu-voice-insight/blob/29def6115c2b967d47ee5584bf2b127f7292beda/zhihu-voice-insight.user.js#L770-L775)。缓存和在途去重都只按作者 token；更换服务商、模型或样本仍命中旧结果。本地从 model-a 换 model-b 且更换文本，调用总数仍为 1，结果记录的 model 仍是 model-a。建议键包含端点、模型、规范化文本摘要和评分／提示词版本；如产品希望按账号固定缓存七天，也应至少在用户换模型时失效，并明确展示缓存时间。不要把 API Key 明文用于可展示的缓存键。

此外，以下优化来自静态检查，未计入上面的 12 项复现：

- **请求预算与扫描队列。** `maxPerPage=15` 实际限制单轮 queue 长度，后续扫描继续处理更多作者，并不限制整页；`pending` 只有检查和 clear，没有 add。建议明确“每批／每页／视口”的限制，用统一请求队列、IntersectionObserver、可取消任务及失败退避控制流量。同一卡片识别和面板去重可用 Map／Set，减少嵌套遍历。
- **精确长度缓存。** `lenCache` 仅按内容 id 保存，无类型、统计口径、编辑版本或过期时间；答案与文章可能同 id，切换 word/char 或正文编辑后也可能读旧值。应使用类型与 id 组合键并包含口径／版本，设置有效期与容量上限。`cache`、`lenCache`、`aiCache` 都应清理过期项，避免每次序列化长期累积的全量数据。
- **统一长度统计口径。** `exactLength` 完成后仅使用 recent 子集重新计算 avgLen，中位数、最长长度仍沿用原样本。因此开启精确模式或改展开条数，可能改变“平均值”的样本范围。统计范围应与展示条数解耦；补全文后统一重算平均、中位、最大值及可靠性。
- **悬停异步结果和配置校验。** `showHover` 保存了 `anchorEl` 却未在回调检查是否仍是当前作者；快速移过多人时较慢请求可能覆盖新卡片。输入框的 min/max 没有在 `readPanel` 中执行校验，应校验有限数、范围、枚举，避免负值／超大值进入统计与请求参数。
- **文档与设置一致性。** README 的“启用／暂停标注”“切换展开条数”菜单与实际 `registerMenus` 不一致；“阈值全部可调”也与设置面板缺少 shortLen/shortDays 不符。建议在下一版一起核对。手动黑名单还受 `burst.enabled` 与 action 控制，关闭行为规则后手动屏蔽不会执行，这需要明确产品行为或拆开逻辑。

建议修复顺序：先处理 R01/R02/R03 与安全的默认动作，再处理缓存和接口状态，最后完善扫描调度、悬停交互与 AI 结果校验。无需先引入复杂构建框架；先把数据采集、纯统计、缓存和 DOM 操作分开，使这些复现用例能转为修复后的回归测试。

复现命令：在仓库根目录执行 `python review/reproduce.py`。需要已安装 Python Playwright 和 Chromium。该脚本断言的是“当前缺陷可以复现”，修复后应把对应断言改成预期行为，不能把它直接当作发布验收测试。机器可读证据见同目录 `results.json`。

已完成 `node --check zhihu-voice-insight.user.js`，语法检查通过；复现脚本完整运行成功。`git diff --exit-code` 确认原有受跟踪文件没有改动，仅新增本地 `review/` 材料，未提交或推送。
