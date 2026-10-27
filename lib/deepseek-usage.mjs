// lib/deepseek-usage.mjs — DeepSeek 官方开放平台用量（消费明细）
//
// 为什么不能用 API Key：
//   余额能用 API Key（GET api.deepseek.com/user/balance），但**用量没有公开接口**。
//   平台网页端自己在用的内部接口是这两个（2026-10 实测可用）：
//     GET /api/v0/usage/amount?month=<1-12>&year=<YYYY>   按月，token 数
//     GET /api/v0/usage/cost?month=<1-12>&year=<YYYY>     按月，人民币金额
//     GET /api/v0/users/get_user_summary                  余额 + 可用 token 估算
//   鉴权走**网页登录令牌**（登录后平台下发、存在 localStorage.userToken），
//   跟 API Key 是两套东西，互不通用。贴 API Key 会稳定拿到 40003——
//   所以这里专门把这种情况识别出来并说清楚，别让人反复试。
//
// 另外实测过的坑（都写进代码里了）：
//   · 新版 /usage/by_api_key/amount?start=&end=&tz= 目前对该账号返回
//     biz_code 1 INVALID_PARAM，用不了；老版 month/year 反而正常。
//   · 只带 Authorization 裸请求会被 WAF 挡成 429「Request Blocked」，
//     必须装成浏览器（Origin / Referer / Accept-Language / UA）。
//   · 响应里的 usage 是 [{type, amount}] 数组：amount 接口给 token 数，
//     cost 接口给**该类型对应的钱**（所以按类型累加就是当天该模型的总花费）。
//
// 这是未公开契约：字段名、端点都可能变。所以一旦形状对不上就如实报
// 「返回结构变了」，不拿半截数据拼一个看着合理的数字。
import fs from "node:fs";
import path from "node:path";

export const DEEPSEEK_PLATFORM_ORIGIN = "https://platform.deepseek.com";
export const CONFIG_FILE = "deepseek-platform.json";
const AMOUNT_PATH = "/api/v0/usage/amount";
const COST_PATH = "/api/v0/usage/cost";
const SUMMARY_PATH = "/api/v0/users/get_user_summary";
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 少一样都可能被 WAF 挡成 429，所以统一从这里取。 */
const BROWSER_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Origin: DEEPSEEK_PLATFORM_ORIGIN,
  Referer: `${DEEPSEEK_PLATFORM_ORIGIN}/usage`,
  "x-client-platform": "web",
  "User-Agent": UA,
};

const TYPES = {
  hit: "PROMPT_CACHE_HIT_TOKEN",
  miss: "PROMPT_CACHE_MISS_TOKEN",
  output: "RESPONSE_TOKEN",
  request: "REQUEST",
  prompt: "PROMPT_TOKEN",
};

/**
 * 清洗令牌输入。
 * 最容易犯的错是把 API Key 贴进来（sk- 开头）——那不是这套接口的凭证，
 * 与其让它去撞 40003，不如当场说清楚。
 */
export function parsePlatformToken(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return { ok: false, code: "EMPTY", message: "没有提供令牌" };
  const token = raw.replace(/^authorization\s*:\s*/i, "").replace(/^bearer\s+/i, "").trim();
  if (!token) return { ok: false, code: "EMPTY", message: "没有提供令牌" };
  if (/^sk-/i.test(token)) {
    return {
      ok: false,
      code: "API_KEY_NOT_TOKEN",
      message:
        "这看起来是 API Key（sk- 开头）。用量接口不吃 API Key：余额用 API Key，用量要网页登录令牌。登录 platform.deepseek.com 后从浏览器 local storage 取 userToken。",
    };
  }
  if (token.length < 16) {
    return { ok: false, code: "TOO_SHORT", message: "令牌太短，可能复制不全" };
  }
  return { ok: true, token };
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 平台月度接口按年/月，不按时间戳；所以区间只能以「月」为单位。 */
export function buildMonths(range = "month", now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  const back = (n) => {
    let yy = y;
    let mm = m - n;
    while (mm <= 0) {
      mm += 12;
      yy -= 1;
    }
    return { year: yy, month: mm };
  };
  if (range === "last") return [back(1)];
  if (range === "q3") return [back(2), back(1), { year: y, month: m }];
  return [{ year: y, month: m }];
}

export function monthKey({ year, month }) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * 单个自然月归一化。
 *
 * 真实形状（2026-10 抓的）：
 *   amount: data.biz_data = { total:[{model, usage:[{type,amount}]}],
 *                             days:[{date:"2026-10-21", data:[{model, usage:[…]}]}] }
 *   cost:   data.biz_data = [ { currency:"CNY", total:[…], days:[…] } ]
 * usage 的 amount：amount 接口是 token 数，cost 接口是该类型对应的钱。
 */
export function normalizeMonth(amountBody, costBody, { year, month } = {}) {
  const amountBiz = amountBody?.data?.biz_data;
  const costRoot = costBody?.data?.biz_data;
  const costBiz = Array.isArray(costRoot) ? costRoot[0] : null;

  const amountOk = amountBiz && Array.isArray(amountBiz.days);
  const costOk = costBiz && Array.isArray(costBiz.days);
  if (!amountOk || !costOk) {
    return {
      connected: false,
      reason: "shape_changed",
      message: "平台返回结构变了（找不到 days），无法解析。需要按新结构改一次解析。",
      rawKeys: {
        amount: amountBiz ? Object.keys(amountBiz) : null,
        cost: Array.isArray(costRoot) ? { arrayLen: costRoot.length } : costRoot ? Object.keys(costRoot) : null,
      },
    };
  }

  const usageMap = (row) => {
    const out = {};
    for (const u of Array.isArray(row?.usage) ? row.usage : []) {
      if (!u?.type) continue;
      out[u.type] = toNum(u.amount);
    }
    return out;
  };

  const days = new Map(); // date -> { day, cost, tokens, byModel: Map(model -> {tokens,cost}) }
  const models = new Map(); // model -> counters
  const bumpModel = (model) => {
    if (!models.has(model)) {
      models.set(model, { model, cost: 0, hit: 0, miss: 0, output: 0, requests: 0, days: new Set() });
    }
    return models.get(model);
  };
  const bumpDay = (day) => {
    if (!days.has(day)) days.set(day, { day, cost: 0, tokens: 0, byModel: new Map() });
    return days.get(day);
  };

  for (const entry of amountBiz.days) {
    const day = typeof entry?.date === "string" ? entry.date : "";
    if (!day) continue;
    for (const row of Array.isArray(entry.data) ? entry.data : []) {
      const model = row?.model || "(未知模型)";
      const u = usageMap(row);
      const hit = u[TYPES.hit] || 0;
      const miss = u[TYPES.miss] || 0;
      const output = u[TYPES.output] || 0;
      const requests = u[TYPES.request] || 0;
      const tokens = hit + miss + output;
      if (tokens === 0 && requests === 0) continue; // 平台上会把没用过的模型也列出来，全是 0
      const m = bumpModel(model);
      m.hit += hit;
      m.miss += miss;
      m.output += output;
      m.requests += requests;
      m.days.add(day);
      const d = bumpDay(day);
      d.tokens += tokens;
      const dm = d.byModel.get(model) || { tokens: 0, cost: 0 };
      dm.tokens += tokens;
      d.byModel.set(model, dm);
    }
  }

  for (const entry of costBiz.days) {
    const day = typeof entry?.date === "string" ? entry.date : "";
    if (!day) continue;
    for (const row of Array.isArray(entry.data) ? entry.data : []) {
      const model = row?.model || "(未知模型)";
      const u = usageMap(row);
      // 按类型累加就是钱；REQUEST 在 cost 接口里恒为 0，排除掉更保险。
      // 若哪天平台只给合计的 PROMPT_TOKEN（命中+未命中混在一起），就用它兜底，避免重复计。
      const split = (u[TYPES.hit] || 0) + (u[TYPES.miss] || 0) + (u[TYPES.output] || 0);
      const cost = split > 0 ? split : u[TYPES.prompt] || 0;
      if (cost === 0) continue;
      const m = bumpModel(model);
      m.cost += cost;
      m.days.add(day);
      const d = bumpDay(day);
      d.cost += cost;
      const dm = d.byModel.get(model) || { tokens: 0, cost: 0 };
      dm.cost += cost;
      d.byModel.set(model, dm);
    }
  }

  const totalCost = [...models.values()].reduce((a, m) => a + m.cost, 0);
  const hit = [...models.values()].reduce((a, m) => a + m.hit, 0);
  const miss = [...models.values()].reduce((a, m) => a + m.miss, 0);
  const output = [...models.values()].reduce((a, m) => a + m.output, 0);
  const requests = [...models.values()].reduce((a, m) => a + m.requests, 0);

  const modelRows = [...models.values()]
    .map((m) => ({
      model: m.model,
      cost: Number(m.cost.toFixed(4)),
      // 未舍入的原始值：多月合并时要用它再累加，否则先舍入后相加会漂出几分钱
      costRaw: m.cost,
      costDisplay: `¥${m.cost.toFixed(2)}`,
      hitTokens: m.hit,
      missTokens: m.miss,
      outputTokens: m.output,
      tokens: m.hit + m.miss + m.output,
      requests: m.requests,
      hitRate: m.hit + m.miss > 0 ? m.hit / (m.hit + m.miss) : null,
      days: m.days.size,
      share: totalCost > 0 ? m.cost / totalCost : 0,
    }))
    .filter((m) => m.tokens > 0 || m.cost > 0 || m.requests > 0)
    .sort((a, b) => b.cost - a.cost);

  const dayRows = [...days.values()]
    .map((d) => ({
      day: d.day,
      cost: Number(d.cost.toFixed(4)),
      costRaw: d.cost,
      costDisplay: `¥${d.cost.toFixed(2)}`,
      tokens: d.tokens,
      byModel: Object.fromEntries(
        [...d.byModel.entries()].map(([k, v]) => [k, { tokens: v.tokens, cost: Number(v.cost.toFixed(4)) }])
      ),
    }))
    .filter((d) => d.cost > 0 || d.tokens > 0)
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    connected: true,
    month: year && month ? monthKey({ year, month }) : null,
    currency: costBiz.currency || "CNY",
    totalCost: Number(totalCost.toFixed(4)),
    hitTokens: hit,
    missTokens: miss,
    outputTokens: output,
    tokens: hit + miss + output,
    requests,
    hitRate: hit + miss > 0 ? hit / (hit + miss) : null,
    models: modelRows,
    days: dayRows,
  };
}

/** 多个月合并成一个视图：天按日期串起来，模型按名字累加。 */
export function mergeMonths(parts) {
  const ok = parts.filter((p) => p?.connected);
  if (!ok.length) return ok[0] || { connected: false, reason: "no_data", message: "没有可合并的月份数据" };

  const daysByKey = new Map();
  const models = new Map();

  for (const part of ok) {
    for (const d of part.days) {
      const cur = daysByKey.get(d.day) || { day: d.day, cost: 0, tokens: 0, byModel: {} };
      cur.cost += d.costRaw ?? d.cost;
      cur.tokens += d.tokens;
      for (const [model, v] of Object.entries(d.byModel || {})) {
        const cell = cur.byModel[model] || { tokens: 0, cost: 0 };
        cell.tokens += v.tokens;
        cell.cost += v.cost;
        cur.byModel[model] = cell;
      }
      daysByKey.set(d.day, cur);
    }
    for (const m of part.models) {
      const cur = models.get(m.model) || {
        model: m.model,
        cost: 0,
        hitTokens: 0,
        missTokens: 0,
        outputTokens: 0,
        tokens: 0,
        requests: 0,
        days: 0,
      };
      cur.cost += m.costRaw ?? m.cost;
      cur.hitTokens += m.hitTokens;
      cur.missTokens += m.missTokens;
      cur.outputTokens += m.outputTokens;
      cur.tokens += m.tokens;
      cur.requests += m.requests;
      cur.days += m.days;
      models.set(m.model, cur);
    }
  }

  const totalCost = [...models.values()].reduce((a, m) => a + m.cost, 0);
  const modelRows = [...models.values()]
    .map((m) => ({
      ...m,
      cost: Number(m.cost.toFixed(4)),
      costDisplay: `¥${m.cost.toFixed(2)}`,
      hitRate: m.hitTokens + m.missTokens > 0 ? m.hitTokens / (m.hitTokens + m.missTokens) : null,
      share: totalCost > 0 ? m.cost / totalCost : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  const days = [...daysByKey.values()]
    .map((d) => ({ ...d, cost: Number(d.cost.toFixed(4)), costDisplay: `¥${d.cost.toFixed(2)}` }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const hit = modelRows.reduce((a, m) => a + m.hitTokens, 0);
  const miss = modelRows.reduce((a, m) => a + m.missTokens, 0);
  const output = modelRows.reduce((a, m) => a + m.outputTokens, 0);

  return {
    connected: true,
    months: ok.map((p) => p.month).filter(Boolean),
    currency: ok[0].currency || "CNY",
    totalCost: Number(totalCost.toFixed(4)),
    totalCostDisplay: `¥${totalCost.toFixed(2)}`,
    hitTokens: hit,
    missTokens: miss,
    outputTokens: output,
    tokens: hit + miss + output,
    requests: modelRows.reduce((a, m) => a + m.requests, 0),
    hitRate: hit + miss > 0 ? hit / (hit + miss) : null,
    models: modelRows,
    days,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** 平台返回的业务错误码 → 人话。 */
function describeBizError(body, status) {
  const biz = body?.data?.biz_code;
  const bizMsg = body?.data?.biz_msg;
  if (body?.code === 40003) {
    return {
      reason: "unauthorized",
      message: "令牌无效或已过期。重新登录 platform.deepseek.com，再取一次 userToken 贴进来。",
    };
  }
  if (body?.code === 40002) {
    return { reason: "unauthorized", message: "平台说没收到令牌（Missing Token）——多半是复制时丢了前半段。" };
  }
  if (biz !== undefined && biz !== 0) {
    return { reason: "biz_error", message: `平台业务错误（biz_code ${biz}${bizMsg ? " " + bizMsg : ""}）` };
  }
  if (status === 429) {
    return { reason: "blocked", message: "平台把这个请求当异常流量挡了（429）。稍后再试，或检查令牌是否还有效。" };
  }
  return { reason: `http_${status}`, message: `平台返回异常（HTTP ${status}）` };
}

export class DeepSeekUsageService {
  constructor({
    dataDir = "",
    fetchFn = globalThis.fetch,
    network = null,
    ttlMs = CACHE_TTL_MS,
    origin = DEEPSEEK_PLATFORM_ORIGIN,
    log = null,
  } = {}) {
    this.dataDir = dataDir;
    // 出网走宿主 network 桥：App 主进程里的 globalThis.fetch 在沙箱里会被挡
    this.network = network;
    this.fetchFn = fetchFn;
    this.ttlMs = ttlMs;
    this.origin = origin;
    this.log = log;
    this.cache = new Map();
    this.summaryCache = null;
    this.inFlight = new Map();
  }

  get configPath() {
    return this.dataDir ? path.join(this.dataDir, CONFIG_FILE) : "";
  }

  loadConfig() {
    const raw = this.configPath ? readJson(this.configPath) : null;
    if (!raw || typeof raw.token !== "string") return null;
    const parsed = parsePlatformToken(raw.token);
    if (!parsed.ok) return null;
    return { token: parsed.token, savedAt: raw.savedAt || null };
  }

  /** 存令牌：只落本机 dataDir，0600（里面是登录态）。 */
  saveToken(input) {
    const parsed = parsePlatformToken(input);
    if (!parsed.ok) return parsed;
    if (!this.dataDir) return { ok: false, code: "NO_DATA_DIR", message: "没有数据目录，存不了" };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const payload = { token: parsed.token, savedAt: new Date().toISOString() };
      fs.writeFileSync(this.configPath, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
      this.cache.clear();
      this.summaryCache = null;
      return { ok: true, configured: true, savedAt: payload.savedAt };
    } catch (e) {
      return { ok: false, code: "SAVE_FAILED", message: e.message };
    }
  }

  clearToken() {
    try {
      if (this.configPath && fs.existsSync(this.configPath)) fs.unlinkSync(this.configPath);
    } catch (e) {
      return { ok: false, code: "CLEAR_FAILED", message: e.message };
    }
    this.cache.clear();
    this.summaryCache = null;
    return { ok: true, configured: false };
  }

  configured() {
    return !!this.loadConfig();
  }

  async request(pathname, token) {
    const doFetch = this.network?.fetch ? (u, init) => this.network.fetch(u, init) : this.fetchFn;
    const res = await doFetch(this.origin + pathname, {
      method: "GET",
      headers: { ...BROWSER_HEADERS, Authorization: `Bearer ${token}` },
      signal:
        typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: Number(res.status) || 0, ok: Number(res.status) >= 200 && Number(res.status) < 300, body };
  }

  /** 用户概览：顺便当令牌验活（拿得到就说明令牌还有效），缓存 5 分钟。 */
  async getSummary({ force = false } = {}) {
    const conf = this.loadConfig();
    if (!conf) return { connected: false, reason: "not_configured", message: "未配置平台令牌" };
    const now = Date.now();
    if (!force && this.summaryCache && now - this.summaryCache.at < 5 * 60_000) return this.summaryCache.value;

    let value;
    try {
      const res = await this.request(SUMMARY_PATH, conf.token);
      const biz = res.body?.data?.biz_data;
      if (res.ok && res.body?.data?.biz_code === 0 && biz) {
        const wallet = Array.isArray(biz.normal_wallets) ? biz.normal_wallets[0] : null;
        const bonus = Array.isArray(biz.bonus_wallets) ? biz.bonus_wallets[0] : null;
        const balance = wallet?.balance != null ? Number(wallet.balance) : null;
        value = {
          connected: true,
          currency: wallet?.currency || "CNY",
          balance,
          // 平台给的是 "14.9641625400000000"，显示成 ¥14.96
          balanceDisplay: Number.isFinite(balance) ? `¥${balance.toFixed(2)}` : null,
          bonusBalance: bonus?.balance != null ? Number(bonus.balance) : null,
          // 这就是「还能用多少 token」的官方估算；为 0 时平台自己也显示 0，不编。
          tokenEstimation: wallet?.token_estimation != null ? toNum(wallet.token_estimation) : null,
          totalCosts: Array.isArray(biz.total_costs)
            ? biz.total_costs.map((t) => ({ currency: t.currency, amount: t.amount != null ? Number(t.amount) : null }))
            : null,
        };
      } else {
        value = { connected: false, ...describeBizError(res.body, res.status) };
      }
    } catch (e) {
      value = { connected: false, reason: "network_error", message: `连不上平台：${e?.cause?.code || e?.message || e}` };
    }
    this.summaryCache = { at: now, value };
    return value;
  }

  /**
   * 区间用量。平台只有「按月」的接口，所以区间就是若干个月份相加。
   * 任一月失败就整体失败——只给一部分月份，看着像成功其实是残的。
   */
  async getUsage({ range = "month", now = new Date(), force = false } = {}) {
    const conf = this.loadConfig();
    if (!conf) return { connected: false, reason: "not_configured", message: "未配置平台令牌" };

    const months = buildMonths(range, now);
    const key = `${range}:${months.map(monthKey).join(",")}`;
    const at = Date.now();
    const hit = this.cache.get(key);
    if (!force && hit && at - hit.at < this.ttlMs) return hit.value;
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const task = (async () => {
      try {
        const parts = [];
        for (const m of months) {
          const qs = `?month=${m.month}&year=${m.year}`;
          const [amountRes, costRes] = await Promise.all([
            this.request(AMOUNT_PATH + qs, conf.token),
            this.request(COST_PATH + qs, conf.token),
          ]);
          const bad = [amountRes, costRes].find(
            (r) => !r.ok || r.body?.data?.biz_code !== 0 || r.body?.code !== 0
          );
          if (bad) {
            const value = { connected: false, ...describeBizError(bad.body, bad.status) };
            this.cache.set(key, { at, value });
            return value;
          }
          const normalized = normalizeMonth(amountRes.body, costRes.body, m);
          if (!normalized.connected) {
            this.cache.set(key, { at, value: normalized });
            return normalized;
          }
          parts.push(normalized);
        }
        const merged = mergeMonths(parts);
        const value = { ...merged, range, months: parts.map((p) => p.month), updatedAt: Date.now() };
        this.cache.set(key, { at, value });
        return value;
      } catch (e) {
        return {
          connected: false,
          reason: "network_error",
          message: `连不上 platform.deepseek.com：${e?.cause?.code || e?.message || e}`,
        };
      }
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, task);
    return task;
  }
}
