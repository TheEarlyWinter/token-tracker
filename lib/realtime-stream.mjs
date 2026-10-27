import { normalizeEntryForArchive } from "./ledger-normalization.mjs";

export function tokVal(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "object") return value.totalTokens || 0;
  return 0;
}

export function createRealtimeState() {
  return {
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
}

function capSet(set, limit = 5000) {
  while (set.size > limit) set.delete(set.values().next().value);
}

function ensureRealtimeArchiveState(shared) {
  if (!(shared._seenRealtimeUsage instanceof Set)) shared._seenRealtimeUsage = new Set();
  if (!(shared._archivedRealtimeUsage instanceof Set)) shared._archivedRealtimeUsage = new Set();
  if (!(shared._realtimeArchiveInFlight instanceof Map)) shared._realtimeArchiveInFlight = new Map();
  return {
    seen: shared._seenRealtimeUsage,
    archived: shared._archivedRealtimeUsage,
    inFlight: shared._realtimeArchiveInFlight,
  };
}

function archiveRealtimeUsage(shared, id, rawEntry, state) {
  if (state.archived.has(id) || state.inFlight.has(id)) return;
  const task = Promise.resolve().then(() => shared.client.archiveUsage(rawEntry));
  state.inFlight.set(id, task);
  task.then(() => {
    state.archived.add(id);
    capSet(state.archived);
  }, (error) => {
    // UI 去重与持久化去重分开：失败只释放在途标记，下一次同 ID 事件仍可重试。
    shared.log?.warn?.("[token-tracker] live usage archive failed:", error?.code || error?.message);
  }).finally(() => {
    if (state.inFlight.get(id) === task) state.inFlight.delete(id);
  });
}

function resetRealtimeSession(realtime, agentId, sessionId, agentNames) {
  realtime.agentId = agentId;
  realtime.agentName = agentNames?.[agentId] || agentId;
  realtime.sessionId = sessionId || null;
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

export function handleLlmUsageEvent(shared, rawEntry) {
  if (!rawEntry || rawEntry.status !== "ok" || !rawEntry.usage || typeof rawEntry.requestId !== "string" || !rawEntry.requestId) return;
  const id = rawEntry.requestId;
  const archiveState = ensureRealtimeArchiveState(shared);
  const firstUiEvent = !archiveState.seen.has(id);
  if (firstUiEvent) {
    archiveState.seen.add(id);
    capSet(archiveState.seen);
  }
  archiveRealtimeUsage(shared, id, rawEntry, archiveState);
  if (!firstUiEvent) return;

  const entry = normalizeEntryForArchive(rawEntry);
  const realtime = shared.realtime;
  if (!realtime) return;
  const agentId = entry.agentId;
  const sessionId = entry.sessionId || null;
  const agentChanged = !!agentId && agentId !== realtime.agentId;
  const sessionChanged = !!sessionId && !!realtime.sessionId && sessionId !== realtime.sessionId;
  if (agentChanged || sessionChanged) resetRealtimeSession(realtime, agentId, sessionId, shared.agentNames);
  else if (agentId && !realtime.agentId) {
    realtime.agentId = agentId;
    realtime.agentName = shared.agentNames?.[agentId] || agentId;
  }
  // 缺失 sessionId 时保留当前会话的合理 fallback，不能每条都触发重置。
  if (sessionId) realtime.sessionId = sessionId;
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

export function handleLegacyTokenUsageEvent(shared, event) {
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

export function pushToSSE(shared) {
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

export function realtimeSnapshot(realtime, agentNames) {
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
