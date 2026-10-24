// lib/session-sources.mjs
// 官方会话 namespace 查询器：有界调度、正负缓存与安全降级。
//
// 只调用官方 sdk.sessions.get({ sessionId, scope: "all" })（或等价的 bus session:get），
// 只读取返回对象的 namespace 字段；标题、正文、路径等一律不落地、不写日志。
// 分类失败只影响来源完整性，不允许把账本扫描拖失败。
import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_PER_SCAN = 8;
const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CANDIDATES_LIMIT = 24;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_NAMESPACE_LENGTH = 64;
const MAX_FAILED_IDS_REPORTED = 64;
const MAX_WINDOW = 256;
const MAX_PENDING = 256;

const noop = () => {};

function hashId(id) {
  return createHash("sha256").update(String(id)).digest("hex").slice(0, 12);
}

function normalizeId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SESSION_ID_LENGTH) return null;
  if (trimmed === "__proto__" || trimmed === "constructor" || trimmed === "prototype") return null;
  return trimmed;
}

export function createSessionSourceResolver({
  sdk,
  client,
  dataDir, // 保留签名占位：映射持久化由引擎侧负责
  log = null,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxPerScan = DEFAULT_MAX_PER_SCAN,
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS,
  candidatesLimit = DEFAULT_CANDIDATES_LIMIT,
} = {}) {
  void dataDir;
  const logger = log || { info: noop, warn: noop, error: noop };
  const failures = new Map(); // sessionId -> timestamp（负缓存，进程内）
  const known = new Map(); // sessionId -> namespace（引擎已确认）
  const pending = new Map(); // sessionId -> namespace（已查到但引擎尚未确认接收）
  const coolingLocal = new Map(); // sessionId -> timestamp（引擎持久冷却的本地镜像）
  const inFlightIds = new Set();
  let active = 0;
  const waiting = [];
  let disposed = false;

  const canQuery = () =>
    typeof sdk?.sessions?.get === "function" || typeof sdk?.bus?.request === "function";

  function acquire(deadline) {
    if (active < maxInFlight) {
      active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = {
        grant() {
          clearTimeout(timer);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        resolve(false);
      }, Math.max(1, deadline));
      timer.unref?.();
      waiting.push(waiter);
    });
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = waiting.shift();
    if (next && active < maxInFlight) {
      active += 1;
      next.grant();
    }
  }

  async function requestNamespace(sessionId) {
    let result;
    if (typeof sdk?.sessions?.get === "function") {
      result = await sdk.sessions.get({ sessionId, scope: "all" });
    } else {
      result = await sdk.bus.request("session:get", { sessionId, scope: "all" });
    }
    if (result?.error) return null;
    const session = result?.session;
    if (!session || typeof session !== "object") return null;
    const namespace = session.namespace;
    if (typeof namespace !== "string") return null;
    const trimmed = namespace.trim();
    if (!trimmed || trimmed.length > MAX_NAMESPACE_LENGTH) return null;
    return trimmed;
  }

  // 底层请求真正结束前一直占用在途名额；调用方只等到 timeoutMs。
  function query(sessionId) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ timeout: true }), Math.max(1, timeoutMs));
      timer.unref?.();
      const pending = Promise.resolve()
        .then(() => requestNamespace(sessionId))
        .then(
          (namespace) => {
            release();
            inFlightIds.delete(sessionId);
            finish({ namespace });
          },
          (error) => {
            release();
            inFlightIds.delete(sessionId);
            finish({ error });
          },
        );
      void pending;
    });
  }

  function eligible(sessionId) {
    if (disposed) return false;
    if (known.has(sessionId)) return false;
    if (pending.has(sessionId)) return false;
    if (inFlightIds.has(sessionId)) return false;
    const failedAt = failures.get(sessionId);
    if (failedAt !== undefined) {
      if (now() - failedAt < negativeTtlMs) return false;
      failures.delete(sessionId);
    }
    return true;
  }

  function coolingActive(sessionId) {
    const at = coolingLocal.get(sessionId);
    if (at === undefined) return false;
    if (now() - at < negativeTtlMs) return true;
    coolingLocal.delete(sessionId);
    return false;
  }

  function candidatesFromEntries(entries) {
    const seen = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const id = normalizeId(entry?.attribution?.sessionId);
      if (!id) continue;
      const ts = typeof entry?.startedAt === "string" ? entry.startedAt : "";
      const previous = seen.get(id);
      if (previous === undefined || ts > previous) seen.set(id, ts);
    }
    return [...seen.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id);
  }

  // 历史候选与 recent 候选的已知/冷却状态都由引擎持久层给出，重启后仍然有效。
  async function candidateState(recentIds) {
    const empty = { ok: false, sessionIds: [], known: new Set(), cooling: new Set() };
    if (!client || typeof client.call !== "function") return empty;
    try {
      const result = await client.call("sessions.candidates", { limit: candidatesLimit, recent: recentIds });
      const list = Array.isArray(result) ? result : Array.isArray(result?.sessionIds) ? result.sessionIds : [];
      const ids = [];
      for (const value of list) {
        const id = normalizeId(value);
        if (id) ids.push(id);
      }
      const knownStates = new Map();
      for (const [id, namespace] of Object.entries(result?.known || {})) {
        const normalized = normalizeId(id);
        if (normalized) knownStates.set(normalized, typeof namespace === "string" ? namespace : "");
      }
      const cooling = new Set();
      for (const value of Array.isArray(result?.cooling) ? result.cooling : []) {
        const id = normalizeId(value);
        if (id) cooling.add(id);
      }
      return { ok: true, sessionIds: ids, known: knownStates, cooling };
    } catch (error) {
      logger.warn?.(`[token-tracker] session candidates unavailable: ${error?.code || "UNKNOWN"}; classification skipped this round`);
      return empty;
    }
  }

  function deliver() {
    const sessionNamespaces = {};
    let count = 0;
    for (const [sessionId, namespace] of pending) {
      if (count >= MAX_PENDING) break;
      sessionNamespaces[sessionId] = namespace;
      count += 1;
    }
    return sessionNamespaces;
  }

  function emptyResult(capability) {
    return { sessionNamespaces: deliver(), sourceResolution: { capability, failedSessionIds: [] } };
  }

  async function resolve(entries) {
    if (disposed) return emptyResult("unavailable");
    if (!canQuery()) return emptyResult("unavailable");

    const recentIds = candidatesFromEntries(entries);
    // 只对经过本地已知/待提交/冷却过滤后的前 256 个 recent ID 请求持久状态，窗口随进度推进。
    const windowSource = recentIds.filter((id) => {
      if (known.has(id) || pending.has(id) || coolingActive(id)) return false;
      return eligible(id);
    });
    const window = windowSource.slice(0, MAX_WINDOW);
    const candidateStateResult = await candidateState(window);
    if (!candidateStateResult.ok) return emptyResult("ready");
    for (const [sessionId, namespace] of candidateStateResult.known) {
      if (namespace === "") failures.set(sessionId, now());
      else known.set(sessionId, namespace);
    }
    for (const sessionId of candidateStateResult.cooling) coolingLocal.set(sessionId, now());

    const skip = (sessionId) => known.has(sessionId) || coolingActive(sessionId);
    const available = MAX_PENDING - pending.size;
    if (available <= 0) return emptyResult("ready");

    const recentSet = new Set(window);
    const newCandidates = window.filter((id) => eligible(id) && !skip(id));
    const history = candidateStateResult.sessionIds.filter((id) => !recentSet.has(id) && eligible(id) && !skip(id));

    const budget = Math.min(Math.max(1, Math.floor(maxPerScan)), available);
    const reserveForHistory = history.length ? 1 : 0;
    const newQuota = Math.max(0, budget - reserveForHistory);
    const pickedNew = newCandidates.slice(0, newQuota);
    const pickedHistory = history.slice(0, Math.max(0, budget - pickedNew.length));
    const picks = [...new Set([...pickedNew, ...pickedHistory])];

    const failed = [];
    const capability = "ready";

    await Promise.all(picks.map(async (sessionId) => {
      if (disposed) return;
      inFlightIds.add(sessionId);
      const granted = await acquire(timeoutMs);
      if (!granted) {
        inFlightIds.delete(sessionId);
        return;
      }
      if (disposed) {
        inFlightIds.delete(sessionId);
        release();
        return;
      }
      const outcome = await query(sessionId);
      if (outcome.timeout) {
        logger.warn?.(`[token-tracker] session namespace lookup timed out for ${hashId(sessionId)}`);
        failures.set(sessionId, now());
        failed.push(sessionId);
        return;
      }
      if (outcome.error) {
        const code = outcome.error?.code || "";
        logger.warn?.(`[token-tracker] session namespace lookup failed for ${hashId(sessionId)}: ${code || "UNKNOWN"}`);
        failures.set(sessionId, now());
        failed.push(sessionId);
        return;
      }
      if (!outcome.namespace) {
        // 会话不存在或缺少 namespace：不猜测类别，稍后重试。
        failures.set(sessionId, now());
        failed.push(sessionId);
        return;
      }
      // 先待提交，等引擎 scan 确认后再转 known；扫描失败时下次继续重发。
      if (pending.size < MAX_PENDING) pending.set(sessionId, outcome.namespace);
      failures.delete(sessionId);
    }));

    return {
      sessionNamespaces: deliver(),
      sourceResolution: {
        capability,
        failedSessionIds: failed.slice(0, MAX_FAILED_IDS_REPORTED),
      },
    };
  }

  // 引擎已接收并持久化这些会话的映射。
  async function ack(sessionIds) {
    const ids = Array.isArray(sessionIds) ? sessionIds : sessionIds == null ? [] : [sessionIds];
    for (const value of ids) {
      const sessionId = normalizeId(value);
      if (!sessionId) continue;
      const namespace = pending.get(sessionId);
      if (namespace === undefined) continue;
      pending.delete(sessionId);
      known.set(sessionId, namespace);
    }
  }

  async function dispose() {
    disposed = true;
    failures.clear();
    known.clear();
    pending.clear();
    coolingLocal.clear();
    while (waiting.length) {
      const waiter = waiting.shift();
      waiter?.grant?.();
    }
  }

  return { resolve, ack, dispose };
}

export default { createSessionSourceResolver };
