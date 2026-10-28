import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeFileAtomic } from "../runtime/engine/services/jsonl-log.js";

export const GEMINI_CPA_BASE_URL = "https://cpa.example.invalid";
export const GEMINI_CPA_CONFIG_FILE = "gemini-cpa.json";
export const GEMINI_CREDENTIALS_URL = `${GEMINI_CPA_BASE_URL}/v8/management/credentials`;
export const GEMINI_API_CALL_URL = `${GEMINI_CPA_BASE_URL}/v8/management/requests/api-call`;
export const GEMINI_QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];

const SINGLE_REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_ACCOUNT_CONCURRENCY = 3;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 12_000;
const MANAGEMENT_KEY_MAX_LENGTH = 4096;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const MANAGEMENT_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};
const QUOTA_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
};

function safeString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizedKey(value) {
  return safeString(value).toLowerCase().replace(/[_\s]+/g, "-");
}

function isTruthyFlag(value) {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  return typeof value === "string" && ["true", "1", "yes", "disabled"].includes(value.trim().toLowerCase());
}

function isDisabled(file) {
  return isTruthyFlag(file?.disabled) || normalizedKey(file?.status) === "disabled";
}

function accountHealth(file) {
  if (isDisabled(file)) return "disabled";
  if (isTruthyFlag(file?.unavailable) || ["error", "unavailable"].includes(normalizedKey(file?.status))) {
    return "unavailable";
  }
  if (["active", "ready"].includes(normalizedKey(file?.status))) return "healthy";
  return "unknown";
}

function isAntigravity(file) {
  const provider = normalizedKey(file?.provider ?? file?.type);
  return provider === "antigravity";
}

function authIndexOf(file) {
  const value = file?.auth_index ?? file?.authIndex;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function projectIdOf(file) {
  const direct = safeString(file?.project_id ?? file?.projectId);
  if (direct) return direct;
  for (const source of [file?.metadata, file?.attributes]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const value = safeString(source.project_id ?? source.projectId ?? source.gemini_virtual_project);
    if (value) return value;
  }
  return "";
}

function maskLabel(file) {
  const raw = safeString(
    file?.email
      ?? file?.email_address
      ?? file?.account_email
      ?? file?.accountEmail
      ?? file?.user_email
      ?? file?.userEmail
      ?? file?.account,
  );
  if (!raw || /[\\/]/.test(raw)) return "Antigravity账号";
  const at = raw.indexOf("@");
  if (at > 0 && at < raw.length - 1) {
    const local = raw.slice(0, at);
    const domain = raw.slice(at + 1);
    return `${local.slice(0, 1)}***${local.length > 1 ? local.slice(-1) : ""}@${domain}`;
  }
  return `${raw.slice(0, 1)}***`;
}

function stableAccountId(file, index) {
  const authIndex = authIndexOf(file);
  const credentialIdentity = safeString(
    file?.credential_id
      ?? file?.credentialId
      ?? file?.id
      ?? file?.name,
  );
  const emailIdentity = safeString(
    file?.email
      ?? file?.email_address
      ?? file?.account_email
      ?? file?.accountEmail
      ?? file?.user_email
      ?? file?.userEmail
      ?? file?.account,
  );
  const identity = (authIndex ?? credentialIdentity) || emailIdentity || `account-${index}`;
  const disambiguator = (authIndex ?? credentialIdentity) || index;
  return crypto.createHash("sha256").update(`antigravity:${identity}:${disambiguator}`).digest("hex").slice(0, 16);
}

function normalizeFraction(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const isPercent = text.endsWith("%");
  const numberText = isPercent ? text.slice(0, -1).trim() : text;
  if (!numberText) return null;
  const number = Number(numberText);
  if (!Number.isFinite(number)) return null;
  const fraction = isPercent ? number / 100 : number;
  return fraction >= 0 && fraction <= 1 ? fraction : null;
}

function normalizeResetTime(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !ISO_TIME_RE.test(text)) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function publicText(value, fallback, projectId = "") {
  const text = safeString(value);
  const lower = text.toLowerCase();
  if (!text
    || (projectId && lower.includes(projectId.toLowerCase()))
    || /[\\/]/.test(text)
    || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)) return fallback;
  return text.slice(0, 128);
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildGroups(rawPayload, projectId) {
  const payload = parseObject(rawPayload);
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  return groups.map((rawGroup, groupIndex) => {
    if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) return null;
    const groupFallback = `Quota Group ${groupIndex + 1}`;
    const label = publicText(rawGroup.displayName ?? rawGroup.display_name ?? rawGroup.name, groupFallback, projectId);
    const rawId = publicText(rawGroup.id ?? rawGroup.groupId ?? rawGroup.group_id, `quota-group-${groupIndex + 1}`, projectId);
    const rawBuckets = Array.isArray(rawGroup.buckets) ? rawGroup.buckets : [];
    const buckets = rawBuckets.map((rawBucket, bucketIndex) => {
      if (!rawBucket || typeof rawBucket !== "object" || Array.isArray(rawBucket)) return null;
      const remainingFraction = normalizeFraction(rawBucket.remainingFraction ?? rawBucket.remaining_fraction);
      if (remainingFraction === null) return null;
      const bucketFallback = `Bucket ${bucketIndex + 1}`;
      const bucketLabel = publicText(
        rawBucket.displayName ?? rawBucket.display_name ?? rawBucket.name ?? rawBucket.description,
        bucketFallback,
        projectId,
      );
      const bucketId = publicText(
        rawBucket.bucketId ?? rawBucket.bucket_id ?? rawBucket.id,
        `${rawId}-bucket-${bucketIndex + 1}`,
        projectId,
      );
      return {
        id: bucketId,
        label: bucketLabel,
        remainingFraction,
        resetTime: normalizeResetTime(rawBucket.resetTime ?? rawBucket.reset_time),
      };
    }).filter(Boolean);
    return buckets.length ? { id: rawId, label, buckets } : null;
  }).filter(Boolean);
}

function emptyDto(configured, reason = null) {
  return {
    configured,
    connected: false,
    reason,
    updatedAt: null,
    accounts: [],
  };
}

function timeoutError() {
  const error = new Error("request timeout");
  error.code = "TIMEOUT";
  return error;
}

function isTimeout(error) {
  return error?.code === "TIMEOUT"
    || error?.name === "AbortError"
    || error?.name === "TimeoutError"
    || /timeout|aborted/i.test(String(error?.message || ""));
}

function safeFailure(configured, reason) {
  return {
    configured,
    connected: false,
    reason,
    updatedAt: null,
    accounts: [],
  };
}

export class GeminiQuotaService {
  constructor({
    dataDir = "",
    network = null,
    fetchFn = globalThis.fetch,
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    now = Date.now,
  } = {}) {
    this.dataDir = typeof dataDir === "string" ? dataDir : "";
    this.network = network;
    this.fetchFn = fetchFn;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TOTAL_TIMEOUT_MS;
    this.now = typeof now === "function" ? now : Date.now;
    this.epoch = 0;
    this.cachedResult = null;
    this.cachedAt = 0;
    this.inFlight = null;
    this.inFlightEpoch = -1;
    this.authPausedEpoch = null;
    this.controllers = new Set();
  }

  get configPath() {
    return this.dataDir ? path.join(this.dataDir, GEMINI_CPA_CONFIG_FILE) : "";
  }

  readManagementKey() {
    if (!this.configPath) return "";
    try {
      if (!fs.existsSync(this.configPath)) return "";
      const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      return safeString(parsed?.managementKey);
    } catch {
      return "";
    }
  }

  getConfig() {
    return { configured: !!this.readManagementKey(), baseUrl: GEMINI_CPA_BASE_URL };
  }

  saveConfig(input = {}) {
    const { action, managementKey } = input && typeof input === "object" ? input : {};
    if (action !== "save" && action !== "clear") return { ok: false, code: "INVALID_INPUT" };
    if (action === "save") {
      if (typeof managementKey !== "string") return { ok: false, code: "INVALID_INPUT" };
      const key = managementKey.trim();
      if (!key || key.length > MANAGEMENT_KEY_MAX_LENGTH || /[\u0000\r\n]/.test(key)) {
        return { ok: false, code: "INVALID_INPUT" };
      }
      return this.writeConfig({ managementKey: key });
    }
    return this.writeConfig({});
  }

  writeConfig(config) {
    if (!this.configPath) return { ok: false, code: "NO_DATA_DIR" };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      writeFileAtomic(this.configPath, JSON.stringify(config), 0o600);
    } catch {
      return { ok: false, code: "STORAGE_UNAVAILABLE" };
    }
    this.invalidate();
    return {
      ok: true,
      configured: !!config.managementKey,
      baseUrl: GEMINI_CPA_BASE_URL,
    };
  }

  invalidate() {
    this.epoch += 1;
    this.authPausedEpoch = null;
    this.cachedResult = null;
    this.cachedAt = 0;
    for (const controller of this.controllers) {
      try { controller.abort(); } catch {}
    }
    this.controllers.clear();
  }

  pauseAuth(epoch) {
    if (epoch !== this.epoch) return false;
    this.authPausedEpoch = epoch;
    for (const controller of this.controllers) {
      try { controller.abort(); } catch {}
    }
    this.controllers.clear();
    return true;
  }

  currentSafeDto() {
    const configured = !!this.readManagementKey();
    return configured ? safeFailure(true, "not_checked") : emptyDto(false, "not_configured");
  }

  async getQuota() {
    const managementKey = this.readManagementKey();
    if (!managementKey) return emptyDto(false, "not_configured");
    if (this.authPausedEpoch === this.epoch) return safeFailure(true, "unauthorized");

    const now = this.now();
    if (this.cachedResult && now - this.cachedAt < this.ttlMs) return this.cachedResult;
    if (this.inFlight && this.inFlightEpoch === this.epoch) return this.inFlight;

    const epoch = this.epoch;
    const task = this.fetchQuota(managementKey, epoch)
      .then((result) => (epoch === this.epoch ? result : this.currentSafeDto()))
      .catch(() => (epoch === this.epoch ? safeFailure(true, "service_error") : this.currentSafeDto()))
      .then((result) => {
        if (epoch === this.epoch) {
          this.cachedResult = result;
          this.cachedAt = this.now();
        }
        return result;
      })
      .finally(() => {
        if (this.inFlight === task) {
          this.inFlight = null;
          this.inFlightEpoch = -1;
        }
      });
    this.inFlight = task;
    this.inFlightEpoch = epoch;
    return task;
  }

  async fetchQuota(managementKey, epoch) {
    const deadline = Date.now() + this.timeoutMs;
    let credentialsResult;
    try {
      credentialsResult = await this.request(GEMINI_CREDENTIALS_URL, {
        method: "GET",
        headers: { ...MANAGEMENT_HEADERS, Authorization: `Bearer ${managementKey}` },
      }, deadline);
    } catch (error) {
      return safeFailure(true, isTimeout(error) ? "timeout" : "network_error");
    }

    const status = Number(credentialsResult?.response?.status) || 0;
    if (status === 401 || status === 403) {
      this.pauseAuth(epoch);
      return safeFailure(true, "unauthorized");
    }
    if (status === 429) return safeFailure(true, "rate_limited");
    if (status < 200 || status >= 300) return safeFailure(true, "upstream_error");
    if (credentialsResult.bodyError || !credentialsResult.body) return safeFailure(true, "invalid_response");

    const credentialsBody = credentialsResult.body;
    if (!Array.isArray(credentialsBody.files)) return safeFailure(true, "invalid_response");

    const accounts = credentialsBody.files
      .filter(isAntigravity)
      .map((file, index) => this.normalizeAccount(file, index));
    const quotaAccounts = await this.queryAccounts(accounts, deadline, epoch, managementKey);
    if (this.authPausedEpoch === epoch) return safeFailure(true, "unauthorized");
    return {
      configured: true,
      connected: true,
      reason: accounts.length ? null : "no_accounts",
      updatedAt: this.now(),
      accounts: quotaAccounts,
    };
  }

  normalizeAccount(file, index) {
    const authIndex = authIndexOf(file);
    return {
      id: stableAccountId(file, index),
      label: maskLabel(file),
      health: accountHealth(file),
      quotaStatus: isDisabled(file) ? "not_checked" : "error",
      groups: [],
      authIndex,
      projectId: projectIdOf(file),
    };
  }

  async queryAccounts(accounts, deadline, epoch, managementKey) {
    const results = new Array(accounts.length);
    let next = 0;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= accounts.length) return;
        const account = accounts[index];
        if (this.authPausedEpoch === epoch) {
          results[index] = { ...account, quotaStatus: "error" };
          continue;
        }
        if (account.quotaStatus === "not_checked") {
          results[index] = account;
          continue;
        }
        if (!account.projectId || account.authIndex === null) {
          results[index] = { ...account, quotaStatus: account.projectId ? "error" : "missing_project" };
          continue;
        }
        if (Date.now() >= deadline || epoch !== this.epoch) {
          results[index] = { ...account, quotaStatus: "timeout" };
          continue;
        }
        results[index] = await this.queryAccount(account, deadline, epoch, managementKey);
      }
    };
    const workerCount = Math.min(MAX_ACCOUNT_CONCURRENCY, accounts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results.map((account, index) => account || {
      ...accounts[index],
      quotaStatus: "timeout",
      groups: [],
    }).map(({ authIndex, projectId, ...account }) => account);
  }

  async queryAccount(account, deadline, epoch, managementKey) {
    let sawEmpty = false;
    let sawInvalid = false;
    let sawTimeout = false;
    for (const quotaUrl of GEMINI_QUOTA_URLS) {
      if (this.authPausedEpoch === epoch) return { ...account, quotaStatus: "error", groups: [] };
      if (Date.now() >= deadline || epoch !== this.epoch) return { ...account, quotaStatus: "timeout" };
      const body = {
        auth_index: account.authIndex,
        method: "POST",
        url: quotaUrl,
        header: { ...QUOTA_HEADERS },
        data: JSON.stringify({ project: account.projectId }),
      };
      let quotaResult;
      try {
        quotaResult = await this.request(GEMINI_API_CALL_URL, {
          method: "POST",
          headers: {
            ...MANAGEMENT_HEADERS,
            Authorization: `Bearer ${managementKey}`,
          },
          body: JSON.stringify(body),
        }, deadline);
      } catch (error) {
        if (this.authPausedEpoch === epoch) return { ...account, quotaStatus: "error", groups: [] };
        if (isTimeout(error)) {
          sawTimeout = true;
          if (Date.now() >= deadline) return { ...account, quotaStatus: "timeout" };
        }
        continue;
      }
      const outerStatus = Number(quotaResult?.response?.status) || 0;
      if (outerStatus === 401 || outerStatus === 403) {
        this.pauseAuth(epoch);
        return { ...account, quotaStatus: "error", groups: [] };
      }
      if (outerStatus < 200 || outerStatus >= 300) continue;
      if (quotaResult.bodyError) continue;
      const inner = quotaResult.body;
      const innerStatus = Number(inner?.status_code ?? inner?.statusCode) || 0;
      if (innerStatus < 200 || innerStatus >= 300) continue;
      const payload = parseObject(inner.body ?? inner.data);
      if (!payload || !Array.isArray(payload.groups)) {
        sawInvalid = true;
        continue;
      }
      const groups = buildGroups(payload, account.projectId);
      if (groups.length) return { ...account, quotaStatus: "ok", groups };
      sawEmpty = true;
    }
    return {
      ...account,
      quotaStatus: sawTimeout ? "timeout" : sawEmpty ? "empty" : "error",
      groups: [],
    };
  }

  async readBody(response) {
    if (typeof response?.json === "function") {
      const value = await response.json();
      return typeof value === "string" ? parseObject(value) : value;
    }
    if (typeof response?.text === "function") return parseObject(await response.text());
    return null;
  }

  async request(url, init, deadline) {
    const doFetch = typeof this.network?.fetch === "function"
      ? (target, options) => this.network.fetch(target, options)
      : this.fetchFn;
    if (typeof doFetch !== "function") throw Object.assign(new Error("network unavailable"), { code: "NETWORK_UNAVAILABLE" });

    const remaining = Math.max(1, deadline - Date.now());
    const timeoutMs = Math.min(SINGLE_REQUEST_TIMEOUT_MS, remaining);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    if (controller) this.controllers.add(controller);
    let timer = null;
    let timedOut = false;
    const options = {
      ...init,
      redirect: "error",
      maxResponseBytes: MAX_RESPONSE_BYTES,
      timeoutMs,
      ...(controller ? { signal: controller.signal } : {}),
    };
    const requestPromise = Promise.resolve().then(async () => {
      const response = await doFetch(url, options);
      const status = Number(response?.status) || 0;
      if (status < 200 || status >= 300) return { response, body: null, bodyError: null };
      let body = null;
      let bodyError = null;
      try {
        body = await this.readBody(response);
      } catch (error) {
        bodyError = error;
      }
      return { response, body, bodyError };
    });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        try { controller?.abort(); } catch {}
        reject(timeoutError());
      }, timeoutMs);
    });
    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      if (controller) this.controllers.delete(controller);
      if (timedOut) requestPromise.catch(() => {});
    }
  }
}
