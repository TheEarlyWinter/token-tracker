// runtime/engine/services/session-calls.js
// 「点得开」：从明细里的一行，还原出这一轮会话的**逐次调用**。
//
// 数据源是归档文件（usage-archive.jsonl）而不是 turns 表、也不是内存里的
// conversations：后两者都是扫描时按「agent::type::day」压扁的派生物，只有归档里
// 每一条 = 真实的一次请求（带 requestId / sessionId / status / 各项 token）。
//
// 为什么不读会话 JSONL（上游那套做法）：
//   我们的记账单位是账本记录，一个会话在本地是按天切开的桶，没有「用户一轮 →
//   N 次 assistant 调用」这层结构。账本给的是一次请求一行，那就如实按行给，
//   不往里塞推断出来的对话结构。
//
// 性能：归档 45 MB / 13 万行，全量 JSON.parse 要秒级。这里先用整块 Buffer
// 做子串预筛（sessionId 不出现就直接判定「没这个会话」，一条都不解析），命中
// 的行才 parse。实测点一次几十毫秒，因此不做 memo —— 归档一直在追加，
// mtime 频繁变化，memo 命中率低还白占内存。
import fs from "node:fs";

// 一次最多回多少条调用：给界面用的上限，不是数据上限。
const CALL_LIMIT = 400;

// 间隔 = 本次调用开始 − 上一次调用开始。含排队与工具往返，只是「间隔」，
// 别当「耗时」用。区间与生成速度的采样口径一致：>= 100ms 且 < 600000ms 才给值。
function gapMsOf(curTs, prevTs) {
  const cur = curTs ? new Date(curTs).getTime() : NaN;
  const prev = prevTs ? new Date(prevTs).getTime() : NaN;
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  const d = cur - prev;
  return d >= 100 && d < 600000 ? d : null;
}

function toCall(rec, prevStartedAt) {
  const input = Number(rec.inputUncachedTokens ?? rec.inputTokens ?? 0) || 0;
  const cacheRead = Number(rec.cacheReadTokens || 0) || 0;
  const output = Number(rec.outputTokens || 0) || 0;
  return {
    requestId: rec.requestId || null,
    startedAt: rec.startedAt || null,
    endedAt: rec.endedAt || null,
    // 宿主账本里的 durationMs 实测恒为 0，那就照实给 0，不拿间隔去冒充耗时。
    durationMs: Number(rec.durationMs || 0) || 0,
    status: rec.status || "ok",
    failed: (rec.status || "ok") !== "ok",
    agentId: rec.agentId || "unknown",
    provider: rec.provider || "",
    model: rec.model || "unknown",
    type: rec.type || "",
    baseType: rec.baseType || rec.type || "",
    // input 是「未命中输入」，inputTotal 才是含命中的输入总量。
    input,
    cacheRead,
    cacheWrite: Number(rec.cacheWriteTokens || 0) || 0,
    output,
    reasoning: Number(rec.reasoningTokens || 0) || 0,
    inputTotal: input + cacheRead,
    totalTokens: Number(rec.totalTokens || (input + output + cacheRead)) || 0,
    costTotal: Number(rec.costTotal || 0) || 0,
    gapMs: gapMsOf(rec.startedAt, prevStartedAt),
  };
}

// 把归档解法：返回 v 对象数组（只解析 needle 命中的行）。
function collectLines(buf, needle, predicate) {
  const out = [];
  const needleBuf = Buffer.from(needle, "utf8");
  if (!buf.includes(needleBuf)) return out;
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(10, start);
    if (nl < 0) nl = buf.length;
    const line = buf.subarray(start, nl);
    start = nl + 1;
    if (!line.length || !line.includes(needleBuf)) continue;
    let parsed;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      continue; // 中断写入的残行跳过：明细是只读视图，不为坏行中断整次查询
    }
    const v = parsed && parsed.v ? parsed.v : null;
    if (!v) continue;
    if (predicate && !predicate(v)) continue;
    out.push(v);
  }
  return out;
}

/**
 * 读一个会话的逐次调用；给定 requestId 时顺带标出「点的是哪一条」。
 *
 * @param {{file: string, requestId?: string, sessionId?: string, limit?: number, log?: object}} opts
 */
export function readSessionCalls({ file, requestId = null, sessionId = null, limit = CALL_LIMIT, log = null } = {}) {
  try {
    if (!file || !fs.existsSync(file)) {
      return { ok: false, code: "NO_ARCHIVE", message: "归档文件不存在" };
    }
    if (!requestId && !sessionId) {
      return { ok: false, code: "MISSING_ARG", message: "需要 requestId 或 sessionId" };
    }

    const buf = fs.readFileSync(file);

    // 先按 requestId 定位它属于哪个会话（明细行只有 requestId，没有 sessionId）。
    let resolvedSessionId = sessionId;
    let anchor = null;
    if (requestId) {
      const hits = collectLines(buf, requestId, (v) => v.requestId === requestId);
      anchor = hits[0] || null;
      if (!anchor) {
        return { ok: false, code: "TURN_NOT_FOUND", message: "归档里没有这条请求（可能已被归档窗口挤出）" };
      }
      if (!resolvedSessionId) resolvedSessionId = anchor.sessionId || null;
    }

    if (!resolvedSessionId) {
      // 账本记录没带 sessionId：只回这一条，并说明拿不到上下文。
      const sole = toCall(anchor, null);
      return {
        ok: true,
        requestId,
        sessionId: null,
        found: true,
        sessionKnown: false,
        callCount: 1,
        truncated: false,
        calls: [sole],
        totals: { calls: 1, failedCalls: sole.failed ? 1 : 0, totalTokens: sole.totalTokens },
      };
    }

    const records = collectLines(buf, resolvedSessionId, (v) => v.sessionId === resolvedSessionId);
    records.sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));

    const calls = [];
    let prevStartedAt = null;
    for (const rec of records) {
      calls.push(toCall(rec, prevStartedAt));
      prevStartedAt = rec.startedAt || prevStartedAt;
    }

    const totals = calls.reduce(
      (acc, c) => {
        acc.calls += 1;
        if (c.failed) acc.failedCalls += 1;
        acc.totalTokens += c.totalTokens;
        acc.input += c.input;
        acc.cacheRead += c.cacheRead;
        acc.cacheWrite += c.cacheWrite;
        acc.output += c.output;
        acc.reasoning += c.reasoning;
        return acc;
      },
      { calls: 0, failedCalls: 0, totalTokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
    );

    const truncated = calls.length > limit;
    // 会话可能很长（实测有 417 次调用）：截断时以「你点的那条」为中心开窗，
    // 而不是留最早的 400 条。否则点最近的行，看到的是几个小时前的最开头。
    let windowStart = 0;
    let window = calls;
    if (truncated) {
      const anchorIdx = requestId ? calls.findIndex((c) => c.requestId === requestId) : calls.length - 1;
      const idx = anchorIdx >= 0 ? anchorIdx : calls.length - 1;
      const half = Math.floor(limit / 2);
      windowStart = Math.max(0, Math.min(idx - half, calls.length - limit));
      window = calls.slice(windowStart, windowStart + limit);
    }

    return {
      ok: true,
      requestId,
      sessionId: resolvedSessionId,
      found: requestId ? calls.some((c) => c.requestId === requestId) : true,
      sessionKnown: true,
      callCount: calls.length,
      truncated,
      windowStart,
      calls: window,
      // 合计按整个会话算，不是按展示窗口：上面写「共 N 次调用 · 合计 X」才对得上。
      totals,
      // 归档里同一会话的记录数就是「这轮对话调了几次模型」，界面直接写这个数。
      archiveFile: file,
    };
  } catch (e) {
    try { log?.warn?.("[token-tracker] readSessionCalls 读取失败：", e.code || "", e.message); } catch {}
    return { ok: false, code: "READ_FAILED", message: e.message };
  }
}

export default { readSessionCalls };
