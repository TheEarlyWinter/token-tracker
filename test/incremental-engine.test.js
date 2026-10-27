import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-engine-"));
}

function entry(requestId, { agentId = "agent-a", startedAt = "2026-10-06T10:00:00.000Z", totalTokens = 15, status = "ok" } = {}) {
  return {
    requestId,
    startedAt,
    status,
    source: { subsystem: "session" },
    attribution: { agentId, sessionId: "session-a", kind: "session" },
    model: { provider: "deepseek", modelId: "deepseek-chat" },
    usage: status === "ok" ? {
      input: { totalTokens: 10, uncachedTokens: 8 },
      output: { totalTokens: 2, reasoningTokens: 1 },
      cache: { readTokens: 3, writeTokens: 1, hitRatio: 0.2 },
      totalTokens,
      costTotal: 0.004,
    } : null,
  };
}

test("engine preserves official-ledger normalization and archives only valid terminal entries", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: { info() {}, warn() {}, error() {} } });
  try {
    const result = await engine.scan([entry("valid"), entry("failed", { status: "error" }), { ...entry("missing"), usage: null }], {
      agentNames: { "agent-a": "阿尔法" },
      coverageLimitReached: false,
    });
    const data = engine.getData();
    const session = data.sessions["agent-a::desktop::2026-10-06"];

    assert.equal(result.newArchivedCount, 1);
    assert.equal(session.totalTokens, 15);
    // input 对外统一是未命中输入；原始 total input 仍保存在归档里的 inputTokens。
    assert.equal(session.input, 8);
    assert.equal(session.inputUncached, 8);
    assert.equal(session.assistantCount, 1);
    assert.equal(data.agentNames["agent-a"], "阿尔法");
    assert.equal(engine.archiveCount(), 1);
    assert.equal(fs.existsSync(path.join(dir, "usage-archive.jsonl")), true);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate scans are idempotent and do not rewrite unchanged session rows", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: { info() {}, warn() {}, error() {} } });
  try {
    await engine.scan([entry("same")], {});
    const again = await engine.scan([entry("same")], {});
    assert.equal(again.newArchivedCount, 0);
    assert.equal(again.cacheWrites, 0);
    assert.equal(engine.getData().sessions["agent-a::desktop::2026-10-06"].totalTokens, 15);
    assert.equal(engine.archiveCount(), 1);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new ledger entries update only the affected aggregate bucket", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: { info() {}, warn() {}, error() {} } });
  try {
    await engine.scan([entry("one"), entry("other-agent", { agentId: "agent-b" })], {});
    const next = await engine.scan([
      entry("one"),
      entry("other-agent", { agentId: "agent-b" }),
      entry("two", { totalTokens: 7 }),
    ], {});

    assert.equal(next.newArchivedCount, 1);
    assert.equal(next.cacheWrites, 1);
    assert.equal(engine.getData().sessions["agent-a::desktop::2026-10-06"].totalTokens, 22);
    assert.equal(engine.getData().sessions["agent-b::desktop::2026-10-06"].totalTokens, 15);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("live usage event is journaled once and folded into the next ledger scan", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: { info() {}, warn() {}, error() {} } });
  try {
    const live = entry("live");
    assert.equal((await engine.archiveUsage(live)).accepted, true);
    assert.equal((await engine.archiveUsage(live)).accepted, false);
    const result = await engine.scan([live], {});
    assert.equal(result.newArchivedCount, 0);
    assert.equal(engine.getData().sessions["agent-a::desktop::2026-10-06"].totalTokens, 15);
    assert.equal(engine.archiveCount(), 1);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized session records are trimmed for transport without touching stored history", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: { info() {}, warn() {}, error() {} } });
  try {
    // 单个 Agent-日桶塞进足够多请求，让记录超过 RPC 单条预算（约 900KB）。
    const many = Array.from({ length: 9000 }, (_, i) =>
      entry(`bulk-${i}`, { startedAt: `2026-10-06T${String(10 + (i % 10)).padStart(2, "0")}:00:00+08:00` })
    );
    await engine.scan(many, {});

    const key = "agent-a::desktop::2026-10-06";
    const stored = engine.getData().sessions[key];
    assert.equal(stored.conversations.length, 9000, "磁盘缓存保留全量明细");

    const payload = engine.page({ cursor: 0 });
    const row = payload.sessions[key];
    assert.ok(row, "超预算记录仍必须能被翻出");
    assert.equal(row.conversationsTotal, 9000);
    assert.equal(row.conversationsTruncated, true);
    assert.ok(row.conversations.length < 9000);
    assert.ok(row.conversations.length > 0);
    // 裁剪保留最近的请求，不是从头截断。
    assert.equal(row.conversations[row.conversations.length - 1].time, stored.conversations[stored.conversations.length - 1].time);
    assert.ok(Buffer.byteLength(JSON.stringify({ [key]: row })) <= 900 * 1024);

    // 聚合字段不受裁剪影响。
    assert.equal(row.totalTokens, stored.totalTokens);
    assert.equal(row.assistantCount, stored.assistantCount);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
