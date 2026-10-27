import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";
import { buildVisualAnalytics } from "../runtime/engine/services/visual-analytics.js";

const source = fs.readFileSync(new URL("../server/dashboard.js", import.meta.url), "utf8");
const context = vm.createContext({ fs, path, Intl, Date, DEFAULT_PRICE_TABLE: {} });
vm.runInContext(source.slice(source.indexOf("function pickPrice("), source.indexOf("// 缓存汇率")), context);
vm.runInContext(source.slice(source.indexOf("function build(cache,")), context);
const build = context.build;

const quiet = { info() {}, warn() {}, error() {} };
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

function entry(requestId, { agentId = "agent-a", sessionId, subsystem = "session", totalTokens = 10, costTotal = 0.001, provider = "deepseek", modelId = "deepseek-chat", startedAt = `${today}T10:00:00+08:00` } = {}) {
  return {
    requestId,
    startedAt,
    status: "ok",
    source: { subsystem },
    attribution: { agentId, sessionId, kind: "session" },
    model: { provider, modelId },
    usage: {
      input: { totalTokens: totalTokens, uncachedTokens: totalTokens - 2 },
      output: { totalTokens: 0 },
      cache: { readTokens: 2, writeTokens: 0 },
      totalTokens,
      costTotal,
    },
  };
}

async function seeded(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-code-dash-"));
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await engine.scan([
    entry("code-parent", { sessionId: "code-parent", totalTokens: 100 }),
    entry("code-child", { sessionId: "code-parent", subsystem: "subagent", totalTokens: 50, modelId: "deepseek-reasoner" }),
    entry("chat-sub", { sessionId: "chat-sess", subsystem: "subagent", totalTokens: 30 }),
    entry("desktop", { sessionId: "desk-sess", totalTokens: 20 }),
    entry("other-agent-code", { agentId: "agent-b", sessionId: "code-b", totalTokens: 5 }),
  ], {
    sessionNamespaces: { "code-parent": "code", "chat-sess": "chat", "code-b": "code", "desk-sess": "chat" },
  });
  return engine;
}

test("Code totals are exposed on summary, agents, daily, daily30 and hourly without touching channels", async (t) => {
  const engine = await seeded(t);
  const data = build(engine.getData(), "today", {});

  assert.equal(data.summary.totalCode, 155);
  assert.equal(data.summary.totalSub, 30, "聊天子请求仍计入 sub");
  assert.equal(data.summary.totalChannel, 0, "Code 不得流入 channel");
  assert.equal(data.summary.totalTokens, 205);

  const agentA = data.agents.find((a) => a.id === "agent-a");
  const agentB = data.agents.find((a) => a.id === "agent-b");
  assert.equal(agentA.codeTotal, 150);
  // 委托方口径：Code 命名空间下的子代理也要计入。旧实现只累加 type=sub 的桶，
  // 这里 50 token 的 code-sub 被漏掉，所以这里正确值是 80。
  assert.equal(agentA.subTotal, 80);
  assert.equal(agentB.codeTotal, 5);

  const day = data.daily.find((d) => d.date === today);
  assert.equal(day.code, 155);
  assert.equal(day.channel, 0);
  assert.equal(day.sub, 30);

  const d30 = data.daily30.find((d) => d.date === today);
  assert.equal(d30.code, 155);
  assert.equal(d30.channel, 0);

  const h10 = data.hourly.find((h) => h.hour === "10");
  assert.equal(h10.code, 155);
  assert.equal(h10.channel, 0);
  assert.equal(h10.sub, 30);

  const analytics = buildVisualAnalytics(Object.values(engine.getData().sessions), () => true, {}, []);
  const analyticsDay = analytics.daily.find((d) => d.date === today);
  assert.equal(analyticsDay.kinds.code, 155, "可视化来源图层必须包含 code");
});

test("type=code filtering intersects with agent, model, provider and date filters", async (t) => {
  const engine = await seeded(t);
  const snapshot = engine.getData();

  const onlyCode = build(snapshot, "today", { type: "code" });
  assert.equal(onlyCode.summary.totalTokens, 155);
  assert.equal(onlyCode.summary.totalCode, 155);
  assert.equal(onlyCode.summary.totalSub, 0);
  assert.equal(onlyCode.daily.reduce((s, d) => s + d.code, 0), 155);

  const codeWithModel = build(snapshot, "today", { type: "code", model: "deepseek-reasoner" });
  assert.equal(codeWithModel.summary.totalTokens, 50);
  assert.equal(codeWithModel.summary.totalCode, 50);

  const codeWithProvider = build(snapshot, "today", { type: "code", provider: "deepseek", agent: "agent-b" });
  assert.equal(codeWithProvider.summary.totalTokens, 5);

  const codeWrongDay = build(snapshot, "today", { type: "code", from: "2020-01-02", to: "2020-01-02" });
  assert.equal(codeWrongDay.summary.totalTokens, 0);

  const nonCode = build(snapshot, "today", { type: "sub" });
  assert.equal(nonCode.summary.totalTokens, 30, "非 Code 现有规则不变");
  assert.equal(nonCode.summary.totalCode, 0);
});

test("sourceClassification is surfaced from the archive-wide state", async (t) => {
  const engine = await seeded(t);
  let data = build(engine.getData(), "all", {});
  assert.equal(data.sourceClassification.status, "complete");
  assert.equal(data.sourceClassification.unresolvedSessionCount, 0);
  assert.equal(data.sourceClassification.unresolvedRecordCount, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-code-dash2-"));
  const second = createLedgerEngine({ dataDir: dir, log: quiet });
  t.after(() => { second.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await second.scan([entry("a", { sessionId: "known" }), entry("b", { sessionId: "unknown-session" })], {
    sessionNamespaces: { known: "chat" },
  });
  data = build(second.getData(), "all", {});
  assert.equal(data.sourceClassification.status, "partial");
  assert.equal(data.sourceClassification.unresolvedSessionCount, 1);
  assert.equal(data.sourceClassification.unresolvedRecordCount, 0);
});

test("records with no session id keep their usage but surface an incomplete classification", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-code-dash3-"));
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await engine.scan([
    entry("known", { sessionId: "known" }),
    entry("orphan", { sessionId: null, totalTokens: 40 }),
  ], { sessionNamespaces: { known: "chat" } });

  const data = build(engine.getData(), "all", {});
  assert.equal(data.sourceClassification.status, "partial");
  assert.equal(data.sourceClassification.unresolvedSessionCount, 0);
  assert.equal(data.sourceClassification.unresolvedRecordCount, 1, "无合法会话 ID 的请求单独计数");
  assert.equal(data.summary.totalTokens, 50, "无法归属的请求仍计入总量");
  assert.equal(data.summary.totalCode, 0);
});

test("detail and CSV do not serve stale SQLite rows while the derived index is unready", async () => {
  const { default: registerRoutes } = await import("../server/dashboard.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-code-turns-"));
  const routes = {};
  const staleStore = {
    query() {
      return { rows: [{ at: "2020-01-01T00:00:00Z", agent: "stale", provider: "p", model: "m", total: 999, input: 1, output: 1, cacheRead: 0, calls: 1 }], total: 1, sumTokens: 999 };
    },
  };
  const conversations = [{ time: "2026-10-08T01:00:00Z", provider: "p", model: "m", totalTokens: 10, inTokens: 8 }];
  const ctx = {
    dataDir: dir,
    _tokenCache: {
      ready: true,
      turnsStore: staleStore,
      data: { turnsIndexReady: false, sessions: { s: { agent: "a", type: "desktop", conversations } } },
    },
  };
  registerRoutes({ get: (p, fn) => { routes[p] = fn; }, post: () => {} }, ctx);
  const call = async (route) => routes[route]({
    req: { query: () => "" },
    json: (body, status = 200) => ({ body, status }),
    text: (body, status = 200) => ({ body, status }),
  });

  try {
    const csv = await call("/turns/csv");
    assert.match(csv.body, /"10"/, "索引未就绪时 CSV 必须改走聚合 conversations");
    assert.doesNotMatch(csv.body, /"999"/);

    const turns = await call("/turns");
    assert.equal(turns.body.rows.length, 1);
    assert.equal(turns.body.sumTokens, 10, "明细同样不得返回陈旧 SQLite 行");

    ctx._tokenCache.data.turnsIndexReady = true;
    const readyCsv = await call("/turns/csv");
    assert.match(readyCsv.body, /"999"/, "就绪时仍使用 SQLite 明细");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
