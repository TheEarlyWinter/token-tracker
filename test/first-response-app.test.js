import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import app from "../index.js";
import { createFakeRuntime } from "./helpers/fake-runtime.mjs";

// Exercise the actual SDK adapter and index.js composition, not just isolated classes.
test("App publishes real timed speed with zero-duration ledger and preserves first response",  async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "first-response-app-"));
  const callbacks = {};
  const listeners = new Set();
  const updates = [];
  const sessionPath = "/sessions/existing.jsonl";
  const sessionId = "existing";
  const entry = {
    requestId: "one", status: "ok", durationMs: 0,
    startedAt: new Date().toISOString(),
    attribution: { sessionId, agentId: "agent-a" },
    model: { provider: "test", modelId: "test" },
    usage: { input: { totalTokens: 100, uncachedTokens: 10 }, cache: { readTokens: 90 }, output: { totalTokens: 20 }, totalTokens: 120 },
  };
  const registration = () => {
    const off = () => {};
    off.ready = Promise.resolve();
    off.disposeAsync = async () => {};
    return off;
  };
  const ctx = {
    dataDir, runtime: createFakeRuntime().api,
    logger: { info() {}, warn() {}, error() {} },
    inputStatus: { set: async value => { assert.equal(value.sessionId, sessionId); updates.push(value); } },
    hooks: {
      onDecision: (word, callback) => { callbacks[word] = callback; return registration(); },
      on: (word, callback) => { callbacks[word] = callback; return registration(); },
    },
    bus: {
      request: async (verb, params) => {
        if (verb === "usage:list") {
          if (params?.sessionId) assert.equal(params.sessionId, sessionId, "Hook file UUID must never be sent as a ledger session ID");
          return { entries: [entry] };
        }
        if (verb === "session:list") return { sessions: [{ sessionId, path: sessionPath }] };
        if (verb === "agent:list") return { agents: [] };
        return {};
      },
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  };
  try {
    await app.apply(ctx);
    callbacks["provider/before-request"]({ session: { sessionId: "file-uuid", sessionPath } });
    await new Promise(resolve => setTimeout(resolve, 10));
    callbacks["provider/after-response"]({ session: { sessionId: "file-uuid", sessionPath } });
    await new Promise(resolve => setTimeout(resolve, 120));
    const message = { role: "assistant", provider: "test", model: "test", usage: { output: 20 }, stopReason: "stop" };
    assert.equal(callbacks["messages/post-assistant"]({ session: { sessionId: "file-uuid", sessionPath }, message }), undefined);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.match(updates.at(-1)?.text || "", /首响：[\d.]+ s/);
    assert.match(updates.at(-1).text, /速度：[1-9]\d* tok\/s/);
    const firstText = updates.at(-1).text;
    for (const listener of listeners) listener({ type: "llm_usage", entry });
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert.equal(updates.at(-1).text, firstText);
    assert.ok(updates.length >= 2);
  } finally {
    await ctx._tokenCache?.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
