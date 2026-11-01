// lib/opencode-quota.mjs — OpenCode Go 订阅用量查询（官方 API Key 端点）
//
// 口径来源（2026-11 核实）：
//   GET https://opencode.ai/zen/go/v1/usage
//   Authorization: Bearer <推理 API Key>（oc_sk_...，Personal key 或 Service account key）
//   返回 usage.{rolling,weekly,monthly}，每个窗口带 percent 与 resetsAt。
//
// 为什么要说清楚边界：
//   1. 官方文档只承诺「到控制台看用量」，这个端点由上游 PR 上线（anomalyco/opencode#32913），
//      不是文档化的稳定契约；控制台内部的会话接口（lite.subscription.get）不可作为依赖。
//   2. 端点只给百分比，不给美元 used/limit。美元金额不可得，
//      所以这里绝不按价格表倒推一个「官方扣费」——那是估算，不是账单。
//   3. percent 到底表示「已用」还是「剩余」，上游没有文档化。这里按「已用」解释
//      （与上游 CLI 用法一致），同时把两面都算出来，界面上不写模棱两可的话。
//   4. 未配置 Key 与「Key 失效」「没有 Go 订阅」是三件事，分别给不同的 reason，不合并成一个失败。
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../runtime/engine/services/jsonl-log.js";

export const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const OPENCODE_CONFIG_FILE = "opencode-go.json";
// 宿主里这条供应商线的 id：新版是 opencode-go，旧配置可能只写了 opencode。
export const OPENCODE_PROVIDER_IDS = ["opencode-go", "opencode"];

const WINDOW_LEVELS = ["rolling", "weekly", "monthly"];
// 窗口名在不同实现里叫法不一样：上游 PR 用 name，社区实现用对象键。
const LEVEL_ALIASES = {
  rolling: ["rolling", "5h", "5-hour", "5hour", "five-hour", "fivehour", "session", "rolling-5h"],
  weekly: ["weekly", "week", "7d", "7-day", "7day", "seven-day"],
  monthly: ["monthly", "month", "30d", "30-day", "30day"],
};
const MAX_KEY_LENGTH = 512;

function bearerFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return "";
  const raw = typeof headers.Authorization === "string"
    ? headers.Authorization
    : typeof headers.authorization === "string"
      ? headers.authorization
      : "";
  const match = /^Bearer\s+(\S+)/i.exec(raw.trim());
  return match?.[1] ?? "";
}

function safeKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  if (!key || key.length > MAX_KEY_LENGTH) return "";
  // 控制台 Cookie（iron-session，形如 Fe26.2**）不是 API Key，混进来只会拿到 401，
  // 所以在归一化这一步就挡掉，别让它被当成密钥存进去。
  if (key.startsWith("Fe26.") || /\s/.test(key)) return "";
  return key;
}

export function normalizeOpenCodeCredentials(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.error === "string" && raw.error.trim()) return null;
  const apiKey = safeKey(raw.apiKey)
    || safeKey(raw.api_key)
    || safeKey(raw.access)
    || safeKey(raw.key)
    || safeKey(bearerFromHeaders(raw.headers));
  if (!apiKey) return null;
  return { apiKey };
}

// 顺序与 DeepSeek 一致：本设置页显式填的 Key 优先，宿主总线只当侧底。
// 原因同样是「名字撞车」——宿主里叫 opencode 的供应商可能指向中转站，
// 用户专门填了官方 Key 时不该被顶掉。
export async function resolveOpenCodeCredentials(bus, { dataDir = "", candidateIds = OPENCODE_PROVIDER_IDS } = {}) {
  if (dataDir) {
    try {
      const file = path.join(dataDir, OPENCODE_CONFIG_FILE);
      if (fs.existsSync(file)) {
        const conf = JSON.parse(fs.readFileSync(file, "utf-8"));
        const apiKey = safeKey(conf?.apiKey);
        if (apiKey) return { apiKey, source: "explicit" };
      }
    } catch {
      // 配置读坏了不能当成没配：下面总线还会再试一次，最终失败原因里会带出来。
    }
  }

  if (bus?.request) {
    for (const providerId of candidateIds) {
      try {
        const res = await bus.request("provider:credentials", { providerId });
        const creds = normalizeOpenCodeCredentials(res);
        if (creds) return { ...creds, source: "bus", providerId };
      } catch {
        // 静默容错
      }
    }
  }

  return null;
}

function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// percent 优先；没有就给 used/limit 折算。两者都没有 = 这个窗口的数据确实没给，标 unknown。
function pickUsedPercent(item) {
  if (!item || typeof item !== "object") return null;
  const direct = toFinite(item.percent) ?? toFinite(item.usedPercent) ?? toFinite(item.used_percent);
  if (direct !== null) return Math.min(100, Math.max(0, direct));
  const used = toFinite(item.used) ?? toFinite(item.usedUsd) ?? toFinite(item.used_usd);
  const limit = toFinite(item.limit) ?? toFinite(item.limitUsd) ?? toFinite(item.limit_usd);
  if (used === null || limit === null || limit <= 0) return null;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

export function normalizeOpenCodeUsage(payload, { now = Date.now() } = {}) {
  // 两种形状都要认，因为上游没正式文档化：
  //   A（anomalyco/opencode#32913 描述的）：{ plan, windows:[{name,status,usagePercent,resetInSec,used,limit}], useBalance }
  //   B（社区模板读到的）：{ usage: { rolling:{percent,resetsAt}, weekly:…, monthly:… } }
  // 认不出就如实报 shape_changed，不编。
  if (payload && typeof payload === "object" && Array.isArray(payload.windows)) {
    return normalizeFromWindowList(payload, { now });
  }

  const usage = payload && typeof payload === "object" && payload.usage && typeof payload.usage === "object"
    ? payload.usage
    : payload;
  if (!usage || typeof usage !== "object") {
    return { ok: false, reason: "shape_changed", windows: [], extraKeys: [] };
  }

  const windows = [];
  let anyKnown = false;
  for (const level of WINDOW_LEVELS) {
    const item = usage[level];
    const usedPercent = pickUsedPercent(item);
    if (usedPercent === null) {
      windows.push(emptyWindow(level));
      continue;
    }
    anyKnown = true;
    windows.push(buildWindow(level, { item, usedPercent, now }));
  }

  if (!anyKnown) return { ok: false, reason: "shape_changed", windows, extraKeys: Object.keys(usage).slice(0, 8) };
  return { ok: true, windows, extraKeys: Object.keys(usage).slice(0, 8) };
}

function emptyWindow(level) {
  return { level, known: false, usedPercent: null, remainingPercent: null, resetsAt: null, resetInSec: null, usedUsd: null, limitUsd: null };
}

function buildWindow(level, { item, usedPercent, now, resetInSec, usedUsd, limitUsd }) {
  const resetsAt = typeof item?.resetsAt === "string" && item.resetsAt.trim() ? item.resetsAt.trim() : null;
  let resetInSecValue = typeof resetInSec === "number" && Number.isFinite(resetInSec) ? Math.max(0, Math.round(resetInSec)) : null;
  if (resetInSecValue === null && resetsAt) {
    const at = Date.parse(resetsAt);
    if (Number.isFinite(at)) resetInSecValue = Math.max(0, Math.round((at - now) / 1000));
  }
  const usedValue = toFinite(usedUsd);
  const limitValue = toFinite(limitUsd);
  return {
    level,
    known: true,
    usedPercent: Math.round(usedPercent * 10) / 10,
    remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
    resetsAt,
    resetInSec: resetInSecValue,
    usedUsd: usedValue,
    limitUsd: limitValue,
  };
}

function windowLevelFromName(name) {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  for (const level of WINDOW_LEVELS) {
    if (LEVEL_ALIASES[level].includes(key)) return level;
  }
  return null;
}

function normalizeFromWindowList(payload, { now }) {
  const byLevel = new Map();
  for (const raw of payload.windows) {
    const level = windowLevelFromName(raw?.name ?? raw?.level ?? raw?.window);
    if (!level || byLevel.has(level)) continue;
    byLevel.set(level, raw);
  }

  const windows = [];
  let anyKnown = false;
  for (const level of WINDOW_LEVELS) {
    const raw = byLevel.get(level);
    if (!raw) {
      windows.push(emptyWindow(level));
      continue;
    }
    // usagePercent 是这一形状的正式字段；也兼容拣 used/limit 折算。
    const usedPercent = toFinite(raw.usagePercent) ?? toFinite(raw.usedPercent) ?? pickUsedPercent(raw);
    if (usedPercent === null) {
      windows.push(emptyWindow(level));
      continue;
    }
    anyKnown = true;
    windows.push(buildWindow(level, {
      item: raw,
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      now,
      resetInSec: raw.resetInSec,
      usedUsd: raw.used,
      limitUsd: raw.limit,
    }));
  }

  if (!anyKnown) {
    return { ok: false, reason: "shape_changed", windows, extraKeys: Object.keys(payload).slice(0, 8) };
  }
  return {
    ok: true,
    windows,
    plan: typeof payload.plan === "string" ? payload.plan : null,
    useBalance: payload.useBalance === true,
    extraKeys: Object.keys(payload).slice(0, 8),
  };
}

export class OpenCodeQuotaService {
  constructor({
    bus,
    network,
    fetchFn = globalThis.fetch,
    dataDir = "",
    ttlMs = 60_000,
    timeoutMs = 8_000,
    now = () => Date.now(),
  } = {}) {
    this.bus = bus;
    this.network = network;
    this.fetchFn = fetchFn;
    this.dataDir = dataDir;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.configPath = dataDir ? path.join(dataDir, OPENCODE_CONFIG_FILE) : "";
    this._cached = null;
    this._cachedAt = 0;
    this._inFlight = null;
    this._epoch = 0;
    this._cooldownUntil = 0;
  }

  loadConfig() {
    if (!this.configPath) return null;
    try {
      if (!fs.existsSync(this.configPath)) return null;
      const conf = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
      const apiKey = safeKey(conf?.apiKey);
      if (!apiKey) return null;
      return { apiKey, savedAt: conf?.savedAt || null };
    } catch {
      return null;
    }
  }

  // 只回是否配过，不回 Key 本身：界面上不需要看到它。
  describeConfig() {
    const conf = this.loadConfig();
    return { configured: !!conf, savedAt: conf?.savedAt || null };
  }

  async saveApiKey(input) {
    const apiKey = safeKey(input);
    if (!apiKey) {
      return {
        ok: false,
        code: "INVALID_KEY",
        message: "需要 OpenCode API Key（oc_sk_ 开头）。控制台 Cookie 不能用来查额度。",
      };
    }
    if (!this.dataDir) return { ok: false, code: "NO_DATA_DIR", message: "没有数据目录，存不了" };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const payload = { apiKey, savedAt: new Date(this.now()).toISOString() };
      writeFileAtomic(this.configPath, JSON.stringify(payload, null, 2), 0o600);
      this.invalidate();
      return { ok: true, configured: true, savedAt: payload.savedAt };
    } catch (e) {
      return { ok: false, code: "SAVE_FAILED", message: e.message };
    }
  }

  async clearApiKey() {
    if (!this.configPath) return { ok: true, configured: false };
    try {
      fs.rmSync(this.configPath, { force: true });
      this.invalidate();
      return { ok: true, configured: false };
    } catch (e) {
      return { ok: false, code: "CLEAR_FAILED", message: e.message };
    }
  }

  invalidate() {
    this._epoch += 1;
    this._cached = null;
    this._cachedAt = 0;
    this._inFlight = null;
    this._cooldownUntil = 0;
  }

  async getQuota({ force = false } = {}) {
    const now = this.now();
    if (!force && this._cached && now - this._cachedAt < this.ttlMs) return this._cached;
    if (this._inFlight) return this._inFlight;

    const epoch = this._epoch;
    const task = this._fetchQuota(now, epoch).finally(() => {
      if (this._inFlight === task) this._inFlight = null;
    });
    this._inFlight = task;
    return task;
  }

  async _fetchQuota(now, epoch) {
    const store = (value) => {
      if (epoch === this._epoch) {
        this._cached = value;
        this._cachedAt = now;
      }
      return value;
    };

    if (now < this._cooldownUntil) {
      return this._cached || {
        connected: false,
        reason: "rate_limited",
        message: "OpenCode 查询冷却中，请稍后重试",
        windows: [],
      };
    }

    let creds = null;
    try {
      creds = await resolveOpenCodeCredentials(this.bus, { dataDir: this.dataDir });
    } catch {
      // 容错：凭据解析失败按未配置处理，但把原因说清楚
    }

    if (!creds?.apiKey) {
      return store({
        connected: false,
        reason: "not_configured",
        message: "未检测到 OpenCode Go API Key（可在设置里填 oc_sk_ 开头的 Key）",
        windows: [],
      });
    }

    const doFetch = this.network?.fetch
      ? (url, init) => this.network.fetch(url, init)
      : this.fetchFn;

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let resp = null;
    try {
      resp = await doFetch(OPENCODE_USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          Accept: "application/json",
        },
        signal: controller?.signal,
      });
    } catch (e) {
      const aborted = e?.name === "AbortError";
      return store({
        connected: false,
        reason: aborted ? "timeout" : "network_error",
        message: aborted ? "查询超时，请稍后重试" : "网络请求失败，未取得用量数据",
        source: creds.source,
        windows: [],
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const status = typeof resp?.status === "number" ? resp.status : 0;
    if (status === 401) {
      return store({
        connected: false,
        reason: "unauthorized",
        message: "OpenCode API Key 无效或已撤销（额度查询要用能调用模型的 Key）",
        source: creds.source,
        windows: [],
      });
    }
    if (status === 403) {
      return store({
        connected: false,
        reason: "forbidden",
        message: "这把 Key 无权读取用量，或账号没有 Go 订阅",
        source: creds.source,
        windows: [],
      });
    }
    if (status === 404) {
      return store({
        connected: false,
        reason: "endpoint_missing",
        message: "上游没有 /zen/go/v1/usage 端点（接口可能已变更）",
        source: creds.source,
        windows: [],
      });
    }
    if (status === 429) {
      this._cooldownUntil = now + 60_000;
      return store({
        connected: false,
        reason: "rate_limited",
        message: "被限流了，60 秒后再查",
        source: creds.source,
        windows: [],
      });
    }
    if (status && (status < 200 || status >= 300)) {
      return store({
        connected: false,
        reason: "http_error",
        message: `上游返回 HTTP ${status}`,
        source: creds.source,
        windows: [],
      });
    }

    let payload = null;
    try {
      payload = await resp.json();
    } catch {
      return store({
        connected: false,
        reason: "bad_json",
        message: "上游返回的不是 JSON",
        source: creds.source,
        windows: [],
      });
    }

    const normalized = normalizeOpenCodeUsage(payload, { now });
    if (!normalized.ok) {
      return store({
        connected: false,
        reason: "shape_changed",
        message: "用量结构变了，没有识别到 rolling / weekly / monthly 窗口",
        source: creds.source,
        fields: normalized.extraKeys,
        windows: [],
      });
    }

    return store({
      connected: true,
      provider: "opencode-go",
      label: "OpenCode Go",
      // 具体档位只有其中一种响应形状才带；不给就不猜。
      plan: normalized.plan || null,
      useBalance: normalized.useBalance === true,
      source: creds.source,
      windows: normalized.windows,
      fetchedAt: now,
    });
  }
}
