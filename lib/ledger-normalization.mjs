export function normalizeEntryForArchive(raw) {
  const usage = raw?.usage || {};
  const inputInfo = usage.input || {};
  const outputInfo = usage.output || {};
  const cacheInfo = usage.cache || {};
  const inputUncachedTokens = typeof inputInfo.uncachedTokens === "number" ? inputInfo.uncachedTokens : null;
  const inputTokens = typeof inputInfo.totalTokens === "number" ? inputInfo.totalTokens : (inputUncachedTokens ?? 0);
  const outputTokens = outputInfo.totalTokens || 0;
  const cacheReadTokens = cacheInfo.readTokens || 0;
  const cacheWriteTokens = cacheInfo.writeTokens || 0;
  const subsystem = raw?.source?.subsystem || "";
  const kind = raw?.attribution?.kind || "session";
  const surface = raw?.source?.surface || "";
  const conversationType = raw?.attribution?.conversationType || "";

  let type = "desktop";
  if (subsystem === "automation" || subsystem === "compaction") type = "background";
  else if (subsystem === "subagent") type = "sub";
  else if (kind === "memory" || kind === "utility" || subsystem === "memory" || subsystem === "utility") type = "ledger";
  else if (kind === "phone" && (conversationType === "channel" || surface === "channel")) type = "channel";
  else if (kind === "phone" && (conversationType === "bridge" || surface === "bridge")) type = "bridge";

  return {
    requestId: raw.requestId,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt || null,
    durationMs: raw.durationMs || 0,
    status: raw.status || "ok",
    agentId: raw.attribution?.agentId || "unknown",
    sessionId: raw.attribution?.sessionId || null,
    provider: raw.model?.provider || "",
    model: raw.model?.modelId || "unknown",
    type,
    inputTokens,
    inputUncachedTokens,
    outputTokens,
    reasoningTokens: outputInfo.reasoningTokens || 0,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: usage.totalTokens != null ? usage.totalTokens : inputTokens + outputTokens + cacheReadTokens,
    costTotal: usage.costTotal || 0,
    hitRatio: cacheInfo.hitRatio != null ? cacheInfo.hitRatio : null,
  };
}
