import test from "node:test";
import assert from "node:assert/strict";
import { FirstResponseTimer, registerFirstResponseHooks } from "../lib/first-response.mjs";

test("first-response timer pairs concurrent session requests FIFO and keeps only valid samples", () => {
  let now = 100;
  const timer = new FirstResponseTimer({ clock: () => now, maxPending: 2, keep: 2, staleMs: 5000 });
  assert.equal(timer.complete("s1"), null);
  timer.begin("s1");
  now = 200;
  timer.begin("s1");
  now = 450;
  assert.equal(timer.complete("s1").lastMs, 350);
  now = 800;
  assert.equal(timer.complete("s1").lastMs, 600);
  assert.equal(timer.latest("s1").count, 2);
});

test("session path fallback correlates hooks when the session id is absent from the start event", () => {
  let now = 10;
  const timer = new FirstResponseTimer({ clock: () => now });
  assert.equal(timer.begin({ sessionId: null, sessionPath: "/agents/a/sessions/s1.jsonl" }), true);
  now = 210;
  const sample = timer.complete({ sessionId: "session-1", sessionPath: "/agents/a/sessions/s1.jsonl" });
  assert.equal(sample.sessionId, "session-1");
  assert.equal(sample.lastMs, 200);
});

test("hook UUID and manifest session ID share path-scoped samples", () => {
  let now = 10;
  const timer = new FirstResponseTimer({ clock: () => now });
  const sessionPath = "/sessions/existing.jsonl";
  timer.begin({ sessionId: "file-uuid", sessionPath });
  now = 810;
  timer.complete({ sessionId: "file-uuid", sessionPath });
  assert.equal(timer.latest({ sessionId: "sess_manifest", sessionPath })?.lastMs, 800);
  now = 1000;
  timer.begin({ sessionId: "file-uuid", sessionPath });
  now = 2000;
  timer.complete({ sessionId: "file-uuid", sessionPath });
  assert.equal(timer.latest({ sessionId: "sess_manifest", sessionPath })?.lastMs, 1000);
  assert.equal(timer.latest("sess_manifest")?.count, 2);
});

test("expired and missing-session starts are ignored instead of leaking into future calls", () => {
  let now = 0;
  const timer = new FirstResponseTimer({ clock: () => now, staleMs: 1000 });
  assert.equal(timer.begin(null), false);
  assert.equal(timer.begin("s1"), true);
  now = 1500;
  assert.equal(timer.complete("s1"), null);
  assert.equal(timer.latest("s1"), null);
});

test("hook registration waits for each AppRegistration.ready acknowledgement", async () => {
  let releaseReady;
  let ready = false;
  const registration = () => {};
  registration.ready = new Promise(resolve => { releaseReady = () => { ready = true; resolve(); }; });
  registration.disposeAsync = async () => {};
  const hooks = {
    onDecision: async () => registration,
    on: async () => registration,
  };
  const timer = new FirstResponseTimer();
  let completed = false;
  const registering = registerFirstResponseHooks({ hooks, timer, log: () => {} }).then(dispose => { completed = true; return dispose; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  assert.equal(completed, false);
  releaseReady();
  const dispose = await registering;
  assert.equal(ready, true);
  await dispose();
});

test("hooks measure response metadata latency, do not rewrite requests, and unregister cleanly", async () => {
  let now = 10;
  let decision;
  let listener;
  let releases = 0;
  const registration = () => {};
  registration.ready = Promise.resolve();
  registration.disposeAsync = async () => { releases++; };
  const hooks = {
    onDecision: async (name, callback) => { assert.equal(name, "provider/before-request"); decision = callback; return registration; },
    on: async (name, callback) => { assert.equal(name, "provider/after-response"); listener = callback; return registration; },
  };
  const timer = new FirstResponseTimer({ clock: () => now });
  const observed = [];
  const dispose = await registerFirstResponseHooks({ hooks, timer, now: () => now, onMetric: metric => observed.push(metric), log: () => {} });

  const decisionResult = decision({ session: { sessionId: "s1", sessionPath: "/private/path" }, payload: { secret: "not-read" } });
  assert.equal(decisionResult, undefined);
  now = 735;
  listener({ session: { sessionId: "s1", sessionPath: "/private/path" }, status: 200, headers: { Authorization: "not-read" } });
  assert.equal(observed[0].sessionId, "s1");
  assert.equal(observed[0].lastMs, 725);
  assert.equal(timer.latest("s1").lastMs, 725);

  await dispose();
  await dispose();
  assert.equal(releases, 2);
});
