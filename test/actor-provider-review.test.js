import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const day = "2026-10-27";
const hour = "10";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-actor-provider-"));
}

function entry(requestId, {
  agentId = "test-agent",
  sessionId = "shared-session",
  provider = "provider-a",
  modelId = "shared-model",
  totalTokens = 10,
  subsystem = "session",
  childAgentId = null,
} = {}) {
  const isSub = subsystem === "subagent";
  return {
    requestId,
    startedAt: `${day}T${hour}:00:00+08:00`,
    status: "ok",
    source: {
      subsystem,
      ...(isSub && childAgentId ? { actor: { kind: "subagent", agentId: childAgentId } } : {}),
    },
    attribution: {
      agentId,
      sessionId,
      kind: "session",
      ...(isSub && childAgentId ? { childAgentId } : {}),
    },
    model: { provider, modelId },
    usage: {
      input: { totalTokens, uncachedTokens: totalTokens },
      output: { totalTokens: 0 },
      cache: { readTokens: 0, writeTokens: 0 },
      totalTokens,
    },
  };
}

function fixtureEntries() {
  return [
    entry("self-a", { provider: "provider-a", totalTokens: 10 }),
    entry("self-b", { provider: "provider-b", totalTokens: 20 }),
    entry("self-unknown", { provider: "", modelId: "unknown-provider-model", totalTokens: 5 }),
    entry("sub-a", { subsystem: "subagent", childAgentId: "executor-agent", provider: "provider-a", totalTokens: 7 }),
    entry("sub-b", { subsystem: "subagent", childAgentId: "executor-agent", provider: "provider-b", totalTokens: 13 }),
  ];
}

function actorProviderTotals(snapshot, sessionKey, actorId) {
  return snapshot.sessions[sessionKey].dailyBreakdown[day].actors[actorId].providerTotals;
}

test("actor providerTotals keeps same-model providers separate in daily and hourly buckets", async () => {
  const dir = tempDir();
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  try {
    await engine.scan(fixtureEntries());
    const snapshot = engine.getData();
    const selfKey = `test-agent::desktop::${day}`;
    const subKey = `test-agent::sub::${day}`;
    const selfDay = snapshot.sessions[selfKey].dailyBreakdown[day];
    const selfHour = snapshot.sessions[selfKey].hourlyBreakdown[day][hour];
    const subDay = snapshot.sessions[subKey].dailyBreakdown[day];
    const subHour = snapshot.sessions[subKey].hourlyBreakdown[day][hour];

    assert.equal(selfDay.actors["test-agent"].models["shared-model"].totalTokens, 30);
    assert.deepEqual(actorProviderTotals(snapshot, selfKey, "test-agent"), {
      "provider-a/shared-model": {
        provider: "provider-a", model: "shared-model", input: 10, output: 0,
        cacheRead: 0, cacheWrite: 0, totalTokens: 10, assistantCount: 1, subTokens: 0,
      },
      "provider-b/shared-model": {
        provider: "provider-b", model: "shared-model", input: 20, output: 0,
        cacheRead: 0, cacheWrite: 0, totalTokens: 20, assistantCount: 1, subTokens: 0,
      },
    });
    assert.equal(selfHour.actors["test-agent"].models["shared-model"].totalTokens, 30);
    assert.equal(selfHour.actors["test-agent"].providerTotals["provider-a/shared-model"].totalTokens, 10);
    assert.equal(selfHour.actors["test-agent"].providerTotals["provider-b/shared-model"].totalTokens, 20);
    assert.equal(Object.keys(selfDay.actors["test-agent"].providerTotals).length, 2, "未知 provider 不得伪造 providerTotals 键");

    assert.equal(subDay.actors["executor-agent"].models["shared-model"].totalTokens, 20);
    assert.equal(subDay.actors["executor-agent"].providerTotals["provider-a/shared-model"].totalTokens, 7);
    assert.equal(subDay.actors["executor-agent"].providerTotals["provider-a/shared-model"].subTokens, 7);
    assert.equal(subDay.actors["executor-agent"].providerTotals["provider-b/shared-model"].totalTokens, 13);
    assert.equal(subDay.actors["executor-agent"].providerTotals["provider-b/shared-model"].subTokens, 13);
    assert.equal(subHour.actors["executor-agent"].providerTotals["provider-a/shared-model"].totalTokens, 7);
    assert.equal(subHour.actors["executor-agent"].providerTotals["provider-b/shared-model"].totalTokens, 13);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restart rebuilds providerTotals from archive without duplicating actor totals", async () => {
  const dir = tempDir();
  const first = createLedgerEngine({ dataDir: dir, log: quiet });
  const entries = fixtureEntries();
  await first.scan(entries);
  const oldCache = structuredClone(first.getData());
  first.close();

  // 模拟尚未带 providerTotals 的旧派生缓存；归档保持完整，由新 CACHE_VERSION 触发重建。
  oldCache.version = 22;
  for (const session of Object.values(oldCache.sessions)) {
    for (const bucket of Object.values(session.dailyBreakdown || {})) {
      for (const actor of Object.values(bucket.actors || {})) delete actor.providerTotals;
    }
    for (const hours of Object.values(session.hourlyBreakdown || {})) {
      for (const bucket of Object.values(hours || {})) {
        for (const actor of Object.values(bucket.actors || {})) delete actor.providerTotals;
      }
    }
  }
  fs.rmSync(path.join(dir, "token-cache.json"), { force: true });
  fs.rmSync(path.join(dir, "token-cache.json.journal"), { force: true });
  fs.rmSync(path.join(dir, "token-cache.json.meta"), { force: true });
  fs.writeFileSync(path.join(dir, "token-cache.json"), JSON.stringify({
    version: 22,
    turnsGeneration: oldCache.turnsGeneration,
    sessions: oldCache.sessions,
  }));

  const restarted = createLedgerEngine({ dataDir: dir, log: quiet });
  try {
    await restarted.scan([]);
    const snapshot = restarted.getData();
    const selfKey = `test-agent::desktop::${day}`;
    const subKey = `test-agent::sub::${day}`;
    const selfActor = snapshot.sessions[selfKey].dailyBreakdown[day].actors["test-agent"];
    const subActor = snapshot.sessions[subKey].dailyBreakdown[day].actors["executor-agent"];
    assert.equal(selfActor.models["shared-model"].totalTokens, 30);
    assert.equal(selfActor.providerTotals["provider-a/shared-model"].totalTokens, 10);
    assert.equal(selfActor.providerTotals["provider-b/shared-model"].totalTokens, 20);
    assert.equal(subActor.models["shared-model"].totalTokens, 20);
    assert.equal(subActor.providerTotals["provider-a/shared-model"].subTokens, 7);
    assert.equal(subActor.providerTotals["provider-b/shared-model"].subTokens, 13);
  } finally {
    restarted.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
