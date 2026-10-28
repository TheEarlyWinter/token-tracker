# Gemini 算力池微卡设计

## 目标与授权

用户确认继续实施已交接的 Gemini 额度微卡。
只做 Token Tracker 的看板和 Function Panel。沿用原生 JavaScript、现有样式和服务结构，不加运行时依赖。
不修改 Codex、模型路由或宿主适配器。实现阶段不自动安装、提交、推送或发布。
用户随后授权本机安装测试，并追加授权发布 7.2.0。用户明确禁止公开私人 CPA 地址。公开源码与发布包统一使用 `https://cpa.example.invalid`，白名单同步为 `cpa.example.invalid`。使用者须在安装自己的构建前同时替换服务常量和网络白名单；管理密钥仍只在 App 设置输入。已安装本机试用版本不随公开源码替换而自动覆盖。

## 方案

采用 App 后端代理 CPA v8、60 秒共享缓存、双端复用卡片渲染器。
浏览器直连 CPA 会暴露管理密钥，不采用。只读取 credentials 列表无法得到实时额度，也不采用。
本次选择延续已确认的后端代理方案，仅按公开接口补齐额度请求链。

## 数据链与边界

1. 用户在设置页输入 CPA 管理密钥。不在聊天中索取，不从宿主其他凭据配置中猜取。
2. 后端向已指定的 CPA HTTPS 主机请求 `GET /v8/management/credentials`。使用 Bearer 管理鉴权，不跟随重定向。
3. 只选择 Antigravity 账号。只取索引、脱敏标识所需信息、项目标识和健康状态。
4. 项目标识按公开管理中心的顶层、metadata、attributes 已知字段解析。缺失时标记 `missing_project`。
5. 禁止调用 credentials/download，不下载或保存账号 OAuth Token。
6. 通过 `POST /v8/management/requests/api-call` 转发固定的 `retrieveUserQuotaSummary` 查询。账号索引采用 `auth_index`；目标请求的鉴权使用 `Bearer $TOKEN$`，由 CPA 替换。
7. 依次使用公开的 daily、sandbox、production Cloud Code 配额地址。只查询配额，不发模型生成请求，不读取订阅计划。
8. 验证 api-call 的 status_code 和 body，提取 groups/buckets。未知结构返回安全错误，不伪造余额。
9. App 网络白名单只增加指定 CPA 主机。Google 配额请求由 CPA 转发，不在浏览器执行。

实现阶段对指定部署的匿名状态探测返回 401，该结果不能证明已鉴权接口可用。真实连通性由用户在本机试装后配置验证；代理不读取管理密钥或账号池数据。公开占位域不是已连接的服务。

## 配置与 HTTP 契约

- `GET /gemini-quota/config`：返回 `{configured, baseUrl}`，不返回密钥或密钥片段。
- `POST /gemini-quota/config`：接受 `{action:"save",managementKey}` 或 `{action:"clear"}`。保存成功只返回安全配置状态。密钥只写 App 自有 dataDir 的 `gemini-cpa.json`，权限 0600。清空时写空配置，不删除其他文件。
- `GET /gemini-quota`：返回下述 DTO。未配置时不访问 CPA。
- 仅在上述边界验证外部数据。内部使用已经归一化的字段。

```text
{
  configured: boolean,
  connected: boolean,
  reason: string | null,
  updatedAt: number | null,
  accounts: [{
    id: string,                 // 稳定摘要，不含文件名或原始索引
    label: string,              // 脱敏邮箱或匿名账号名
    health: "healthy" | "disabled" | "unavailable" | "unknown",
    quotaStatus: "ok" | "missing_project" | "error" | "empty" | "not_checked" | "timeout",
    groups: [{
      id: string,
      label: string,
      buckets: [{id: string, label: string, remainingFraction: number, resetTime: string | null}]
    }]
  }]
}
```

- remainingFraction 保留 0，合法范围为 0..1。兼容公开接口的数字、数字字符串和百分数字符串。非法值丢弃，不当作 0 或 100%。
- resetTime 转为有效 ISO 时间或 null。缺少时间显示未知。过期时间显示待刷新，不推定额度已恢复。
- 只允许上述公开 DTO。管理密钥、OAuth Token、完整邮箱、文件路径、原始账号索引、项目 ID、原始错误和上游响应头均不返回前端。
- health 来自 CPA，quotaStatus 表示配额查询结果，两者分开。配额查询失败不等于账号已失效。
- disabled 为 true 或 status 为 disabled 时不查询配额。unavailable 为 true 或 status 为 error 时标记不可用，但仍查询额度，以保留耗尽账号的重置时间。status 为 active 或公开 v8 示例的 ready 时标记 healthy，其他状态为 unknown。
- 配额成功不覆盖 CPA 的不可用状态。缺项目必须显示无法查询，不推定账号失效。

## 配额口径

这是 Antigravity 账号的分组配额，不是独立验证的 Gemini 模型专属额度。
保留 groups/buckets，不凭空按模型拆分，也不把不同账号百分比相加或平均为总池额度。
卡片标题为 Gemini 算力池，并标注 Antigravity 共享配额。

## 性能与失败

- 成功和一般失败结果均缓存 60 秒。看板、侧栏、普通刷新及手动刷新共用缓存，不提供任意 force 绕过。
- 管理请求外层 401/403 是例外：暂停自动鉴权重试，保留安全错误，直到重新保存或清空配置。官方文档说明连续 5 次鉴权失败会临时封禁客户端 IP，不能每分钟自动重试错误密钥。内层上游 401/403 仅代表账号配额查询失败，不触发管理密钥暂停。
- 并发请求共用一个在途任务。保存或清空配置后失效旧缓存；旧请求不能覆盖新配置结果。
- 每次刷新只有一次 credentials 查询。账号额度每批最多 3 个并发。
- deadline 从本轮刷新开始计时，为开始时间加 12 秒。credentials 和所有 quota 请求共用该截止时间。每次超时设为 min(8 秒, 剩余预算)，覆盖取得响应头和读取响应体。到截止时间取消在途请求并停止新增请求，以已有结果结束，未完成账号标记 timeout。不在 credentials 之后另起一个 12 秒预算。
- 单个账号失败不清空其他账号。401/403、404、429、超时和未知结构只返回固定安全原因。
- 不新增后台扫描或网络轮询。复用现有页面刷新生命周期。

## UI

- 同一个纯渲染模块用于看板侧栏和 Function Panel，纯白、细边框、紧凑进度条，沿用现有设计。
- 未配置时清空并隐藏卡片与所属区块，不显示未配置占位。
- 已配置但失败时显示简短错误，不伪造零额度。首次请求失败且配置状态未知时不自行假定已配置；沿用最后已确认的配置状态。
- 管理鉴权受限时提示检查密钥和远程管理，再重新保存配置；不诱导无意义重复刷新。
- 各账号显示脱敏标识、状态、分组剩余百分比、重置倒计时。
- 设置中提供密码输入、保存和清空。保存后清空输入框，不回填已有密钥。
- 新卡的慢请求不能阻塞现有 Codex、DeepSeek、Lithos 卡片。重复刷新不得叠加监听器或倒计时定时器。

## 验收

先红后绿。合成数据覆盖配置权限、密钥脱敏、未配置零出网、60 秒缓存和双端并发去重、配置变更竞争、CPA 外层/内层失败、缺项目、不下载凭据、并发与时间预算、分组口径、0 额度、非法字段和倒计时过期。
前端验证两处真实接线、未配置隐藏、部分失败、HTML 转义和刷新竞争。
主代理核对关键实现，运行完整测试、语法、diff check 和独立 headless 浏览器。真实 CPA 鉴权尚未验证时必须明确说明。

## 公开依据

- https://help.router-for.me/cn/management/apiv8
- https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/handlers/management/auth_files.go
- https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/handlers/management/api_tools.go
- https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/features/quota/providers/antigravity/data.ts
- https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/utils/quota/constants.ts
