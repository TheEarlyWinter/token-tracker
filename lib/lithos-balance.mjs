// lib/lithos-balance.mjs — LithosAI 控制台预付余额
//
// 为什么不用 API key：
//   Lithos 的公开 API 只有 /v1/models 与 /v1/chat/completions，没有余额端点。
//   实测 /v1/credits、/v1/balance、/v1/usage、/v1/me 全 404。钱只在控制台里：
//     GET https://console.lithosai.cloud/api/me       → 当前用户与活动组织
//     GET https://console.lithosai.cloud/api/billing  → balanceNanos / hasCard / onHold
//   凭证是控制台登录态的两个 cookie（__Host-console_session + __Host-console_csrf），
//   两个必须同时在；请求还要把活动组织 ID 打成 X-Organization-Id、把 csrf 打成
//   X-Console-Csrf 回显。API key 拿不到账单——Lithos 文档原话：
//   "Inference API keys cannot read console billing."
//
// 这是未公开契约。所以：401 就如实报「会话过期，请重新粘贴」，不静默沿用旧数，
// 也不把「查不到」写成 $0.00。金额单位是纳美元（1 USD = 1e9 nanos）。
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../runtime/engine/services/jsonl-log.js";

export const LITHOS_ORIGIN = "https://console.lithosai.cloud";
export const CONFIG_FILE = "lithos-console.json";
const SESSION_COOKIE = "__Host-console_session";
const CSRF_COOKIE = "__Host-console_csrf";
const CACHE_TTL_MS = 60_000;
const SESSION_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * 从一段 Cookie 请求头里取出控制台会话的两个 cookie。
 * 接受整行 `Cookie: a=b; c=d` 或 `a=b; c=d`；多余 cookie 丢掉，只发这两个。
 */
export function parseConsoleCookie(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return { ok: false, code: "EMPTY", message: "没有提供 Cookie" };
  const body = raw.replace(/^cookie\s*:\s*/i, "");
  const map = new Map();
  for (const part of body.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    if (i <= 0) continue;
    const name = p.slice(0, i).trim();
    const value = p.slice(i + 1).trim();
    if (name && value) map.set(name, value);
  }
  const session = map.get(SESSION_COOKIE) || "";
  const csrf = map.get(CSRF_COOKIE) || "";
  const missing = [];
  if (!session) missing.push(SESSION_COOKIE);
  if (!csrf) missing.push(CSRF_COOKIE);
  if (missing.length) {
    return {
      ok: false,
      code: "MISSING_COOKIE",
      message: `缺 ${missing.join(" 和 ")}。两个都要：控制台靠 session 认人、靠 csrf 放行读接口。`,
      missing,
    };
  }
  return { ok: true, cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

/**
 * 纳美元 → 可显示金额。
 * 小于一分钱的非零余额单独说，不四舍五入成 $0.00（那会让人以为钱没了）。
 */
export function formatUsdFromNanos(nanos) {
  const n = Number(nanos);
  if (!Number.isFinite(n)) return { usd: null, display: "—" };
  const usd = n / 1e9;
  if (usd === 0) return { usd: 0, display: "$0.00" };
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  if (abs < 0.01) return { usd, display: `${sign}低于 $0.01` };
  return { usd, display: `${sign}$${abs.toFixed(2)}` };
}

/**
 * 裸值输入：用户往往从 DevTools 里只抢到两串值，没带名字。
 * 名字对不上就只能试：两串就是两个 cookie，但不一定是哪个。
 * 这里只负责把值拆出来，到底是哪种顺序交给 probe 判定（不猜）。
 */
export function looseCookieValues(input) {
  const raw = typeof input === "string" ? input.trim().replace(/^cookie\s*:\s*/i, "") : "";
  if (!raw) return null;
  if (raw.includes("=")) return null; // 带名字的走严格解析
  const parts = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  // 两串长得一样就没法判序，也没必要：那是同一串的两个副本
  if (parts[0] === parts[1]) return null;
  return parts;
}

/**
 * 消费接口的归一化：一条 = (天, 模型, API key) 的用量。
 * 金额单位同样是纳美元。我们把行原样留着（可回溯到哪个 key），另给按天/按模型两种聚合，
 * 前端画图用后者，查账用前者。
 */
export function normalizeSpend(body, { start, end, org = null } = {}) {
  const rows = (Array.isArray(body?.days) ? body.days : [])
    .map((r) => {
      const nanos = Number(r?.nanos) || 0;
      return {
        day: typeof r?.day === "string" ? r.day : "",
        modelId: typeof r?.modelId === "string" ? r.modelId : "unknown",
        apiKeyId: r?.apiKeyId || null,
        nanos,
        usd: nanos / 1e9,
        inputTokens: Number(r?.inputTokens) || 0,
        cachedTokens: Number(r?.cachedTokens) || 0,
        outputTokens: Number(r?.outputTokens) || 0,
      };
    })
    .filter((r) => r.day);

  const totalNanos = rows.reduce((acc, r) => acc + r.nanos, 0);
  const dayMap = new Map();
  const modelMap = new Map();
  const modelDaySet = new Map();

  for (const r of rows) {
    const d = dayMap.get(r.day) || { day: r.day, nanos: 0, usd: 0, byModel: {} };
    d.nanos += r.nanos;
    d.usd = d.nanos / 1e9;
    d.byModel[r.modelId] = (d.byModel[r.modelId] || 0) + r.nanos / 1e9;
    dayMap.set(r.day, d);

    const m = modelMap.get(r.modelId) || {
      modelId: r.modelId,
      nanos: 0,
      usd: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      days: 0,
    };
    m.nanos += r.nanos;
    m.usd = m.nanos / 1e9;
    m.inputTokens += r.inputTokens;
    m.cachedTokens += r.cachedTokens;
    m.outputTokens += r.outputTokens;
    modelMap.set(r.modelId, m);

    const set = modelDaySet.get(r.modelId) || new Set();
    set.add(r.day);
    modelDaySet.set(r.modelId, set);
  }

  for (const [modelId, set] of modelDaySet) {
    const m = modelMap.get(modelId);
    if (m) m.days = set.size; // 同一个模型同一天有多个 key 时只算一天
  }

  const models = [...modelMap.values()]
    .sort((a, b) => b.nanos - a.nanos)
    .map((m) => ({ ...m, share: totalNanos > 0 ? m.nanos / totalNanos : 0 }));

  return {
    provider: "lithos",
    connected: true,
    configured: true,
    currency: "USD",
    start: start || null,
    end: end || null,
    totalNanos,
    totalUsd: totalNanos / 1e9,
    totalDisplay: formatUsdFromNanos(totalNanos).display,
    rows,
    days: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    models,
    organization: org ? { id: org.id || null, name: org.name || null } : null,
    updatedAt: new Date().toISOString(),
  };
}

/** 本月至今（UTC）：控制台的区间按 UTC 算，跟本地时区差一天的地方不要自己拍。 */
export function monthToDateUtc(now = new Date()) {
  const end = now.toISOString().slice(0, 10);
  return { start: end.slice(0, 8) + "01", end };
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export class LithosBalanceService {
  constructor({ dataDir = "", fetchFn = globalThis.fetch, network = null, ttlMs = CACHE_TTL_MS, origin = LITHOS_ORIGIN, log = null } = {}) {
    this.dataDir = dataDir;
    // 出网必须走宿主的 network 桥：App 主进程里的 globalThis.fetch 会被沙箱挡掉，
    // 报的是底层 undici 的 "fetch failed"（DeepSeek 余额卡一直就是这么走的）。
    this.network = network;
    this.fetchFn = fetchFn;
    this.ttlMs = ttlMs;
    this.origin = origin;
    this.log = log;
    this.cache = null; // { at, value } 余额
    this.sessionCache = null; // { at, value } 活动组织（/api/me）
    this.spendCache = new Map(); // `${start}:${end}` -> { at, value, epoch }
    this.inFlight = null;
    this.credentialEpoch = 0;
  }

  invalidate() {
    this.credentialEpoch += 1;
    this.cache = null;
    this.sessionCache = null;
    this.spendCache.clear();
    this.inFlight = null;
  }

  get configPath() {
    return this.dataDir ? path.join(this.dataDir, CONFIG_FILE) : "";
  }

  loadConfig() {
    const raw = this.configPath ? readJson(this.configPath) : null;
    if (!raw || typeof raw.cookie !== "string") return null;
    const parsed = parseConsoleCookie(raw.cookie);
    if (!parsed.ok) return null;
    return { cookie: parsed.cookie, csrf: parsed.csrf, savedAt: raw.savedAt || null };
  }

  /** 存 Cookie：只落本机 dataDir，读写权限 0600（里面是登录态）。 */
  saveCookie(input) {
    const parsed = parseConsoleCookie(input);
    if (!parsed.ok) return parsed;
    if (!this.dataDir) return { ok: false, code: "NO_DATA_DIR", message: "没有数据目录，存不了" };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const payload = { cookie: parsed.cookie, savedAt: new Date().toISOString() };
      writeFileAtomic(this.configPath, JSON.stringify(payload, null, 2), 0o600);
      this.invalidate();
      return { ok: true, configured: true, savedAt: payload.savedAt };
    } catch (e) {
      return { ok: false, code: "SAVE_FAILED", message: e.message };
    }
  }

  clearCookie() {
    try {
      if (this.configPath && fs.existsSync(this.configPath)) fs.unlinkSync(this.configPath);
    } catch (e) {
      return { ok: false, code: "CLEAR_FAILED", message: e.message };
    }
    this.invalidate();
    return { ok: true, configured: false };
  }

  configured() {
    return !!this.loadConfig();
  }

  async request(pathname, { cookie, csrf, orgId = null } = {}) {
    const headers = { cookie, accept: "application/json" };
    if (csrf) headers["x-console-csrf"] = csrf;
    if (orgId) headers["x-organization-id"] = orgId;
    const doFetch = this.network?.fetch ? (u, init) => this.network.fetch(u, init) : this.fetchFn;
    const res = await doFetch(this.origin + pathname, {
      method: "GET",
      headers,
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: Number(res.status) || 0, ok: Number(res.status) >= 200 && Number(res.status) < 300, body };
  }

  /**
   * 两串裸值：按两种顺序各认一次，哪种能登就存哪种。
   * 这是在“实测”而不是“猜”：被拒的那次只会在服务端留一条 401。
   */
  async resolveLooseCookie(values) {
    if (!Array.isArray(values) || values.length !== 2) return { ok: false, code: "BAD_INPUT", message: "需要正好两串值" };
    const [a, b] = values;
    const attempts = [
      { order: "ab", cookie: `${SESSION_COOKIE}=${a}; ${CSRF_COOKIE}=${b}`, csrf: b },
      { order: "ba", cookie: `${SESSION_COOKIE}=${b}; ${CSRF_COOKIE}=${a}`, csrf: a },
    ];
    for (const attempt of attempts) {
      try {
        const res = await this.request("/api/me", attempt);
        if (res.status === 200) {
          return { ok: true, cookie: attempt.cookie, order: attempt.order, resolvedBy: "probe" };
        }
      } catch {
        // 网络问题不该把另一种顺序也否掉，继续试
      }
    }
    return {
      ok: false,
      code: "AUTH_FAILED",
      message: "两种顺序都被拒。Cookie 可能已过期，或者不是 console.lithosai.cloud 这个站点的。",
    };
  }

  /**
   * 活动组织：/api/me 的结果对余额与消费两个视图都要用，缓存 5 分钟。
   * 拿不到就返回 { ok:false, reason, message }，调用方自己决定怎么表达。
   */
  async resolveSession(conf, { force = false, epoch = this.credentialEpoch } = {}) {
    const now = Date.now();
    if (!force && this.sessionCache && this.sessionCache.epoch === epoch && now - this.sessionCache.at < SESSION_TTL_MS) return this.sessionCache.value;
    let value;
    try {
      const me = await this.request("/api/me", conf);
      if (me.status === 401) {
        value = {
          ok: false,
          reason: "session_expired",
          message:
            "控制台会话已过期（401）。重新登录 console.lithosai.cloud，再把 Cookie 粘一次。若刚粘过仍报这句，说明请求没被认成已登录——多半是 Cookie 只粘了一半。",
        };
      } else if (!me.ok) {
        value = {
          ok: false,
          reason: "http_" + me.status,
          message: `控制台拒绝了 /api/me（HTTP ${me.status}）${me.body?.error ? "：" + me.body.error : ""}`,
        };
      } else {
        // 真实响应里活动组织叫 activeOrganization（CodexBar 文档写的是 organization）——
        // 两种都收，拿不到就拿不到：没组织 ID 时账单接口自己会拒，不编一个。
        const org = me.body?.activeOrganization || me.body?.organization || me.body?.org || null;
        value = {
          ok: true,
          org,
          orgId: org?.id || me.body?.activeOrganizationId || null,
          user: me.body?.user || null,
        };
      }
    } catch (e) {
      value = {
        ok: false,
        reason: e?.name === "TimeoutError" ? "timeout" : "network",
        message:
          "连不上 console.lithosai.cloud：" +
          (e?.message || String(e)) +
          (e?.cause?.code ? `（${e.cause.code}）` : ""),
      };
    }
    if (epoch === this.credentialEpoch) this.sessionCache = { at: now, value, epoch };
    return value;
  }

  /** 查余额。任何失败都返回 connected:false + reason，不抛。 */
  async getBalance({ force = false } = {}) {
    const conf = this.loadConfig();
    if (!conf) {
      return { provider: "lithos", connected: false, configured: false, reason: "not_configured", message: "还没填控制台 Cookie" };
    }

    const now = Date.now();
    const epoch = this.credentialEpoch;
    if (!force && this.cache && this.cache.epoch === epoch && now - this.cache.at < this.ttlMs) return this.cache.value;
    if (this.inFlight?.epoch === epoch) return this.inFlight.promise;

    const task = (async () => {
      let value;
      const session = await this.resolveSession(conf, { force, epoch });
      if (!session.ok) {
        value = { provider: "lithos", connected: false, configured: true, reason: session.reason, message: session.message };
      } else {
        try {
          const billing = await this.request("/api/billing", { ...conf, orgId: session.orgId });
          if (billing.status === 401) {
            value = {
              provider: "lithos",
              connected: false,
              configured: true,
              reason: "session_expired",
              message:
                "控制台会话已过期（401）。重新登录后把 Cookie 粘一次。若刚粘过仍报这句，说明请求没被认成已登录——多半是 Cookie 只粘了一半。",
            };
          } else if (!billing.ok) {
            value = {
              provider: "lithos",
              connected: false,
              configured: true,
              reason: "http_" + billing.status,
              message: `控制台拒绝了 /api/billing（HTTP ${billing.status}）`,
            };
          } else {
            const nanos = billing.body?.balanceNanos;
            const money = formatUsdFromNanos(nanos);
            if (money.usd === null) {
              value = {
                provider: "lithos",
                connected: false,
                configured: true,
                reason: "no_balance_field",
                message: "账单接口没有返回 balanceNanos，契约可能变了",
              };
            } else {
              value = {
                provider: "lithos",
                connected: true,
                configured: true,
                currency: "USD",
                symbol: "$",
                balance: money.usd,
                display: money.display,
                balanceNanos: Number(nanos),
                hasCard: billing.body?.hasCard === true,
                onHold: billing.body?.onHold === true,
                organization: session.org ? { id: session.org.id || null, name: session.org.name || null } : null,
                account: session.user?.email || session.user?.name || null,
                updatedAt: new Date().toISOString(),
              };
            }
          }
        } catch (e) {
          value = {
            provider: "lithos",
            connected: false,
            configured: true,
            reason: e?.name === "TimeoutError" ? "timeout" : "network",
            message:
              "连不上 console.lithosai.cloud：" +
              (e?.message || String(e)) +
              (e?.cause?.code ? `（${e.cause.code}）` : ""),
          };
        }
      }
      if (epoch === this.credentialEpoch) this.cache = { at: Date.now(), value, epoch };
      return value;
    })();
    const flight = { epoch, promise: task };
    this.inFlight = flight;
    try {
      return await task;
    } finally {
      if (this.inFlight === flight) this.inFlight = null;
    }
  }

  /**
   * 区间消费明细：GET /api/billing/spend?start=&end=（UTC，含首尾）。
   * 返回按 (day, modelId, apiKeyId) 拆好的行 + 按模型/按天两种聚合。
   */
  async getSpend({ start, end, force = false } = {}) {
    const conf = this.loadConfig();
    if (!conf) {
      return { provider: "lithos", connected: false, configured: false, reason: "not_configured", message: "还没填控制台 Cookie" };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end || ""))) {
      return { provider: "lithos", connected: false, configured: true, reason: "bad_range", message: "区间要给 YYYY-MM-DD" };
    }

    const key = `${start}:${end}`;
    const now = Date.now();
    const epoch = this.credentialEpoch;
    const hit = this.spendCache?.get(key);
    if (!force && hit && hit.epoch === epoch && now - hit.at < this.ttlMs) return hit.value;

    const session = await this.resolveSession(conf, { force, epoch });
    if (!session.ok) {
      return { provider: "lithos", connected: false, configured: true, reason: session.reason, message: session.message };
    }

    let value;
    try {
      const res = await this.request(
        `/api/billing/spend?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        { ...conf, orgId: session.orgId }
      );
      if (res.status === 401) {
        value = {
          provider: "lithos",
          connected: false,
          configured: true,
          reason: "session_expired",
          message: "控制台会话已过期（401）。重新登录后把 Cookie 粘一次。",
        };
      } else if (!res.ok) {
        value = {
          provider: "lithos",
          connected: false,
          configured: true,
          reason: "http_" + res.status,
          message: `控制台拒绝了消费接口（HTTP ${res.status}）`,
        };
      } else {
        value = normalizeSpend(res.body, { start, end, org: session.org });
      }
    } catch (e) {
      value = {
        provider: "lithos",
        connected: false,
        configured: true,
        reason: e?.name === "TimeoutError" ? "timeout" : "network",
        message: "连不上 console.lithosai.cloud：" + (e?.message || String(e)) + (e?.cause?.code ? `（${e.cause.code}）` : ""),
      };
    }

    if (epoch === this.credentialEpoch) {
      if (!this.spendCache) this.spendCache = new Map();
      this.spendCache.set(key, { at: Date.now(), value, epoch });
    }
    return value;
  }
}

export default { LithosBalanceService, parseConsoleCookie, formatUsdFromNanos };
