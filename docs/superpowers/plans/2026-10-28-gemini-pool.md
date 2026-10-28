# Gemini 算力池微卡实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax.

**状态：** 实现、独立审查与本机合成验收已完成。7.1.0 本机试装已由正式入口确认 installed。用户随后授权推送、发包 7.2.0，并要求私人域名替换为占位符；公开代码使用 cpa.example.invalid，不覆盖现有本机试装。

**目标：** 在看板和 Function Panel 增加只读 Gemini 算力池微卡，未配置时隐藏。

**架构：** 后端持有管理密钥，通过 CPA v8 获取账号和分组配额。60 秒缓存与单飞共享。前端复用同一渲染器，仅接收脱敏 DTO。

**技术：** 原生 ESM、Node 内置测试、现有 Hana UI SDK，不增加依赖。

**规格：** docs/superpowers/specs/2026-10-28-gemini-pool-design.md。

## 全局约束

- 基线为 c771e9f，基线版本 7.1.0。开始时工作树干净；发布目标为 7.2.0。
- 仅主代理和 Luna。每次 Luna 调用均为 thinkingLevel=max。
- 不改 Codex、模型路由、宿主、Provider 配置和其他余额业务。
- 不读取实际凭据、原始 OAuth 文件或会话正文。真实管理密钥由用户通过设置输入。
- 初始不自动安装；用户后续明确授权覆盖安装测试及 7.2.0 推送、发包。只按追加授权发布，不删除用户文件，不重写既有 Git 历史。
- 管理密钥保存到 App 自有 gemini-cpa.json，0600；不进入响应、日志、文档或发布包。
- 公开 CPA 主机统一为保留占位域，不含私人部署地址。测试用注入 fetch，不访问真实账号。使用者需同步替换服务地址和 manifest 白名单。
- 新外部数据仅在 HTTP/网络入口校验，内部不重复做同类校验。

## 审查重点

1. 账号列表不是额度。不能把被动 quota 信号或 supports_quota 当实时剩余量。
2. 禁用、缺项目、失败、未知与 0 剩余必须区分，不伪造恢复或完整性。
3. 管理 API 的外层 200 不代表上游成功，需检查 status_code 与 body。
4. 不下载凭据、不透传原始错误/邮箱/路径/索引/项目 ID；不跟随重定向泄露管理密钥。
5. 双端和手动刷新不穿透 60 秒缓存；慢池查询不阻塞旧卡；配置更新后的旧响应不能覆盖新配置。
6. 管理鉴权失败暂停自动重试，直到配置变更，避免 CPA 连续失败封 IP。内层账号 401 不触发管理暂停。
7. 12 秒总预算包含 credentials、quota 及响应体读取。单请求不超过 8 秒或剩余预算。

## 任务一：后端与安全配置

**负责：** Luna 数据实例。

**文件：** 新建 lib/gemini-quota.mjs、test/gemini-quota.test.js、test/gemini-quota-routes.test.js；修改 server/dashboard.js、manifest.json、.gitignore、test/manifest.test.js。

**接口：** GeminiQuotaService({dataDir,network,fetchFn,ttlMs=60000,timeoutMs=12000,now=Date.now})。提供 getQuota()、getConfig()、saveConfig({action,managementKey})。输出严格按设计 DTO。

- [x] 先写失败测试：未配置零网络、保存/清空/0600、安全配置状态、缓存与单飞、配置 epoch、外层与内层错误、缺项目与禁用、分组 0 值和非法值、固定目标、3 并发与总预算。
- [x] 运行新增服务和路由测试，确认功能缺失导致红灯。
- [x] 实现 v8 credentials → requests/api-call → retrieveUserQuotaSummary，不下载凭据，不查询订阅，不支持任意转发 URL。
- [x] 在 registerRoutes 中单次构造服务；接入 GET /gemini-quota、GET/POST /gemini-quota/config 及 dashboard 别名。
- [x] manifest 只增加指定 CPA 主机；忽略 gemini-cpa.json；同步精确白名单测试。
- [x] 补 ready、body deadline、管理鉴权暂停、Go string 索引、同邮箱 ID 和非法值回归。定向关联 73/73。

## 任务二：卡片、设置与双端接线

**负责：** Luna 前端实例，与任务一并行，按固定 DTO 开发。

**文件：** 新建 ui/modules/gemini-card.js、test/gemini-card.test.js、test/gemini-pool-browser.mjs；修改 ui/base.css、ui/dashboard-app.js、ui/function-panel.html、ui/function-panel.js、ui/modules/settings-dialog.js。另更新 test/reset-credits-ui.test.js 的 bootstrap harness，ACK 断言不变。

**接口：** renderGeminiCard(container, dto, {now=Date.now()}={})。双端复用轻量加载控制器，不新增通用状态框架。只请求 App 的配额与配置路由。

- [x] 先写失败测试：隐藏、分组 0%、过期和未知重置、HTML 转义、查询失败、加载顺序及设置保存/清空。
- [x] 确认初始缺模块及未接线的真实红灯。
- [x] 实现共享纯白微卡，标注 Antigravity 共享配额，不聚合账号百分比，沿用 CSS tokens。
- [x] 独立接入看板侧栏和 Function Panel。动态 pending 测试确认不阻塞三张旧卡。
- [x] 设置提供密码输入、保存、清空和安全状态；不回填密钥；成功后清空输入；广播只传安全状态。
- [x] 未配置或首次未知状态失败时整块隐藏；迟到响应和清空后失败不能复活卡片。分隔线同步隐藏。
- [x] 同步旧 VM harness 的末尾 bootstrap 边界，不改业务或 ACK 断言。追加 storage tick 时间戳与连续保存回归。

## 任务三：主代理审查与交付

- [x] 主代理读取关键实现，核对请求体、host/redirect、0600、脱敏 DTO、缓存、epoch、鉴权暂停和 UI 接线。
- [x] Luna 只读独立复查：Approve，无 Critical/Important；同毫秒 storage 备用通道边界记为不阻断 Minor。
- [x] 更新 README，说明配置、配额口径、性能成本和真实连通性边界。
- [x] 主代理新鲜运行 npm test：425/425；JS/MJS 语法：226/226；git diff --check 通过。
- [x] 主代理独立运行 Gemini headless：6/6；旧原生鼠标首击回归通过；模型路由浏览器：5/5。
- [x] 记录源码变更与验收结果。明确真实 CPA 尚未鉴权验收；无提交、推送、版本升级或发布。

## 用户追加：安装测试

- [x] 使用正式扩展入口暂存本地 7.1.0 源码，不卸载，不清数据。
- [x] 用户确认后，正式 status 已核对 installed。
- [x] 用户反馈可以继续发布。代理未读取真实管理密钥或真实配额，不把该反馈等同于代理独立鉴权验收。

## 用户追加：发布 7.2.0 与隐私

- [x] 版本和当前静态入口同步为 7.2.0，旧 7.1.0 入口保留。
- [x] 私人服务域全部换为 cpa.example.invalid；密钥配置和本地输出不进入 Git 发布树。
- [x] 旧变更日志的具体现场用量和金额改为一般说明；不重写既有公开历史。
- 发布门禁：最终全量、干净发布包和隐私复核必须在推送前完成。正式发布状态以 v7.2.0 Release 及 CI 为准。

## 验收记录

报告：docs/2026-10-28-gemini-pool-review-report.md。
基线 npm test 为 391/391。新增实现期间主代理全量曾发现 2 个旧 VM harness 失败，修正测试引导边界后再次全量达到 425/425。
本轮没有真实 CPA 管理密钥，不把公开源码和合成测试当作部署验收。
