const PROVIDER_IDS = ["openai-codex-oauth", "openai-codex"];
const CHATGPT_BACKEND_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_RESET_CREDITS = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CHATGPT_RESET_CONSUME = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { connected: false, reason: "invalid_response", message: "数据无法识别" };
  }
  const rateLimit = raw.rate_limit;
  const primary = parseWindow(rateLimit?.primary_window);
  const secondary = parseWindow(rateLimit?.secondary_window);
  const planType = typeof raw.plan_type === "string" ? raw.plan_type : "";
  const rawResetCredits = raw.rate_limit_reset_credits?.available_count;
  const hasResetCredits = typeof rawResetCredits === "number" && Number.isFinite(rawResetCredits);
  const resetCredits = hasResetCredits ? Math.max(0, rawResetCredits) : 0;

  const rawCredits = raw.credits || raw.user_credits || raw.account_credits || {};
  let creditsBalance = null;
  const rawBalanceVal = rawCredits.balance ?? raw.credits_balance;
  let hasValidBalance = false;
  if (typeof rawBalanceVal === "number" && Number.isFinite(rawBalanceVal)) {
    creditsBalance = "$" + rawBalanceVal.toFixed(2);
    hasValidBalance = true;
  } else if (typeof rawBalanceVal === "string" && rawBalanceVal.trim()) {
    const trimmed = rawBalanceVal.trim();
    const numeric = Number(trimmed.startsWith("$") ? trimmed.slice(1) : trimmed);
    if (Number.isFinite(numeric)) {
      creditsBalance = trimmed.startsWith("$") ? "$" + numeric.toFixed(2) : numeric.toFixed(2);
      hasValidBalance = true;
    }
  }
  const hasCredits = typeof rawCredits.has_credits === "boolean"
    ? rawCredits.has_credits
    : (creditsBalance !== null && creditsBalance !== "$0.00" && creditsBalance !== "$0" && creditsBalance !== "0.00" && creditsBalance !== "0");
  const hasWindow = (win) => win && typeof win === "object" && !Array.isArray(win) &&
    [win.used_percent, win.limit_window_seconds, win.reset_after_seconds, win.reset_at]
      .some((value) => typeof value === "number" && Number.isFinite(value));
  const hasRateLimit = rateLimit && typeof rateLimit === "object" && !Array.isArray(rateLimit) &&
    (hasWindow(rateLimit.primary_window) || hasWindow(rateLimit.secondary_window) ||
      typeof rateLimit.allowed === "boolean" || typeof rateLimit.limit_reached === "boolean");
  const hasCreditsData = rawCredits && typeof rawCredits === "object" && !Array.isArray(rawCredits) &&
    (hasValidBalance || typeof rawCredits.has_credits === "boolean");
  if (!hasRateLimit && !hasCreditsData && !hasResetCredits) {
    return { connected: false, reason: "invalid_response", message: "数据无法识别" };
  }

  return {
    connected: true,
    planType,
    planLabel: planLabel(planType),
    primary,
    secondary,
    resetCredits,
    creditsBalance,
    hasCredits,
    allowed: rateLimit?.allowed !== false,
    limitReached: !!rateLimit?.limit_reached,
    updatedAt: Date.now(),
  };
}

export function parseResetCredit(c) {
  if (!c || typeof c !== "object") return null;
  const id = typeof c.id === "string" ? c.id.trim() : "";
  if (!id) return null;
  return {
    id,
    resetType: typeof c.reset_type === "string" ? c.reset_type : (c.resetType || ""),
    status: typeof c.status === "string" ? c.status : "available",
    grantedAt: typeof c.granted_at === "string" ? c.granted_at : (c.grantedAt || null),
    expiresAt: typeof c.expires_at === "string" ? c.expires_at : (c.expiresAt || null),
    title: typeof c.title === "string" ? c.title : (c.title || "使用限额重置卡"),
    description: typeof c.description === "string" ? c.description : (c.description || ""),
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
    this._cachedResetCredits = null;
    this._cachedResetCreditsAt = 0;
    this._inFlight = null;
    this._inFlightEpoch = -1;
    this._quotaEpoch = 0;
    this._cooldownUntil = 0;
  }

  async getQuota({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._cachedResult && (now - this._cachedAt < this.ttlMs)) {
      return this._cachedResult;
    }
    if (this._inFlight && this._inFlightEpoch === this._quotaEpoch) {
      return this._inFlight;
    }
    const epoch = this._quotaEpoch;
    const task = this._fetchQuota(now, epoch).finally(() => {
      if (this._inFlight === task) {
        this._inFlight = null;
        this._inFlightEpoch = -1;
      }
    });
    this._inFlight = task;
    this._inFlightEpoch = epoch;
    return task;
  }

  async _fetchQuota(now, epoch = this._quotaEpoch) {
    const store = (value) => {
      if (epoch === this._quotaEpoch) {
        this._cachedResult = value;
        this._cachedAt = now;
      }
      return value;
    };
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
      return store({ connected: false, reason: "not_connected", message: "未检测到 Codex 登录" });
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
        return store({ connected: false, reason: "unauthorized", message: "Codex 登录已失效" });
      }

      if (resp.status === 429) {
        if (epoch === this._quotaEpoch) this._cooldownUntil = now + 60_000;
        return store({ connected: false, reason: "rate_limited", message: "Codex 查询频繁，进入冷却" });
      }

      if (!resp.ok) {
        return store({ connected: false, reason: "upstream_error", message: `Codex 响应异常 (${resp.status})` });
      }

      const json = await resp.json();
      return store(sanitizeCodexUsage(json));
    } catch (err) {
      const fallback = this._cachedResult || {
        connected: false,
        reason: "network_error",
        message: "暂时无法连接 Codex 服务",
      };
      return fallback;
    }
  }

  async getResetCredits({ force = false } = {}) {
    const epoch = this._quotaEpoch;
    const now = Date.now();
    if (!force && this._cachedResetCredits && (now - this._cachedResetCreditsAt < this.ttlMs)) {
      return this._cachedResetCredits;
    }

    let creds = null;
    try {
      creds = await resolveCodexCredentials(this.bus);
    } catch {}

    if (!creds?.apiKey) {
      return { connected: false, reason: "not_connected", message: "未检测到 Codex 登录", credits: [], availableCount: 0 };
    }

    const endpoint = creds.baseUrl
      ? creds.baseUrl.replace(/\/+$/, "") + "/wham/rate-limit-reset-credits"
      : CHATGPT_RESET_CREDITS;
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
        return { connected: false, reason: "unauthorized", message: "Codex 登录已失效", credits: [], availableCount: 0 };
      }
      if (!resp.ok) {
        return { connected: false, reason: "upstream_error", message: `Codex 重置卡查询异常 (${resp.status})`, credits: [], availableCount: 0 };
      }

      const json = await resp.json();
      const rawCredits = Array.isArray(json?.credits) ? json.credits : [];
      const credits = rawCredits.map(parseResetCredit).filter(Boolean);
      const availableCount = typeof json?.available_count === "number"
        ? Math.max(0, json.available_count)
        : credits.filter((c) => c.status === "available").length;

      const result = {
        connected: true,
        credits,
        availableCount,
        updatedAt: now,
      };
      if (epoch === this._quotaEpoch) {
        this._cachedResetCredits = result;
        this._cachedResetCreditsAt = now;
      }
      return result;
    } catch (err) {
      return {
        connected: false,
        reason: "network_error",
        message: "暂时无法连接 Codex 重置卡服务",
        credits: [],
        availableCount: 0,
      };
    }
  }

  async consumeResetCredit({ creditId, redeemRequestId } = {}) {
    if (!creditId || typeof creditId !== "string") {
      return { ok: false, code: "invalid_param", message: "未指定重置卡 ID" };
    }
    if (redeemRequestId !== undefined) {
      if (typeof redeemRequestId !== "string" || !redeemRequestId.trim() || redeemRequestId.trim().length > 128) {
        return { ok: false, code: "invalid_param", message: "redeemRequestId 必须是 1-128 个字符的字符串" };
      }
      redeemRequestId = redeemRequestId.trim();
    }

    let creds = null;
    try {
      creds = await resolveCodexCredentials(this.bus);
    } catch {}

    if (!creds?.apiKey) {
      return { ok: false, code: "not_connected", message: "未检测到 Codex 登录" };
    }

    const endpoint = creds.baseUrl
      ? creds.baseUrl.replace(/\/+$/, "") + "/wham/rate-limit-reset-credits/consume"
      : CHATGPT_RESET_CONSUME;
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.apiKey}`,
    };
    if (creds.accountId) {
      headers["ChatGPT-Account-Id"] = creds.accountId;
    }

    const uuid = redeemRequestId || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const body = {
      credit_id: creditId,
      redeem_request_id: uuid,
      ...(creds.accountId ? { account_id: creds.accountId } : {}),
    };

    const doFetch = this.network?.fetch ? (u, init) => this.network.fetch(u, init) : this.fetchFn;

    try {
      const resp = await doFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      let json = null;
      try {
        json = await resp.json();
      } catch {}

      let code;
      if (!resp.ok) {
        code = typeof json?.code === "string" && json.code !== "reset"
          ? json.code
          : `http_${resp.status}`;
      } else if (!json || typeof json !== "object") {
        return { ok: false, code: "invalid_response", message: "上游返回无法识别的核销结果，未确认成功" };
      } else {
        code = typeof json.code === "string" && json.code.trim() ? json.code.trim() : "unknown_response";
      }

      if (resp.ok && code === "reset") {
        // 核销成功：切换 quota epoch，旧请求只能完成自己的调用，不能回写新缓存。
        this._quotaEpoch += 1;
        this._cachedResult = null;
        this._cachedAt = 0;
        this._cachedResetCredits = null;
        this._cachedResetCreditsAt = 0;
        this._cooldownUntil = 0;
        this._inFlight = null;
        this._inFlightEpoch = -1;
        return { ok: true, code: "reset", message: "重置卡已成功使用，限额已清空" };
      }

      const messageMap = {
        already_redeemed: "这张重置卡已经被使用过了",
        no_credit: "重置卡不存在或已失效",
        nothing_to_reset: "当前未达到限额，无需重置",
        rate_limit_reset_ineligible: "当前账号暂不符合重置条件",
        unknown_response: "上游未明确确认核销成功，请不要自动重试",
      };
      const message = messageMap[code] || json?.message || json?.detail?.message || `重置未生效 (${code})`;
      return { ok: false, code, message };
    } catch (err) {
      return { ok: false, code: "network_error", message: `重置请求失败：${err.message || err}` };
    }
  }
}
