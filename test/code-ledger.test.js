import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";
import { createRpcDispatcher } from "../runtime/engine/rpc-handler.mjs";
import { buildDetailsCSV } from "../runtime/engine/services/details-csv.js";
import { openTurnsStore, queryTurns } from "../runtime/engine/services/turns-store.js";

const quiet = { info() {}, warn() {}, error() {} };
const DAY = "2026-10-06";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-code-"));
}

function entry(requestId, { agentId = "agent-a", sessionId = "sess-a", subsystem = "session", totalTokens = 15, costTotal = 0.004, startedAt = `${DAY}T10:00:00.000Z` } = {}) {
  return {
    requestId,
    startedAt,
    status: "ok",
    source: { subsystem },
    attribution: { agentId, sessionId, kind: "session" },
    model: { provider: "deepseek", modelId: "deepseek-chat" },
    usage: {
      input: { totalTokens: 10, uncachedTokens: 8 },
      output: { totalTokens: 2, reasoningTokens: 1 },
      cache: { readTokens: 3, writeTokens: 1, hitRatio: 0.2 },
      totalTokens,
      costTotal,
    },
  };
}

function open(dir) {
  return createLedgerEngine({ dataDir: dir, log: quiet });
}

test("code parent and sub requests are classified as code while chat subs keep their base type", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const result = await engine.scan([
    entry("parent", { sessionId: "code-parent" }),
    entry("child", { sessionId: "code-parent", subsystem: "subagent", totalTokens: 5 }),
    entry("chat-sub", { sessionId: "chat-sess", subsystem: "subagent", totalTokens: 7 }),
  ], { sessionNamespaces: { "code-parent": "code", "chat-sess": "chat" } });

  const data = engine.getData();
  const code = data.sessions[`agent-a::code::${DAY}`];
  const sub = data.sessions[`agent-a::sub::${DAY}`];
  assert.ok(code, "Code 父请求与子请求必须归入 code 桶");
  assert.equal(code.totalTokens, 20);
  assert.equal(code.assistantCount, 2);
  assert.equal(sub.totalTokens, 7, "聊天子请求保持 sub，且不重复计入 Code");
  assert.equal(result.sourceClassification.status, "complete");
  assert.equal(result.sourceClassification.unresolvedSessionCount, 0);

  const archived = fs.readFileSync(path.join(dir, "usage-archive.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.rid);
  const byId = Object.fromEntries(archived.map((row) => [row.rid, row.v]));
  assert.equal(byId.parent.type, "code");
  assert.equal(byId.parent.baseType, "desktop");
  assert.equal(byId.child.type, "code");
  assert.equal(byId.child.baseType, "sub", "baseType 必须保留原子代理类型");
  assert.equal(byId["chat-sub"].type, "sub");
  assert.equal(byId["chat-sub"].baseType, "sub");

  const totals = Object.values(data.sessions).reduce((acc, s) => {
    acc.tokens += s.totalTokens;
    acc.cost += s.cost;
    return acc;
  }, { tokens: 0, cost: 0 });
  assert.equal(totals.tokens, 27, "重新分类不得改变总 Token");
  assert.ok(Math.abs(totals.cost - 0.012) < 1e-9, "重新分类不得改变总费用");
});

test("late classification revokes the old bucket, keeps archive totals and updates SQLite", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const entries = [
    entry("parent", { sessionId: "late-session" }),
    entry("child", { sessionId: "late-session", subsystem: "subagent", totalTokens: 5 }),
  ];
  await engine.scan(entries, {});
  assert.equal(engine.getData().sessions[`agent-a::desktop::${DAY}`].totalTokens, 15);
  assert.equal(engine.getData().sessions[`agent-a::sub::${DAY}`].totalTokens, 5);
  assert.equal(engine.turnsStore.query({ type: "desktop" }).total, 1);

  const before = { tokens: 20, cost: 0.008, archive: engine.archiveCount() };
  const rescanned = await engine.scan(entries, { sessionNamespaces: { "late-session": "code" } });

  const data = engine.getData();
  assert.equal(data.sessions[`agent-a::desktop::${DAY}`], undefined, "旧 desktop 桶必须撤销");
  assert.equal(data.sessions[`agent-a::sub::${DAY}`], undefined, "旧 sub 桶必须撤销");
  assert.equal(data.sessions[`agent-a::code::${DAY}`].totalTokens, 20);
  assert.equal(engine.archiveCount(), before.archive, "requestId 归档数量不变");
  assert.equal(rescanned.archiveCount, before.archive);
  const totals = Object.values(data.sessions).reduce((acc, s) => ({ tokens: acc.tokens + s.totalTokens, cost: acc.cost + s.cost }), { tokens: 0, cost: 0 });
  assert.equal(totals.tokens, before.tokens, "总 Token 不变");
  assert.ok(Math.abs(totals.cost - before.cost) < 1e-9, "总费用不变");

  assert.equal(engine.turnsStore.query({ type: "code" }).total, 2, "SQLite 必须同时更新两行");
  assert.equal(engine.turnsStore.query({ type: "desktop" }).total, 0);
  assert.equal(engine.turnsStore.query({ type: "sub" }).total, 0);
  assert.equal(engine.turnsStore.query({ type: "code" }).sumTokens, 20);

  const csvRows = engine.turnsStore.query({ type: "code", all: true }).rows;
  const dataLines = buildDetailsCSV(csvRows).replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(dataLines.length, 3, "CSV 导出与 SQLite 过滤一致（表头 + 2 行）");
});

test("classification mapping survives restart and re-classifies archived records without new ledger entries", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan([entry("only", { sessionId: "archive-only" })], { sessionNamespaces: { "archive-only": "code" } });
  first.close();

  assert.ok(fs.existsSync(path.join(dir, "session-sources.json")));

  const second = open(dir);
  t.after(() => second.close());
  const data = second.getData();
  assert.equal(data.sessions[`agent-a::code::${DAY}`].totalTokens, 15, "重启后直接复用持久映射");
  assert.equal(data.sessions[`agent-a::desktop::${DAY}`], undefined);

  const rescanned = await second.scan([], {});
  assert.equal(rescanned.newArchivedCount, 0);
  assert.equal(second.getData().sessions[`agent-a::code::${DAY}`].totalTokens, 15);
  assert.equal(rescanned.sourceClassification.status, "complete");
});

test("already archived history is reclassified when only a mapping is learned", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await engine.scan([entry("hist", { sessionId: "hist-1", subsystem: "subagent" })], {});
  assert.equal(engine.getData().sessions[`agent-a::sub::${DAY}`].totalTokens, 15);

  const res = await engine.scan([], { sessionNamespaces: { "hist-1": "code" } });
  assert.equal(engine.getData().sessions[`agent-a::sub::${DAY}`], undefined);
  assert.equal(engine.getData().sessions[`agent-a::code::${DAY}`].totalTokens, 15);
  assert.equal(res.sourceClassification.status, "complete");
});

test("live archived events are reclassified by the next scan without duplicating requests", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const live = entry("live", { sessionId: "live-session", subsystem: "subagent" });
  assert.equal((await engine.archiveUsage(live)).accepted, true);
  await engine.scan([live], { sessionNamespaces: { "live-session": "code" } });

  assert.equal(engine.archiveCount(), 1);
  const data = engine.getData();
  assert.equal(data.sessions[`agent-a::sub::${DAY}`], undefined);
  assert.equal(data.sessions[`agent-a::code::${DAY}`].totalTokens, 15);
  assert.equal(engine.turnsStore.query({ type: "code" }).total, 1);
});

test("classification status reflects the whole archive rather than the current window", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await engine.scan([
    entry("known", { sessionId: "known" }),
    entry("unknown", { sessionId: "unknown" }),
  ], { sessionNamespaces: { known: "chat" } });
  let result = await engine.scan([], {});
  assert.deepEqual(result.sourceClassification, { status: "partial", unresolvedSessionCount: 1, unresolvedRecordCount: 0 });
  assert.deepEqual(engine.getData().sourceClassification, { status: "partial", unresolvedSessionCount: 1, unresolvedRecordCount: 0 });

  result = await engine.scan([], { sourceResolution: { capability: "unavailable", failedSessionIds: [] } });
  assert.deepEqual(result.sourceClassification, { status: "unavailable", unresolvedSessionCount: 1, unresolvedRecordCount: 0 });

  result = await engine.scan([], { sessionNamespaces: { unknown: "chat" } });
  assert.deepEqual(result.sourceClassification, { status: "complete", unresolvedSessionCount: 0, unresolvedRecordCount: 0 });
});

test("unknown, denied and corrupt cache states degrade without failing the scan", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, "session-sources.json"), "{not json");
  const engine = open(dir);
  t.after(() => engine.close());
  const result = await engine.scan([entry("one", { sessionId: "s1" })], {
    sessionNamespaces: {},
    sourceResolution: { capability: "ready", failedSessionIds: ["s1"] },
  });
  assert.equal(result.newArchivedCount, 1);
  assert.equal(engine.getData().sessions[`agent-a::desktop::${DAY}`].totalTokens, 15);
  assert.equal(result.sourceClassification.status, "partial");
  assert.ok(fs.existsSync(path.join(dir, "session-sources.json")), "损坏缓存恢复后必须重新落盘");
});

test("candidates expose bounded unresolved archive session ids and skip recent failures", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await engine.scan([
    entry("a", { sessionId: "resolved", startedAt: `${DAY}T09:00:00.000Z` }),
    entry("b", { sessionId: "oldest", startedAt: "2026-10-01T09:00:00.000Z" }),
    entry("c", { sessionId: "newest", startedAt: `${DAY}T11:00:00.000Z` }),
    entry("d", { sessionId: "failing", startedAt: `${DAY}T12:00:00.000Z` }),
  ], { sessionNamespaces: { resolved: "chat" }, sourceResolution: { capability: "ready", failedSessionIds: ["failing"] } });

  assert.deepEqual(engine.sessionCandidates({ limit: 10 }).sessionIds, ["oldest", "newest"], "历史优先最老，避免新会话饥饿");
  assert.deepEqual(engine.sessionCandidates({ limit: 1 }).sessionIds, ["oldest"]);
  assert.deepEqual(engine.sessionCandidates({ limit: 0 }).sessionIds, ["oldest"]);
  assert.deepEqual(engine.sessionCandidates({ limit: 999 }).sessionIds, ["oldest", "newest"]);
  assert.deepEqual(engine.sessionCandidates({ limit: 10, recent: ["oldest"] }).sessionIds, ["newest"], "历史候选必须先排除 recent 再截断");
  const recent = engine.sessionCandidates({ limit: 10, recent: ["resolved", "failing", "newest"] });
  assert.deepEqual(recent.known, { resolved: "chat" }, "resolved 会话的 known 状态必须可跨进程读取");
  assert.deepEqual(recent.cooling, ["failing"], "五分钟内失败会话必须给出冷却状态");
});

test("rpc scan accepts only safe session ids and exposes bounded candidates", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const dispatch = createRpcDispatcher({ getEngine: () => engine });

  await dispatch("scan.begin", {
    scanId: "rpc-code",
    sessionNamespaces: { "rpc-code-session": "code", bad: 42, "__proto__": "code" },
    sourceResolution: { capability: "ready", failedSessionIds: ["rpc-unknown", 7] },
  });
  await dispatch("scan.append", { scanId: "rpc-code", entries: [
    entry("rpc-parent", { sessionId: "rpc-code-session" }),
    entry("rpc-unknown-child", { sessionId: "rpc-unknown", subsystem: "subagent" }),
  ] });
  const committed = await dispatch("scan.commit", { scanId: "rpc-code" });
  let state = await dispatch("scan.status", { jobId: committed.jobId });
  for (let i = 0; i < 50 && state.state === "running"; i++) {
    await new Promise((r) => setTimeout(r, 5));
    state = await dispatch("scan.status", { jobId: committed.jobId });
  }
  assert.equal(state.state, "complete");
  const data = engine.getData();
  assert.equal(data.sessions[`agent-a::code::${DAY}`].totalTokens, 15);
  assert.equal(data.sessions[`agent-a::sub::${DAY}`].totalTokens, 15);
  assert.deepEqual(state.result.sourceClassification, { status: "partial", unresolvedSessionCount: 1, unresolvedRecordCount: 0 });

  const candidates = await dispatch("sessions.candidates", { limit: 5 });
  assert.deepEqual(candidates.sessionIds, [], "5 分钟内的失败会话不重复候选");
  const recent = await dispatch("sessions.candidates", { limit: 5, recent: ["rpc-code-session", "rpc-unknown"] });
  assert.deepEqual(recent.known, { "rpc-code-session": "code" });
  assert.deepEqual(recent.cooling, ["rpc-unknown"]);
});

function snapshotCacheFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^(token-cache\.json|cache\.sqlite)/.test(name)) continue;
    out.push({ name, data: fs.readFileSync(path.join(dir, name)) });
  }
  return out;
}

function restoreCacheFiles(dir, files) {
  for (const name of fs.readdirSync(dir)) {
    if (/^(token-cache\.json|cache\.sqlite)/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
  for (const file of files) fs.writeFileSync(path.join(dir, file.name), file.data);
}

function numberedEntries(count, { from = 0, sessionOf = (i) => `sess-${i}`, totalTokens = 15 } = {}) {
  const out = [];
  for (let i = from; i < from + count; i++) {
    out.push(entry(`req-${i}`, {
      sessionId: sessionOf(i),
      totalTokens,
      costTotal: 0.001,
      startedAt: `${DAY}T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
    }));
  }
  return out;
}

test("101 archived requests stay 101 SQLite rows after a late Code mapping without any manual rebuild", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const entries = numberedEntries(101);
  await engine.scan(entries, {});
  assert.equal(engine.turnsStore.count(), 101, "首次扫描后每个请求恰好一行");
  assert.equal(engine.archiveCount(), 101);

  await engine.scan(entries, { sessionNamespaces: { "sess-0": "code" } });
  assert.equal(engine.turnsStore.count(), 101, "晚分类不得产生重复明细");
  assert.equal(engine.turnsStore.query({ type: "code" }).total, 1);
  assert.equal(engine.turnsStore.query({ type: "desktop" }).total, 100);

  const rows = engine.turnsStore.query({ all: true, sortKey: "time", order: "asc" }).rows;
  assert.equal(rows.length, 101);
  assert.equal(rows.reduce((sum, r) => sum + r.total, 0), 101 * 15, "CSV/SQLite 总 Token 与归档一致");
  const csvLines = buildDetailsCSV(rows).replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(csvLines.length, 102, "CSV 行数 = 表头 + 归档请求数");
});

test("99 → 100 → 101 rows grow without duplicating derived detail rows", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const all = numberedEntries(101);
  for (const size of [99, 100, 101]) {
    await engine.scan(all.slice(0, size), {});
    assert.equal(engine.turnsStore.count(), size, `第 ${size} 条后行数必须等于归档请求数`);
    assert.equal(engine.turnsStore.query({ type: "desktop" }).total, size);
  }
  await engine.scan(all, { sessionNamespaces: { "sess-0": "code", "sess-1": "code" } });
  assert.equal(engine.turnsStore.count(), 101);
  assert.equal(engine.turnsStore.query({ type: "code" }).total, 2);
  assert.equal(engine.turnsStore.query({ type: "desktop" }).total, 99);
});

test("legacy session-keyed SQLite rows are migrated to bucket keys exactly once", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan(numberedEntries(5), {});
  const expected = first.getData();
  first.close();

  // 模拟旧安装：session_key 是 sessionId/requestId，且没有索引键标记。
  const legacy = openTurnsStore({ file: path.join(dir, "cache.sqlite"), log: quiet });
  legacy.rebuild({ sessions: {} });
  legacy.setMeta("index_key", null);
  for (const raw of numberedEntries(5)) {
    legacy.replaceSession(raw.attribution.sessionId, {
      agent: "agent-a",
      type: "desktop",
      conversations: [{ time: raw.startedAt, provider: "deepseek", model: "deepseek-chat", totalTokens: 15, inTokens: 10, outTokens: 2, cacheRead: 3, msgCount: 1 }],
    });
  }
  assert.equal(legacy.count(), 5);
  legacy.close();

  const upgraded = open(dir);
  t.after(() => upgraded.close());
  assert.equal(upgraded.getData().turnsIndexReady, false, "键标记缺失时必须先标记未就绪");
  await upgraded.scan([], {});
  assert.equal(upgraded.turnsStore.count(), 5, "迁移后行数不变");
  const rows = upgraded.turnsStore.query({ all: true }).rows;
  assert.ok(rows.every((row) => row.sessionKey.startsWith("agent-a::desktop::")), "迁移必须统一为聚合桶键");
  assert.equal(upgraded.turnsStore.query({ type: "desktop" }).sumTokens, Object.values(expected.sessions)[0].totalTokens);

  await upgraded.scan([], {});
  assert.equal(upgraded.turnsStore.count(), 5, "迁移后再次扫描不得重复");
});

test("persisted mapping without a matching aggregate cache rebuilds buckets after restart", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entries = numberedEntries(3);

  const first = open(dir);
  await first.scan(entries, {});
  first.close();
  const stale = snapshotCacheFiles(dir);

  const classified = open(dir);
  await classified.scan(entries, { sessionNamespaces: { "sess-0": "code", "sess-1": "chat", "sess-2": "chat" } });
  classified.close();

  restoreCacheFiles(dir, stale);

  const recovered = open(dir);
  t.after(() => recovered.close());
  await recovered.scan([], {});
  const data = recovered.getData();
  assert.equal(data.sessions[`agent-a::code::${DAY}`].totalTokens, 15, "重启后必须重建分类差异的桶");
  assert.equal(data.sessions[`agent-a::desktop::${DAY}`].totalTokens, 30);
  assert.equal(data.sourceClassification.status, "complete");
  assert.equal(recovered.turnsStore.query({ type: "code" }).total, 1, "聚合重建时 SQLite 必须同步");
});

test("archive appended without a matching aggregate is recovered after restart instead of being deduplicated away", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan([entry("a", { sessionId: "sess-a" })], {});
  // 实时事件先归档、聚合未写：模拟进程在两次落盘之间退出。
  assert.equal((await first.archiveUsage(entry("b", { sessionId: "sess-b" }))).accepted, true);
  first.close();

  const recovered = open(dir);
  t.after(() => recovered.close());
  await recovered.scan([], {});
  const data = recovered.getData();
  const total = Object.values(data.sessions).reduce((sum, s) => sum + s.totalTokens, 0);
  assert.equal(total, 30, "已落盘但未聚合的归档记录必须补入总览");
  assert.equal(recovered.turnsStore.count(), 2);
  assert.equal(recovered.archiveCount(), 2);
});

test("records without a usable session id keep their tokens but prevent a complete classification", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const result = await engine.scan([
    entry("ok", { sessionId: "known" }),
    entry("no-id", { sessionId: null }),
    entry("empty-id", { sessionId: "" }),
  ], { sessionNamespaces: { known: "chat" } });

  assert.equal(result.sourceClassification.status, "partial");
  assert.equal(result.sourceClassification.unresolvedSessionCount, 0);
  assert.equal(result.sourceClassification.unresolvedRecordCount, 2);
  assert.equal(engine.getData().sessions[`agent-a::desktop::${DAY}`].totalTokens, 45, "无法归属的记录仍计入总量与原类别");
});

test("source cache write failure degrades classification without losing usage, then recovers", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const sourceFile = path.join(dir, "session-sources.json");
  fs.mkdirSync(sourceFile);
  const result = await engine.scan([
    entry("p", { sessionId: "code-parent" }),
    entry("d", { sessionId: "desk-sess" }),
  ], { sessionNamespaces: { "code-parent": "code", "desk-sess": "chat" } });

  assert.equal(result.newArchivedCount, 2, "来源写失败不得中断归档");
  assert.equal(engine.archiveCount(), 2);
  assert.equal(engine.getData().sessions[`agent-a::code::${DAY}`].totalTokens, 15);
  assert.equal(result.sourceClassification.status, "partial", "持久化未完成不得宣称 complete");
  assert.deepEqual(result.sourceAckSessionIds, [], "保存失败时不得返回任何 ack");

  fs.rmdirSync(sourceFile);
  const recovered = await engine.scan([], {
    sessionNamespaces: { "code-parent": "code", "desk-sess": "chat" },
  });
  assert.equal(recovered.sourceClassification.status, "complete");
  assert.ok(fs.statSync(sourceFile).isFile(), "恢复写入后映射必须落盘");
  assert.deepEqual(recovered.sourceAckSessionIds.sort(), ["code-parent", "desk-sess"], "仅确认实际已持久化的映射");
  assert.equal(engine.getData().sessions[`agent-a::code::${DAY}`].totalTokens, 15);
});

function pokeTurnsMeta(dir, patch) {
  const store = openTurnsStore({ file: path.join(dir, "cache.sqlite"), log: quiet });
  for (const [key, value] of Object.entries(patch)) store.setMeta(key, value);
  store.close();
}

test("stale SQLite generation marks the derived index unready and rebuilds in the same process", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan(numberedEntries(3), {});
  first.close();
  pokeTurnsMeta(dir, { data_generation: "0" });

  const engine = open(dir);
  t.after(() => engine.close());
  assert.equal(engine.getData().turnsIndexReady, false, "同版 marker 但内容代次落后不得当作就绪");

  const realRebuild = engine.turnsStore.rebuild;
  engine.turnsStore.rebuild = () => { throw new Error("sqlite rebuild broken"); };
  const degraded = await engine.scan([], {});
  assert.equal(degraded.ready, true, "索引失败不得阻断主用量扫描");
  assert.equal(engine.getData().turnsIndexReady, false);
  assert.equal(engine.turnsStore.count(), 3, "失败时保留旧派生行，不伪装成新内容");

  engine.turnsStore.rebuild = realRebuild;
  await engine.scan([], {});
  assert.equal(engine.getData().turnsIndexReady, true, "同进程下一轮必须恢复");
  assert.equal(engine.turnsStore.count(), 3);
  assert.equal(engine.turnsStore.query({ type: "desktop" }).sumTokens, 45);
});

test("a failed incremental apply forces a full rebuild on the next scan", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await engine.scan(numberedEntries(3), {});
  assert.equal(engine.getData().turnsIndexReady, true);

  const realApply = engine.turnsStore.apply;
  engine.turnsStore.apply = () => { throw new Error("sqlite apply broken"); };
  const failed = await engine.scan(numberedEntries(1, { from: 3 }), {});
  assert.equal(failed.newArchivedCount, 1);
  assert.equal(engine.getData().turnsIndexReady, false);
  assert.equal(engine.turnsStore.count(), 3, "apply 失败后旧行原样保留");

  engine.turnsStore.apply = realApply;
  await engine.scan([], {});
  assert.equal(engine.getData().turnsIndexReady, true);
  assert.equal(engine.turnsStore.count(), 4, "恢复时必须全量重建而不是继续增量");
  assert.equal(engine.turnsStore.query({ type: "desktop" }).sumTokens, 60);
});

test("an apply failure followed by a restart recovers the derived index", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan(numberedEntries(3), {});
  first.turnsStore.apply = () => { throw new Error("sqlite apply broken"); };
  await first.scan(numberedEntries(1, { from: 3 }), {});
  assert.equal(first.getData().turnsIndexReady, false);
  first.close();

  const restarted = open(dir);
  t.after(() => restarted.close());
  assert.equal(restarted.getData().turnsIndexReady, false, "代次不一致必须在重启时暴露");
  await restarted.scan([], {});
  assert.equal(restarted.getData().turnsIndexReady, true);
  assert.equal(restarted.turnsStore.count(), 4);
  assert.equal(restarted.turnsStore.query({ type: "desktop" }).sumTokens, 60);
});

test("an empty aggregate cache with an old SQLite store is rebuilt and cleared", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan(numberedEntries(3), {});
  first.close();
  for (const name of fs.readdirSync(dir)) {
    if (/^token-cache\.json/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  }

  const engine = open(dir);
  t.after(() => engine.close());
  assert.equal(engine.getData().turnsIndexReady, false, "无聚合会话但存在旧 SQLite 时不得就绪");
  await engine.scan([], {});
  assert.equal(engine.getData().turnsIndexReady, true);
  assert.equal(engine.turnsStore.count(), 3, "从归档重新聚合并清除陈旧行");
  assert.deepEqual(engine.turnsStore.query({ all: true }).rows.map((row) => row.sessionKey).sort(), ["agent-a::desktop::2026-10-06", "agent-a::desktop::2026-10-06", "agent-a::desktop::2026-10-06"]);
});

test("history candidates prefer the oldest session and exclude recent before truncation", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const entries = [];
  for (let i = 0; i < 30; i++) {
    entries.push(entry(`recent-${i}`, { sessionId: `recent-${i}`, startedAt: `${DAY}T11:${String(i).padStart(2, "0")}:00.000Z` }));
  }
  entries.push(entry("hist", { sessionId: "hist-old", startedAt: "2026-09-01T09:00:00.000Z" }));
  await engine.scan(entries, {});

  const recent = entries.filter((row) => row.attribution.sessionId.startsWith("recent-")).map((row) => row.attribution.sessionId);
  const candidates = engine.sessionCandidates({ limit: 24, recent });
  assert.deepEqual(candidates.sessionIds, ["hist-old"], "真正历史必须在截断前保留并排在前面");
});

test("historical ids with surrounding whitespace are classified by the same canonical rule", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan([entry("p", { sessionId: "code-parent" })], {});
  const archive = fs.readFileSync(path.join(dir, "usage-archive.jsonl"), "utf8").trim().split("\n");
  const rewritten = archive.map((line) => {
    const row = JSON.parse(line);
    if (row.rid && row.v) row.v.sessionId = " code-parent ";
    return JSON.stringify(row);
  });
  fs.writeFileSync(path.join(dir, "usage-archive.jsonl"), rewritten.join("\n") + "\n");
  first.close();
  for (const name of fs.readdirSync(dir)) {
    if (/^(token-cache\.json|cache\.sqlite|session-sources\.json)/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  }

  const engine = open(dir);
  t.after(() => engine.close());
  const result = await engine.scan([], { sessionNamespaces: { " code-parent ": "code" } });
  const data = engine.getData();
  assert.equal(data.sessions[`agent-a::code::${DAY}`].totalTokens, 15, "两侧空白的已归档 ID 必须同样归为 Code");
  assert.equal(data.sessions[`agent-a::desktop::${DAY}`], undefined);
  assert.equal(engine.archiveCount(), 1);
  assert.equal(result.sourceClassification.status, "complete");
  assert.deepEqual(result.sourceAckSessionIds, ["code-parent"], "ack 必须使用规范化的会话 ID");
});

test("a round-1 style marker without a content generation is not treated as ready", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan(numberedEntries(3), {});
  first.close();
  pokeTurnsMeta(dir, { data_generation: null });

  const engine = open(dir);
  t.after(() => engine.close());
  assert.equal(engine.getData().turnsIndexReady, false, "只有键标记不足以证明内容与聚合一致");
  await engine.scan([], {});
  assert.equal(engine.getData().turnsIndexReady, true);
  assert.equal(engine.turnsStore.count(), 3);
});

function failCacheMetaAt(engine, callNumber) {
  const real = engine.cacheStore.saveMeta.bind(engine.cacheStore);
  let calls = 0;
  engine.cacheStore.saveMeta = (data) => {
    calls += 1;
    if (calls === callNumber) throw new Error("cache meta write failed");
    return real(data);
  };
  return () => { engine.cacheStore.saveMeta = real; };
}

test("a journal write followed by a meta failure stays pending and rebuilds from archive", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan(numberedEntries(3), {});
  first.close();

  const engine = open(dir);
  t.after(() => engine.close());
  // 第 1 次 meta 是屏障，第 2 次紧跟聚合 journal；只让第 2 次（journal 后的 meta）失败。
  const restore = failCacheMetaAt(engine, 2);
  await assert.rejects(engine.scan(numberedEntries(1, { from: 3 }), {}));
  assert.ok(engine.getData().aggregateWritePending, "写盘中段失败必须保持待提交屏障");
  restore();

  engine.close();
  const restarted = open(dir);
  t.after(() => restarted.close());
  assert.equal(restarted.getData().turnsIndexReady, false, "重启必须看到未完成写入");
  await restarted.scan([], {});
  const data = restarted.getData();
  assert.equal(data.aggregateWritePending, false);
  assert.equal(data.turnsIndexReady, true);
  const total = Object.values(data.sessions).reduce((sum, session) => sum + session.totalTokens, 0);
  assert.equal(total, 60, "恢复必须按归档重建聚合");
  assert.equal(restarted.turnsStore.count(), 4);
  assert.equal(restarted.turnsStore.query({ type: "desktop" }).sumTokens, 60);
});

test("a pending barrier blocks false-ready even when generation and row counts happen to match", async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = open(dir);
  await first.scan(numberedEntries(3), {});
  first.close();

  // 构造同代次、同会话数但内容可能不同的持久状态，并附带待提交屏障。
  pokeTurnsMeta(dir, { data_generation: "2" });
  const metaFile = path.join(dir, "token-cache.json.meta");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  meta.turnsGeneration = 2;
  meta.aggregateWritePending = true;
  meta.turnsIndexReady = true;
  fs.writeFileSync(metaFile, JSON.stringify(meta));

  const engine = open(dir);
  t.after(() => engine.close());
  assert.equal(engine.getData().aggregateWritePending, true);
  assert.equal(engine.getData().turnsIndexReady, false, "pending 屏障不得被同代次 marker 覆盖");
  await engine.scan([], {});
  assert.equal(engine.getData().turnsIndexReady, true);
  assert.equal(engine.getData().aggregateWritePending, false);
  assert.equal(engine.turnsStore.query({ type: "desktop" }).sumTokens, 45);
});

test("a failed final barrier clear keeps pending and recovers on the next scan", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await engine.scan(numberedEntries(3), {});
  // 1=开始屏障，2=聚合 meta，3=applyTurns 内部 meta，4=最终清屏障。
  const restore = failCacheMetaAt(engine, 4);
  const result = await engine.scan(numberedEntries(1, { from: 3 }), {});
  assert.equal(result.newArchivedCount, 1);
  assert.equal(engine.getData().aggregateWritePending, true, "清屏障失败不得宣称完整提交");
  assert.equal(engine.getData().turnsIndexReady, false);
  restore();

  await engine.scan([], {});
  assert.equal(engine.getData().aggregateWritePending, false);
  assert.equal(engine.getData().turnsIndexReady, true);
  assert.equal(engine.turnsStore.count(), 4);
});

test("a barrier write failure stops before touching archive or source state", async (t) => {
  const dir = tempDir();
  const engine = open(dir);
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await engine.scan(numberedEntries(1), {});
  const restore = failCacheMetaAt(engine, 1);
  await assert.rejects(engine.scan(numberedEntries(1, { from: 1 }), { sessionNamespaces: { "sess-1": "code" } }));
  restore();
  assert.equal(engine.archiveCount(), 1, "屏障失败时不得继续归档");
  assert.equal(engine.getData().sessions[`agent-a::code::${DAY}`], undefined, "屏障失败时不得提交分类变更");
});
