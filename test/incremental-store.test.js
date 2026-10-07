import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openArchiveStore } from "../runtime/engine/services/archive-store.js";
import { createJsonJournalStore } from "../runtime/engine/services/json-journal-store.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-journal-"));
}

test("legacy archive migrates without data loss and appends idempotently", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "usage-archive.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: "2026-10-01T00:00:00.000Z", entries: { old: { totalTokens: 9 } } }));

    const first = openArchiveStore(file);
    assert.deepEqual(first.entries.old, { totalTokens: 9 });
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(file + ".imported"), true);

    first.entries.new = { totalTokens: 4 };
    first.updatedAt = "2026-10-02T00:00:00.000Z";
    assert.equal(first.appendPending().rows, 1);

    const reopened = openArchiveStore(file);
    assert.deepEqual({ ...reopened.entries }, { old: { totalTokens: 9 }, new: { totalTokens: 4 } });
    assert.equal(reopened.appendPending().rows, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache journal persists only changed session rows and replays after restart", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "token-cache.json");
    const store = createJsonJournalStore({ file });
    const initial = { version: 20, lastScan: "a", agentNames: {}, sessions: { a: { mtime: 1, size: 2, totalTokens: 10 }, b: { mtime: 1, size: 2, totalTokens: 20 } } };
    assert.equal(store.save(initial, [], true).rows, 2);
    store.saveMeta(initial);

    const next = { ...initial, lastScan: "b", sessions: { a: { mtime: 1, size: 2, totalTokens: 11 }, b: initial.sessions.b } };
    assert.equal(store.save(next, ["a"], false).rows, 1);
    store.saveMeta(next);

    const loaded = createJsonJournalStore({ file }).load();
    assert.equal(loaded.lastScan, "b");
    assert.equal(loaded.sessions.a.totalTokens, 11);
    assert.equal(loaded.sessions.b.totalTokens, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache store does not mark rows persisted when journal append fails", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "token-cache.json");
    const journal = file + ".journal";
    fs.mkdirSync(journal);
    const store = createJsonJournalStore({ file });
    const data = { version: 20, sessions: { a: { mtime: 1, size: 2, totalTokens: 10 } } };

    assert.throws(() => store.save(data, [], false));
    fs.rmSync(journal, { recursive: true, force: true });
    assert.equal(store.save(data, [], false).rows, 1, "下一次成功追加必须仍写入失败时未落盘的行");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache journal skips a truncated tail and seals it before the next append", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "token-cache.json");
    const store = createJsonJournalStore({ file });
    const initial = { version: 20, sessions: { a: { mtime: 1, size: 2, totalTokens: 10 } } };
    store.save(initial, [], true);
    fs.appendFileSync(file + ".journal", '{"k":"broken"');

    const recovered = createJsonJournalStore({ file });
    assert.equal(recovered.load().sessions.a.totalTokens, 10);
    recovered.save({ version: 20, sessions: { a: initial.sessions.a, b: { mtime: 1, size: 2, totalTokens: 5 } } }, ["b"], false);
    const reopened = createJsonJournalStore({ file });
    assert.equal(reopened.load().sessions.b.totalTokens, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
