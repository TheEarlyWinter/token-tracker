# HanaAgent Token Tracker

面向 HanaAgent 的 v2 App：纯粹的 Token 资产与调用看板，以及输入栏缓存率、速度和首响胶囊。

## 输入栏状态胶囊指标说明

输入栏常驻的状态胶囊展示当前会话的关键运行时质量指标：
`缓存：xx.x%　速度：xx tok/s　首响：x.x s`

鼠标悬停在胶囊上可查看紧凑的详情气泡（如 `命中 107.4万 / 未命中 5.0万 · 输出 47.2k · 523 次`）。三大核心指标的定义与统计口径如下：

### 1. 缓存（Prompt Cache 命中率）
- **含义**：衡量模型上下文缓存（如 Claude Prompt Caching、OpenAI Context Caching、Gemini Context Caching）在当前会话中的复用效果。
- **计算口径**：统计当前会话、当前模型最近 50 条账本记录，按 Token 体量加权计算：
  $$\text{缓存率} = \frac{\text{读取缓存 Token (read)}}{\text{读取缓存 Token (read)} + \text{未命中输入 Token (uncached)}} \times 100\%$$
- **用户收益**：缓存命中率越高，大上下文传输越快、API 计费越经济，同时能显著缩短模型的预处理延迟。
- **缺省与降级**：若供应商不上报缓存读写细则，或尚无历史请求，显示为 `缓存：—`。

### 2. 速度（端到端输出吞吐率）
- **含义**：衡量模型完成回答的综合生成速度，单位为 `tok/s`（Tokens Per Second）。
- **计算口径**：按当前模型最近 8 个有效样本计算移动平均：
  $$\text{速度} = \frac{\text{输出 Token 数}}{\text{完整请求耗时 (秒)}}$$
- **关键特征**：
  - **端到端平均吞吐率**：耗时统计覆盖从发出请求到 assistant 最终消息完成，包含网络往返、模型排队思考与全部 Token 输出时长，**不是流式瞬时出字速度**。
  - **实时高精采样**：优先通过宿主生命周期 Hook（`hooks.provider-before-request` 至 `hooks.messages-post-assistant`）采集毫秒级耗时；无实时样本时自动回退为官方账本记录时长。
  - **异常过滤**：耗时异常（<100ms）、无输出 Token 或非 assistant 消息均不计入样本；请求进行中保持此前有效历史样本，避免界面闪烁。

### 3. 首响（首包响应元数据延迟）
- **含义**：衡量网络链路通信与模型服务端的初始响应等待时间（单位为秒 `s`）。
- **计算口径**：从宿主向 Provider 发出请求起，到接收到 Provider 的第一包响应元数据（Response Headers / 首包到达）的耗时。
- **关键特征**：
  - **网络与排队延迟**：反映请求到达供应商服务器并建立连接的速度，**不是最终流式文字渲染首字完成的 TTFT（Time to First Token）**。
  - **失败剔除**：若请求触发 429 限流、502 网关错误或中断取消，本次样本作废，不污染统计指标。

---

## 核心功能与特性

- **纯粹 Token 资产看板**：专注于 Token 用量与调用质量，包含总览核心指标卡、小时/日消耗趋势图、模型占比双栏榜（Token 消耗榜 + 调用频次榜）、Agent 消耗对比与多媒体任务统计。
- **输入栏常驻胶囊**：会话级 Prompt Cache 命中率、端到端生成吞吐率及首包响应延迟，带紧凑防溢出悬浮气泡。
- **运行健康与诊断**：默认折叠的组件健康监测、指标异常/降级原因解释、数据新鲜度指示及安全脱敏诊断摘要（支持一键复制）。
- **原生 ESM 架构**：零构建打包负担，高内聚原生模块化与现代 macOS 风格设计。

---

## 版本与加载策略

版本 **6.4.17**。Tag、manifest 和 package 版本保持严格一致。

主卡使用 `/dashboard-v6.4.17.html` 版本入口，`/index.html` 仍可使用；通过随包官方 UI SDK 握手并加载看板，启动失败时保留可见说明。运行状态详情和诊断同时显示插件版本与界面版本；不一致时提示重新打开卡片。Hana 的静态资源集随装载代次捕获，更新后应重新打开旧卡片，不用磁盘文件哈希代替已打开页面的版本验证。卡片封面 `face.image: assets/face.png` 相对 `ui/`，对应 `ui/assets/face.png`，不要求顶层 `assets/face.png`。

看板区分最后尝试与最后成功同步；失败保留已成功取得的数据，首次失败不渲染零消耗。过期判断采用配置扫描间隔的两倍，并结合当前扫描任务状态。运行状态仅在取得注册回执、成功扫描或实际发布结果后显示正常；宿主将 Agent 启用与输入栏授权合并拒绝时，明确保留该原因的不确定性。

诊断摘要可先预览再复制，不自动上传。原生卡片使用官方 UI SDK 的剪贴板写入能力（`app/ui.clipboard-write`）。仅在点击复制按钮时写入已预览的摘要，不读取剪贴板，也不在拒权后绕过宿主限制。仅包含版本、五个组件的最新状态、安全错误分类和同步时间，不包含会话身份/路径、凭据、正文或供应商错误原文。状态条目固定有界并在 dispose 时释放。

供应商接口返回当前筛选范围的 `providers` 聚合，以及独立、稳定的 `providerOptions`。模型筛选以成功读取的宿主当前有效配置为准；历史未配置模型标注为“历史，当前未配置”，`unknown` 解释为“未标注模型”，历史数据如实参与总览与排行榜统计。当前配置读取失败时不误判全部删除。小时趋势与日趋势共享相同的筛选交集。

## 架构与模块职责

### 后端与后台运行时
- `index.js`：App 生命周期管理、官方 `usage:list` 拉取与事件订阅分发。
- `lib/local-client.mjs`：启动宿主管理的 Node 服务，以短期随机凭据执行有大小限制的 RPC；扫描请求单飞，支持批量和分页。
- `runtime/service.mjs`、`runtime/engine/`：子进程进行归档、增量聚合与缓存恢复。数据写入 App 自有 dataDir，不猜测用户会话目录、不直接扫描会话正文 JSONL。
- `usage-archive.jsonl` 与缓存 journal：追加写入、去重、重启恢复；坏 JSON 行和中断尾行跳过并计数警告，空行忽略。读取权限/磁盘错误不等同于可恢复的坏 JSON。
- `lib/session-cache.mjs`：输入栏胶囊管理。加权计算会话 Prompt Cache 命中率，调度速度与首响更新，生成紧凑安全的双行浮层。
- `lib/first-response.mjs`：请求发出至 provider 响应元数据到达，称为**首响**，不是首 token TTFT。
- `lib/generation-speed.mjs`：请求发出至 assistant 消息完成，使用消息上报的输出 token，按当前模型最近 8 个有效样本计算平均请求吞吐率；包含响应等待时间，不是流式瞬时 tok/s。

### 前端模块架构 (`ui/`)
- `ui/modules/theme.js`：主题与深浅色模式状态管理，与宿主主题自动同步。
- `ui/modules/headline-cards.js`：总览核心指标卡片渲染（总消耗、聊天/频道、输出、未命中/命中、缓存率）。
- `ui/modules/filter-dropdown.js`：Agent、供应商、模型与消息类型下拉筛选组件。
- `ui/modules/subscription-quotas.js`：顶栏与底栏订阅额度与余量仪表组件。
- `ui/modules/media-section.js`：多媒体（图片/视频）任务生成统计与分类展示。
- `ui/modules/settings-dialog.js`：外观与偏好设置面板。
- `ui/modules/date-picker.js`：日历式自定义日期范围选择器。
- `ui/base.css`：轻量精简的现代 macOS 风格原生样式表。

HTTP 429/502、错误/取消完成消息和有未完成请求的 settled 事件使对应指标显示 `—`；恢复成功后重新采样。无事件的请求超时由保留策略回收，不能在尚未收到宿主事件前推断网络错误。

## 资源边界与收尾

- 每个会话映射/指标表最多 512 项，写入后保留 30 分钟；每会话首响 FIFO/样本最多 8 条，速度最多 16 个模型、每模型 8 条样本。
- 待响应请求最多保留 5 分钟。每分钟执行空闲清理；过期值在读取/写入时也会淘汰。TTL 使用上次写入时间，不因反复读取而永久续期。
- 胶囊待刷新定时器和已发布会话各最多 512 个，最多 32 个并行刷新；扫盘 interval 和清理 interval 均为 unref 定时器，显式 dispose 会释放。
- App 的隔离进程与受管 Node 服务由 Hana 拥有，禁用、重载、退出时最终回收责任属于宿主。`shared.dispose()` 用于明确停止扫描、清除计时数据、退订与等待运行时停止；停止失败会报告，不假装成功。
- 自动测试检查 SIGTERM 下的真实子进程正常退出及 PID 回收，但这不等同于对操作系统崩溃、SIGKILL、宿主故障做出“100% 无僵尸/零字节泄漏”的保证。历史归档索引会随真实数据增长，不属于恒定大小的实时指标表。

## 依赖与宿主契约

- 最低 Hana 版本：`0.1050.9`（以 `manifest.json` 为准）。
- 本地测试/CI：Node.js 24；使用原生测试运行器与内建模块，无需 npm 安装运行时依赖。
- 前端纯原生 ES Modules：零构建打包步骤，图表库由 `ui/vendor/` 本地提供，不依赖运行时 CDN。
- 后台服务保持 `profile: scoped`，显式使用 `network: external`：Linux bwrap 不支持 loopback-only managed service。服务自身仍仅监听 `127.0.0.1`，RPC 需要随机鉴权。授予 external 表示扩大运行时联网能力，不应将其描述为无网络沙箱。

## 安装

下载正式 Release ZIP 或克隆仓库，然后在 Hana 请求通过扩展管理器安装本地 App 并确认授权。不要直接覆盖托管安装目录。批准后检查版本、运行日志和实际胶囊；静态占位文字不能作为验收结果。

```bash
git clone https://github.com/TheEarlyWinter/token-tracker.git
cd token-tracker
npm test
```

核心声明权限与用途：

| 能力 | 用途 |
| --- | --- |
| `app/usage.read` | 读取官方账本用量数据 |
| `app/ui.clipboard-write` | 手动复制已预览的脱敏诊断摘要到剪贴板 |
| `app/runtime.execute`、`app/runtime.network` | 启动受管扫描服务及本地通信 |
| `app/input.status` | 会话输入栏右下角状态胶囊覆盖 |
| `app/hooks.provider-before-request`、`app/hooks.observe` | 首响延迟计量与生命周期观察 |
| `app/hooks.messages-post-assistant` | 助手完成消息 Token 与时长计量（只读观察，不改写消息） |
| `app/agents.read`、`app/sessions.read` | 会话归属与 ID/路径解析 |
| `app/provider.credentials.read` | 订阅配额路由向相应供应商 API 发起只读查询 |
| `app/media.tasks.read` | 多媒体（图片/视频）任务用量读取 |

不将凭据写入扫描归档或发布包；余额查询会向对应供应商发送所需凭据，不向无关第三方发送。撤销可选权限不应导致主用量页面崩溃。

## 发布

`npm test` 与 `git diff --check` 通过、宿主安装验证通过后，提交代码并推送与版本一致的 annotated Tag。GitHub Actions 使用 Node 24 先测试、校验 Tag/manifest/package 一致性，再将 **Git 跟踪的文件** 打包，在临时目录解压后重新执行完整测试，最后发布 ZIP 与 SHA-256 校验文件。只对版本 Tag 创建正式 Release；手动工作流仅上传构建 Artifact。不将本机 dataDir、node_modules、凭据或未跟踪文件打包。

GitHub Release 及工作流成功状态须实际核对；推送 Tag 不代表构建已经成功。

MIT License，见 [LICENSE](LICENSE)。
