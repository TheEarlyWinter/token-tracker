const CODE_NAMESPACE = "code";

/**
 * 归一化一条官方账本记录。
 *
 * @param {object} raw 官方账本原始条目
 * @param {{namespace?: string}|string|null} [source] 已确认的父会话 namespace；
 *   仅当 namespace 为 "code" 时把互斥来源改写为 code，原类型保留在 baseType。
 */
export function normalizeEntryForArchive(raw, source) {
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

  let baseType = "desktop";
  if (subsystem === "automation" || subsystem === "compaction") baseType = "background";
  else if (subsystem === "subagent") baseType = "sub";
  else if (kind === "memory" || kind === "utility" || subsystem === "memory" || subsystem === "utility") baseType = "ledger";
  else if (kind === "phone" && (conversationType === "channel" || surface === "channel")) baseType = "channel";
  else if (kind === "phone" && (conversationType === "bridge" || surface === "bridge")) baseType = "bridge";

  // 执行者归因：子代理请求由宿主挂在父会话的 agentId 上，真正的执行者在
  // source.actor.agentId（= attribution.childAgentId）。只对 baseType=sub 记录采集，
  // 其余记录的执行者就是 agentId 本身，不重复存一份。
  const rawActor = raw?.source?.actor?.agentId || raw?.attribution?.childAgentId || null;
  const actorAgentId = baseType === "sub" && typeof rawActor === "string" && rawActor.trim() ? rawActor.trim() : null;
  const parentAgentId = baseType === "sub" ? (raw?.attribution?.agentId || null) : null;

  const namespace = typeof source === "string" ? source : source?.namespace;
  const type = namespace === CODE_NAMESPACE ? CODE_NAMESPACE : baseType;
  const rawSessionId = raw?.attribution?.sessionId;
  // 会话 ID 使用与索引/映射一致的规范化规则（去首尾空白、限制长度），不改写原始归档文件。
  const trimmedSessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
  const sessionId = trimmedSessionId && trimmedSessionId.length <= 256 ? trimmedSessionId : null;

  return {
    requestId: raw.requestId,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt || null,
    durationMs: raw.durationMs || 0,
    status: raw.status || "ok",
    agentId: raw.attribution?.agentId || "unknown",
    sessionId,
    provider: raw.model?.provider || "",
    model: raw.model?.modelId || "unknown",
    type,
    baseType,
    actorAgentId,
    parentAgentId,
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
