// Average request throughput: dispatch -> finalized assistant message.
// Includes provider response latency; never claims instantaneous streamed TPS.
import { classifyError } from "./runtime-health.mjs";
import { RetainedMap, observeAsync } from "./retained-map.mjs";
import { extractSessionIdentity } from "./session-identity.mjs";
const clockNow = () => globalThis.performance?.now?.() ?? Date.now();
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;

export class GenerationSpeedTimer {
  constructor({ clock = clockNow, keep = 8, staleMs = 300000, maxSessions = 512, ttlMs = 1800000 } = {}) {
    this.clock = clock;
    this.keep = keep;
    this.staleMs = staleMs;
    const retention = { max: maxSessions, ttlMs, clock };
    this.pending = new RetainedMap({ ...retention, ttlMs: Math.min(ttlMs, staleMs) });
    this.samples = new RetainedMap(retention);
    this.paths = new RetainedMap(retention);
  }

  identity(session) {
    const raw = extractSessionIdentity(session);
    const sessionId = raw.sessionId;
    const sessionPath = raw.sessionPath || (sessionId ? this.paths.get(sessionId) : null) || null;
    if (!sessionPath) return null; // No guessing from hook UUIDs.
    if (sessionId) this.paths.set(sessionId, sessionPath);
    return { sessionId, sessionPath };
  }

  begin(session) {
    const identity = this.identity(session);
    const started = this.clock();
    if (!identity || !Number.isFinite(started)) return false;
    // Host serializes provider calls per session. A retry replaces a failed start.
    this.pending.set(identity.sessionPath, started);
    return true;
  }

  complete(session, message) {
    const identity = this.identity(session);
    if (!identity || !this.pending.has(identity.sessionPath)) return null;
    const started = this.pending.get(identity.sessionPath);
    this.pending.delete(identity.sessionPath);
    const durationMs = this.clock() - started;
    const output = typeof message?.usage?.output === "object" ? message.usage.output?.totalTokens : message?.usage?.output;
    if (message?.role !== "assistant" || ["error", "aborted"].includes(message.stopReason)
      || !positive(output) || !(durationMs >= 100 && durationMs < this.staleMs)) {
      this.fail(session, message?.stopReason === "aborted" ? "cancelled" : message?.stopReason === "error" ? "request_failed" : "invalid_data");
      return null;
    }
    const modelId = typeof message.model === "string" ? message.model : message.model?.modelId;
    if (!modelId) { this.fail(session, "invalid_data"); return null; }
    const modelKey = message.provider ? `${message.provider}/${modelId}` : modelId;
    const models = this.samples.get(identity.sessionPath) || new Map();
    models.delete("unavailable");
    const samples = models.get(modelKey) || [];
    samples.push({ output, durationMs });
    while (samples.length > this.keep) samples.shift();
    models.set(modelKey, samples);
    if (models.size > 16) models.delete(models.keys().next().value);
    this.samples.set(identity.sessionPath, models);
    return { ...identity, ...this.latest(session, modelKey), output, durationMs };
  }

  latest(session, modelKey) {
    this.prune();
    const identity = this.identity(session);
    const models = identity ? this.samples.get(identity.sessionPath) : null;
    const pending = identity && this.pending.has(identity.sessionPath);
    if (pending && (!models || models.has("unavailable") || !models.get(modelKey)?.length)) return { scope: "session", tps: null, unavailable: true, reason: "pending" };
    if (models?.has("unavailable")) return { scope: "session", tps: null, unavailable: true, reason: models.get("unavailable") };
    const samples = models?.get(modelKey);
    if (!samples?.length) return null;
    const output = samples.reduce((sum, sample) => sum + sample.output, 0);
    const duration = samples.reduce((sum, sample) => sum + sample.durationMs, 0);
    return { scope: "session", historical: pending, reason: pending ? "pending" : "ok", mode: "request-duration", modelKey, count: samples.length, tps: output * 1000 / duration };
  }

  fail(session, reason = "request_failed") {
    const identity = this.identity(session);
    if (!identity) return;
    this.pending.delete(identity.sessionPath);
    this.samples.set(identity.sessionPath, new Map([["unavailable", reason]]));
  }

  prune() {
    const failures = [];
    for (const [sessionPath, expiry] of this.pending.expiry) {
      if (expiry <= this.clock()) {
        this.fail({ sessionPath }, "timeout");
        failures.push({ sessionPath, unavailable: true, reason: "timeout" });
      }
    }
    for (const map of [this.pending, this.samples, this.paths]) map.prune();
    return failures;
  }

  clear() {
    this.pending.clear();
    this.samples.clear();
    this.paths.clear();
  }
}

export async function registerGenerationSpeedHook({ hooks, timer, onMetric = () => {}, onFailure = () => {}, onStatus = () => {}, log = () => {} } = {}) {
  let registration;
  const note = (...args) => observeAsync(() => log("warn", ...args));
  let disposed = false;
  if (!hooks?.onDecision || !timer) { onStatus("degraded", "unavailable"); return async () => {}; }
  try {
    registration = await hooks.onDecision("messages/post-assistant", invocation => {
      if (disposed) return undefined;
      const sample = timer.complete(invocation?.session, invocation?.message);
      if (sample) observeAsync(() => onMetric(sample), error => note("速度状态更新失败：", error?.message || error));
      else {
        const metric = timer.latest(invocation?.session, null);
        if (metric?.unavailable) {
          if (["error", "aborted"].includes(invocation?.message?.stopReason)) observeAsync(() => onFailure(invocation?.session, metric.reason));
          observeAsync(() => onMetric({ ...invocation?.session, ...metric }), error => note("速度状态更新失败：", error?.message || error));
        }
      }
      return undefined; // Never rewrite message content or usage.
    });
    if (registration?.ready) await registration.ready;
    if (registration) onStatus("ok", "hook_ok");
  } catch (error) { onStatus("degraded", classifyError(error)); note("速度完成消息钩子不可用：", error?.message || error); }
  return async () => {
    if (disposed) return;
    disposed = true;
    try {
      if (registration?.disposeAsync) await registration.disposeAsync();
      else if (typeof registration === "function") await registration();
      else await registration?.unsubscribe?.();
    } catch (error) { note("速度钩子释放失败：", error?.message || error); }
    timer.clear();
  };
}
