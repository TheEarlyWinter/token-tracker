import test from "node:test";
import assert from "node:assert/strict";
import { GenerationSpeedTimer, registerGenerationSpeedHook } from "../lib/generation-speed.mjs";

const a = { sessionId: "file-uuid", sessionPath: "/sessions/a.jsonl" };
const msg = (overrides = {}) => ({ role: "assistant", provider: "test", model: "m1", usage: { output: 80 }, stopReason: "stop", ...overrides });

test("speed measures dispatch to completed assistant, not response headers or ledger zero duration", () => {
  let now = 100;
  const timer = new GenerationSpeedTimer({ clock: () => now });
  timer.begin(a);
  now = 2100;
  const sample = timer.complete(a, msg());
  assert.equal(sample.tps, 40);
  assert.equal(sample.durationMs, 2000);
  assert.equal(timer.latest({ sessionId: "sess_manifest", sessionPath: a.sessionPath }, "test/m1").tps, 40);
  assert.equal(timer.latest({ sessionPath: "/sessions/b.jsonl" }, "test/m1"), null);
  assert.equal(timer.latest(a, "test/m2"), null);
});

test("retries replace abandoned starts, invalid completions never fabricate speed", () => {
  let now = 100;
  const timer = new GenerationSpeedTimer({ clock: () => now });
  timer.begin(a);
  now = 1000;
  timer.begin(a);
  now = 3000;
  assert.equal(timer.complete(a, msg()).tps, 40);
  timer.begin(a);
  now += 2000;
  assert.equal(timer.complete(a, msg({ stopReason: "error" })), null);
  timer.begin(a);
  now += 2000;
  assert.equal(timer.complete(a, msg({ usage: null })), null);
  timer.begin(a);
  now += 300000;
  assert.equal(timer.complete(a, msg()), null);
  assert.equal(timer.complete(a, msg()), null);
});

test("zero output, sub-100ms intervals and non-assistant messages are rejected", () => {
  let now = 0;
  const timer = new GenerationSpeedTimer({ clock: () => now });
  timer.begin(a); now += 1;
  assert.equal(timer.complete(a, msg()), null);
  timer.begin(a); now += 1000;
  assert.equal(timer.complete(a, msg({ usage: { output: 0 } })), null);
  timer.begin(a); now += 1000;
  assert.equal(timer.complete(a, msg({ role: "tool" })), null);
  assert.equal(timer.latest(a, "test/m1"), null);
});

test("denied completion hook degrades with a warning and remains disposable", async () => {
  const warnings = [];
  let disposed = false;
  const off = () => {};
  off.ready = Promise.reject(new Error("PERMISSION_DENIED"));
  off.disposeAsync = async () => { disposed = true; };
  const stop = await registerGenerationSpeedHook({
    hooks: { onDecision: async () => off },
    timer: new GenerationSpeedTimer(), log: (...args) => warnings.push(args),
  });
  assert.match(warnings.flat().join(" "), /PERMISSION_DENIED/);
  await stop();
  assert.equal(disposed, true);
});

test("speed averages only bounded valid samples of the same model", () => {
  let now = 0;
  const timer = new GenerationSpeedTimer({ clock: () => now, keep: 2 });
  for (const output of [10000, 20, 40]) {
    timer.begin(a); now += 1000; timer.complete(a, msg({ usage: { output } }));
  }
  assert.equal(timer.latest(a, "test/m1").tps, 30);
  assert.equal(timer.latest(a, "test/m1").count, 2);
  timer.begin(a); now += 1000; timer.complete(a, msg({ model: "m2", usage: { output: 90 } }));
  assert.equal(timer.latest(a, "test/m2").tps, 90);
  assert.equal(timer.latest(a, "test/m1").tps, 30);
  timer.clear();
  assert.equal(timer.latest(a, "test/m1"), null);
});

test("completion hook does not rewrite messages and waits for registration", async () => {
  let handler, disposed = 0;
  const samples = [];
  let now = 0;
  const timer = new GenerationSpeedTimer({ clock: () => now });
  const off = () => {};
  off.ready = Promise.resolve();
  off.disposeAsync = async () => { disposed++; };
  const stop = await registerGenerationSpeedHook({
    hooks: { onDecision: async (word, callback) => { assert.equal(word, "messages/post-assistant"); handler = callback; return off; } },
    timer, onMetric: sample => samples.push(sample),
  });
  timer.begin(a); now = 2000;
  const message = msg();
  assert.equal(handler({ session: a, message }), undefined);
  assert.equal(message.usage.output, 80);
  assert.equal(samples[0].tps, 40);
  await stop(); await stop();
  assert.equal(disposed, 1);
});
