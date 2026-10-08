const PROVIDER_IDS = ["openai-codex-oauth", "openai-codex"];
const CHATGPT_BACKEND_USAGE = "https://chatgpt.com/backend-api/wham/usage";

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

export function normalizeCodexCredentials(raw) {
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
  const accountId = typeof raw.accountId === "string" && raw.accountId.trim()
    ? raw.accountId.trim()
    : typeof raw.account_id === "string" && raw.account_id.trim()
      ? raw.account_id.trim()
      : "";
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim()
    ? raw.baseUrl.trim()
    : typeof raw.base_url === "string" && raw.base_url.trim()
      ? raw.base_url.trim()
      : "";
  return {
    apiKey,
    ...(accountId ? { accountId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export async function resolveCodexCredentials(bus) {
  if (!bus?.request) return null;
  for (const providerId of PROVIDER_IDS) {
    try {
      const res = await bus.request("provider:credentials", { providerId });
      const creds = normalizeCodexCredentials(res);
      if (creds) return creds;
    } catch {
      // 静默容错，不阻断主流程
    }
  }
  return null;
}

function parseWindow(win) {
  if (!win || typeof win !== "object") return null;
  const usedPercent = typeof win.used_percent === "number" ? Math.min(100, Math.max(0, win.used_percent)) : null;
  const remainingPercent = usedPercent !== null ? Math.max(0, 100 - usedPercent) : null;
  return {
    usedPercent,
    remainingPercent,
    windowSeconds: typeof win.limit_window_seconds === "number" ? win.limit_window_seconds : null,
    resetAfterSeconds: typeof win.reset_after_seconds === "number" ? win.reset_after_seconds : null,
    resetAt: typeof win.reset_at === "number" ? win.reset_at : null,
  };
}

function planLabel(planType) {
  const p = String(planType || "").trim().toLowerCase();
  if (!p) return "";
  if (p === "plus") return "Plus";
  if (p === "pro") return "Pro";
  if (p === "free") return "Free";
  if (p === "team") return "Team";
  if (p.includes("5x")) return "5X";
  if (p.includes("20x")) return "20X";
  return planType;
}

export function sanitizeCodexUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return { connected: false, reason: "invalid_response", message: "数据无法识别" };
  }
  const rateLimit = raw.rate_limit || {};
  const primary = parseWindow(rateLimit.primary_window);
  const secondary = parseWindow(rateLimit.secondary_window);
  const planType = typeof raw.plan_type === "string" ? raw.plan_type : "";
  const resetCredits = typeof raw.rate_limit_reset_credits?.available_count === "number"
    ? Math.max(0, raw.rate_limit_reset_credits.available_count)
    : 0;

  return {
    connected: true,
    planType,
    planLabel: planLabel(planType),
    primary,
    secondary,
    resetCredits,
    allowed: rateLimit.allowed !== false,
    limitReached: !!rateLimit.limit_reached,
    updatedAt: Date.now(),
  };
}

export class CodexQuotaService {
  constructor({ bus, network, fetchFn = globalThis.fetch, ttlMs = 60_000 } = {}) {
    this.bus = bus;
    this.network = network;
    this.fetchFn = fetchFn;
    this.ttlMs = ttlMs;
    this._cachedResult = null;
    this._cachedAt = 0;
    this._inFlight = null;
    this._cooldownUntil = 0;
  }

  async getQuota({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._cachedResult && (now - this._cachedAt < this.ttlMs)) {
      return this._cachedResult;
    }
    if (this._inFlight) {
      return this._inFlight;
    }
    this._inFlight = this._fetchQuota(now).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  async _fetchQuota(now) {
    if (now < this._cooldownUntil) {
      return this._cachedResult || { connected: false, reason: "rate_limited", message: "Codex 查询冷却中，请稍后" };
    }

    let creds = null;
    try {
      creds = await resolveCodexCredentials(this.bus);
    } catch {
      // 容错
    }

    if (!creds?.apiKey) {
      this._cachedResult = { connected: false, reason: "not_connected", message: "未检测到 Codex 登录" };
      this._cachedAt = now;
      return this._cachedResult;
    }

    const endpoint = (creds.baseUrl ? creds.baseUrl.replace(/\/+$/, "") + "/wham/usage" : CHATGPT_BACKEND_USAGE);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${creds.apiKey}`,
    };
    if (creds.accountId) {
      headers["ChatGPT-Account-Id"] = creds.accountId;
    }

    const doFetch = this.network?.fetch ? (u, init) => this.network.fetch(u, init) : this.fetchFn;

    try {
      const resp = await doFetch(endpoint, {
        method: "GET",
        headers,
      });

      if (resp.status === 401 || resp.status === 403) {
        this._cachedResult = { connected: false, reason: "unauthorized", message: "Codex 登录已失效" };
        this._cachedAt = now;
        return this._cachedResult;
      }

      if (resp.status === 429) {
        this._cooldownUntil = now + 60_000;
        this._cachedResult = { connected: false, reason: "rate_limited", message: "Codex 查询频繁，进入冷却" };
        this._cachedAt = now;
        return this._cachedResult;
      }

      if (!resp.ok) {
        this._cachedResult = { connected: false, reason: "upstream_error", message: `Codex 响应异常 (${resp.status})` };
        this._cachedAt = now;
        return this._cachedResult;
      }

      const json = await resp.json();
      const sanitized = sanitizeCodexUsage(json);
      this._cachedResult = sanitized;
      this._cachedAt = now;
      return sanitized;
    } catch (err) {
      const fallback = this._cachedResult || {
        connected: false,
        reason: "network_error",
        message: "暂时无法连接 Codex 服务",
      };
      return fallback;
    }
  }
}
