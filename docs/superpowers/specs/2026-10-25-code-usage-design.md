# Code 模式用量统计设计

## 目标与成功标准

在 Token Tracker 中独立展示 Hana Code 模式的 Token 用量。包含 Code 主代理及其子代理。聊天、频道和其他来源继续正常统计。只重新分类，不新增重复请求，不改变相同账本的总 Token、调用次数和费用。

用户已批准 App-only 最小方案及子代理执行方式。历史会话无法查询时允许保留原有分类，但必须明确提示分类不完整。只读调查已确认当前宿主 session:get 返回 namespace，App 已具有 app/sessions.read。该字段尚未明确承诺为长期稳定 SDK 契约，缺失或拒权时必须降级，不猜测类别。

## 方案取舍

选择官方 sessions.get({sessionId, scope:"all"}) 关联父会话的 namespace。子代理沿用原账本 attribution.sessionId 的父会话归属。相比修改 Hana 账本，无须变更宿主；相比直接扫描 JSONL 或私有数据库，保留权限与隐私边界。

实现沿用现有 type 筛选与统计管线，新增互斥来源 code。一个 Code 父会话下的主请求和子代理请求均 type=code，每个 requestId 只保留一条记录。保存原类型 baseType 供内部追溯。不开辟第二套 namespace 筛选或 SQLite 列，避免扩大改造。非 Code 的现有分类规则不变。

## 数据与接口契约

- 原始 Token 数值、成功过滤、费用口径、requestId 去重不变。
- 由父 sessionId 的官方 namespace=code 识别 Code。不得靠模型名、Agent 名、路径或正文猜测。
- 归档是唯一请求记录源。分类映射独立持久化，或作为现有聚合缓存元数据持久化。历史重新分类不追加请求副本，不篡改原始 Token。
- 聚合 cache、SQLite turns、CSV、日/小时趋势、热力矩阵、来源图层、Agent/模型/provider 筛选必须一致。
- /data 增加 summary.totalCode、agents[].codeTotal、daily[].code、daily30[].code、hourly[].code；type=code 是已有筛选参数的新取值；visualAnalytics 来源增加 code。
- /data 增加 sourceClassification:{status:"complete"|"partial"|"unavailable", unresolvedSessionCount:number}。完整性按归档中可归属 sessionId 的请求会话集合计算，不能仅凭最近账本窗口宣称历史完整。不可分类项仍计入总量和原类别，不归为 Code。
- 只使用 namespace 字段。不得持久化 session:get 返回的正文、标题、路径、凭据或 firstMessage。日志和文档不含敏感信息。

## 资源约束

官方 session:get 每次可能生成完整会话投影，因此查询必须节流。每次扫描最多尝试 8 个未知会话、全局最多 2 个在途查询，每个等待最多 2000ms。超时的底层请求在真正结束前仍占在途名额，禁止用 Promise.race 制造无限悬挂请求。失败会话至少 5 分钟后再试；成功映射重启可复用。优先新账本中的最近未知会话，同时为历史回填保留至少 1 个名额，避免历史饥饿。分类失败不得使账本同步失败。无新增 npm 依赖。

## 恢复协议

聚合sessions journal与代次meta分别落盘。scan在相关来源分类、聚合和代次变更前，先在现有meta持久写aggregateWritePending=true；中间写入保留true，最后才清除。重启遇到pending，必须从原始归档重建聚合与SQLite，不信任旧代次。SQLite以turnsGeneration/data_generation校验；索引未就绪时明细与CSV走聚合回退。

实时archiveUsage只追加原始请求，不改变聚合journal、代次或SQLite。该纯追加路径沿用archiveCoverageMismatch数量覆盖核对；有效桶新增唯一请求会触发重启重建。不要求为该路径另加聚合屏障。主代理已实测“追加后立即重启”，旧聚合与旧SQLite保持同一快照，随后空scan恢复且不重复。

分类只确认引擎返回的已持久化sourceAckSessionIds，并在scan与snapshot都成功后ack；未确认映射保留待提交。候选窗口与pending上限均256，RPC失败不能当作全部未知绕过持久缓存。冷却镜像同样必须检查五分钟TTL。

## 界面与交付

保留既有样式，增加 Code 选项、总览来源数据和图表标签；有未识别历史时显示短句提示。不重做布局。以本机正式导出的 6.8.0 完整源码副本为基线；原安装目录只读。开发版本为 6.9.0，版本入口与 manifest/package 保持一致。不推送、不发 Release。测试和审查通过后，只通过扩展管理器发起本机更新，用户确认后再验运行时。

## 非目标

不修改 Hana 本体，不直读会话正文或私有数据库，不重做计费口径，不顺带修频道/bridge 分类，不新增外部服务，不自动上线，不删除现有数据或清理工作目录。
