import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalClient, chunkLedgerEntries } from "../lib/local-client.mjs";
import { createFakeRuntime } from "./helpers/fake-runtime.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-client-"));
}

function entry(requestId) {
  return {
    requestId,
    startedAt: "2026-10-06T10:00:00.000Z",
    status: "ok",
    attribution: { agentId: "agent-a", sessionId: "session-a", kind: "session" },
    model: { provider: "deepseek", modelId: "deepseek-chat" },
    usage: { input: { totalTokens: 10 }, output: { totalTokens: 2 }, cache: { readTokens: 3 }, totalTokens: 15 },
  };
}

test("managed service starts once with scoped/external networking and stops cleanly",  async () => {
  const dir = tempDir();
  const fake = createFakeRuntime();
  const client = new LocalClient({ ctx: { dataDir: dir, runtime: fake.api }, dataDir: dir });
  try {
    const ids = await Promise.all([client.start(), client.start(), client.start()]);
    assert.equal(new Set(ids).size, 1);
    assert.equal(fake.stats.starts, 1);
    assert.equal(fake.stats.lastStartInput.profile, "scoped");
    assert.equal(fake.stats.lastStartInput.network, "external");
    assert.equal(fake.stats.lastStartInput.entry, "runtime/service.mjs");
    assert.equal((await client.call("status")).ready, true);
    await client.dispose();
    await client.dispose();
    assert.equal(fake.stats.stops, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("client batches ledger payloads and returns a paged child-process snapshot", async () => {
  const dir = tempDir();
  const fake = createFakeRuntime();
  const client = new LocalClient({ ctx: { dataDir: dir, runtime: fake.api }, dataDir: dir, scanTimeoutMs: 5000 });
  try {
    const result = await client.scan([entry("req-1")], { agentNames: { "agent-a": "Alpha" } });
    const snapshot = await client.readSnapshot();
    assert.equal(result.newArchivedCount, 1);
    assert.equal(snapshot.sessions["agent-a::desktop::2026-10-06"].totalTokens, 15);
    assert.equal(snapshot.agentNames["agent-a"], "Alpha");
  } finally {
    await client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dispose cancels queued operations and reports stop failures instead of pretending success", async () => {
  const dir = tempDir();
  const fake = createFakeRuntime();
  const client = new LocalClient({ ctx: { dataDir: dir, runtime: fake.api }, dataDir: dir });
  try {
    await client.start();
    const queued = client.call("status");
    const rejection = assert.rejects(queued, { code: "APP_STOPPED" });
    await client.dispose();
    await rejection;
    assert.equal(fake.stats.stops, 1);
    await assert.rejects(client.call("status"), /已停止/);
  } finally { await client.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  const failedDir = tempDir();
  const failing = createFakeRuntime();
  const stopped = new LocalClient({ ctx: { dataDir: failedDir, runtime: failing.api }, dataDir: failedDir });
  await stopped.start();
  const realStop = failing.api.stop;
  failing.api.stop = async () => { throw new Error("stop denied"); };
  try { await assert.rejects(stopped.dispose(), /stop denied/); }
  finally { await realStop("fake-runtime-1"); fs.rmSync(failedDir, { recursive: true, force: true }); }
});

test("chunking keeps RPC requests bounded and rejects one oversized ledger entry", () => {
  const values = Array.from({ length: 12 }, (_, i) => ({ requestId: String(i), payload: "x".repeat(40) }));
  const chunks = chunkLedgerEntries(values, 180);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), values);
  assert.throws(() => chunkLedgerEntries([{ payload: "x".repeat(1024 * 1024) }]), { code: "REQUEST_TOO_LARGE" });
});

test("failed runtime startup removes short-lived config and can be retried by a new client", async () => {
  const dir = tempDir();
  const fake = createFakeRuntime({ onStart() { throw Object.assign(new Error("denied"), { code: "RUNTIME_START_FAILED" }); } });
  const client = new LocalClient({ ctx: { dataDir: dir, runtime: fake.api }, dataDir: dir });
  try {
    await assert.rejects(client.start(), /denied/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
