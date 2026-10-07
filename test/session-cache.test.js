import test from "node:test";
import assert from "node:assert/strict";
import { FirstResponseTimer } from "../lib/first-response.mjs";
import {
  SessionCacheStatus,
  aggregate,
  estimateOutputSpeed,
  renderCachePart,
  renderSpeedPart,
  splitCache,
} from "../lib/session-cache.mjs";

function ledgerEntry(requestId, overrides = {}) {
  return {
    requestId,
    startedAt: "2026-10-06T10:00:00.000Z",
    endedAt: "2026-10-06T10:00:02.000Z",
    durationMs: 2000,
    status: "ok",
    attribution: { sessionId: "session-a", agentId: "agent-a", kind: "session" },
    model: { provider: "deepseek", modelId: "deepseek-chat" },
    usage: {
      input: { totalTokens: 100, uncachedTokens: 10 },
      output: { totalTokens: 20 },
      cache: { readTokens: 90, hitRatio: 0.9 },
      totalTokens: 120,
    },
    ...overrides,
  };
}

test("cache capsule aggregates hit/miss by token volume and de-duplicates request IDs", () => {
  const entries = [ledgerEntry("one"), ledgerEntry("one"), ledgerEntry("two", {
    usage: { input: { totalTokens: 200, uncachedTokens: 100 }, output: { totalTokens: 20 }, cache: { readTokens: 100 }, totalTokens: 320 },
  })];
  const result = aggregate(entries);
  assert.equal(result.requests, 2);
  assert.equal(result.read, 190);
  assert.equal(result.uncached, 110);
  assert.equal(renderCachePart(result.read, result.uncached), "缓存：63.3%");
  assert.deepEqual(splitCache({ input: { totalTokens: 12 }, cache: { readTokens: 3 } }), {
    read: 3, uncached: 9, usable: true, reported: true,
  });
});

test("output speed only uses measured positive durations and otherwise stays unavailable", () => {
  assert.equal(estimateOutputSpeed([ledgerEntry("no-duration", { durationMs: 0, endedAt: null })]), null);
  assert.equal(estimateOutputSpeed([ledgerEntry("valid")]).tps, 10);
  assert.equal(renderSpeedPart({ tps: 10.2 }), "速度：10 tok/s");
});

test("speed uses last valid samples, not the last eight zero-duration ledger rows", () => {
  const valid = ledgerEntry("valid");
  const missing = Array.from({ length: 10 }, (_, i) => ledgerEntry(`zero-${i}`, { durationMs: 0, endedAt: null }));
  assert.equal(estimateOutputSpeed([valid, ...missing])?.tps, 10);
  assert.equal(estimateOutputSpeed([ledgerEntry("too-short", { durationMs: 1 })]), null);
});

test("path-only hook samples survive repeated ledger refreshes and stay session scoped", async () => {
  let now = 10;
  const timer = new FirstResponseTimer({ clock: () => now });
  const sessionPath = "/sessions/session-a.jsonl";
  timer.begin({ sessionPath });
  now = 860;
  timer.complete({ sessionPath });
  const updates = [];
  const status = new SessionCacheStatus({
    bus: { request: async (_method, { sessionId }) => ({ entries: [ledgerEntry("one", {
      attribution: { sessionId, sessionPath: `/sessions/${sessionId}.jsonl` },
    })] }) },
    inputStatus: { set: async value => updates.push(value) },
    firstResponseQuery: (sessionId, path) => timer.latest({ sessionId, sessionPath: path }),
  });
  try {
    await status.refresh("session-a");
    assert.match(updates.at(-1).text, /首响：0\.9 s/);
    await status.refresh("session-a");
    assert.match(updates.at(-1).text, /首响：0\.9 s/);
    await status.refresh("session-b");
    assert.doesNotMatch(updates.at(-1).text, /首响/);
    assert.equal(timer.latest("session-a").lastMs, 850);
  } finally { await status.dispose(); }
});

test("existing sessions resolve path through official session API when ledger lacks it", async () => {
  let now = 1;
  const timer = new FirstResponseTimer({ clock: () => now });
  timer.begin({ sessionPath: "/sessions/session-a.jsonl" });
  now = 1201;
  timer.complete({ sessionPath: "/sessions/session-a.jsonl" });
  let lookups = 0;
  const updates = [];
  const status = new SessionCacheStatus({
    bus: { request: async () => ({ entries: [ledgerEntry("one")] }) },
    sessions: { list: async params => {
      assert.deepEqual(params, { scope: "all", lifecycle: "all" });
      lookups++;
      return { sessions: [{ sessionId: "session-a", path: "/sessions/session-a.jsonl" }] };
    } },
    inputStatus: { set: async value => updates.push(value) },
    firstResponseQuery: (sessionId, sessionPath) => timer.latest({ sessionId, sessionPath }),
  });
  try {
    await status.refresh("session-a");
    await status.refresh("session-a");
    assert.equal(lookups, 1);
    assert.match(updates.at(-1).text, /首响：1\.2 s/);
  } finally { await status.dispose(); }
});

test("bounded path resolution preserves active sessions at the front of a large catalog", async () => {
  let lookups = 0;
  const sessionPath = "/sessions/active.jsonl";
  const catalog = [{ sessionId: "active", path: sessionPath }, { sessionId: "other", path: "/sessions/other.jsonl" },
    ...Array.from({ length: 2000 }, (_, i) => ({ sessionId: `old-${i}`, path: `/sessions/old-${i}.jsonl` }))];
  const status = new SessionCacheStatus({
    sessions: { list: async () => { lookups++; return { sessions: catalog }; } },
    bus: { request: async () => ({ entries: [ledgerEntry("one")] }) },
    inputStatus: { set: async () => {} },
    maxSessions: 32,
  });
  try {
    await Promise.all([
      status.onFirstResponseMetric({ sessionId: "hook-uuid", sessionPath, lastMs: 1200 }),
      status.resolveSessionPath("other"),
    ]);
    assert.equal(status.sessionIdForPath(sessionPath), "active");
    assert.equal(status.sessionPathForId("other"), "/sessions/other.jsonl");
    assert.equal(lookups, 1);
    assert.equal(status.sessionIdByPath.size, 2, "unrelated catalog entries must not pollute the bounded hot cache");
  } finally { await status.dispose(); }
});

test("a refresh arriving during publication is replayed instead of dropped", async () => {
  let release;
  let calls = 0;
  let firstMs = null;
  const updates = [];
  const status = new SessionCacheStatus({
    bus: { request: async () => { calls++; return { entries: [ledgerEntry("one")] }; } },
    inputStatus: { set: async value => {
      updates.push(value);
      if (updates.length === 1) await new Promise(resolve => { release = resolve; });
    } },
    firstResponseQuery: () => firstMs ? { lastMs: firstMs } : null,
  });
  try {
    const refreshing = status.refresh("session-a");
    await new Promise(resolve => setImmediate(resolve));
    firstMs = 900;
    await status.refresh("session-a");
    release();
    await refreshing;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(calls, 2);
    assert.match(updates.at(-1).text, /首响：0\.9 s/);
  } finally { await status.dispose(); }
});

test("App registration style async bus subscription updates the host input status and disposes", async () => {
  let listener;
  let unsubscribed = 0;
  const updates = [];
  const registration = () => {};
  registration.ready = Promise.resolve();
  registration.disposeAsync = async () => { unsubscribed++; };
  const bus = {
    subscribe: async (callback, filter) => {
      listener = callback;
      assert.deepEqual(filter.types, ["session_created", "session_forked", "llm_usage"]);
      return registration;
    },
    request: async (_method, payload) => ({ entries: [ledgerEntry("one", { attribution: { sessionId: payload.sessionId, agentId: "agent-a", kind: "session" } })] }),
  };
  const status = new SessionCacheStatus({
    bus,
    inputStatus: { set: async (value) => updates.push(value) },
    firstResponseQuery: (sessionId) => sessionId === "session-a" ? { lastMs: 850 } : null,
    log: () => {},
    warmDelayMs: 60000,
  });

  const stop = await status.start();
  assert.equal(typeof listener, "function");
  listener({ type: "session_created", payload: { sessionId: "session-a", sessionPath: "/sessions/session-a.jsonl" } });
  assert.equal(status.sessionIdForPath("/sessions/session-a.jsonl"), "session-a");
  assert.equal(status.sessionPathForId("session-a"), "/sessions/session-a.jsonl");
  await status.refresh("session-a");
  assert.equal(updates.at(-1).id, "session-cache");
  assert.equal(updates.at(-1).visible, true);
  assert.equal(updates.at(-1).text, "缓存：90.0%　速度：10 tok/s　首响：0.9 s");
  stop();
  await status.dispose();
  assert.equal(unsubscribed, 1);
});

test("input status tooltip under extreme data scales stays bounded without truncation risk", async () => {
  const updates = [];
  const status = new SessionCacheStatus({
    bus: {
      request: async () => ({
        entries: [
          ledgerEntry("extreme", {
            usage: {
              input: { totalTokens: 88888888, uncachedTokens: 8888888 },
              output: { totalTokens: 6666666 },
              cache: { readTokens: 80000000 },
              totalTokens: 95555554,
            },
          }),
        ],
      }),
    },
    inputStatus: { set: async (value) => updates.push(value) },
    speedQuery: () => ({ tps: 125, scope: "session", mode: "timed-stream" }),
    firstResponseQuery: () => ({ lastMs: 1200 }),
    log: () => {},
  });

  try {
    await status.publish(
      "session-extreme",
      { read: 999999999, uncached: 123456789, output: 999999, outputReported: 1, usable: 99999, reported: 99999 },
      true, // cacheKnown
      { tps: 150, scope: "session" }, // sample
      99999, // sessionCalls
      { cache: true, speed: true },
      1200 // firstResponseMs
    );

    const payload = updates.at(-1);
    assert.equal(payload.visible, true);
    assert.ok(payload.tooltip, "tooltip must be present");
    // Host Tooltip container max-width: 18rem (~288px) with white-space: nowrap
    // Length must be strictly <= 45 characters to guarantee no truncation.
    assert.ok(
      payload.tooltip.length <= 45,
      `tooltip length (${payload.tooltip.length}) must not exceed safety limit (45 chars): ${payload.tooltip}`
    );
    assert.match(payload.tooltip, /命中/);
    assert.match(payload.tooltip, /未命中/);
  } finally {
    await status.dispose();
  }
});
