import test from "node:test";
import assert from "node:assert/strict";
import { FirstResponseTimer, registerFirstResponseHooks } from "../lib/first-response.mjs";
import { GenerationSpeedTimer } from "../lib/generation-speed.mjs";
import { SessionCacheStatus } from "../lib/session-cache.mjs";

const session = i => ({ sessionId: `sess-${i}`, sessionPath: `/sessions/${i}.jsonl` });
test("session metadata has hard caps and idle TTL eviction", () => {
  let now = 0;
  const first = new FirstResponseTimer({ clock: () => now, maxSessions: 32, ttlMs: 1000 });
  const speed = new GenerationSpeedTimer({ clock: () => now, maxSessions: 32, ttlMs: 1000 });
  const status = new SessionCacheStatus({ clock: () => now, maxSessions: 32, ttlMs: 1000 });
  for (let i = 0; i < 2000; i++) {
    first.begin(session(i)); speed.begin(session(i));
    status.rememberSession(session(i).sessionId, session(i).sessionPath);
  }
  assert.ok(first.pending.size <= 32);
  assert.ok(first.sessionPathById.size <= 32);
  assert.ok(speed.paths.size <= 32);
  assert.ok(status.sessionIdByPath.size <= 32);
  now = 1001;
  first.prune(); speed.prune(); status.prune();
  assert.equal(first.pending.size, 0);
  assert.equal(first.sessionPathById.size, 0);
  assert.equal(speed.paths.size, 0);
  assert.equal(status.sessionIdByPath.size, 0);
  now = 3000;
  first.prune(); speed.prune();
  assert.equal(first.samples.size, 0);
  assert.equal(speed.samples.size, 0);
});

test("refresh timer count is capped and dispose cancels every scheduled callback", async () => {
  let requests = 0;
  const status = new SessionCacheStatus({
    maxSessions: 32,
    bus: { request: async () => { requests++; return { entries: [] }; } },
    inputStatus: { set: async () => {} },
  });
  for (let i = 0; i < 2000; i++) status.schedule(`sess-${i}`, false);
  assert.equal(status.timers.size, 32);
  await status.dispose();
  assert.equal(status.timers.size, 0);
  status.schedule("after-dispose", true);
  await status.refresh("after-dispose");
  assert.equal(requests, 0);
});

test("429/502 response invalidates prior first-response sample without measuring failure", async () => {
  let now = 1;
  const timer = new FirstResponseTimer({ clock: () => now });
  const callbacks = {};
  const metrics = [];
  const dispose = await registerFirstResponseHooks({
    hooks: {
      onDecision: (word, callback) => { callbacks[word] = callback; return () => {}; },
      on: (word, callback) => { callbacks[word] = callback; return () => {}; },
    }, timer, onMetric: metric => metrics.push(metric),
  });
  callbacks["provider/before-request"]({ session: session(1) }); now = 101;
  callbacks["provider/after-response"]({ session: session(1), status: 200 });
  assert.equal(timer.latest(session(1)).lastMs, 100);
  for (const status of [429, 502]) {
    callbacks["provider/before-request"]({ session: session(1) }); now += 100;
    callbacks["provider/after-response"]({ session: session(1), status });
    assert.equal(timer.latest(session(1))?.lastMs, null);
    assert.equal(metrics.at(-1).unavailable, true);
  }
  await dispose();
  assert.equal(timer.pending.size, 0);
  assert.equal(timer.samples.size, 0);
});

test("async metric callback rejection is consumed", async () => {
  let now = 1;
  const timer = new FirstResponseTimer({ clock: () => now });
  const callbacks = {};
  const warnings = [];
  const stop = await registerFirstResponseHooks({
    hooks: {
      onDecision: (word, callback) => { callbacks[word] = callback; return () => {}; },
      on: (word, callback) => { callbacks[word] = callback; return () => {}; },
    }, timer, onMetric: () => Promise.reject(new Error("offline")), log: (...args) => warnings.push(args),
  });
  callbacks["provider/before-request"]({ session: session(1) }); now = 101;
  callbacks["provider/after-response"]({ session: session(1), status: 200 });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(warnings.flat().join(" "), /offline/);
  await stop();
});
