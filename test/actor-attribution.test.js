// 执行者归因：子代理的用量归到真正跑它的 Agent，不并进委托方。
//
// 背景：宿主账本把子代理请求挂在父会话的 attribution.sessionId / agentId 上，
// 真正的执行者在 source.actor.agentId（= attribution.childAgentId）。
// 旧实现只保留 baseType，聚合时丢掉执行者，导致「某个 Agent 用了 3 亿」实际含大量子代理。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";

const source = fs.readFileSync(new URL("../server/dashboard.js", import.meta.url), "utf8");
const context = vm.createContext({ fs, path, Intl, Date, DEFAULT_PRICE_TABLE: {} });
vm.runInContext(source.slice(source.indexOf("function pickPrice("), source.indexOf("// 缓存汇率")), context);
vm.runInContext(source.slice(source.indexOf("function build(cache,")), context);
const build = context.build;

const quiet = { info() {}, warn() {}, error() {} };
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

function entry(requestId, {
  agentId = "sol-architect",
  sessionId = "sess-owner",
  subsystem = "session",
  childAgentId = null,
  totalTokens = 10,
  modelId = "gpt-6.1-sol",
  startedAt = `${today}T10:00:00+08:00`,
} = {}) {
  const isSub = subsystem === "subagent";
  return {
    requestId,
    startedAt,
    status: "ok",
    source: {
      subsystem,
      ...(isSub && childAgentId ? { actor: { kind: "subagent", agentId: childAgentId, sessionId: `child-${requestId}` } } : {}),
    },
    attribution: {
      agentId,
      sessionId,
      kind: "session",
      ...(isSub && childAgentId ? { childAgentId, childSessionId: `child-${requestId}` } : {}),
    },
    model: { provider: "deepseek", modelId },
    usage: {
      input: { totalTokens, uncachedTokens: totalTokens - 2 },
      output: { totalTokens: 0 },
      cache: { readTokens: 2, writeTokens: 0 },
      totalTokens,
    },
  };
}

function engineFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-actors-"));
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return engine;
}

test("subagent usage lands on the executing agent, not on the delegating agent", async (t) => {
  const engine = engineFor(t);
  await engine.scan([
    entry("self-1", { totalTokens: 100 }),
    entry("sub-1", { subsystem: "subagent", childAgentId: "luna", totalTokens: 300 }),
    entry("sub-2", { subsystem: "subagent", childAgentId: "hana-artisan", totalTokens: 50 }),
  ], {});

  const snapshot = engine.getData();
  assert.ok(snapshot.sessions[`sol-architect::desktop::${today}`], "委托方的本体桶仍然存在");
  assert.ok(snapshot.sessions[`sol-architect::sub::${today}`], "子代理仍按 baseType 单独成桶");

  const actorsOfDay = {};
  let baseSub = 0;
  for (const session of Object.values(snapshot.sessions)) {
    const day = session.dailyBreakdown?.[today];
    if (!day) continue;
    baseSub += day.baseTotals?.sub || 0;
    for (const [id, actor] of Object.entries(day.actors || {})) {
      const row = actorsOfDay[id] || (actorsOfDay[id] = { totalTokens: 0, delegatedTokens: 0, byParent: {} });
      row.totalTokens += actor.totalTokens;
      row.delegatedTokens += actor.delegatedTokens;
      for (const [parentId, tokens] of Object.entries(actor.byParent || {})) {
        row.byParent[parentId] = (row.byParent[parentId] || 0) + tokens;
      }
    }
  }
  assert.equal(actorsOfDay["sol-architect"].totalTokens, 100);
  assert.equal(actorsOfDay["sol-architect"].delegatedTokens, 0);
  assert.equal(actorsOfDay.luna.totalTokens, 300);
  assert.equal(actorsOfDay.luna.delegatedTokens, 300);
  assert.equal(actorsOfDay.luna.byParent["sol-architect"], 300);
  assert.equal(actorsOfDay["hana-artisan"].totalTokens, 50);
  assert.equal(baseSub, 350);

  const data = build(snapshot, "today", {});
  const actors = new Map(data.actors.map((a) => [a.id, a]));
  assert.equal(actors.get("sol-architect").selfTokens, 100);
  assert.equal(actors.get("sol-architect").delegatedTokens, 0);
  assert.equal(actors.get("sol-architect").totalTokens, 100, "委托方不再背着子代理的用量");
  assert.equal(actors.get("luna").delegatedTokens, 300);
  assert.equal(actors.get("luna").parents["sol-architect"], 300);

  // 总量不丢：执行者口径相加等于总览总量。
  const actorSum = data.actors.reduce((sum, a) => sum + a.totalTokens, 0);
  assert.equal(actorSum, data.summary.totalTokens);

  // 委托方口径：派出去了多少仍可查。
  const owner = data.agents.find((a) => a.id === "sol-architect");
  assert.equal(owner.subTotal, 350);
  assert.equal(owner.delegatedBy.luna, 300);
});

test("records without executor identity are grouped separately instead of being charged to the owner", async (t) => {
  const engine = engineFor(t);
  await engine.scan([
    entry("self-1", { totalTokens: 100 }),
    entry("sub-legacy", { subsystem: "subagent", totalTokens: 70 }),
  ], {});

  const data = build(engine.getData(), "today", {});
  const actors = new Map(data.actors.map((a) => [a.id, a]));
  assert.equal(actors.get("sub:unknown").totalTokens, 70);
  assert.equal(actors.get("sub:unknown").delegatedTokens, 70);
  assert.equal(actors.get("sol-architect").totalTokens, 100);
  assert.equal(actors.get("sol-architect").delegatedTokens, 0);
});

test("archive backfills executor identity when the ledger window still holds the raw entry", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-backfill-"));
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // 第一轮：旧版本写下的归档形状（子代理记录但没有执行者字段）。
  const legacy = entry("sub-legacy", { subsystem: "subagent", totalTokens: 70 });
  delete legacy.source.actor;
  delete legacy.attribution.childAgentId;
  delete legacy.attribution.childSessionId;
  await engine.scan([legacy], {});

  const first = engine.getData().sessions[`sol-architect::sub::${today}`].dailyBreakdown[today];
  assert.equal(first.actors["sub:unknown"].totalTokens, 70);

  // 第二轮：宿主账本窗口里还能拿到原条目（含 actor），归档补写并重新聚合。
  const result = await engine.scan([
    entry("sub-legacy", { subsystem: "subagent", childAgentId: "luna", totalTokens: 70 }),
  ], {});
  assert.equal(result.actorBackfilled, 1);

  const second = engine.getData().sessions[`sol-architect::sub::${today}`].dailyBreakdown[today];
  assert.equal(second.actors.luna.totalTokens, 70);
  assert.equal(second.actors["sub:unknown"], undefined);

  const actors = new Map(build(engine.getData(), "today", {}).actors.map((a) => [a.id, a]));
  assert.equal(actors.get("luna").delegatedTokens, 70);
});

test("actor attribution survives model and provider filters", async (t) => {
  const engine = engineFor(t);
  await engine.scan([
    entry("self-1", { totalTokens: 100, modelId: "gpt-6.1-sol" }),
    entry("sub-1", { subsystem: "subagent", childAgentId: "luna", totalTokens: 300, modelId: "gpt-5.6-luna" }),
    entry("sub-2", { subsystem: "subagent", childAgentId: "luna", totalTokens: 40, modelId: "gpt-6.1-sol" }),
  ], {});

  const byModel = build(engine.getData(), "today", { model: "gpt-6.1-sol" });
  const actors = new Map(byModel.actors.map((a) => [a.id, a]));
  assert.equal(actors.get("luna").totalTokens, 40, "筛选模型后执行者用量跟着收敛");
  assert.equal(actors.get("luna").delegatedTokens, 40);
  assert.equal(actors.get("sol-architect").totalTokens, 100);
  assert.equal(byModel.actors.reduce((sum, a) => sum + a.totalTokens, 0), byModel.summary.totalTokens);

  const byOther = build(engine.getData(), "today", { model: "gpt-5.6-luna" });
  assert.equal(byOther.actors.length, 1);
  assert.equal(byOther.actors[0].id, "luna");
  assert.equal(byOther.actors[0].totalTokens, 300);
});

// ── 路由层：执行者不该被标成「历史 Agent」 ──
// 宿主 agent:list 不包含子代理池成员（hana-artisan / luna / gemini-coder…），
// 不看名册就给执行者盖「已删除」章，等于把正在干活的子代理说成历史。
test("actor list never marks a missing pool member as a deleted agent", async () => {
  const registerRoutes = (await import("../server/dashboard.js")).default;
  const day = "2026-10-26";
  const actor = (totalTokens, delegatedTokens, parent) => ({
    totalTokens, delegatedTokens, byParent: parent ? { [parent]: delegatedTokens } : {},
    models: { "gpt-5.6-luna": { provider: "openai-codex", totalTokens, subTokens: delegatedTokens } },
  });
  const session = (agent, withSub = false) => ({
    agent,
    type: "desktop",
    dailyBreakdown: {
      [day]: {
        totalTokens: 100, desktop: 100,
        models: { "gpt-6.1-sol": { totalTokens: 100, assistantCount: 1 } },
        providerTotals: { "openai-codex/gpt-6.1-sol": { totalTokens: 100, assistantCount: 1 } },
        baseTotals: { desktop: 100 },
        actors: {
          [agent]: actor(100, 0, null),
          ...(withSub ? { "hana-artisan": actor(250, 250, agent) } : {}),
        },
      },
    },
    models: { "gpt-6.1-sol": { totalTokens: 100 } },
  });
  const cache = {
    ready: true,
    data: {
      lastScan: `${day}T10:00:00.000Z`,
      sessions: {
        [`sol-architect::desktop::${day}`]: session("sol-architect", true),
        [`retired-one::desktop::${day}`]: session("retired-one"),
      },
    },
  };
  const routes = {};
  registerRoutes({ get: (p, fn) => { routes[`GET ${p}`] = fn; }, post: (p, fn) => { routes[`POST ${p}`] = fn; } }, {
    pluginId: "token-tracker",
    dataDir: "/tmp",
    _tokenCache: cache,
    bus: {
      request: async (verb) => {
        if (verb === "agent:list") {
          return { agents: [
            { id: "sol-architect", name: "日下晴", state: "active" },
            { id: "retired-one", name: "退役的那位", state: "retired" },
          ] };
        }
        return {};
      },
    },
  });
  const res = await routes["GET /data"]({ req: { query: () => "" }, json: (body, status = 200) => ({ body, status }) });
  assert.equal(res.status, 200);
  const { actors, agents } = res.body;

  const artisan = actors.find((a) => a.id === "hana-artisan");
  assert.ok(artisan, "子代理池成员必须出现在执行者清单里");
  assert.equal(artisan.deleted, false, "不在 agent:list 名册 ≠ 已退役");
  assert.equal(artisan.delegatedTokens, 250);
  assert.equal(artisan.parents["sol-architect"], 250);

  assert.equal(actors.find((a) => a.id === "sol-architect").deleted, false);
  // 委托方口径照旧：名册里明确是 retired 的才标历史，名字也还能拿到。
  const retired = agents.find((a) => a.id === "retired-one");
  assert.equal(retired.deleted, true);
  assert.equal(res.body.agentNames["retired-one"], "退役的那位");
});
