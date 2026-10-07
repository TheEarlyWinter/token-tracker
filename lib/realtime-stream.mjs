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

export function handleLlmUsageEvent(shared, rawEntry) {
  if (!rawEntry || rawEntry.status !== "ok" || !rawEntry.usage || typeof rawEntry.requestId !== "string" || !rawEntry.requestId) return;
  const id = rawEntry.requestId;
  if (shared._seenRealtimeUsage.has(id)) return;
  shared._seenRealtimeUsage.add(id);
  if (shared._seenRealtimeUsage.size > 5000) {
    shared._seenRealtimeUsage.delete(shared._seenRealtimeUsage.values().next().value);
  }

  shared.client.archiveUsage(rawEntry).catch((error) => {
    shared.log?.warn?.("[token-tracker] live usage archive failed:", error?.code || error?.message);
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
