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
  // 1. 优先通过宿主总线读取 DeepSeek 凭据
  if (bus?.request) {
    for (const providerId of candidateIds) {
      try {
        const res = await bus.request("provider:credentials", { providerId });
        const creds = normalizeDeepSeekCredentials(res);
        if (creds) return creds;
      } catch {
        // 静默容错
      }
    }
  }

  // 2. 检查本地 balance-apis.json 是否有预填的 apiKey 回退
  if (dataDir) {
    try {
      const p = path.join(dataDir, "balance-apis.json");
      if (fs.existsSync(p)) {
        const conf = JSON.parse(fs.readFileSync(p, "utf-8"));
        const dsKey = conf?.deepseek?.apiKey;
        if (dsKey && typeof dsKey === "string" && dsKey !== "••••••••" && dsKey.trim()) {
          return { apiKey: dsKey.trim() };
        }
      }
    } catch {}
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

  const total = parseFloat(row.total_balance) || 0;
  const granted = parseFloat(row.granted_balance) || 0;
  const toppedUp = parseFloat(row.topped_up_balance) || 0;
  const currency = row.currency || "CNY";
  const symbol = currency === "USD" ? "$" : "¥";

  return {
    connected: true,
    isAvailable: payload.is_available !== false,
    currency,
    symbol,
    totalBalance: row.total_balance,
    grantedBalance: row.granted_balance || "0.00",
    toppedUpBalance: row.topped_up_balance || "0.00",
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
  }

  async getBalance({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._cachedResult && (now - this._cachedAt < this.ttlMs)) {
      return this._cachedResult;
    }
    if (this._inFlight) {
      return this._inFlight;
    }
    this._inFlight = this._fetchBalance(now).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  async _fetchBalance(now) {
    if (now < this._cooldownUntil) {
      return this._cachedResult || { connected: false, reason: "rate_limited", message: "DeepSeek 查询冷却中，请稍后" };
    }

    let creds = null;
    try {
      creds = await resolveDeepSeekCredentials(this.bus, { dataDir: this.dataDir });
    } catch {}

    if (!creds?.apiKey) {
      this._cachedResult = { connected: false, reason: "not_connected", message: "未配置 DeepSeek" };
      this._cachedAt = now;
      return this._cachedResult;
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
        this._cachedResult = { connected: false, reason: "unauthorized", message: "DeepSeek API Key 无效" };
        this._cachedAt = now;
        return this._cachedResult;
      }

      if (resp.status === 429) {
        this._cooldownUntil = now + 60_000;
        this._cachedResult = { connected: false, reason: "rate_limited", message: "DeepSeek 查询频繁，进入冷却" };
        this._cachedAt = now;
        return this._cachedResult;
      }

      if (!resp.ok) {
        this._cachedResult = { connected: false, reason: "upstream_error", message: `DeepSeek 响应异常 (${resp.status})` };
        this._cachedAt = now;
        return this._cachedResult;
      }

      const json = await resp.json();
      const parsed = parseDeepSeekBalance(json);
      this._cachedResult = parsed;
      this._cachedAt = now;
      return parsed;
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
