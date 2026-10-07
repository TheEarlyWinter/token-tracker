# HanaAgent Token Tracker

面向 HanaAgent 的 v2 App：官方用量账本、成本与余额仪表盘，以及输入框缓存率、速度和首响胶囊。

## 版本与发布策略

版本 **6.4.8**。Tag、manifest 和 package 版本必须一致。只有完成测试与安装验收后才推送 `v6.4.8`；Tag 不是验收证据。

## 架构与数据口径

- `index.js`：App 生命周期、官方 `usage:list` 拉取与事件订阅。保留既有仪表盘路由。
- `lib/local-client.mjs`：启动宿主管理的 Node 服务，以短期随机凭据执行有大小限制的 RPC；扫描请求单飞，支持批量和分页。
- `runtime/service.mjs`、`runtime/engine/`：子进程进行归档、增量聚合与缓存恢复。数据写入 App 自有 dataDir，不猜测用户会话目录、不直接扫描会话正文 JSONL。
- `usage-archive.jsonl` 与缓存 journal：追加写入、去重、重启恢复；坏 JSON 行和中断尾行跳过并计数警告，空行忽略。读取权限/磁盘错误不等同于可恢复的坏 JSON。
- `lib/session-cache.mjs`：缓存率按同会话、当前模型最近 50 条账本记录的缓存 token 体量加权。输出速度优先采用实时计量，无实时样本时才使用有效账本时长。
- `lib/first-response.mjs`：请求发出至 provider 响应元数据到达，称为**首响**，不是首 token TTFT。
- `lib/generation-speed.mjs`：请求发出至 assistant 消息完成，使用消息上报的输出 token，按当前模型最近 8 个有效样本计算平均请求吞吐率；包含响应等待时间，不是流式瞬时 tok/s。

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
- SDK 契约随仓库 `sdk/` 提供；前端图表库由 `ui/vendor/` 本地提供，不依赖运行时 CDN。
- 后台服务保持 `profile: scoped`，显式使用 `network: external`：Linux bwrap 不支持 loopback-only managed service。服务自身仍仅监听 `127.0.0.1`，RPC 需要随机鉴权。授予 external 表示扩大运行时联网能力，不应将其描述为无网络沙箱。

## 安装

下载正式 Release ZIP 或克隆仓库，然后在 Hana 请求通过扩展管理器安装本地 App 并确认授权。不要直接覆盖托管安装目录。批准后检查版本、运行日志和实际胶囊；静态占位文字不能作为验收结果。

```bash
git clone https://github.com/TheEarlyWinter/token-tracker.git
cd token-tracker
npm test
```

新增授权必须由用户确认：

| 能力 | 用途 |
| --- | --- |
| `app/usage.read` | 官方账本 |
| `app/runtime.execute`、`app/runtime.network` | 受管扫描服务及其显式联网配置 |
| `app/input.status` | 胶囊覆盖 |
| `app/hooks.provider-before-request`、`app/hooks.observe` | 首响计量与生命周期观察 |
| `app/hooks.messages-post-assistant` | 完成消息 token/时长计量；返回 undefined，不改写消息 |
| `app/agents.read`、`app/sessions.read` | 归属与会话 ID/路径解析 |
| `app/provider.credentials.read` | 已有余额/配额路由向相应供应商 API 发起只读查询 |
| `app/media.tasks.read` | 已有媒体用量路由 |

不将凭据写入扫描归档或发布包；余额查询会向对应供应商发送所需凭据，不向无关第三方发送。撤销可选权限不应导致主用量页面崩溃。

## 发布

`npm test` 与 `git diff --check` 通过、宿主安装验证通过后，提交代码并推送与版本一致的 annotated Tag。GitHub Actions 使用 Node 24 先测试、校验 Tag/manifest/package 一致性，再将 **Git 跟踪的文件** 打包并发布 ZIP 与 SHA-256 校验文件。只对版本 Tag 创建正式 Release；手动工作流仅上传构建 Artifact。不将本机 dataDir、node_modules、凭据或未跟踪文件打包。

GitHub Release 及工作流成功状态须实际核对；推送 Tag 不代表构建已经成功。

MIT License，见 [LICENSE](LICENSE)。
