<div align="center">

# HanaAgent Token Tracker

<p align="center">
  <b>面向 HanaAgent (v2 App) 的官方口径 Token 消耗审计、多模型成本分析、余额监控与用量仪表盘</b>
</p>

[![HanaAgent App](https://img.shields.io/badge/HanaAgent-v2_App-000000?style=flat-square&logo=probot&logoColor=white)](https://github.com/liliMozi/openhanako)
[![JavaScript](https://img.shields.io/badge/Language-JavaScript-000000?style=flat-square&logo=javascript&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/License-MIT-000000?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-Passing-000000?style=flat-square)](test/)
[![Architecture](https://img.shields.io/badge/Architecture-manifestVersion_2-000000?style=flat-square)](manifest.json)

</div>

---

## 简介

**HanaAgent Token Tracker** 是专为 [HanaAgent (OpenHanako)](https://github.com/liliMozi/openhanako) 设计的官方标准 **v2 App**。

提供全方位的 Token 消耗统计、各模型与 Agent 维度成本分析、提示词缓存（Prompt Cache）命中率追踪、多模态任务生成统计及第三方 API 余额监控。基于标准 `@hana/app-sdk/server` 构建，告别私自扫盘与脆弱路径猜测，以合规、轻量、高确定的方式还原每一笔 Token 消耗明细。

---

## 核心特性

### 1. 全面对齐 Hana v2 App 架构规范
- **官方标准规范**：声明 `manifestVersion: 2`，入口采用 `defineApp(async (sdk) => ...)`，使用官方标准 SDK 域方法（`sdk.usage`、`sdk.agents`、`sdk.routes` 等）；
- **全屏工作台沉浸体验**：通过 `contributes.cards` 注册带 `realization: "page"` 与 `siteNavEntry: true` 的常驻大页面仪表盘，完美融入 Hana 侧边栏导航；
- **优雅拒权降级**：未获得 `app/usage.read` 等权限时，返回结构化可解释错误与友好界面提示，绝不发生未捕获崩溃或白屏。

### 2. 多维度 Token 用量深度下钻
- **灵活的时间区间**：按日、周、月、年或自定义日历日期范围精准统计；
- **消耗来源七分类**：支持将用量精细归属至 **聊天、频道、Bridge、后台任务、子代理（Subagent）、系统账本及媒体任务**；
- **Token 构成全景明细**：拆分输入（Input）、输出（Output）、思维链推理（Reasoning）、提示词缓存读取（Cache Read）与缓存写入（Cache Write）；
- **可视化图表**：日/小时粒度消耗趋势图、模型消耗占比饼图、各 Agent 消耗对比柱状图。

### 3. Prompt Cache（提示词缓存）命中率诊断
- 针对模型的缓存机制提供按 Agent 与模型维度的命中率环形图与对比分析；
- 趋势图叠加缓存命中率折线，快速定位前缀被击穿（Cache Miss）的时段与调用方，辅助提示词工程调优。

### 4. 主流供应商余额与配额监控
- **DeepSeek**：官方 API 余额实时查询与货币明细展示；
- **火山方舟（Volcengine Ark）**：Coding Plan 三窗口（5小时 / 周 / 月）配额进度条与重置倒计时追踪；
- **OpenCode Go**：官方账单口径对账、多 Key 消耗聚合与模型月额度跟踪。

### 5. 灵活的多计费模型与双币种支持
- **多种计费模式**：支持 `token`（每百万 Token 计费）、`per_call`（单次调用计费，适用于生图/视频模型）、`per_char`（字符计费，适用于语音 TTS 模型）；
- **进阶定价规则**：支持设置长上下文分档阶梯价（如 >256K / >272K）及高峰/低谷时段费率；
- **实时双币种换算**：支持美元（USD）与人民币（CNY）一键切换，汇率自动同步。

### 6. 严谨的测试与代码质量保障
- 内置基于 Node.js 原生测试运行器的完整测试套件（`npm test`）；
- 覆盖生命周期绑定、Manifest V2 合规性审计、路由脱敏与拒权可解释性校验。

---

## 目录结构

```
token-tracker/
├── index.js              # v2 App 主入口：生命周期与官方 SDK 域接口绑定
├── manifest.json         # v2 App 元数据契约 (manifestVersion: 2, capabilities)
├── server/               # 后端 HTTP 路由与数据聚合层
│   └── dashboard.js      # 用量账本聚合、价格估算、余额查询与脱敏路由
├── ui/                   # 前端单页应用 (SPA Dashboard)
│   ├── index.html        # 仪表盘主页面模板 (Card page realization)
│   ├── dashboard-app.js  # 前端渲染控制器、图表联动与状态管理
│   ├── base.css          # 布局骨架与核心组件样式
│   ├── theme.css         # 暖纸 / 青夜主题色板规范
│   └── vendor/           # Chart.js 本地离线依赖库
├── sdk/                  # Hana v2 官方 App SDK 契约垫片与类型定义
├── test/                 # 自动化单元测试套件
│   ├── lifecycle-and-ledger.test.js  # 生命周期与账本聚合测试
│   ├── manifest.test.js              # Manifest 合规性与权限最小化测试
│   └── routes-security.test.js       # 路由脱敏与拒权状态码校验
└── assets/               # 静态图标与预览图片
```

---

## 安装与快速上手

### 方式一：在 HanaAgent 中一键安装（推荐）

1. 将仓库克隆至本地任意目录：
   ```bash
   git clone https://github.com/TheEarlyWinter/token-tracker.git
   ```
2. 在 HanaAgent 对话框中发送：
   > 帮我安装本地路径为 `/path/to/token-tracker` 的应用
3. 界面将弹出「Token 用量 (v6.3.0)」的安装授权卡片，点击【确认】；
4. 安装完成后，左侧导航栏将直接出现「Token 用量」页面入口，点击即可打开完整仪表盘。

### 方式二：手动安装到 Hana 应用目录

1. 克隆至 HanaAgent 的 App 目录：
   ```bash
   git clone https://github.com/TheEarlyWinter/token-tracker.git ~/.hanako/apps/token-tracker
   ```
2. 打开 HanaAgent，进入 设置 → 扩展管理 → App 分类；
3. 在待批准列表中找到 Token 用量，点击批准并授予必要权限。

---

## 权限声明与安全说明 (Capabilities)

本应用遵循权限最小化原则，声明并请求以下运行能力：

| 权限标识 | 用途说明 | 必要性 |
| :--- | :--- | :---: |
| `app/usage.read` | 读取系统底层官方模型用量账本数据 | 必需 |
| `app/agents.read` | 读取当前活跃 Agent 清单以完成用量归属映射 | 必需 |
| `app/sessions.read` | 读取关联会话元数据以展示会话类型与明细 | 必需 |
| `app/provider.credentials.read` | 读取已配置的供应商凭据以查询余额/配额（仅内存查询，绝不外发） | 可选 |
| `app/media.tasks.read` | 读取图片/视频等多模态生成任务明细 | 可选 |

> **数据安全承诺**：所有数据均在本地聚合处理，API 密钥仅用于向对应官方 API 发起只读余额查询，绝不会上传至任何第三方服务器。

---

## 测试与校验

在提交代码前，可通过以下命令运行完整的质量验证：

```bash
# 运行完整自动化测试套件 (Node.js test runner)
npm test

# 运行 Hana App 官方规范静态审计工具
node ~/.hanako/skills/hana-app-creator/scripts/validate_app.mjs --dir . --json
```

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源发布。
