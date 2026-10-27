import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";
import { normalizeEntryForArchive } from "../lib/ledger-normalization.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-final-review-"));
}

function entry(requestId, totalTokens = 10) {
  return {
    requestId,
    startedAt: "2026-10-27T10:00:00.000+08:00",
    status: "ok",
    source: { subsystem: "session" },
    attribution: { agentId: "agent-a", sessionId: "session-a", kind: "session" },
    model: { provider: "provider-a", modelId: "model-a" },
    usage: {
      input: { totalTokens, uncachedTokens: totalTokens },
      output: { totalTokens: 0 },
      cache: { readTokens: 0, writeTokens: 0 },
      totalTokens,
    },
  };
}

function session(engine) {
  return engine.getData().sessions["agent-a::desktop::2026-10-27"];
}

function pageSession(engine) {
  return engine.page({ cursor: 0, maxBytes: 64 * 1024 }).sessions["agent-a::desktop::2026-10-27"];
}

function corruptBackups(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith("usage-archive.json.corrupt-"));
}

test("finalize 失败不发布新快照，下一轮成功重建且不重复", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  const first = entry("finalize-a");
  const second = entry("finalize-b");

  try {
    await engine.scan([first]);
    const oldLastScan = engine.status().lastScan;
    assert.equal(session(engine).totalTokens, 10);
    assert.equal(pageSession(engine).totalTokens, 10);

    const realSaveMeta = engine.cacheStore.saveMeta.bind(engine.cacheStore);
    engine.cacheStore.saveMeta = (cache) => {
      if (cache.aggregateWritePending === false) {
        throw Object.assign(new Error("barrier clear denied"), { code: "CACHE_BARRIER_CLEAR_FAILED" });
      }
      return realSaveMeta(cache);
    };

    await assert.rejects(engine.scan([second]), { code: "AGGREGATE_WRITE_FAILED" });
    assert.equal(session(engine).totalTokens, 10, "失败扫描不得暴露未提交的 20-token 快照");
    assert.equal(pageSession(engine).totalTokens, 10, "page 不得暴露未提交的新快照");
    assert.equal(engine.status().lastScan, oldLastScan, "status.lastScan 必须保留上次成功值");
    assert.equal(engine.getData().aggregateWritePending, true, "旧成功数据必须保留 pending 屏障");
    assert.equal(engine.needsFullRebuild, true, "失败后下一轮必须强制重建");
    assert.ok(engine.dirtyBuckets.size > 0, "失败后的新桶必须保留为 dirty");

    engine.cacheStore.saveMeta = realSaveMeta;
    await engine.scan([second]);
    assert.equal(session(engine).totalTokens, 20, "恢复后必须包含 A+B");
    assert.equal(session(engine).msgCount, 2, "恢复后请求数不得重复");
    assert.equal(pageSession(engine).totalTokens, 20);
    assert.equal(engine.status().lastScan > oldLastScan, true);
    assert.equal(engine.archiveCount(), 2, "归档原始记录不得重复");
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏 legacy 源文件跨重启持续阻止缩减，原位修复后正常迁移恢复", async () => {
  const dir = tempDir();
  const first = createLedgerEngine({ dataDir: dir, log: quiet });
  const a = entry("legacy-a");
  const b = entry("legacy-b");
  let cachedA;

  try {
    await first.scan([a]);
    cachedA = structuredClone(first.archiveStore.entries[a.requestId]);
    first.close();

    const journal = path.join(dir, "usage-archive.jsonl");
    const journalBackup = path.join(dir, "usage-archive.jsonl.test-backup");
    fs.renameSync(journal, journalBackup);
    const legacy = path.join(dir, "usage-archive.json");
    fs.writeFileSync(legacy, "{broken legacy archive");

    const firstRestart = createLedgerEngine({ dataDir: dir, log: quiet });
    try {
      assert.ok(firstRestart.archiveStore.readError);
      assert.equal(fs.existsSync(legacy), true, "损坏源必须保留在原位");
      assert.deepEqual(corruptBackups(dir), [], "不得把损坏源改名成 corrupt 备份");
      await assert.rejects(firstRestart.scan([b]), { code: "ARCHIVE_READ_FAILED" });
      assert.equal(session(firstRestart).totalTokens, 10);
      assert.equal(pageSession(firstRestart).totalTokens, 10);
    } finally {
      firstRestart.close();
    }

    const secondRestart = createLedgerEngine({ dataDir: dir, log: quiet });
    try {
      assert.ok(secondRestart.archiveStore.readError, "重启后必须重新识别原位损坏源");
      await assert.rejects(secondRestart.scan([b]), { code: "ARCHIVE_READ_FAILED" });
      assert.equal(session(secondRestart).totalTokens, 10);
      assert.equal(pageSession(secondRestart).totalTokens, 10);
    } finally {
      secondRestart.close();
    }

    // 手动提供完整合法 legacy：允许正常原子迁移，再由归档重建 A+B。
    fs.writeFileSync(legacy, JSON.stringify({
      version: 1,
      updatedAt: "2026-10-27T10:00:00.000Z",
      entries: {
        [a.requestId]: cachedA,
        [b.requestId]: normalizeEntryForArchive(b),
      },
    }));
    const repaired = createLedgerEngine({ dataDir: dir, log: quiet });
    try {
      await repaired.scan([]);
      assert.equal(session(repaired).totalTokens, 20);
      assert.equal(session(repaired).msgCount, 2);
      assert.equal(repaired.archiveCount(), 2);
      assert.equal(fs.existsSync(legacy), false, "合法 legacy 仍应完成正常迁移");
      assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("usage-archive.json.imported")));
      assert.equal(fs.existsSync(journalBackup), true, "测试备份的原始 JSONL 不应被自动删除");
    } finally {
      repaired.close();
    }
  } finally {
    try { first.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
