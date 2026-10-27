import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";
import { createRealtimeState, handleLlmUsageEvent } from "../lib/realtime-stream.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-archive-retry-"));
}

function entry(requestId) {
  return {
    requestId,
    startedAt: "2026-10-27T10:00:00.000+08:00",
    status: "ok",
    source: { subsystem: "session" },
    attribution: { agentId: "agent-a", sessionId: "session-a", kind: "session" },
    model: { provider: "provider-a", modelId: "model-a" },
    usage: {
      input: { totalTokens: 100, uncachedTokens: 10 },
      output: { totalTokens: 5 },
      cache: { readTokens: 90, writeTokens: 0 },
      totalTokens: 105,
    },
  };
}

function archiveRecords(dir) {
  const file = path.join(dir, "usage-archive.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function archiveRids(dir) {
  return archiveRecords(dir).filter((record) => record.rid).map((record) => record.rid);
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

function realtimeShared(engine) {
  return {
    _seenRealtimeUsage: new Set(),
    _archivedRealtimeUsage: new Set(),
    _realtimeArchiveInFlight: new Map(),
    _realtimeClients: new Set(),
    realtime: createRealtimeState(),
    agentNames: {},
    log: quiet,
    client: { archiveUsage: (raw) => engine.archiveUsage(raw) },
  };
}

test("真实 engine 在 append 失败后通过同 rid 重试落盘并重启恢复，聚合不重复", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  const raw = entry("archive-retry");
  const realAppend = engine.archiveStore.appendPending.bind(engine.archiveStore);
  let appendCalls = 0;
  engine.archiveStore.appendPending = () => {
    appendCalls++;
    if (appendCalls === 1) throw Object.assign(new Error("disk full"), { code: "ARCHIVE_WRITE_FAILED" });
    return realAppend();
  };

  try {
    await assert.rejects(Promise.resolve().then(() => engine.archiveUsage(raw)), { code: "ARCHIVE_WRITE_FAILED" });
    assert.equal(engine.archiveStore.entries[raw.requestId].totalTokens, 105, "失败后 rid 只应留在待落盘内存");
    assert.deepEqual(archiveRids(dir), [], "首次 append 失败时磁盘不得出现 rid");

    const retry = engine.archiveUsage(raw);
    assert.deepEqual(retry, { accepted: false, reason: "duplicate" });
    assert.deepEqual(archiveRids(dir), [raw.requestId], "duplicate 重试必须刷新 pending 并真正落盘");
    engine.close();

    const restarted = createLedgerEngine({ dataDir: dir, log: quiet });
    try {
      assert.equal(restarted.archiveCount(), 1, "重启后归档仍应包含该 rid");
      await restarted.scan([]);
      const session = restarted.getData().sessions["agent-a::desktop::2026-10-27"];
      assert.equal(session.totalTokens, 105, "重建后总 token 只能计一次");
      assert.equal(session.assistantCount, 1, "重建后 UI/调用计数只能计一次");
    } finally {
      restarted.close();
    }
  } finally {
    try { engine.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("实时同事件重试真实 engine 的失败 append，但 UI token 与请求计数不重复", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  const raw = entry("realtime-archive-retry");
  const realAppend = engine.archiveStore.appendPending.bind(engine.archiveStore);
  let appendCalls = 0;
  engine.archiveStore.appendPending = () => {
    appendCalls++;
    if (appendCalls === 1) throw Object.assign(new Error("disk full"), { code: "ARCHIVE_WRITE_FAILED" });
    return realAppend();
  };
  const shared = realtimeShared(engine);

  try {
    handleLlmUsageEvent(shared, raw);
    await tick();
    assert.equal(shared.realtime.sessionTotalTokens, 105);
    assert.equal(shared.realtime.sessionMsgCount, 1);
    assert.deepEqual(archiveRids(dir), [], "实时首次落盘失败时磁盘不得出现 rid");

    handleLlmUsageEvent(shared, raw);
    await tick();
    assert.deepEqual(archiveRids(dir), [raw.requestId], "实时重试必须走 engine 的 pending flush");
    assert.equal(shared.realtime.sessionTotalTokens, 105, "重复事件不得重复累计 UI token");
    assert.equal(shared.realtime.sessionMsgCount, 1, "重复事件不得重复累计 UI 请求数");
    assert.equal(shared.realtime.totalRequests, 1);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("连续两次真实 append 失败都必须抛错，不能被 duplicate 假成功吞掉", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  const raw = entry("archive-two-failures");
  let appendCalls = 0;
  engine.archiveStore.appendPending = () => {
    appendCalls++;
    if (appendCalls <= 2) throw Object.assign(new Error(`disk full ${appendCalls}`), { code: "ARCHIVE_WRITE_FAILED" });
    throw new Error("unexpected third append");
  };

  try {
    await assert.rejects(Promise.resolve().then(() => engine.archiveUsage(raw)), { code: "ARCHIVE_WRITE_FAILED" });
    await assert.rejects(Promise.resolve().then(() => engine.archiveUsage(raw)), { code: "ARCHIVE_WRITE_FAILED" });
    assert.equal(appendCalls, 2, "两次调用都必须实际尝试 append");
    assert.deepEqual(archiveRids(dir), [], "连续失败不能产生伪落盘记录");
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("正常已持久化的 duplicate 不新增归档行", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  const raw = entry("already-persisted");

  try {
    assert.equal(engine.archiveUsage(raw).accepted, true);
    const before = archiveRecords(dir).filter((record) => record.rid === raw.requestId);
    assert.equal(before.length, 1);
    assert.deepEqual(engine.archiveUsage(raw), { accepted: false, reason: "duplicate" });
    const after = archiveRecords(dir).filter((record) => record.rid === raw.requestId);
    assert.equal(after.length, 1, "正常 duplicate 不得追加第二行");
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
