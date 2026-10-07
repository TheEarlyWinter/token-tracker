import { RetainedMap, observeAsync } from "./retained-map.mjs";

const defaultClock = () => {
  const value = globalThis.performance?.now?.();
  return Number.isFinite(value) ? value : Date.now();
};

function identityOf(value) {
  if (typeof value === "string" && value) return { sessionId: value, sessionPath: null };
  const session = value && typeof value === "object" ? value : {};
  return {
    sessionId: typeof session.sessionId === "string" && session.sessionId ? session.sessionId : null,
    sessionPath: typeof session.sessionPath === "string" && session.sessionPath ? session.sessionPath : null,
  };
}

export class FirstResponseTimer {
  constructor({ clock = defaultClock, staleMs = 300000, maxPending = 8, keep = 8, maxSessions = 512, ttlMs = 1800000 } = {}) {
    this.clock = clock;
    this.staleMs = staleMs;
    this.maxPending = maxPending;
    this.keep = keep;
    const retention = { max: maxSessions, ttlMs, clock };
    this.pending = new RetainedMap({ ...retention, ttlMs: Math.min(ttlMs, staleMs) });
    this.samples = new RetainedMap(retention);
    this.pathToSessionId = new RetainedMap(retention);
    this.sessionPathById = new RetainedMap(retention);
  }

  bind(sessionId, sessionPath) {
    if (typeof sessionId !== "string" || !sessionId || typeof sessionPath !== "string" || !sessionPath) return;
    const idKey = `id:${sessionId}`;
    const pathKey = `path:${sessionPath}`;
    this.pathToSessionId.set(sessionPath, sessionId);
    this.sessionPathById.set(sessionId, sessionPath);
    // Hook sessionId may be the file UUID while the ledger uses a manifest ID.
    // Path owns the queue/ring; both IDs are aliases, never separate sample stores.
    if (this.pending.has(idKey)) {
      const queued = this.pending.get(idKey);
      this.pending.delete(idKey);
      const existing = this.pending.get(pathKey) || [];
      this.pending.set(pathKey, [...existing, ...queued].sort((a, b) => a - b).slice(-this.maxPending));
    }
    if (this.samples.has(idKey)) {
      const previous = this.samples.get(idKey);
      this.samples.delete(idKey);
      const existing = this.samples.get(pathKey) || [];
      this.samples.set(pathKey, previous.unavailable ? previous : [...existing, ...previous].slice(-this.keep));
    }
  }

  keyFor(value) {
    const identity = identityOf(value);
    if (identity.sessionId && identity.sessionPath) this.bind(identity.sessionId, identity.sessionPath);
    const sessionPath = identity.sessionPath || this.sessionPathById.get(identity.sessionId) || null;
    const sessionId = identity.sessionId || this.pathToSessionId.get(sessionPath) || null;
    if (sessionPath) return { key: `path:${sessionPath}`, sessionId, sessionPath };
    if (sessionId) return { key: `id:${sessionId}`, sessionId, sessionPath: null };
    return null;
  }

  begin(session) {
    const identity = this.keyFor(session);
    if (!identity) return false;
    const now = this.clock();
    if (!Number.isFinite(now)) return false;
    const queue = this.pending.get(identity.key) || [];
    while (queue.length && now - queue[0] >= this.staleMs) queue.shift();
    queue.push(now);
    while (queue.length > this.maxPending) queue.shift();
    this.pending.set(identity.key, queue);
    return true;
  }

  complete(session) {
    const identity = this.keyFor(session);
    if (!identity) return null;
    const queue = this.pending.get(identity.key);
    if (!queue?.length) return null;
    const now = this.clock();
    while (queue.length && now - queue[0] >= this.staleMs) queue.shift();
    if (!queue.length) {
      this.pending.delete(identity.key);
      return null;
    }
    const startedAt = queue.shift();
    if (!queue.length) this.pending.delete(identity.key);
    const lastMs = now - startedAt;
    if (!(lastMs > 0 && lastMs < this.staleMs)) return null;
    const samples = this.samples.get(identity.key) || [];
    delete samples.unavailable;
    samples.push(lastMs);
    while (samples.length > this.keep) samples.shift();
    this.samples.set(identity.key, samples);
    return {
      sessionId: identity.sessionId,
      sessionPath: identity.sessionPath,
      lastMs,
      avgMs: Math.round(samples.reduce((sum, sample) => sum + sample, 0) / samples.length),
      count: samples.length,
    };
  }

  latest(session) {
    const identity = this.keyFor(session);
    if (!identity) return null;
    const samples = this.samples.get(identity.key);
    if (samples?.unavailable) return { ...identity, lastMs: null, unavailable: true };
    if (!samples?.length) return null;
    return {
      sessionId: identity.sessionId,
      sessionPath: identity.sessionPath,
      lastMs: samples[samples.length - 1],
      avgMs: Math.round(samples.reduce((sum, sample) => sum + sample, 0) / samples.length),
      count: samples.length,
    };
  }

  fail(session) {
    const identity = this.keyFor(session);
    if (!identity) return null;
    this.pending.delete(identity.key);
    const samples = [];
    samples.unavailable = true;
    this.samples.set(identity.key, samples);
    return { ...identity, lastMs: null, unavailable: true };
  }

  prune() {
    const failures = [];
    for (const [key, expiry] of this.pending.expiry) {
      if (expiry <= this.clock()) {
        const metric = this.fail(key.startsWith("path:") ? { sessionPath: key.slice(5) } : { sessionId: key.slice(3) });
        if (metric) failures.push(metric);
      }
    }
    for (const map of [this.pending, this.samples, this.pathToSessionId, this.sessionPathById]) map.prune();
    return failures;
  }

  clear() {
    this.pending.clear();
    this.samples.clear();
    this.pathToSessionId.clear();
    this.sessionPathById.clear();
  }
}

/**
 * Measure request dispatch to the provider/after-response metadata event.
 * This is "首响" latency, not true time-to-first-token: the App observation
 * event exposes response metadata only and never exposes token chunks.
 */
export async function registerFirstResponseHooks({ hooks, timer, onMetric = () => {}, onRequestStart = () => {}, onFailure = () => {}, log = () => {} } = {}) {
  if (!hooks || !timer) return async () => {};
  const registrations = [];
  let disposed = false;
  const note = (level, ...args) => observeAsync(() => log(level, ...args));
  const attach = async (label, work) => {
    try {
      const registration = await work();
      if (registration) {
        registrations.push(registration);
        if (registration.ready && typeof registration.ready.then === "function") {
          try { await registration.ready; }
          catch (error) {
            note("warn", `${label} hook permission unavailable:`, error?.message || error);
            return false;
          }
        }
      }
      return true;
    } catch (error) {
      note("warn", `${label} hook registration failed:`, error?.message || error);
      return false;
    }
  };

  let beforeRegistered = false;
  let afterRegistered = false;
  if (typeof hooks.onDecision === "function") {
    beforeRegistered = await attach("provider/before-request", () => hooks.onDecision("provider/before-request", invocation => {
      if (disposed) return undefined;
      // Physical-session provider calls are serialized; a retry replaces an
      // abandoned start rather than measuring the previous failed attempt.
      const identity = timer.keyFor(invocation?.session);
      if (identity) timer.pending.delete(identity.key);
      timer.begin(invocation?.session);
      observeAsync(() => onRequestStart(invocation?.session), error => note("warn", "请求计时启动失败：", error?.message || error));
      return undefined;
    }));
  } else {
    note("warn", "首响不可用：hooks.onDecision 未提供");
  }

  if (typeof hooks.on === "function") {
    afterRegistered = await attach("provider/after-response", () => hooks.on("provider/after-response", event => {
      if (disposed) return;
      const failed = typeof event?.status === "number" && event.status >= 400;
      const metric = failed ? timer.fail(event?.session) : timer.complete(event?.session);
      if (failed) observeAsync(() => onFailure(event?.session));
      if (!metric) return;
      observeAsync(() => onMetric(metric), error => note("warn", "首响状态更新失败:", error?.message || error));
    }));
  } else {
    note("warn", "首响不可用：hooks.on 未提供");
  }

  if (beforeRegistered && afterRegistered) note("info", "首响计时已注册（请求发出 → provider 响应元数据到达；不是首 token 时间）");
  return async () => {
    if (disposed) return;
    disposed = true;
    timer.clear();
    const results = await Promise.allSettled(registrations.map(async registration => {
      if (registration?.disposeAsync) return registration.disposeAsync();
      if (typeof registration === "function") return registration();
      return registration?.unsubscribe?.();
    }));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) note("warn", `首响 hook 释放失败：${failures.length} 项`);
  };
}
