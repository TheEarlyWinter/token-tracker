# Code 模式用量统计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增互斥的 Code 用量来源，包含父会话及子代理，保持总量和原有非 Code 统计不变。

**Architecture:** 官方 session:get 识别父会话 namespace，持久化分类映射。沿用现有 type 管线，Code 请求 type=code、baseType 保留原类型；同一 requestId 永远只归档一次。分类迟到时重建受影响的聚合与 turns 索引，不追加用量。

**Tech Stack:** Node.js 24，原生 ESM、node:test、node:sqlite，现有 App SDK 和原生前端，无新增依赖。

**Spec:** docs/superpowers/specs/2026-10-25-code-usage-design.md

## Global Constraints

- 当前完整本机源码快照为基线，原安装目录只读。只在本项目工作区改源码；最终安装只走 extension_manager。
- SDK 查询固定为 sessions.get({sessionId, scope:"all"})；可用时兼容正式 bus session:get。仅提取 namespace，禁止扫描正文或私有数据库。
- 每扫描最多 8 个未知会话，全局最多 2 个在途查询，等待最多 2000ms。底层超时请求仍占槽直到结束。失败至少 5 分钟后再试。成功映射持久化。历史回填每轮至少 1 个名额，存在新会话时优先处理最新账本。
- 非 Code 分类、Token/费用口径、ok 过滤和 requestId 去重不变。允许未知历史降级，必须提示。重复扫描、实时事件与回填交错不双算。
- 无新增 npm 依赖。保留原样式。不删除原数据。不推送、发布或合并其他分支。任务子代理不再委派。
- 实现者先写失败测试，再实现，最终执行 npm test 和 git diff --check。只对明确归属本任务的文件提交本地 commit。
- 版本只在 Task 2 更新至 6.9.0，manifest/package/版本界面入口保持一致。

## Review Focus

- 已归档请求晚获得 Code 映射：总量不变，旧聊天桶撤销，Code 桶、SQLite 明细和 CSV 一致。
- 映射缓存损坏、宿主字段缺失或权限拒绝：账本仍可读，未知保持原类并提示，不存正文。
- 大量未知或永久悬挂的查询：每轮调用有界，负缓存有效，历史不饥饿，不能积累在途 Promise。
- App 重启且会话已删除：已有成功映射仍有效；无映射历史不伪造分类完整。
- 筛选交集及实时数据：Code+日期+模型+Agent+provider 的总览、趋势、明细、导出一致，Code 不进入 channel 兜底分支。

---

### Task 1: Code 分类、持久缓存、历史回填与后端一致性

**Files:**
- Create: lib/session-sources.mjs（官方会话查询与有界调度）。
- Modify: lib/sync-scheduler.mjs、lib/local-client.mjs、lib/ledger-normalization.mjs、lib/realtime-stream.mjs（若分类实时快照需要）。
- Modify: runtime/engine/ledger-engine.mjs、runtime/engine/rpc-handler.mjs、runtime/engine/services/turns-store.js、runtime/engine/services/visual-analytics.js。
- Modify: server/dashboard.js（Code 汇总/图表/明细/CSV/过滤兼容及分类完整性元数据）。
- Create/Modify: test/code-sources.test.js、test/code-ledger.test.js、test/code-dashboard.test.js，以及直接受接口变化影响的既有测试。
- 可新增一个 runtime/engine/services/session-sources.js 封装持久映射与候选索引；不得无关拆分。

**Interfaces:**
- Consumes: sdk.sessions.get({sessionId,scope:"all"}) -> {session:{namespace}|null}；existing raw ledger attribution.sessionId 为父会话 ID。
- Produces: type="code"；baseType 保留原类型。normalizeEntryForArchive 的原单参数调用兼容。
- Produces: /data summary.totalCode、agents[].codeTotal、daily/daily30/hourly[].code；visualAnalytics 来源包含 code；type=code 筛选作用于现有全部读取/导出路径。
- Produces: /data sourceClassification:{status:"complete"|"partial"|"unavailable",unresolvedSessionCount:number}，来自完整归档识别状态，不是最近窗口。
- Internal: createSessionSourceResolver({sdk,client,dataDir,log})，提供 resolve(entries) 和 dispose()。候选历史 ID 通过受管引擎 RPC 提供，不在 App 主进程扫描归档正文。新增 RPC sessions.candidates({limit}) 返回有界未知父 sessionId 列表；client.call 可复用。
- Internal: client.scan(entries,options) 接收 sessionNamespaces（本轮成功 namespace 映射）与 sourceResolution（本轮失败/能力状态，只有安全代码与会话 ID）。引擎合并持久映射并使晚分类的桶和 SQLite 索引失效。具体存储组织可按已有 cacheStore 约定实现；不得私自扩大对外接口。

- [ ] Step 1: 写测试：Code 主请求与子请求各一次，聊天子请求保持 sub；再扫相同 requestId 总量/成本/次数不变；所有数值均使用固定合成 fixture。
- [ ] Step 2: node --test test/code-sources.test.js test/code-ledger.test.js test/code-dashboard.test.js，确认新行为测试因功能缺失失败，记录失败证据。
- [ ] Step 3: 实现识别、正负缓存、全局在途限制和调度。测试 8 个上限/2 个在途/2000ms 等待/5 分钟负缓存/历史保留名额；用可注入时钟或延迟缩短测试，不真实等待分钟。
- [ ] Step 4: 实现归档映射和晚分类更新。测试请求归档后才知道 Code、仅历史归档而无当前账本记录、重启恢复、未知会话 null、拒权、字段缺失、缓存损坏。断言 archiveCount、总 Token/费用不变，SQLite 和 CSV 过滤一致。
- [ ] Step 5: 实现后端 Code 分类分支、daily/daily30/hourly、visualAnalytics 和完整性元数据。测试 Code 不流入 channel；Code+模型/provider/Agent/日期筛选交集；非 Code 现有规则不变。
- [ ] Step 6: 跑上述定向测试、npm test、git diff --check。自审后只提交本任务文件（不改版本、不改 ui/），报告 RED/GREEN、测试数量、commit、残留风险。

### Task 2: Code 界面、来源图层与版本交付

**Files:**
- Modify: ui/dashboard-app.js、ui/modules/headline-cards.js、ui/modules/agent-analytics.js、ui/modules/turns-inspector.js、ui/modules/heat-matrix.js（仅需要处）、ui/base.css（仅必要样式）。
- Modify: manifest.json、package.json、lib/dashboard-page.mjs、ui/index.html、ui/function-panel.html、ui/function-panel.js（仅版本引用需要处）。
- Create: ui/dashboard-v6.9.0.html（沿用既有版本入口模式）。
- Modify: README.md、CHANGELOG.md（只记录此功能、正确版本和历史边界；不要重写旧历史）。
- Create: test/code-ui.test.js；Modify 直接受版本/新增来源影响的既有 UI 和 manifest 测试。

**Interfaces:**
- Consumes: Task 1 的 type=code 筛选、summary.totalCode、agents[].codeTotal、daily/daily30/hourly[].code、visualAnalytics code、sourceClassification。
- Produces: 现有来源筛选中可选 Code；总览来源、日/小时趋势、来源流图、明细和 CSV 显示 Code；不增加第二套重复统计。
- Produces: partial/unavailable 时显示“部分历史会话无法识别来源，Code 分类可能不完整。”；complete 不显示警告。接口字段缺失不能默认为完整。
- Produces: App 与 UI 版本 6.9.0，版本入口 /dashboard-v6.9.0.html，不触碰宿主安装目录，不主动安装或重载。

- [ ] Step 1: 先写失败测试：Code 选项、真实渲染 Code 汇总/图层/明细标签、分类不完整提示及缺字段降级，保留既有聊天/频道选项和布局。
- [ ] Step 2: node --test test/code-ui.test.js，确认因新功能缺失而失败。
- [ ] Step 3: 实现 UI 消费已定后端字段。保留现有 CSS 和图表风格；缺 totalCode 时显示安全零值，但分类能力缺失必须提示。不要改后台数据口径。
- [ ] Step 4: 版本/manifest/静态入口更新为 6.9.0；README 只补准确版本与 Code 分类和历史限制说明；CHANGELOG 追加本次功能。
- [ ] Step 5: 定向 UI/版本测试、npm test、git diff --check。自审后只提交本任务文件；报告 RED/GREEN、测试数量、commit、未验内容。

### Task 3: 独立验收与正式安装准备

**Files:**
- Create: docs/verification/2026-10-25-code-usage.md（短句中文，不记录真实会话标识或正文）。
- Modify: 仅审查确认需要的定向测试；发现实现缺陷交回对应作者，不直接无关重构。

**Interfaces:**
- Consumes: 两个实现任务的 diff 和报告、完整设计和接口契约。
- Produces: 需求符合性、代码质量、完整 npm test 与 git diff --check 的实际结果；源码与安装包候选，不假装已安装。

- [ ] Step 1: Luna 独立核对完整归档晚分类、持久映射恢复、去重、查询上限、异常降级、筛选交集、明细/CSV 一致性与隐私边界。
- [ ] Step 2: 按具体缺口补失败测试并交回实施者修复。不可弱化断言，不跑私有真实日志正文。
- [ ] Step 3: 完整 npm test、git diff --check、版本/静态入口检查。给出已验和未验清单。
- [ ] Step 4: 主代理审查关键改动，通过后走 extension_manager 本地更新和确认。不得直接覆盖安装目录。实际确认后再核对安装版本、日志、Code 筛选与总额；若需用户点击，只说明等待确认，不宣称运行时生效。
