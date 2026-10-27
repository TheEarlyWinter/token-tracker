// 官方账本直读：引擎在 local-machine 档下不经过宿主投影，直接读 usage-ledger.sqlite。
//
// 为什么必须测：投影（usage:list）会删掉 attribution.childAgentId 与 source.actor，
// 直读是唯一能让「谁真正跑了这些 token」进入统计的通道。这里验证 sqlite / json 两种来源、
// 指纹缓存，以及 engine.scan 的 localLedger 模式。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLedger, resetLedgerMemo } from "../runtime/engine/services/ledger-source.js";
import { resolveHanaHome } from "../runtime/engine/services/platform.js";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";
import { deriveHanaHome } from "../lib/local-client.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

function entry(requestId, { agentId = "sol-architect", childAgentId = null, totalTokens = 10, modelId = "gpt-6.1-sol", startedAt = `${today}T10:00:00+08:00` } = {}) {
  const isSub = !!childAgentId;
  return {
    requestId,
    startedAt,
    status: "ok",
    source: {
      subsystem: isSub ? "subagent" : "session",
      ...(isSub ? { actor: { kind: "subagent", agentId: childAgentId } } : {}),
    },
    attribution: {
      agentId,
      sessionId: "sess-owner",
      kind: "session",
      ...(isSub ? { childAgentId, childSessionId: `child-${requestId}` } : {}),
    },
    model: { provider: "openai-codex", modelId },
    usage: {
      input: { totalTokens, uncachedTokens: totalTokens - 2 },
      output: { totalTokens: 0 },
      cache: { readTokens: 2, writeTokens: 0 },
      totalTokens,
    },
  };
}

function writeSqliteLedger(home, entries) {
  return import("node:sqlite").then(({ DatabaseSync }) => {
    const file = path.join(home, "usage-ledger.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE usage_entries (
      entry_order INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      provider TEXT,
      model_id TEXT,
      entry_json TEXT NOT NULL
    )`);
    const insert = db.prepare("INSERT INTO usage_entries (request_id, started_at, ended_at, status, provider, model_id, entry_json) VALUES (?,?,?,?,?,?,?)");
    for (const e of entries) insert.run(e.requestId, e.startedAt, e.endedAt || null, e.status, e.model?.provider || null, e.model?.modelId || null, JSON.stringify(e));
    db.close();
  });
}

test("resolveHanaHome honours HANA_HOME then falls back to ~/.hanako", () => {
  assert.equal(resolveHanaHome({ env: { HANA_HOME: "/tmp/hana-home" }, platform: "linux", homedir: () => "/home/x" }), "/tmp/hana-home");
  assert.equal(resolveHanaHome({ env: { HANA_HOME: "~/custom" }, platform: "linux", homedir: () => "/home/x", }), "/home/x/custom");
  assert.equal(resolveHanaHome({ env: {}, platform: "linux", homedir: () => "/home/x" }), "/home/x/.hanako");
});

test("deriveHanaHome only trusts the real app-data layout", () => {
  // <HanaHome>/app-data/<appId> 才能推；推不出来就不直读，退回宿主接口。
  assert.equal(deriveHanaHome("/home/u/.hanako/app-data/token-tracker", {}), "/home/u/.hanako");
  assert.equal(deriveHanaHome("/tmp/token-tracker-test-abc", {}), null);
  assert.equal(deriveHanaHome("/home/u/other/token-tracker", {}), null);
  assert.equal(deriveHanaHome("/home/u/.hanako/app-data/token-tracker", { TOKEN_TRACKER_HANA_HOME: "/srv/hana" }), "/srv/hana");
  assert.equal(deriveHanaHome("/home/u/.hanako/app-data/token-tracker", { TOKEN_TRACKER_HANA_HOME: "relative/path" }), "/home/u/.hanako");
});

test("loadLedger reads the sqlite ledger and keeps executor fields intact", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ledger-"));
  t.after(() => { resetLedgerMemo(); fs.rmSync(home, { recursive: true, force: true }); });
  await writeSqliteLedger(home, [entry("a"), entry("b", { childAgentId: "luna" })]);
  resetLedgerMemo();

  const loaded = loadLedger(home, quiet);
  assert.equal(loaded.sourceMode, "sqlite");
  assert.equal(loaded.entries.length, 2);
  const sub = loaded.entries.find((e) => e.requestId === "b");
  assert.equal(sub.source.actor.agentId, "luna");
  assert.equal(sub.attribution.childAgentId, "luna", "直读保留投影会删掉的字段");

  // 指纹命中：同一份账本不再重复解析。
  const again = loadLedger(home, quiet);
  assert.equal(again, loaded);
});

test("loadLedger falls back to the legacy json ledger", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ledger-json-"));
  t.after(() => { resetLedgerMemo(); fs.rmSync(home, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, "usage-ledger.json"), JSON.stringify({ entries: [entry("j1")] }));
  resetLedgerMemo();
  const loaded = loadLedger(home, quiet);
  assert.equal(loaded.sourceMode, "json");
  assert.equal(loaded.entries.length, 1);
});

test("loadLedger reports an unavailable source instead of throwing", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ledger-none-"));
  t.after(() => { resetLedgerMemo(); fs.rmSync(home, { recursive: true, force: true }); });
  resetLedgerMemo();
  const loaded = loadLedger(home, quiet);
  assert.equal(loaded.sourceMode, "none");
  assert.deepEqual(loaded.entries, []);
});

test("engine localLedger scan reads the ledger itself and attributes subagents to the executor", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-engine-local-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-engine-local-data-"));
  t.after(() => { resetLedgerMemo(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await writeSqliteLedger(home, [entry("self", { totalTokens: 100 }), entry("sub", { childAgentId: "luna", totalTokens: 70 })]);
  resetLedgerMemo();

  const engine = createLedgerEngine({ dataDir, homeDir: home, log: quiet });
  t.after(() => engine.close());

  const probe = engine.ledgerProbe();
  assert.equal(probe.available, true);
  assert.equal(probe.mode, "sqlite");

  const result = await engine.scan(null, { localLedger: true });
  assert.equal(result.newArchivedCount, 2);
  assert.equal(result.ledgerSource.mode, "sqlite");
  assert.equal(result.ledgerSource.count, 2);

  const archived = engine.archiveCount();
  assert.equal(archived, 2);

  const bucket = engine.getData().sessions[`sol-architect::sub::${today}`];
  assert.ok(bucket, "子代理桶存在");
  assert.ok(bucket.dailyBreakdown[today].actors.luna, "执行者来自直读的原始账本");
  assert.equal(bucket.dailyBreakdown[today].actors.luna.totalTokens, 70);
});

test("engine localLedger scan refuses to run when the ledger is unreadable", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-engine-noledger-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-engine-noledger-data-"));
  t.after(() => { resetLedgerMemo(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  resetLedgerMemo();
  const engine = createLedgerEngine({ dataDir, homeDir: home, log: quiet });
  t.after(() => engine.close());

  assert.equal(engine.ledgerProbe().available, false);
  await assert.rejects(() => engine.scan(null, { localLedger: true }), /LEDGER_UNAVAILABLE|官方账本不可读/);
});
