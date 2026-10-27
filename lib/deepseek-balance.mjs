// lib/deepseek-balance.mjs — DeepSeek 官方 API 余额查询与防刷缓存服务
import path from "node:path";
import fs from "node:fs";

const PROVIDER_IDS = ["deepseek", "deepseek-chat"];
const BALANCE_URL = "https://api.deepseek.com/user/balance";

function bearerFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return "";
  const authorization = typeof headers.Authorization === "string"
    ? headers.Authorization
    : typeof headers.authorization === "string"
      ? headers.authorization
      : "";
  const match = /^Bearer\s+(\S+)/i.exec(authorization.trim());
  return match?.[1] ?? "";
}

export function normalizeDeepSeekCredentials(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.error === "string" && raw.error.trim()) return null;
  const apiKey = typeof raw.apiKey === "string" && raw.apiKey.trim()
    ? raw.apiKey.trim()
    : typeof raw.api_key === "string" && raw.api_key.trim()
      ? raw.api_key.trim()
      : typeof raw.access === "string" && raw.access.trim()
        ? raw.access.trim()
        : bearerFromHeaders(raw.headers);
  if (!apiKey) return null;
  return { apiKey };
}

export async function resolveDeepSeekCredentials(bus, { dataDir = "", candidateIds = PROVIDER_IDS } = {}) {
  // 顺序很重要：**本设置页里显式填的 key 优先**，宿主总线只当侧底。
  //
  // 为什么不在前面先问总线：宿主里名为 "deepseek" 的供应商现在完全可能指向中转站/别家
  // （2026-10 实测：同一个 providerId 的 baseUrl 已经成了 api.lithosai.cloud）。
  // 那时总线上那把 key 根本不是官方 DeepSeek 的，拿去请求 api.deepseek.com 只会 401，
  // 而用户已经专门在设置里填了官方 key，没道理被一个名字撞车的供应商顶掉。
  //
  // 返回 source：401 时那句错误要能说清楚这把 key 是哪来的。
  if (dataDir) {
    try {
      const p = path.join(dataDir, "balance-apis.json");
      if (fs.existsSync(p)) {
        const conf = JSON.parse(fs.readFileSync(p, "utf-8"));
        const dsKey = conf?.deepseek?.apiKey;
        if (dsKey && typeof dsKey === "string" && dsKey !== "••••••••" && dsKey.trim()) {
          return { apiKey: dsKey.trim(), source: "explicit" };
        }
      }
    } catch {}
  }

  if (bus?.request) {
    for (const providerId of candidateIds) {
      try {
        const res = await bus.request("provider:credentials", { providerId });
        const creds = normalizeDeepSeekCredentials(res);
        if (creds) return { ...creds, source: "bus", providerId };
      } catch {
        // 静默容错
      }
    }
  }

  return null;
}

export function parseDeepSeekBalance(payload) {
  if (!payload || typeof payload !== "object") {
    return { connected: false, reason: "invalid_response", message: "数据无法识别" };
  }
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  // 优先选取 CNY，其次 USD，最后回退任意有效项
  const cny = infos.find((row) => row?.currency === "CNY" && typeof row.total_balance === "string");
  const usd = infos.find((row) => row?.currency === "USD" && typeof row.total_balance === "string");
  const row = cny || usd || infos.find((item) => typeof item?.total_balance === "string");
  if (!row) {
    return { connected: false, reason: "no_balance_info", message: "未获取到余额信息" };
  }

  const parseAmount = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const amount = Number(value.trim());
    return Number.isFinite(amount) ? amount : null;
  };
  const total = parseAmount(row.total_balance);
  const granted = Object.hasOwn(row, "granted_balance") ? parseAmount(row.granted_balance) : 0;
  const toppedUp = Object.hasOwn(row, "topped_up_balance") ? parseAmount(row.topped_up_balance) : 0;
  if (total === null || granted === null || toppedUp === null) {
    return { connected: false, reason: "invalid_response", message: "余额字段无法识别" };
  }
  const currency = row.currency || "CNY";
  const symbol = currency === "USD" ? "$" : "¥";

  return {
    connected: true,
    isAvailable: payload.is_available !== false,
    currency,
    symbol,
    totalBalance: row.total_balance,
    grantedBalance: row.granted_balance == null ? "0.00" : String(row.granted_balance),
    toppedUpBalance: row.topped_up_balance == null ? "0.00" : String(row.topped_up_balance),
    total,
    granted,
    toppedUp,
    display: `${symbol}${total.toFixed(2)}`,
    updatedAt: Date.now(),
  };
}

export class DeepSeekBalanceService {
  constructor({ bus, network, fetchFn = globalThis.fetch, ttlMs = 60_000, dataDir = "" } = {}) {
    this.bus = bus;
    this.network = network;
    this.fetchFn = fetchFn;
    this.ttlMs = ttlMs;
    this.dataDir = dataDir;
    this._cachedResult = null;
    this._cachedAt = 0;
    this._inFlight = null;
    this._cooldownUntil = 0;
    this.credentialEpoch = 0;
  }

  invalidate() {
    this.credentialEpoch += 1;
    this._cachedResult = null;
    this._cachedAt = 0;
    this._cooldownUntil = 0;
    this._inFlight = null;
  }

  async getBalance({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._cachedResult && (now - this._cachedAt < this.ttlMs)) {
      return this._cachedResult;
    }
    if (this._inFlight) {
      return this._inFlight;
    }
    const epoch = this.credentialEpoch;
    const task = this._fetchBalance(now, epoch).finally(() => {
      if (this._inFlight === task) this._inFlight = null;
    });
    this._inFlight = task;
    return task;
  }

  async _fetchBalance(now, epoch = this.credentialEpoch) {
    const store = (value) => {
      if (epoch === this.credentialEpoch) {
        this._cachedResult = value;
        this._cachedAt = now;
      }
      return value;
    };
    if (now < this._cooldownUntil) {
      return this._cachedResult || { connected: false, reason: "rate_limited", message: "DeepSeek 查询冷却中，请稍后" };
    }

    let creds = null;
    try {
      creds = await resolveDeepSeekCredentials(this.bus, { dataDir: this.dataDir });
    } catch {}

    if (!creds?.apiKey) {
      return store({ connected: false, reason: "not_connected", message: "未配置 DeepSeek" });
    }

    const endpoint = BALANCE_URL;
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${creds.apiKey}`,
    };

    const doFetch = this.network?.fetch ? (u, init) => this.network.fetch(u, init) : this.fetchFn;

    try {
      const resp = await doFetch(endpoint, {
        method: "GET",
        headers,
      });

      if (resp.status === 401 || resp.status === 403) {
        // 说清楚这把 key 从哪来：宿主供应商名字对得上但不一定是官方渠道（可能已改成中转站）。
        const hint = creds.source === "bus"
          ? `（这把 key 来自宿主里的 ${creds.providerId || "deepseek"} 供应商；若它已改成中转站，官方余额接口不认它，请在上方单独填官方 API Key）`
          : "";
        return store({ connected: false, reason: "unauthorized", message: "DeepSeek API Key 无效" + hint });
      }

      if (resp.status === 429) {
        this._cooldownUntil = now + 60_000;
        return store({ connected: false, reason: "rate_limited", message: "DeepSeek 查询频繁，进入冷却" });
      }

      if (!resp.ok) {
        return store({ connected: false, reason: "upstream_error", message: `DeepSeek 响应异常 (${resp.status})` });
      }

      const json = await resp.json();
      const parsed = parseDeepSeekBalance(json);
      return store(parsed);
    } catch (err) {
      const fallback = this._cachedResult || {
        connected: false,
        reason: "network_error",
        message: "暂时无法连接 DeepSeek",
      };
      return fallback;
    }
  }
}
