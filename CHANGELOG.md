## 7.0.0

### 审查修复与稳定性收尾

- 修复侧板重置卡需要点击两次的问题。焦点刷新不再替换按住的按钮。用户已确认实际侧板正常。
- 重置卡跨面板接管匹配请求 ID 和过期时间。多卡确认不累积监听。核销只接受明确成功，旧额度响应不能覆盖新缓存。
- 统一未命中输入、总 Token 和缓存命中率口径。供应商筛选、执行者归因和模型计费使用一致维度，不借用其他供应商的价格。
- 日期和筛选切换忽略过期响应。DeepSeek、Lithos 账单加载采用最新日期，稳定筛选不多发请求。周起点按统计时区计算。
- 扫描中止或提交屏障失败时保留上次成功快照。归档写入失败可重试。损坏旧归档保留原位，不用空历史覆盖已有数据。
- 收紧余额请求的出网边界。凭据文件使用 0600 权限，不在日志或导出包中加入真实凭据。
- 派生缓存版本为 23。首次从旧版升级时可能重建缓存；原始归档不变。
- 新增原生鼠标回归。测试覆盖按下期间触发焦点刷新、首次松开打开弹窗，以及重复刷新后只查询一次。

### 验收边界

- 346 项单元与集成测试通过。原有 6 组浏览器 DOM 回归和独立 Chrome 原生鼠标回归通过。
- 未进行真实重置卡核销或真实长期归档性能压测。
- 后台看板接管仍以 document.hidden 判断可见性，尚未接入宿主 lifecycle 可见性。本版未扩大这部分修改。

## 6.15.1

### 修正官方用量接口：改用真正能用的那组端点

6.15.0 按公开逆向文档实现了 `usage/by_api_key/amount?start=&end=&tz=`，**实测这条路走不通**：
拿真令牌打过去返回 `biz_code 1 INVALID_PARAM`，四种参数组合都试过，全拒。

用真令牌把端点扫了一遍，能用的是老的一组：

- `GET /api/v0/usage/amount?month=<1-12>&year=<YYYY>` → `biz_data.days[].data[].usage[]`
- `GET /api/v0/usage/cost?month=&year=` → `biz_data[0].days[].data[].usage[]`（**金额也用同一个 usage 数组**，
  `amount` 是 token 数，`cost` 是同类型对应的钱，按类型累加即当天该模型的花费）
- `GET /api/v0/users/get_user_summary` → `normal_wallets[] / bonus_wallets[] / total_costs[]`

另外两个坑：

- **WAF**：只带 `Authorization` 的裸请求会被挡成 429「Request Blocked」，
  必须带 `Origin` / `Referer` / `Accept-Language` / 浏览器 UA / `x-client-platform`。
- **余额字段**：没有文档里说的 `total_available_token_estimation`，
  可用估算在 `normal_wallets[].token_estimation`；余额是 `14.9641625400000000` 这种精度，显示要收成两位。

因此区间也跟着改成按月：**本月 / 上月 / 近 3 个月**（平台只给月粒度，摆 7 天/30 天是骗人的）。
多个月合并时按模型累加，并用未舍入的原始成本累加，避免先舍入再相加漂出几分钱。

真数据核对（2026-10-27）：本月 ¥17.94 / 371.5M tokens / 命中 98.9%；
上月 ¥6.22；近三个月 ¥29.63；余额 ¥14.96。

测试 262 项全过（fixture 直接取自真响应，不再按文档臆造）。

## 6.15.0

### 新增页签「DeepSeek 官方用量」

看板顶部第三个页签。数据来自开放平台网页端自己在用的内部接口：

- `GET /api/v0/usage/by_api_key/amount?start=&end=&tz=` → 按天 × 模型的 token（命中/未命中/输出/请求数）
- `GET /api/v0/usage/by_api_key/cost?start=&end=&tz=` → 按天 × 模型的人民币金额（含峰谷）
- `GET /api/v0/users/get_user_summary` → 余额 + 可用 token 估算

**凭证是网页登录令牌，不是 API Key。** 这两套东西互不通用：余额用 API Key，
用量要登录后平台下发的 userToken（浏览器 localStorage 里）。所以：

- 空状态就把「去哪儿拿」写成三步（登录 → F12 → Local Storage → userToken），
  输入框直接放在这个页签，不用绕去设置
- 贴了 `sk-` 开头的 API Key 会被当场拦下并说明原因（实测平台对 API Key 稳定返回 40003）
- 令牌 0600 存 `<dataDir>/deepseek-platform.json`；失效时页面显示重新粘贴入口，不沿用旧数

页面内容：区间切换（本月 / 近 7 天 / 近 30 天）、四张卡（区间消费 / 今日 / 区间 Token /
官方余额）、每日消费按模型堆叠柱状图、按模型表（消费、占比、输入与命中率、输出、请求、天数）。
平台按 `tz` 参数切日，这里传本机时区偏移，让「今天」和用户看到的一致。

金额是**官方账单**（人民币、含峰谷计价），与看板别处的估算费用不是一回事——这句话印在表下面。

端点与字段是未公开契约。形状对不上时返回 `shape_changed` 并如实说明，不拼一个看着合理的数字。

测试 251 → 262。

## 6.14.0

### 两张余额卡各配一个「充值 ↗」

- DeepSeek 余额卡 → `https://platform.deepseek.com/top_up`
- LithosAI 余额卡 → `https://console.lithosai.cloud/billing/general`

点开走宿主的 `hana.external.open`（manifest 补了 `app/ui.open-external` 能力），
拿不到这个能力时才退到 `window.open`，再不行弹提示让人手动开——不在沙箱里「点了没反应」。

刻意没做的：**查不到余额时不摆充值按钮**。key 失效、会话过期时该修的是凭据，
摆个充值入口反而把人往错方向引。

地址集中在 `ui/external-link.js`，测试直接盯这两个字符串。

测试 247 → 251。

## 6.13.1

- 修「填了正确的官方 key 仍报 DeepSeek API Key 无效」。根因是取凭据的顺序：
  以前先问宿主总线（`provider:credentials` for `deepseek`），拿到了才轮到本机存的 key。
  但宿主里名为 `deepseek` 的供应商现在指向的是中转站（实测 baseUrl 已是 api.lithosai.cloud），
  那把 key 发给 api.deepseek.com 当然 401——而用户显式填的官方 key 从来没被用到。
  顺序改成：**设置页显式填的 key 优先，宿主总线只当侧底**。
- 用总线凭据被 401 时，错误文案会说明这把 key 来自哪个供应商，并提示「若它已改成中转站，
  请在上方单独填官方 API Key」。

测试 245 → 247。

## 6.13.0

### DeepSeek 余额卡不再因为「删了供应商」而消失

原来的凭据只从宿主总线取（`provider:credentials` for deepseek），宿主里没有这个供应商就等于没凭据，
卡直接隐藏——看上去像功能坏了，实际上是没地方填 key。

- 设置页新增「DeepSeek 余额」：单独填一把只用于查余额的 API Key，存进 `balance-apis.json`，
  不碰宿主的供应商配置。填完立刻查一次并把结果写在设置页上。
- 卡的隐藏条件收紧：只有「从来没配过」（`not_connected` / `not_configured` / 历史字段 `no_credentials`）
  才整块隐藏；**配了但失效**（key 无效、429 冷却、接口异常）留在面板上写明原因。
  以前任何 `connected: false` 都藏，于是「有 key 但过期」也表现为卡凭空消失。

测试 240 → 245。

## 6.12.0

### LithosAI 消费页签

看板顶部多了一排页签：**用量**（原来那整页）/ **LithosAI 消费**。后者只在进入时才拉数据，
没配 Cookie 的人切过去看到的是一条「还没配置」，不会吃一次失败。

数据来自控制台的 `GET /api/billing/spend?start=&end=`（UTC 区间，含首尾）：

- 四张卡：区间合计 / 今日（UTC）/ 日均（按有消费的天平摊）/ 预付余额
- 每日消费·按模型：堆叠柱状图，悬停显示当天各模型金额与合计（和控制台自己的图一致）
- 按模型表：消费、占比、输入、缓存命中（带命中占比）、输出、天数

几个刻意的地方：

- **口径写在界面上**：控制台按 UTC 切日、按纳美元记账，这是官方扣费；看板别处的
  「估算费用」是按价格表算的，两者对不上是正常的——这句话直接印在表格下面，不藏在文档里。
- 归一化在后端做：一条原始记录 = (天, 模型, API key)，后端聚成按天 / 按模型两种视图；
  同一天同一模型有多个 key 时合并，天数按去重后的天算。
- 余额与消费并行取，余额拿不到不影响消费显示（反之亦然）。
- 页签选择记在 localStorage，下次打开还在原来那个。

测试 236 → 240。

## 6.11.2

- Lithos 余额卡去掉「未绑卡」标签。它是支付方式的状态，不是当下的问题，平时挂着只是噪音。
  冻结（onHold）照旧标——那个真的会让请求失败。

## 6.11.1

- 修：Lithos 余额卡显示「连不上 console.lithosai.cloud: fetch failed」。原因是直接用了
  `globalThis.fetch`——App 主进程里的它被沙箱挡掉，报的是底层 undici 的 fetch failed。
  改走宿主的 `ctx.network.fetch` 桥（DeepSeek 余额卡一直这么走），并把底层错误码一起显示出来。
- 顺带纠正 6.11.0 的两处实测差异：`/api/me` 的活动组织字段是 `activeOrganization`；
  只贴两串裸值时会按两种顺序各认一次，哪种返回 200 存哪种。

## 6.11.0

### LithosAI 余额（控制台会话）

先搞清楚了一件事：**Lithos 的 API key 查不到余额**。公开 API 只有 `/v1/models` 与
`/v1/chat/completions`，试过 `/v1/credits`、`/v1/balance`、`/v1/usage`、`/v1/me` 全 404。
钱只在控制台里，而控制台的两个接口要登录态：`/api/me`（用户与活动组织）、
`/api/billing`（`balanceNanos` / `hasCard` / `onHold`）。Lithos 文档原话：
“Inference API keys cannot read console billing.”

所以做法是：设置页里粘一行控制台 Cookie 请求头（`__Host-console_session` 与
`__Host-console_csrf` 两个都要），我们替你去调那两个 GET。余额出现在功能面板的微卡上，
没配就不占位；会话过期时卡片留着并写清楚怎么修。

几个刻意的地方：

- Cookie 只存本机 `dataDir/lithos-console.json`，权限 0600；只发那两个 cookie，多余的丢掉。
- 金额单位是纳美元（1 USD = 1e9 nanos）；小于一分钱的非零余额写「低于 $0.01」，
  不四舍五入成 `$0.00`——那会让人以为钱没了。
- 401 一律报「会话过期，请重新粘」，不静默沿用旧数；网络失败与契约变更（没有
  `balanceNanos`）各用各的 reason，不混成一个“查询失败”。
- 60 秒缓存，功能面板的「刷新」能穿过（`?refresh=1`）。
- 这是未公开契约。Lithos 改了就失效，所以不适合当唯一依据：控制台还是真相。
- 实测修正：`/api/me` 里活动组织叫 `activeOrganization`（不是 CodexBar 文档写的 `organization`），
  两种都收；少了它就拿不到 `X-Organization-Id`，账单接口会拒。
- 只贴两串裸值（没带 cookie 名字）时，按两种顺序各认一次 `/api/me`，哪种返回 200 就存哪种：
  这算实测不算猜，省掉“哪个是 session 哪个是 csrf”这类来回。

出网白名单显式加了 `console.lithosai.cloud`（manifest 的全量断言同步改了，不静默扩权）。

测试 222 → 234。

## 6.10.0

从上游 8.7.5 抄了两个东西，都是「口径/可查性」层面的事。

### 命中率只剩一个口径

以前 KPI 用 `缓存读 / 总 token`（分母带了输出），明细行用 `缓存读 / 输入`，两处对不上。
现在式子收进 `ui/hit-rate.js`：命中率 = 缓存读 / 输入总量（含缓存读），不含输出。
KPI 卡、明细行、SQL 排序三处各 import 同一份实现；turns 的排序表达式是 SQL 调不到 JS，
公式在 `HIT_SORT_EXPR` 里拄了一遍，`test/hit-rate.test.js` 用同一批样本比对两边。

实际影响：你现在的负载输出占比小，今日 96.8% → 97.1%（+0.3pt）；输出重的模型会拉开更多。

### 明细行点得开：看得到这一轮会话的逐次调用

新接口 `GET /turn?requestId=`：按 requestId 回归档（`usage-archive.jsonl`）定位会话，
把这一轮所有调用按时间排开——每一次的模型、未命中输入、缓存读、输出、状态（ok/失败）、
单位费用，点的那一条高亮。明细表里点一下行展开，再点跳到另一条。

几个刻意的取舍：

- 不读会话 JSONL（上游那套做法）：我们的记账单位是账本记录，一个会话在本地是按天切开的桶，
  没有「用户一轮 → N 次 assistant 调用」这层结构。账本给一次请求一行，那就如实按行给。
- 不查 turns 表当详情源：turns 只是索引，字段是压扁过的。详情只认归档。
  归档找不到就直说找不到（可能已滑出窗口），不拼一个看起来完整的假详情。
- 只为了能点开，给 conversations 增加了一个 `requestId` 字段（CACHE_VERSION 21→22，
  会触发一次全量重扫）。传输给前端的副本会剥掉这个字段——最大的 Code 桶本来就贴着
  900KB 的页预算，多 18 字节/条会把它顶出去。
- 间隔 = 与上一次调用的起始时间差，含排队与工具往返，**不是耗时**；
  账本里的 `durationMs` 实测恒为 0，就照实给 0，不拿间隔冒充。

测试 211 → 221（新增命口径、SQL/JS 一致性、逐次调用复原、路由费用与 404）。

## 6.9.5

- 执行者也能显示名字：宿主 `agent:list` 不列「子代理池」成员（`hana-artisan` / `luna` /
  `gemini-coder` / `hana-explorer`），这些身份在接口层只有 id。引擎以 local-machine 档
  读本机 `agents/<id>/config.yaml` 的 `agent.name`（不引 YAML 依赖，只取 `agent:` 段的
  name/latinName，5 分钟 TTL 缓存，读不到就用 id）——所以 `hana-artisan` 现在显示为
  `DeepSeek（hana-artisan）`，`hana-explorer` 为 `寻迹（hana-explorer）`。
- 池成员名字只用于展示：它们不拥有会话桶，所以仍然不进 Agent 筛选下拉；
  `poolAgentIds` 随扫描写入缓存，供前端拼「名字（id）」。

## 6.9.4

- 修正「历史 Agent」误标：执行者清单不再按 `agent:list` 名册盖章。
  宿主不把子代理池成员（`hana-artisan` / `luna` / `gemini-coder` / `hana-explorer`）列入
  `agent:list`，不在名册≠已退役；现在这些执行者只显示 id，不附「历史 Agent」。
  委托方口径仍按名册判断，且改以 `lifecycle: "all"` 拿到退役 Agent 的名字。

## 6.9.3

- 引擎改以 `local-machine` 档运行，直接读宿主官方账本 `usage-ledger.sqlite`（新增能力 `app/runtime.local-machine`）：
  - 新 `runtime/engine/services/ledger-source.js`：`node:sqlite` 只读打开账本，读 `entry_json`，按「主库 mtime + size + -wal」做指纹缓存；驱动缺失或老版本宿主时退回 `usage-ledger.json`；
  - `usage:list` 降为兜底：引擎探不到账本（目录布局不明、文件不存在、无驱动）时仍走宿主接口，行为与旧版一致；
  - 直读拿到的是未投影的原始条目，`source.actor.agentId` / `attribution.childAgentId` 齐全，执行者归因不再依赖补写脚本；
  - 新增 RPC `ledger.probe` 与 `scan.begin.localLedger`；本地直读模式下 `scan.append` 直接拒绝推送条目，两种来源不会混在一起；
  - Hana home 从 `<dataDir>/../..` 推导（布局必须为 `<HanaHome>/app-data/<appId>`），推不出来就不直读、回退 `usage:list`；可用 `TOKEN_TRACKER_HANA_HOME` 显式指定；
  - 权限说明：`local-machine` 不提供文件系统隔离，引擎进程以当前用户身份可读本机文件，只用于读账本与归档；其余能力不变。

## 6.9.2

- 修正 Agent 用量的归属口径：谁跑的算谁的，不再把子代理的消耗并进委托方：
  - 归一化新增执行者字段（`actorAgentId` / `parentAgentId`，来源 `source.actor.agentId` / `attribution.childAgentId`），归档随记录落盘；
  - 聚合缓存按「日 × 模型」记录执行者分布（`dailyBreakdown[day].actors`，含本体/受托 token、委托方、模型明细），新增 `baseTotals` 保留子系统口径，Code 会话里的子代理不再被抹成 code；
  - `build()` 新增 `actors` 执行者清单，并把 `agents[].subTotal` 改为「该 Agent 派出去的用量」（含 Code 命名空间下的子代理），补 `delegatedBy` 映射；
  - 看板「Agent 消耗对比」改为「Agent 消耗（按执行者）」，堆叠本体/受托两段，悬停显示委托方与金额；
  - 选中单个 Agent 时的模型图改为该 Agent 本人执行的模型分布；模型筛选下的「Agent 占比」排行改用执行者口径；
  - 可视化分析（Agent 维度热力/流向）同步改用执行者口径，旧缓存缺字段时回退到委托方；
  - 旧归档补写：`scripts/backfill-actor-from-ledger.mjs` 从宿主官方账本（`usage-ledger.sqlite`）为窗口内的旧记录补写执行者，只追加不删除；
  - 已知限制：应用通过 `usage:list` 拿到的记录是宿主投影对象，投影里保留了 `attribution.childSessionId` 但**丢掉了 `attribution.childAgentId` 与 `source.actor`**，所以新产生的子代理请求只能知道自己被谁派出、不知道是谁在跑。这类记录单列为「子代理（执行者未提供）」，不静默归给委托方；宿主补上该字段后无需再改应用代码（归一化已优先读 `source.actor.agentId` / `attribution.childAgentId`）；
  - 缓存版本升到 21，首次扫描触发一次全量重算。
- 修复超大会话记录导致的翻页失败：单条记录超 RPC 页预算时只裁剪传输副本里最旧的 `conversations`，
  留最近的能装下的部分并标 `conversationsTruncated` / `conversationsTotal`；磁盘缓存与 SQLite 明细索引仍保留全量。
  （重演：10-25 那个 Code 桶已到 896KB，新增执行者维度后越过 900KB 页限制，首次同步会报 `RECORD_TOO_LARGE`。）

## 6.9.1

- 正式同步 Code 统计与版本入口：
  - 同步 Code 模式用量追踪全链路能力至 GitHub 发布版本；
  - 主卡静态入口正式指向 `/dashboard-v6.9.1.html`，保留 `/dashboard-v6.9.0.html` 历史入口并确保向后兼容；
  - 同步活动版本声明与校验断言至 6.9.1。

## 6.9.0

- 新增 Code 模式用量统计与界面图层贯通：
  - 类型下拉筛选支持独立选择「Code」，请求与明细过滤无缝对接；
  - 核心用量指标卡新增 Code 来源卡片（`.cd-code`），缺字段时保持安全零值展示；
  - 消耗趋势图（日/小时趋势）柱状图新增 Code 数据系列，河流图来源图层增加 Code 图例与配色映射；
  - 单轮明细排障列表展示 Code 来源徽标，CSV 导出与复制参数保持筛选贯通；
  - 消费顶层 `sourceClassification` 完整性状态，未完全识别历史时展示提示短句「部分历史会话无法识别来源，Code 分类可能不完整。」；
  - 版本与静态入口统一升级至 6.9.0（`/dashboard-v6.9.0.html`），保持版本配置一致。

## 6.8.0

- 新增 30 天用量热力矩阵组件（方案 B-2：2 行 × 15 列全宽双行方块矩阵）与下钻联动：
  - 采用 2 行 × 15 列的 CSS Grid 全宽排布（第一行展示前 15 天，第二行展示后 15 天），自适应撑满卡片宽度，彻底消除空白与死白感；
  - 严格遵循纯白极简规范，采用 5 阶冷蓝色阶（0 用量至峰值深蓝）及深浅模式平滑适配，保持严谨克制的视觉节奏；
  - 集成单例 Hover 浮动 Tooltip（`#hm-tooltip`），精确展示对应日期与 Tokens，并具备视口越界防溢出保护；
  - 方块点击交互与主趋势图深度联动：点击任一日期方块自动设定起止范围，一键下钻切入该日期的 24 小时小时级趋势构成视图；
  - 后端服务（`server/dashboard.js`）提供连续 30 天 `daily30` 聚合数据，继承当前 Agent/模型/供应商筛选维度；
  - 新增完整独立测试套件 `test/heat-matrix.test.js`。

## 6.7.0

- 修复看板日期选择器弹出失效与单日小时级趋势联动：
  - 在 `ui/base.css` 中补齐 `.cal.on` 展示规则与 `tt-fade-up` 平滑过渡动画，采用 `position: fixed` 进行视口绝对对齐，彻底修复因缺少 `.on` 样式导致日历始终处于 `display: none` 无法弹出的问题。
  - 增强 `ui/modules/date-picker.js` 交互与可靠性：输入框渲染后即时绑定事件并支持 `focus` 触发；支持当前选中日高亮（`.sel`）；支持 `Escape` 键快捷关闭；加入视口越界反向弹出保护。
  - 完善单日范围（如 5 号到 5 号）小时级趋势（24 小时 hourly breakdown）自动聚合联动与单测覆盖。
  - 新增独立单测套件 `test/date-picker.test.js`。
- 设置保存跨上下文即时联动加固：
  - 移除 BroadcastChannel 的立即 `close()`，采用模块级单例常驻并适配 `unref()`，彻底解决通道过早关闭导致的广播丢弃与垃圾回收失效。
  - `fetchSettings` 请求追加防穿透时间戳 `?_t=${Date.now()}`，杜绝浏览器 HTTP 缓存。
  - `loadAndRender` 支持直接接收 `directSettings` 负载，实现毫秒级 UI 显隐切换。
  - `localStorage` 追加随机数 tick 与数据冗余存储。

## 6.6.1

- 功能面板自动化自刷新：
  - 新增 60 秒定时静默轮询机制，常驻侧边栏时自动同步 Codex 额度与 DeepSeek 余额，与服务端 60 秒防刷缓存（TTL）精准对齐，绝不触发限流。
  - 新增页面切回与焦点恢复自刷新（`visibilitychange` 与 `window.focus`），从聊天对话或其它应用切回功能面板时即刻静默更新。
  - 增强跨窗口广播联动（`BroadcastChannel` 监听 `tt-quota-updated`），主看板数据刷新时侧边功能面板无感同步。

## 6.6.0

- 架构与工程健壮性加固：
  - 修复 SQLite turnsStore 实例复用逻辑，避免频繁翻页与 CSV 导出造成的连接句柄泄漏，在应用生命周期结束时安全释放连接。
  - 汇率服务声明 `open.er-api.com` 网络白名单，改造为非阻塞受控获取与并发去重机制，消除首次拉取卡顿隐患。
  - 功能面板在所有卡片均未启用或未配置时提供兜底空状态提示，彻底解决特定配置组合下的全白屏体验死角。
  - 账本引擎与数据看板全面支持动态时区自适应，优先识别环境配置并安全兜底，避免跨时区聚合位移偏差。
  - 设置弹窗增强非 JSON 异常保护，遇到前置网关 502/504 等报错时提供友好状态提示而非未捕获的语法错误。
  - 新增全量针对性加固测试套件 `test/hardening-fixes.test.js`。

## 6.5.11

- 设置保存跨上下文即时联动：在 `settings-dialog.js` 中加入 `BroadcastChannel`、`storage` 及 `postMessage` 三重跨窗口广播机制；用户在看板点击“保存”设置后，左侧功能面板即刻响应并无感重绘，彻底解决此前需要手动点击刷新按钮才能看到开关生效的延迟问题。

## 6.5.10

- 侧边功能面板卡片独立开关：在看板设置面板（⚙️）中新增「侧边功能面板」配置，支持对「Codex 额度」和「DeepSeek 余额」分别进行独立开启/关闭控制；默认均为开启；关闭时在宿主功能面板中完全隐藏对应微卡且不发多余网络请求；两者均关闭时显示纯净轻量提示，避免多余空白。

## 6.5.9

- 宿主功能面板集成 DeepSeek 官方 API 余额查询微卡：在宿主左侧功能面板（`function-panel.html`）中于 Codex 额度正下方新增 DeepSeek 余额微面板；通过官方开放平台 `api.deepseek.com/user/balance` 标准接口提取账户余额与赠送金额；在 `manifest.json` 补充 `api.deepseek.com` 网络白名单；内置 60 秒内存防刷缓存与 429 退避；未配置时静默自动折叠隐藏，不产生视觉噪音。

## 6.5.8

- 宿主功能面板（Function Panel）适配与 Codex 额度挂载：在 `manifest.json` 主整页卡声明 `functionPanel`（`/function-panel.html`）与 `fpFullPanel: true`，彻底替换宿主侧边面板的默认空状态“此页尚无清单”，实现 Codex 额度（5小时、本周、重置卡）在 Hana 宿主侧边功能面板上的原生常驻呈现与 60s 防刷同步；同时移除看板内部侧边栏下方重复挂载的微卡，消除视觉冗余。

## 6.5.7

- 侧边栏集成 Codex 额度与重置时间微卡：纯只读展示 5 小时窗口额度、每周额度、重置倒计时与重置卡余量；采用纯白极简规范（3px 极细进度条、Mono 灰黑微排版、无彩色 Emoji）；后端复用宿主 Codex OAuth/Bearer 凭据，内置 60 秒内存防刷缓存与优雅静默降级。

## 6.5.6

- 优化侧边栏下拉筛选列表：过滤历史/已删除 Agent（如已废弃的测试 Agent）与已失效供应商配置（如历史供应商），仅保留当前活跃的 7 位 Agent 与有效供应商，消除视觉噪音，保持与模型筛选设计一致。

## 6.5.5

- 修复侧边栏 Agent 筛选下拉列表不全缺陷：后端新增 `agentOptions` 汇集宿主全部已配置 Agent 与历史 Agent；解开前端首屏缓存死锁，确保任何时间范围下均可完整选择全部 7 位 Agent。

## 6.5.4

- 修复河流图控制按钮激活态样式切换失效：点击【按 Agent/按来源】及【总量/占比】后，高亮 active 类名即时同步至对应被点击按钮。

## 6.5.3

- 设置面板自聚：移除 `manifest.json` 中的宿主全局设置声明，避免污染 Hana 扩展设置菜单。
- 看板内嵌设置：将“扫描间隔”与“高消耗阈值”移至看板右上角设置齿轮弹窗中，支持在线修改与保存。
- 配置私有落盘与热生效：配置由后台保存至插件数据目录（`settings.json`），保存后后台调度定时器即时热更新生效。

## 6.5.2

- 修复卡片“导出 CSV”点击后不生成文件：改由后台写入插件自有导出目录，完成后返回实际路径、轮数与字节数。
- 移除未核实的“桌面已有文件”提示，失败时明确反馈；保存期间防止重复点击，并在看板刷新后保留状态。
- 导出使用独立文件名，保留 BOM、筛选和全量轮次；无需新增权限。

# 更新记录

## 6.4.12

- 原生诊断复制通过官方 UI SDK 的剪贴板写入能力，失败不伪报成功；只在手动点击时写入预览的允许字段摘要，不读取剪贴板。
- 供应商聚合与稳定选项分别返回，当前配置与历史供应商都能筛选，选项不因当前模型／供应商筛选而消失。
- 模型下拉使用宿主当前配置，已移除的历史模型不再伪装当前配置；保留其真实用量并明确标记，未标注模型单独解释。
- 移除无效的“显示已删除”开关，保留历史统计；仅申请新增 `app/ui.clipboard-write`，安装前需用户确认。

## 6.4.11

- 小时趋势、日趋势及模型明细使用相同的模型／供应商筛选交集，保留 Agent／类型筛选；历史单日使用该日小时记录，日期边界不再漏用。
- 主卡改用版本明确的页面入口，保留 index 兼容入口；通过随包官方 UI SDK 完成握手，启动失败保留可见说明。
- 运行状态与诊断摘要同时展示插件和界面版本，过期界面提示重新打开卡片。
- 封面按宿主契约位于 `ui/assets/face.png`，无需复制到错误的顶层路径；补充入口、版本和筛选一致性的回归检查，未新增权限。

## 6.4.10

- 看板增加默认折叠的运行状态：扫描、账本、首响 Hook、速度 Hook、胶囊发布；未知状态不误报正常。
- 失败、限流、供应商错误、取消、超时和无有效数据分别说明；恢复采样后清除过时异常，等待时显示的历史样本明确标注。
- 同步失败保留旧数据并标记，首次失败不展示虚假零值；显示最后尝试/成功同步时间、按扫描间隔判断新鲜度及有限采集范围。
- 保留所有产生 Token 的未定价模型明细，费用显示未定价；币种与换算一致，无汇率时保留原币，不能换算的费用不计入合计。
- 模型占比绑定真实调用次数，费用不可用时收起空列并说明原因；刷新保留筛选与现有数据。
- 增加指标口径解释及可预览的一键复制诊断摘要，按允许字段生成，不自动上传。
- 未新增权限、主数据源或计量口径变更。
