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
  constructor({ clock = defaultClock, staleMs = 300000, maxPending = 8, keep = 8 } = {}) {
    this.clock = clock;
    this.staleMs = staleMs;
    this.maxPending = maxPending;
    this.keep = keep;
    this.pending = new Map();
    this.samples = new Map();
    this.pathToSessionId = new Map();
    this.sessionPathById = new Map();
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
      this.samples.set(pathKey, [...existing, ...previous].slice(-this.keep));
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
    if (!samples?.length) return null;
    return {
      sessionId: identity.sessionId,
      sessionPath: identity.sessionPath,
      lastMs: samples[samples.length - 1],
      avgMs: Math.round(samples.reduce((sum, sample) => sum + sample, 0) / samples.length),
      count: samples.length,
    };
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
export async function registerFirstResponseHooks({ hooks, timer, onMetric = () => {}, onRequestStart = () => {}, log = () => {} } = {}) {
  if (!hooks || !timer) return async () => {};
  const registrations = [];
  const note = (level, ...args) => { try { log(level, ...args); } catch {} };
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
      timer.begin(invocation?.session);
      try { onRequestStart(invocation?.session); } catch (error) { note("warn", "请求计时启动失败：", error?.message || error); }
      return undefined;
    }));
  } else {
    note("warn", "首响不可用：hooks.onDecision 未提供");
  }

  if (typeof hooks.on === "function") {
    afterRegistered = await attach("provider/after-response", () => hooks.on("provider/after-response", event => {
      const metric = timer.complete(event?.session);
      if (!metric) return;
      try { onMetric(metric); } catch (error) { note("warn", "首响状态更新失败:", error?.message || error); }
    }));
  } else {
    note("warn", "首响不可用：hooks.on 未提供");
  }

  if (beforeRegistered && afterRegistered) note("info", "首响计时已注册（请求发出 → provider 响应元数据到达；不是首 token 时间）");
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    const results = await Promise.allSettled(registrations.map(async registration => {
      if (registration?.disposeAsync) return registration.disposeAsync();
      if (typeof registration === "function") return registration();
      return registration?.unsubscribe?.();
    }));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) note("warn", `首响 hook 释放失败：${failures.length} 项`);
  };
}
