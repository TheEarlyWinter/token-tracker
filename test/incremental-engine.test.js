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
    assert.equal(session.input, 10);
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
