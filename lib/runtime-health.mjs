// Fixed component and reason allowlists: never retain raw errors or session identities.
const COMPONENTS = { scanner: '扫描服务', ledger: '官方账本', firstResponse: '首响 Hook', speed: '速度 Hook', capsule: '胶囊发布' };
const REASONS = {
  unknown: ['尚未取得检查结果。', '等待下一次检查。'],
  checking: ['正在检查。', '等待本次任务完成。'],
  scan_ok: ['最近一次扫描成功。', ''],
  ledger_ok: ['官方账本读取成功。', ''],
  hook_ok: ['Hook 注册已得到确认。', ''],
  publish_ok: ['最近一次胶囊发布成功。', ''],
  permission_denied: ['读取或发布被权限拒绝。', '请在平台正式授权入口检查对应插件权限。'],
  activation_required: ['目标 Agent 的插件启用或输入栏授权条件未满足。', '请检查该 Agent 是否启用插件及输入栏权限；宿主未区分这两种原因。'],
  agent_disabled: ['该 Agent 尚未启用插件，无法显示输入栏指标。', '请在该 Agent 的插件设置中启用 Token 用量。'],
  unavailable: ['宿主未提供所需能力。', '请检查宿主版本与插件权限。'],
  rate_limited: ['本次请求被限流（429）。', '稍后完成一次请求后更新。'],
  provider_error: ['本次请求遇到供应商服务错误。', '稍后重试，并检查供应商服务状态。'],
  timeout: ['本次请求或任务超时。', '检查服务状态，稍后重试。'],
  incomplete: ['当前任务已结束，但未取得完整请求计量结果。', '完成下一次请求后更新。'],
  cancelled: ['本次请求已取消。', '完成下一次请求后更新。'],
  request_failed: ['本次请求失败。', '检查服务状态与相关授权后重试。'],
  invalid_data: ['缺少有效计量数据或返回数据无效。', '完成一次符合计量条件的请求后更新。'],
  pending: ['当前请求尚未完成。', '等待本次请求完成。'],
  no_sample: ['尚无有效样本。', '完成一次符合计量条件的请求后更新。'],
};
export function classifyError(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = error?.status ?? error?.statusCode ?? error?.cause?.status;
  // Text is inspected only for classification, never retained or exported.
  const text = String(error?.message || error?.error || '').toLowerCase();
  if (/needs app\/input.status and activation in the target agent/.test(text)) return 'activation_required';
  if (['APP_NOT_ENABLED_FOR_AGENT', 'AGENT_APP_DISABLED', 'APP_NOT_ENABLED'].includes(code)) return 'agent_disabled';
  if (status === 401 || status === 403 || /PERMISSION|FORBIDDEN|UNAUTHORIZED|DENIED/.test(code) || error?.kind === 'permission' || /permission denied|forbidden|unauthorized|未获授权|权限拒绝/.test(text)) return 'permission_denied';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  if (/TIMEOUT|TIMEDOUT/.test(code) || error?.name === 'TimeoutError') return 'timeout';
  if (/ABORT|CANCEL/.test(code) || error?.name === 'AbortError') return 'cancelled';
  if (/UNAVAILABLE|UNSUPPORTED/.test(code)) return 'unavailable';
  if (/INVALID_RESPONSE|INVALID_DATA/.test(code)) return 'invalid_data';
  return 'request_failed';
}
export function metricReason(code = 'no_sample') {
  if (code === 'pending') return '当前请求尚未完成，暂不能计算本次指标。';
  if (code === 'invalid_data') return '缺少输出 token 或有效请求时长，无法计算速度。';
  if (code === 'no_sample') return '尚无有效样本，完成一次符合计量条件的请求后更新。';
  if (code === 'permission_denied' || code === 'unavailable') return '计量能力不可用，请查看运行状态。';
  return (REASONS[code]?.[0] || REASONS.request_failed[0]) + '不使用旧值代替本次结果。';
}
export class RuntimeHealth {
  constructor({ version = '未知', clock = Date.now } = {}) {
    this.clock = clock;
    this.version = /^\d+\.\d+\.\d+$/.test(version) ? version : '未知';
    this.components = new Map(Object.entries(COMPONENTS).map(([id, label]) => [id, { id, label, state: 'unknown', code: 'unknown', at: null }]));
    this.metrics = { speed: 'no_sample', firstResponse: 'no_sample' };
    this.speedSource = '未知';
  }
  set(id, state, code) {
    if (!this.components.has(id)) return;
    this.components.set(id, { id, label: COMPONENTS[id], state: ['ok', 'degraded', 'unknown'].includes(state) ? state : 'unknown', code: Object.hasOwn(REASONS, code) ? code : 'unknown', at: new Date(this.clock()).toISOString() });
  }
  metric(id, code, source = null) {
    if (id === "speed" && source) this.speedSource = ({ "request-duration": "实时请求计量", "ledger-duration": "有效账本时长回退" })[source] || "未知";
    if (Object.hasOwn(this.metrics, id)) this.metrics[id] = code === 'ok' || Object.hasOwn(REASONS, code) ? code : 'unknown';
  }
  snapshot() {
    return {
      pluginVersion: this.version, hostVersion: '未知',
      components: [...this.components.values()].map(c => ({ ...c, reason: REASONS[c.code][0], suggestion: REASONS[c.code][1] })),
      metrics: Object.fromEntries(Object.entries(this.metrics).map(([id, code]) => [id, { code, reason: code === 'ok' ? '最近一次有效计量成功。' : metricReason(code), ...(id === 'speed' ? { source: this.speedSource } : {}) }])),
    };
  }
  clear() { this.components.clear(); this.metrics = {}; this.speedSource = '未知'; }
}
export function trackerStatus(shared, now = Date.now()) {
  const lastSuccessAt = shared?.lastSuccessAt || (!shared?.data?.usageQueryError ? shared?.data?.lastScan : null) || null;
  const intervalMs = shared?.scanIntervalMs || 60000;
  const scanning = shared?.scanning === true;
  const syncFailed = shared?.syncFailed === true;
  return {
    ...(shared?.health?.snapshot() || new RuntimeHealth().snapshot()),
    freshness: {
      lastAttemptAt: shared?.lastAttemptAt || null, lastSuccessAt, intervalMs, scanning, syncFailed,
      dataAvailable: !!(shared?.ready && shared?.data),
      stale: !!lastSuccessAt && !scanning && now - Date.parse(lastSuccessAt) > intervalMs * 2,
    },
    coverage: '统计来自官方 usage:list 的最近 20,000 条窗口与本地已归档记录；归档仅覆盖插件已采集的记录，不保证完整历史。',
  };
}
