import { defineApp } from "./sdk/app-contract/server-client.js";
import { LocalClient } from "./lib/local-client.mjs";
import { normalizeEntryForArchive } from "./lib/ledger-normalization.mjs";
import { SessionCacheStatus } from "./lib/session-cache.mjs";
import { FirstResponseTimer, registerFirstResponseHooks } from "./lib/first-response.mjs";
import { GenerationSpeedTimer, registerGenerationSpeedHook } from "./lib/generation-speed.mjs";
import { observeAsync } from "./lib/retained-map.mjs";

import fs from "node:fs";
import { RuntimeHealth, trackerStatus, classifyError } from "./lib/runtime-health.mjs";
const pluginVersion = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8")).version;

const MAX_LEDGER_LIMIT = 20000;

function tokVal(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "object") return value.totalTokens || 0;
  return 0;
}

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  let scanIntervalSec = 60;
  try {
    const value = await sdk.config?.get?.("scanInterval");
    if (typeof value === "number" && value > 0) scanIntervalSec = value;
  } catch {
    // 配置读取失败时使用默认扫描间隔。
  }
  const interval = scanIntervalSec * 1000;
  const hostLog = sdk.logger || console;
  const log = Object.fromEntries(["info", "warn", "error", "debug"].map(level => [level,
    (...args) => observeAsync(() => hostLog[level]?.(args.map(String).join(" "))),
  ]));
  const client = new LocalClient({
    ctx: sdk,
    dataDir,
    log: (level, ...args) => { try { log[level]?.(...args); } catch {} },
  });
  const shared = {
    sdk,
    health: new RuntimeHealth({ version: pluginVersion }),
    scanIntervalMs: interval,
    status() { return trackerStatus(shared); },
    lastAttemptAt: null,
    lastSuccessAt: null,
    syncFailed: false,
    bus: sdk.bus,
    log,
    client,
    dataDir,
    data: null,
    ready: false,
    scanning: false,
    scanPromise: null,
    pendingForce: false,
    disposed: false,
    agentNames: {},
    _seenRealtimeUsage: new Set(),
    _realtimeClients: new Set(),
    realtimeSnapshot,
  };

  // 供 /data、实时看板与 Widget 路由读取。
  sdk._tokenCache = shared;
  if (sdk.rawContext) {
    try { sdk.rawContext._tokenCache = shared; } catch {}
  }

  if (typeof sdk.routes?.register === "function") {
    try {
      const { default: registerRoutes } = await import("./server/dashboard.js");
      await sdk.routes.register((app) => registerRoutes(app, sdk));
    } catch (error) {
      shared.log.warn?.("[token-tracker] route registration failed:", error?.message || error);
    }
  }

  await refreshAgentNames(shared);

  async function performScan(force) {
    shared.lastAttemptAt = new Date().toISOString();
    shared.health.set("scanner", "unknown", "checking");
    let entries = [];
    let usageQueryError = null;
    try {
      const listUsage = typeof sdk.usage?.list === "function"
        ? (params) => sdk.usage.list(params)
        : (params) => sdk.bus.request("usage:list", params);
      const result = await listUsage({ limit: MAX_LEDGER_LIMIT });
      if (result?.error) throw Object.assign(new Error(String(result.error?.message || result.error)), { code: result.code || result.error?.code, status: result.status });
      if (!Array.isArray(result?.entries)) throw Object.assign(new Error("无效账本数据"), { code: "INVALID_DATA" });
      entries = result.entries;
      shared.health.set("ledger", "ok", "ledger_ok");
    } catch (error) {
      usageQueryError = classifyError(error);
      shared.syncFailed = true;
      shared.usageQueryError = usageQueryError;
      shared.health.set("ledger", "degraded", usageQueryError);
      // Recover persisted successful data after a reload; do not scan empty entries
      // or advance lastScan when the authoritative query fails.
      if (!shared.data) {
        try {
          const previous = await client.readSnapshot();
          if (!shared.disposed && (previous.lastScan || Object.keys(previous.sessions || {}).length)) {
            shared.data = previous;
            shared.ready = true;
            shared.lastSuccessAt = previous.usageQueryError ? null : previous.lastScan || null;
          }
        } catch {}
      }
      throw Object.assign(new Error("官方账本同步失败"), { code: "LEDGER_SYNC_FAILED", reason: usageQueryError });
    }

    const scanResult = await client.scan(entries, {
      force: force === true,
      agentNames: shared.agentNames,
      coverageLimitReached: entries.length >= MAX_LEDGER_LIMIT,
      usageQueryError,
    });
    const data = await client.readSnapshot();
    if (shared.disposed) return scanResult;
    shared.data = data;
    shared.ready = true;
    shared.syncFailed = false;
    shared.lastSuccessAt = data.lastScan;
    shared.health.set("scanner", "ok", "scan_ok");
    shared.coverageLimitReached = scanResult.coverageLimitReached;
    shared.usageQueryError = scanResult.usageQueryError;
    shared.scanMeta = scanResult;
    shared.log.info?.(`[token-tracker] scan complete: ${entries.length} ledger entries, ${scanResult.newArchivedCount ?? 0} newly archived, ${Object.keys(data.sessions || {}).length} cached sessions`);
    return scanResult;
  }

  // 单飞；扫描中到达的强制刷新会在当前轮结束后补跑。
  shared.scan = (force = false) => {
    if (shared.disposed) return Promise.reject(Object.assign(new Error("Token Tracker 已停止"), { code: "APP_STOPPED" }));
    if (shared.scanPromise) {
      if (force) shared.pendingForce = true;
      return shared.scanPromise;
    }
    const run = async () => {
      let nextForce = force === true;
      let result;
      do {
        if (shared.disposed) break;
        shared.scanning = true;
        try { result = await performScan(nextForce); }
        catch (error) {
          if (!shared.disposed) {
            shared.syncFailed = true;
            shared.health.set("scanner", "degraded", error.reason || classifyError(error));
          }
          throw error;
        }
        finally { shared.scanning = false; }
        nextForce = shared.pendingForce;
        shared.pendingForce = false;
      } while (nextForce);
      return result;
    };
    shared.scanPromise = Promise.resolve().then(run).finally(() => {
      shared.scanning = false;
      shared.scanPromise = null;
      shared.pendingForce = false;
    });
    return shared.scanPromise;
  };
  shared.fullScan = () => shared.scan(true);

  // Initial and periodic indexing run only in the managed child process.
  shared.scan(false).catch((error) => shared.log.warn?.(`[token-tracker] initial scan failed: ${error?.code || "UNKNOWN"}: ${error?.message || "unknown error"}`));
  const timer = setInterval(() => {
    shared.scan(false).catch((error) => shared.log.warn?.(`[token-tracker] scheduled scan failed: ${error?.code || "UNKNOWN"}: ${error?.message || "unknown error"}`));
  }, interval);
  timer.unref?.();

  const realtime = {
    agentId: null,
    agentName: null,
    sessionId: null,
    model: null,
    provider: null,
    lastInput: 0,
    lastOutput: 0,
    lastReasoning: 0,
    lastCacheRead: 0,
    lastTotalTokens: 0,
    lastCost: 0,
    sessionInput: 0,
    sessionOutput: 0,
    sessionReasoning: 0,
    sessionCacheRead: 0,
    sessionTotalTokens: 0,
    sessionCost: 0,
    sessionMsgCount: 0,
    contextTokens: 0,
    contextWindow: 1000000,
    elapsed: 0,
    totalRequests: 0,
    balances: null,
    balanceUpdatedAt: null,
    updatedAt: Date.now(),
    currentSessionStart: Date.now(),
  };
  shared.realtime = realtime;

  const firstResponseTimer = new FirstResponseTimer();
  const generationSpeedTimer = new GenerationSpeedTimer();
  const sessionCache = new SessionCacheStatus({
    bus: sdk.bus,
    inputStatus: sdk.inputStatus,
    sessions: sdk.sessions,
    health: shared.health,
    firstResponseQuery: (sessionId, sessionPath) => {
      const state = shared.health.components.get("firstResponse");
      return state?.state === "degraded" ? { unavailable: true, reason: state.code } : firstResponseTimer.latest({ sessionId, sessionPath });
    },
    generationSpeedQuery: (sessionId, sessionPath, modelKey) => {
      const state = shared.health.components.get("speed");
      return state?.state === "degraded" ? { unavailable: true, reason: state.code } : generationSpeedTimer.latest({ sessionId, sessionPath }, modelKey);
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
    onFailure: (session, reason) => { generationSpeedTimer.fail(session, reason); shared.health.metric("speed", reason); },
    onMetric: (metric) => {
      shared.health.metric("firstResponse", metric.reason || "ok");
      // Hook IDs may be file UUIDs, not IDs accepted by usage:list/inputStatus.
      // Resolve through the official session map; never publish to a guessed ID.
      sessionCache.onFirstResponseMetric(metric).catch(error => {
        try { log.warn?.("首响状态更新失败：", error?.message || error); } catch {}
      });
    },
    log: (level, ...args) => { try { log[level]?.(...args); } catch {} },
  });
  const stopGenerationSpeedHook = await registerGenerationSpeedHook({
    hooks: sdk.hooks,
    timer: generationSpeedTimer,
    onStatus: (state, code) => shared.health.set("speed", state, code),
    onFailure: (session, reason) => { firstResponseTimer.fail(session, reason); shared.health.metric("firstResponse", reason); },
    onMetric: (metric) => {
      shared.health.metric("speed", metric.reason || "ok", metric.mode);
      sessionCache.onFirstResponseMetric(metric).catch(error => {
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
    for (const metric of [...firstFailures, ...speedFailures]) observeAsync(() => sessionCache.onFirstResponseMetric(metric));
  }, 60000);
  housekeeping.unref?.();
  let settledRegistration = null;
  if (typeof sdk.hooks?.on === "function") {
    try {
      settledRegistration = await sdk.hooks.on("agent/settled", event => {
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
    } catch (error) { log.warn(`[token-tracker] settled hook unavailable: ${error?.message || error}`); }
  }

  let unsubBus = null;
  try {
    if (typeof sdk.bus?.subscribe === "function") {
      unsubBus = await sdk.bus.subscribe((event) => {
        try {
          if (event?.type === "llm_usage" && event?.entry) handleLlmUsageEvent(shared, event.entry);
          else if (event?.type === "token_usage") handleLegacyTokenUsageEvent(shared, event);
        } catch (error) {
          shared.log.warn?.("[token-tracker] event handling error:", error?.message || error);
        }
      }, { types: ["llm_usage"] });
    }
  } catch (error) {
    shared.log.warn?.("[token-tracker] bus.subscribe failed:", error?.message || error);
  }

  shared.dispose = () => {
    if (shared.disposePromise) return shared.disposePromise;
    shared.disposed = true;
    shared.ready = false;
    shared.data = null;
    shared._seenRealtimeUsage.clear();
    shared.health.clear();
    clearInterval(timer);
    clearInterval(housekeeping);
    firstResponseTimer.clear();
    generationSpeedTimer.clear();
    const cleanup = [];
    try {
      if (typeof unsubBus === "function") cleanup.push(Promise.resolve(unsubBus()));
      else if (unsubBus?.disposeAsync) cleanup.push(Promise.resolve(unsubBus.disposeAsync()));
      else if (unsubBus?.unsubscribe) cleanup.push(Promise.resolve(unsubBus.unsubscribe()));
    } catch {}
    for (const realtimeClient of shared._realtimeClients) {
      try { realtimeClient.close?.(); } catch {}
    }
    shared._realtimeClients.clear();
    cleanup.push(client.dispose());
    cleanup.push(sessionCache.dispose());
    cleanup.push(stopFirstResponseHooks());
    cleanup.push(stopGenerationSpeedHook());
    if (settledRegistration?.disposeAsync) cleanup.push(settledRegistration.disposeAsync());
    else if (typeof settledRegistration === "function") cleanup.push(Promise.resolve(settledRegistration()));
    shared.disposePromise = Promise.allSettled(cleanup).then(results => {
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Token Tracker cleanup failed");
    });
    return shared.disposePromise;
  };

  shared.log.info?.(`[token-tracker] v2 app loaded (interval ${interval}ms; isolated engine)`);
});

async function refreshAgentNames(shared) {
  try {
    const listAgents = typeof shared.sdk?.agents?.list === "function"
      ? (params) => shared.sdk.agents.list(params)
      : (params) => shared.bus.request("agent:list", params);
    const result = await listAgents({ scope: "all" });
    if (Array.isArray(result?.agents)) {
      const names = {};
      for (const agent of result.agents) if (agent?.id) names[agent.id] = agent.name || agent.id;
      shared.agentNames = { ...shared.agentNames, ...names };
    }
  } catch (error) {
    shared.log.warn?.("[token-tracker] agent:list failed (retaining existing mappings):", error?.message || error);
  }
}

function handleLlmUsageEvent(shared, rawEntry) {
  if (!rawEntry || rawEntry.status !== "ok" || !rawEntry.usage || typeof rawEntry.requestId !== "string" || !rawEntry.requestId) return;
  const id = rawEntry.requestId;
  if (shared._seenRealtimeUsage.has(id)) return;
  shared._seenRealtimeUsage.add(id);
  if (shared._seenRealtimeUsage.size > 5000) shared._seenRealtimeUsage.delete(shared._seenRealtimeUsage.values().next().value);

  shared.client.archiveUsage(rawEntry).catch((error) => {
    shared.log.warn?.("[token-tracker] live usage archive failed:", error?.code || error?.message);
  });
  const entry = normalizeEntryForArchive(rawEntry);
  const realtime = shared.realtime;
  if (!realtime) return;
  const agentId = entry.agentId;
  if (agentId && agentId !== realtime.agentId) {
    realtime.agentId = agentId;
    realtime.agentName = shared.agentNames?.[agentId] || agentId;
    realtime.sessionInput = 0;
    realtime.sessionOutput = 0;
    realtime.sessionReasoning = 0;
    realtime.sessionCacheRead = 0;
    realtime.sessionTotalTokens = 0;
    realtime.sessionCost = 0;
    realtime.sessionMsgCount = 0;
    realtime.totalRequests = 0;
    realtime.currentSessionStart = Date.now();
  }
  realtime.model = entry.model;
  realtime.provider = entry.provider;
  realtime.lastInput = entry.inputTokens;
  realtime.lastOutput = entry.outputTokens;
  realtime.lastReasoning = entry.reasoningTokens;
  realtime.lastCacheRead = entry.cacheReadTokens;
  realtime.lastTotalTokens = entry.totalTokens;
  realtime.lastCost = entry.costTotal;
  realtime.sessionInput += entry.inputTokens;
  realtime.sessionOutput += entry.outputTokens;
  realtime.sessionReasoning += entry.reasoningTokens;
  realtime.sessionCacheRead += entry.cacheReadTokens;
  realtime.sessionTotalTokens += entry.totalTokens;
  realtime.sessionCost += entry.costTotal;
  realtime.sessionMsgCount++;
  realtime.totalRequests++;
  realtime.elapsed = Math.floor((Date.now() - realtime.currentSessionStart) / 1000);
  realtime.updatedAt = Date.now();
  pushToSSE(shared);
}

function handleLegacyTokenUsageEvent(shared, event) {
  const usage = event?.usage || {};
  if (!usage || !usage.totalTokens) return;
  const realtime = shared.realtime;
  if (!realtime) return;
  const input = tokVal(usage.input);
  const output = tokVal(usage.output);
  const reasoning = usage.reasoningTokens || 0;
  const cacheRead = usage.cacheRead || usage.readCache || 0;
  const total = usage.totalTokens || (input + output);
  const cost = usage.cost?.total || usage.cost || 0;
  realtime.lastInput = input;
  realtime.lastOutput = output;
  realtime.lastReasoning = reasoning;
  realtime.lastCacheRead = cacheRead;
  realtime.lastTotalTokens = total;
  realtime.lastCost = cost;
  realtime.sessionInput += input;
  realtime.sessionOutput += output;
  realtime.sessionReasoning += reasoning;
  realtime.sessionCacheRead += cacheRead;
  realtime.sessionTotalTokens += total;
  realtime.sessionCost += cost;
  realtime.sessionMsgCount++;
  realtime.totalRequests++;
  realtime.elapsed = Math.floor((Date.now() - realtime.currentSessionStart) / 1000);
  realtime.updatedAt = Date.now();
  pushToSSE(shared);
}

function pushToSSE(shared) {
  if (!shared._realtimeClients?.size) return;
  const realtime = shared.realtime;
  if (!realtime) return;
  if (shared.data?._balances) {
    realtime.balances = shared.data._balances;
    realtime.balanceUpdatedAt = shared.data._balanceUpdatedAt || null;
  }
  const payload = { type: "usage", data: realtimeSnapshot(realtime, shared.agentNames) };
  for (const client of shared._realtimeClients) {
    try { client.send?.(payload); } catch {}
  }
}

function realtimeSnapshot(realtime, agentNames) {
  const sessionRatio = realtime.sessionTotalTokens > 0 ? ((realtime.sessionCacheRead / realtime.sessionTotalTokens) * 100).toFixed(1) : "0.0";
  const lastRatio = realtime.lastTotalTokens > 0 ? ((realtime.lastCacheRead / realtime.lastTotalTokens) * 100).toFixed(1) : "0.0";
  const contextPercent = realtime.contextWindow > 0 ? ((realtime.contextTokens / realtime.contextWindow) * 100).toFixed(1) : "0.0";
  return {
    agentId: realtime.agentId,
    agentName: (agentNames || {})[realtime.agentId] || realtime.agentId || "—",
    model: realtime.model || "—",
    provider: realtime.provider || "—",
    sessionId: realtime.sessionId || null,
    lastInput: realtime.lastInput,
    lastOutput: realtime.lastOutput,
    lastReasoning: realtime.lastReasoning,
    lastCacheRead: realtime.lastCacheRead,
    lastTotalTokens: realtime.lastTotalTokens,
    lastCost: realtime.lastCost,
    lastHitRate: lastRatio,
    sessionInput: realtime.sessionInput,
    sessionOutput: realtime.sessionOutput,
    sessionReasoning: realtime.sessionReasoning,
    sessionCacheRead: realtime.sessionCacheRead,
    sessionTotalTokens: realtime.sessionTotalTokens,
    sessionCost: realtime.sessionCost,
    sessionMsgCount: realtime.sessionMsgCount,
    sessionHitRate: sessionRatio,
    contextTokens: realtime.contextTokens,
    contextWindow: realtime.contextWindow,
    contextPercent,
    elapsed: realtime.elapsed,
    totalRequests: realtime.totalRequests,
    balances: realtime.balances || null,
    balanceUpdatedAt: realtime.balanceUpdatedAt || null,
    updatedAt: realtime.updatedAt,
  };
}
