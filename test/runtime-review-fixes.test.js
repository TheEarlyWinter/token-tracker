import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { LocalClient } from "../lib/local-client.mjs";
import { createSyncScheduler } from "../lib/sync-scheduler.mjs";
import { createRealtimeState, handleLlmUsageEvent } from "../lib/realtime-stream.mjs";
import { normalizeEntryForArchive } from "../lib/ledger-normalization.mjs";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";

import { loadLedger, resetLedgerMemo } from "../runtime/engine/services/ledger-source.js";

import { openTurnsStore } from "../runtime/engine/services/turns-store.js";
import { buildDetailsCSV } from "../runtime/engine/services/details-csv.js";
import { createFakeRuntime } from "./helpers/fake-runtime.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function tempDir(prefix = "token-tracker-review-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function entry(requestId, {
  agentId = "agent-a",
  sessionId = "session-a",
  startedAt = "2026-10-06T10:00:00.000+08:00",
  inputTotal = 100,
  uncached = 10,
  cacheRead = 90,
  cacheWrite = 0,
  output = 5,
  total = 105,
  omitTotal = false,
} = {}) {
  const usage = {
    input: { totalTokens: inputTotal, uncachedTokens: uncached },
    output: { totalTokens: output },
    cache: { readTokens: cacheRead, writeTokens: cacheWrite },
  };
  if (!omitTotal) usage.totalTokens = total;
  return {
    requestId,
    startedAt,
    status: "ok",
    source: { subsystem: "session" },
    attribution: { agentId, sessionId, kind: "session" },
    model: { provider: "provider-a", modelId: "model-a" },
    usage,
  };
}

function archiveLine(file, rid) {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((record) => record.rid === rid);
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

function schedulerShared() {
  return {
    agentNames: {},
    poolAgentIds: [],
    health: { set() {} },
    log: quiet,
    data: null,
    ready: false,
    scanMeta: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    syncFailed: false,
    usageQueryError: null,
    disposed: false,
  };
}

test("pre-commit scan failures abort only their pending RPC and the next scan succeeds", async () => {
  const dir = tempDir("token-tracker-client-abort-");
  const fake = createFakeRuntime();
  const client = new LocalClient({ ctx: { dataDir: dir, runtime: fake.api }, dataDir: dir });
  try {
    const oversized = { ...entry("oversized"), payload: "x".repeat(1024 * 1024) };
    await assert.rejects(client.scan([oversized]), { code: "REQUEST_TOO_LARGE" });
    const recovered = await client.scan([entry("after-oversized")]);
    assert.equal(recovered.newArchivedCount, 1, "超大单条失败后不能把 pending 扫描卡死");
  } finally {
    await client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("append failure is aborted best-effort without changing the original RPC error", async () => {
  const dir = tempDir("token-tracker-client-append-");
  const fake = createFakeRuntime();
  const realFetch = fake.api.fetch.bind(fake.api);
  let failAppend = true;
  fake.api.fetch = async (runtimeId, endpoint, init) => {
    const request = JSON.parse(init.body);
    if (failAppend && request.method === "scan.append") {
      failAppend = false;
      return new Response(JSON.stringify({ error: { code: "APPEND_FAILED", message: "append failed" } }), { status: 503 });
    }
    return realFetch(runtimeId, endpoint, init);
  };
  const client = new LocalClient({ ctx: { dataDir: dir, runtime: fake.api }, dataDir: dir });
  try {
    await assert.rejects(client.scan([entry("append-fails")]), { code: "APPEND_FAILED" });
    const recovered = await client.scan([entry("after-append-failure")]);
    assert.equal(recovered.newArchivedCount, 1, "append 失败后下一次扫描必须能重新 begin");
  } finally {
    await client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scan.abort cannot clear another scan and never cancels a committed job", async () => {
  const dir = tempDir("token-tracker-rpc-abort-");
  const fake = createFakeRuntime();
  const client = new LocalClient({ ctx: { dataDir: dir, runtime: fake.api }, dataDir: dir });
  try {
    await client.start();
    await client._requestRuntime("scan.begin", { scanId: "owned-scan" });
    const wrong = await client._requestRuntime("scan.abort", { scanId: "other-scan" });
    assert.equal(wrong.aborted, false);
    await assert.rejects(client._requestRuntime("scan.begin", { scanId: "other-scan" }), { code: "BUSY" });

    const right = await client._requestRuntime("scan.abort", { scanId: "owned-scan" });
    assert.equal(right.aborted, true);
    await client._requestRuntime("scan.begin", { scanId: "committed-scan" });
    const committed = await client._requestRuntime("scan.commit", { scanId: "committed-scan" });
    const afterCommit = await client._requestRuntime("scan.abort", { scanId: "committed-scan" });
    assert.equal(afterCommit.aborted, false, "abort 不能杀掉已提交的运行任务");
    let state;
    for (let i = 0; i < 50; i++) {
      state = await client._requestRuntime("scan.status", { jobId: committed.jobId });
      if (state.state !== "running") break;
      await tick();
    }
    assert.equal(state.state, "complete");
  } finally {
    await client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregate input is uncached everywhere, preserves raw totals, and does not double-count cache", async () => {
  const dir = tempDir("token-tracker-input-");
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  try {
    const raw = entry("semantic-input", { omitTotal: true, cacheWrite: 4 });
    await engine.scan([raw]);
    const data = engine.getData();
    const session = data.sessions["agent-a::desktop::2026-10-06"];
    const day = session.dailyBreakdown["2026-10-06"];
    const hour = session.hourlyBreakdown["2026-10-06"]["10"];
    const model = session.models["model-a"];
    const provider = session.providers["provider-a/model-a"];
    const dailyModel = day.models["model-a"];
    const dailyProvider = day.providerTotals["provider-a/model-a"];
    const actor = day.actors["agent-a"];
    const turns = engine.turnsStore.query({ all: true, sortKey: "uncached", order: "desc" });

    assert.equal(archiveLine(path.join(dir, "usage-archive.jsonl"), "semantic-input").v.inputTokens, 100);
    assert.equal(archiveLine(path.join(dir, "usage-archive.jsonl"), "semantic-input").v.inputUncachedTokens, 10);
    assert.equal(archiveLine(path.join(dir, "usage-archive.jsonl"), "semantic-input").v.totalTokens, 105, "缺省 total 不能把缓存再加一遍");

    for (const value of [session, model, provider, day, dailyModel, dailyProvider, actor, hour, hour.models["model-a"], hour.providerTotals["provider-a/model-a"]]) {
      assert.equal(value.input, 10, "所有聚合层的 input 都必须是未命中输入");
    }
    assert.equal(session.inputUncached, 10);
    assert.equal(session.totalTokens, 105);
    assert.equal(session.output, 5);
    assert.equal(session.cacheRead, 90);
    assert.equal(session.cacheWrite, 4);
    assert.equal(session.conversations[0].inTokens, 10);
    assert.equal(turns.rows[0].input, 10);
    assert.equal(turns.rows[0].total, 105);
    assert.match(buildDetailsCSV(turns.rows).split("\r\n")[1], /,"10","5","90\.0%","1","105"$/);
    assert.match(buildDetailsCSV([{ at: "2026-10-06T10:00:00Z", inputTokens: 100, inputUncachedTokens: 10, output: 5, cacheRead: 90, calls: 1, total: 105 }]).split("\r\n")[1], /,"10","5","90\.0%","1","105"$/);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache version change rebuilds old derived input fields from the unchanged archive", async () => {
  const dir = tempDir("token-tracker-input-rebuild-");
  const first = createLedgerEngine({ dataDir: dir, log: quiet });
  const raw = entry("rebuild-input", { omitTotal: true });
  await first.scan([raw]);
  const key = "agent-a::desktop::2026-10-06";
  const oldCache = structuredClone(first.getData());
  first.close();

  oldCache.version = 22;
  oldCache.sessions[key].input = 100;
  oldCache.sessions[key].inputUncached = 100;
  oldCache.sessions[key].dailyBreakdown["2026-10-06"].input = 100;
  oldCache.sessions[key].dailyBreakdown["2026-10-06"].inputUncached = 100;
  oldCache.sessions[key].conversations[0].inTokens = 100;
  fs.rmSync(path.join(dir, "token-cache.json.journal"), { force: true });
  fs.rmSync(path.join(dir, "token-cache.json.meta"), { force: true });
  fs.writeFileSync(path.join(dir, "token-cache.json"), JSON.stringify({ version: 22, turnsGeneration: 1, sessions: oldCache.sessions }));

  const restarted = createLedgerEngine({ dataDir: dir, log: quiet });
  try {
    await restarted.scan([]);
    const rebuilt = restarted.getData().sessions[key];
    assert.equal(rebuilt.input, 10);
    assert.equal(rebuilt.dailyBreakdown["2026-10-06"].input, 10);
    assert.equal(rebuilt.conversations[0].inTokens, 10);
  } finally {
    restarted.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("turn rows use the app timezone even when the child process local timezone is UTC", () => {
  const moduleUrl = pathToFileURL(path.resolve("runtime/engine/services/turns-store.js")).href;
  const script = `import { turnRowsFor } from ${JSON.stringify(moduleUrl)};\nconst rows = turnRowsFor("agent-a::desktop::2026-10-07", { agent: "agent-a", type: "desktop", conversations: [{ time: "2026-10-06T16:00:00.000Z", totalTokens: 1 }] });\nprocess.stdout.write(JSON.stringify(rows));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve("."),
    env: { ...process.env, TZ: "UTC", TOKEN_TRACKER_FORCE_TZ: "Asia/Shanghai" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0][3], "2026-10-07");
});

test("an old turns index is rebuilt with the same app-day semantics", async () => {
  const dir = tempDir("token-tracker-day-rebuild-");
  const raw = entry("day-rebuild", { startedAt: "2026-10-06T16:00:00.000Z" });
  const normalized = normalizeEntryForArchive(raw);
  const key = "agent-a::desktop::2026-10-07";
  const session = {
    agent: "agent-a",
    type: "desktop",
    msgCount: 1,
    conversations: [{ time: raw.startedAt, provider: "provider-a", model: "model-a", totalTokens: 105, inTokens: 10, outTokens: 5, cacheRead: 90 }],
  };
  fs.writeFileSync(path.join(dir, "usage-archive.jsonl"), JSON.stringify({ rid: raw.requestId, v: normalized }) + "\n");
  fs.writeFileSync(path.join(dir, "token-cache.json"), JSON.stringify({ version: 22, turnsGeneration: 1, sessions: { [key]: session } }));
  const oldTurns = openTurnsStore({ file: path.join(dir, "cache.sqlite"), log: quiet });
  assert.ok(oldTurns);
  oldTurns.replaceSession(key, session);
  oldTurns.setMeta("index_key", "bucket-v1");
  oldTurns.setMeta("data_generation", "1");
  oldTurns.close();

  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  try {
    await engine.scan([]);
    const rows = engine.turnsStore.query({ all: true }).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].day, "2026-10-07");
    assert.equal(engine.turnsStore.getMeta("index_key"), "bucket-v2:Asia/Shanghai");
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregate barrier failure rejects the scan and scheduler keeps the last success and source ack", async () => {
  const dir = tempDir("token-tracker-barrier-");
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  const shared = schedulerShared();
  const raw = entry("barrier-entry", { sessionId: "barrier-session" });
  const resolver = {
    acked: [],
    async resolve() {
      return { sessionNamespaces: { "barrier-session": "chat" }, sourceResolution: { capability: "ready", failedSessionIds: [] } };
    },
    ack(ids) { this.acked.push(ids); },
  };
  const client = {
    async scan(entries, options) { return engine.scan(entries, options); },
    async readSnapshot() { return engine.getData(); },
  };
  const sdk = { usage: { async list() { return { entries: [raw] }; } } };
  const scheduler = createSyncScheduler({ shared, client, sdk, interval: 60000, sourceResolver: resolver });
  try {
    await scheduler.scan(false);
    const previous = shared.data;
    const previousSuccess = shared.lastSuccessAt;
    const realSaveMeta = engine.cacheStore.saveMeta.bind(engine.cacheStore);
    engine.cacheStore.saveMeta = (cache) => {
      if (cache.aggregateWritePending === false) throw Object.assign(new Error("barrier clear denied"), { code: "CACHE_BARRIER_CLEAR_FAILED" });
      return realSaveMeta(cache);
    };

    await assert.rejects(scheduler.scan(false), { code: "AGGREGATE_WRITE_FAILED" });
    assert.strictEqual(shared.data, previous);
    assert.equal(shared.lastSuccessAt, previousSuccess);
    assert.equal(shared.syncFailed, true);
    assert.equal(resolver.acked.length, 1, "失败扫描不能 ack 来源映射");

    engine.cacheStore.saveMeta = realSaveMeta;
    await scheduler.scan(false);
    assert.equal(shared.syncFailed, false);
    assert.equal(resolver.acked.length, 2);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("realtime archive failure can retry without double-counting UI usage", async () => {
  let archiveCalls = 0;
  const shared = {
    _seenRealtimeUsage: new Set(),
    _realtimeClients: new Set(),
    realtime: createRealtimeState(),
    agentNames: {},
    log: quiet,
    client: {
      async archiveUsage() {
        archiveCalls += 1;
        if (archiveCalls === 1) throw Object.assign(new Error("disk full"), { code: "ARCHIVE_WRITE_FAILED" });
        return { accepted: true };
      },
    },
  };
  const raw = entry("live-retry", { sessionId: "live-session" });

  handleLlmUsageEvent(shared, raw);
  await tick();
  handleLlmUsageEvent(shared, raw);
  await tick();
  handleLlmUsageEvent(shared, raw);
  await tick();

  assert.equal(archiveCalls, 2, "失败后同一事件再次到达必须重试归档");
  assert.equal(shared.realtime.sessionMsgCount, 1, "重试不能重复增加实时 UI 计数");
});

test("realtime session counter resets on a real session change and keeps a missing id as fallback", async () => {
  const shared = {
    _seenRealtimeUsage: new Set(),
    _realtimeClients: new Set(),
    realtime: createRealtimeState(),
    agentNames: {},
    log: quiet,
    client: { async archiveUsage() { return { accepted: true }; } },
  };
  handleLlmUsageEvent(shared, entry("session-one", { sessionId: "s-1" }));
  handleLlmUsageEvent(shared, entry("session-two", { sessionId: "s-2" }));
  await tick();
  assert.equal(shared.realtime.sessionId, "s-2");
  assert.equal(shared.realtime.sessionMsgCount, 1);

  const missing = entry("session-missing", { sessionId: null });
  handleLlmUsageEvent(shared, missing);
  await tick();
  assert.equal(shared.realtime.sessionId, "s-2", "缺 sessionId 不能把同一 Agent 误判为新会话");
  assert.equal(shared.realtime.sessionMsgCount, 2);
});

test("ledger memo includes the absolute source path", () => {
  const homeA = tempDir("token-tracker-home-a-");
  const homeB = tempDir("token-tracker-home-b-");
  try {
    const jsonA = path.join(homeA, "usage-ledger.json");
    const jsonB = path.join(homeB, "usage-ledger.json");
    fs.writeFileSync(jsonA, JSON.stringify({ entries: [{ requestId: "home-a" }] }));
    fs.writeFileSync(jsonB, JSON.stringify({ entries: [{ requestId: "home-b" }] }));
    const sameTime = new Date("2026-10-27T00:00:00.000Z");
    fs.utimesSync(jsonA, sameTime, sameTime);
    fs.utimesSync(jsonB, sameTime, sameTime);
    resetLedgerMemo();

    const first = loadLedger(homeA, quiet);
    const second = loadLedger(homeB, quiet);
    assert.equal(first.entries[0].requestId, "home-a");
    assert.equal(second.entries[0].requestId, "home-b");
    assert.notEqual(second.sourcePath, first.sourcePath);
  } finally {
    resetLedgerMemo();
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  }
});

test("archive read failure preserves the old successful snapshot and reports a stable sync error", async () => {
  const dir = tempDir("token-tracker-archive-read-");
  const first = createLedgerEngine({ dataDir: dir, log: quiet });
  const entries = [entry("archive-a"), entry("archive-b", { startedAt: "2026-10-06T11:00:00.000Z" })];
  await first.scan(entries);
  first.close();
  const journal = path.join(dir, "usage-archive.jsonl");
  fs.renameSync(journal, journal + ".saved");
  fs.mkdirSync(journal);
  const metaFile = path.join(dir, "token-cache.json.meta");
  const before = fs.readFileSync(metaFile, "utf8");

  const restarted = createLedgerEngine({ dataDir: dir, log: quiet });
  try {
    assert.ok(restarted.archiveStore.readError);
    assert.equal(Object.keys(restarted.getData().sessions).length, 1);
    await assert.rejects(restarted.scan([]), { code: "ARCHIVE_READ_FAILED" });
    assert.equal(Object.keys(restarted.getData().sessions).length, 1);
    assert.equal(fs.readFileSync(metaFile, "utf8"), before, "失败读取不能写 pending 或缩减旧缓存");
  } finally {
    restarted.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt archive rows refuse a rebuild only when they would shrink a successful snapshot", async () => {
  const dir = tempDir("token-tracker-archive-corrupt-");
  const first = createLedgerEngine({ dataDir: dir, log: quiet });
  const entries = [entry("corrupt-a"), entry("corrupt-b", { startedAt: "2026-10-06T11:00:00.000Z" })];
  await first.scan(entries);
  first.close();
  const journal = path.join(dir, "usage-archive.jsonl");
  const records = fs.readFileSync(journal, "utf8").split(/\r?\n/).filter(Boolean);
  const firstRow = records.find((line) => JSON.parse(line).rid === "corrupt-a");
  fs.writeFileSync(journal, `${firstRow}\n{broken archive row}\n`);

  const restarted = createLedgerEngine({ dataDir: dir, log: quiet });
  try {
    assert.equal(restarted.archiveStore.skipped, 1);
    assert.equal(Object.keys(restarted.getData().sessions).length, 1);
    await assert.rejects(restarted.scan([]), { code: "ARCHIVE_INCOMPLETE" });
    assert.equal(Object.keys(restarted.getData().sessions).length, 1);
  } finally {
    restarted.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
