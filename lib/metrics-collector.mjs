import { FirstResponseTimer, registerFirstResponseHooks } from "./first-response.mjs";
import { GenerationSpeedTimer, registerGenerationSpeedHook } from "./generation-speed.mjs";
import { SessionCacheStatus } from "./session-cache.mjs";
import { observeAsync } from "./retained-map.mjs";

export async function initMetricsCollector({ sdk, shared, log }) {
  const firstResponseTimer = new FirstResponseTimer();
  const generationSpeedTimer = new GenerationSpeedTimer();

  const sessionCache = new SessionCacheStatus({
    bus: sdk.bus,
    inputStatus: sdk.inputStatus,
    sessions: sdk.sessions,
    health: shared.health,
    firstResponseQuery: (sessionId, sessionPath) => {
      const state = shared.health.components.get("firstResponse");
      return state?.state === "degraded"
        ? { unavailable: true, reason: state.code }
        : firstResponseTimer.latest({ sessionId, sessionPath });
    },
    generationSpeedQuery: (sessionId, sessionPath, modelKey) => {
      const state = shared.health.components.get("speed");
      return state?.state === "degraded"
        ? { unavailable: true, reason: state.code }
        : generationSpeedTimer.latest({ sessionId, sessionPath }, modelKey);
    },
    log: (level, ...args) => { try { log[level]?.(...args); } catch {} },
  });

  const stopFirstResponseHooks = await registerFirstResponseHooks({
    hooks: sdk.hooks,
    timer: firstResponseTimer,
    onStatus: (state, code) => shared.health.set("firstResponse", state, code),
    onRequestStart: (session) => {
      generationSpeedTimer.begin(session);
      shared.health.metric("speed", "pending");
      shared.health.metric("firstResponse", "pending");
      observeAsync(() => sessionCache.onFirstResponseMetric(session));
    },
    onFailure: (session, reason) => {
      generationSpeedTimer.fail(session, reason);
      shared.health.metric("speed", reason);
    },
    onMetric: (metric) => {
      shared.health.metric("firstResponse", metric.reason || "ok");
      sessionCache.onFirstResponseMetric(metric).catch((error) => {
        try { log.warn?.("首响状态更新失败：", error?.message || error); } catch {}
      });
    },
    log: (level, ...args) => { try { log[level]?.(...args); } catch {} },
  });

  const stopGenerationSpeedHook = await registerGenerationSpeedHook({
    hooks: sdk.hooks,
    timer: generationSpeedTimer,
    onStatus: (state, code) => shared.health.set("speed", state, code),
    onFailure: (session, reason) => {
      firstResponseTimer.fail(session, reason);
      shared.health.metric("firstResponse", reason);
    },
    onMetric: (metric) => {
      shared.health.metric("speed", metric.reason || "ok", metric.mode);
      sessionCache.onFirstResponseMetric(metric).catch((error) => {
        try { log.warn?.("速度状态更新失败：", error?.message || error); } catch {}
      });
    },
    log: (level, ...args) => { try { log[level]?.(...args); } catch {} },
  });

  await sessionCache.start();

  const housekeeping = setInterval(() => {
    const firstFailures = firstResponseTimer.prune();
    const speedFailures = generationSpeedTimer.prune();
    sessionCache.prune();
    for (const metric of firstFailures) shared.health.metric("firstResponse", metric.reason || "timeout");
    for (const metric of speedFailures) shared.health.metric("speed", metric.reason || "timeout");
    for (const metric of [...firstFailures, ...speedFailures]) {
      observeAsync(() => sessionCache.onFirstResponseMetric(metric));
    }
  }, 60000);
  housekeeping.unref?.();

  let settledRegistration = null;
  if (typeof sdk.hooks?.on === "function") {
    try {
      settledRegistration = await sdk.hooks.on("agent/settled", (event) => {
        if (shared.disposed) return;
        const identity = firstResponseTimer.keyFor(event?.session);
        const path = event?.session?.sessionPath;
        if ((identity && firstResponseTimer.pending.has(identity.key)) || (path && generationSpeedTimer.pending.has(path))) {
          const metric = firstResponseTimer.fail(event.session, "incomplete");
          generationSpeedTimer.fail(event.session, "incomplete");
          shared.health.metric("speed", "incomplete");
          shared.health.metric("firstResponse", "incomplete");
          if (metric) observeAsync(() => sessionCache.onFirstResponseMetric(metric));
        }
      });
    } catch (error) {
      log.warn?.(`[token-tracker] settled hook unavailable: ${error?.message || error}`);
    }
  }

  async function dispose() {
    clearInterval(housekeeping);
    firstResponseTimer.clear();
    generationSpeedTimer.clear();
    const cleanup = [];
    cleanup.push(sessionCache.dispose());
    cleanup.push(stopFirstResponseHooks());
    cleanup.push(stopGenerationSpeedHook());
    if (settledRegistration?.disposeAsync) {
      cleanup.push(settledRegistration.disposeAsync());
    } else if (typeof settledRegistration === "function") {
      cleanup.push(Promise.resolve(settledRegistration()));
    }
    await Promise.allSettled(cleanup);
  }

  return {
    firstResponseTimer,
    generationSpeedTimer,
    sessionCache,
    dispose,
  };
}
