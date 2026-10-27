import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import registerRoutes from "../server/dashboard.js";

test("server dashboard returns complete agentOptions even under single-day range filter", async () => {
  const routes = {};
  const mockApp = {
    get: (p, fn) => { routes["GET " + p] = fn; },
    post: (p, fn) => { routes["POST " + p] = fn; },
  };

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

  const mockData = {
    lastScan: today + "T00:00:00Z",
    agentNames: {
      "gemini-coder": "Gemini 编码工程",
      "hakimi": "Hakimi",
      "hanako": "小鲸鱼",
      "luna-tester": "Luna 质检测试",
      "sol-architect": "Sol 架构师",
      "cixiaogui": "星见凛",
    },
    sessions: {
      // 只有 gemini-coder 在今天有消耗
      "s1": {
        agent: "gemini-coder",
        type: "desktop",
        dailyBreakdown: {
          [today]: { totalTokens: 1000, input: 800, output: 200, models: { "m1": { totalTokens: 1000 } } },
        },
      },
      // 历史会话中存在一个已经被废弃/删除的 agent
      "s2": {
        agent: "retired-agent",
        type: "desktop",
        dailyBreakdown: {
          "2020-01-01": { totalTokens: 500, input: 400, output: 100, models: { "m1": { totalTokens: 500 } } },
        },
      },
    },
  };

  const mockCache = {
    ready: true,
    data: mockData,
    agentNames: mockData.agentNames,
    sessions: mockData.sessions,
    lastScan: mockData.lastScan,
  };

  registerRoutes(mockApp, { _tokenCache: mockCache, dataDir: os.tmpdir() });

  const req = {
    query: (key) => (key === "range" ? "today" : ""),
  };

  const res = await routes["GET /data"]({
    req,
    json: (data, status = 200) => ({ status, body: data }),
  });

  assert.equal(res.status, 200);
  const data = res.body;

  // 今天产生消耗的只有 1 个
  assert.equal(data.agents.length, 1);
  assert.equal(data.agents[0].id, "gemini-coder");

  // 但 agentOptions 必须只包含当前注册的 6 个 Agent，不包含已移除的 retired-agent！
  assert.ok(Array.isArray(data.agentOptions), "必须返回 agentOptions");
  assert.equal(data.agentOptions.length, 6);

  const ids = data.agentOptions.map((a) => a.id);
  assert.ok(ids.includes("gemini-coder"));
  assert.ok(ids.includes("luna-tester"));
  assert.ok(ids.includes("sol-architect"));
  assert.ok(ids.includes("cixiaogui"));
  assert.ok(ids.includes("hakimi"));
  assert.ok(ids.includes("hanako"));
  assert.ok(!ids.includes("retired-agent"), "已移除的历史 Agent 不进入下拉筛选选项");

  const luna = data.agentOptions.find((a) => a.id === "luna-tester");
  assert.equal(luna.name, "Luna 质检测试");
});

test("pool members get names but stay out of the agent filter", async () => {
  const routes = {};
  const mockApp = { get: (p, fn) => { routes["GET " + p] = fn; }, post: () => {} };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const cache = {
    ready: true,
    data: {
      lastScan: today + "T00:00:00Z",
      agentNames: { "sol-architect": "日下晴", "hana-artisan": "DeepSeek", "gemini-coder": "Gemini 编码工程" },
      // hana-artisan 是子代理池成员：只有本机名字，不拥有会话桶。
      poolAgentIds: ["hana-artisan"],
      sessions: {
        s1: {
          agent: "sol-architect", type: "desktop",
          dailyBreakdown: {
            [today]: {
              totalTokens: 100, desktop: 100,
              models: { m1: { totalTokens: 100, assistantCount: 1 } },
              providerTotals: { "p/m1": { totalTokens: 100, assistantCount: 1 } },
              baseTotals: { desktop: 100 },
              actors: {
                "sol-architect": { totalTokens: 100, delegatedTokens: 0, byParent: {}, models: { m1: { provider: "p", totalTokens: 100, subTokens: 0 } } },
                "hana-artisan": { totalTokens: 40, delegatedTokens: 40, byParent: { "sol-architect": 40 }, models: { m1: { provider: "p", totalTokens: 40, subTokens: 40 } } },
              },
            },
          },
          models: { m1: { totalTokens: 100 } },
        },
      },
    },
  };
  registerRoutes(mockApp, { _tokenCache: cache, dataDir: os.tmpdir(), bus: { request: async () => ({}) } });
  const res = await routes["GET /data"]({ req: { query: (k) => (k === "range" ? "today" : "") }, json: (body, status = 200) => ({ body, status }) });
  assert.equal(res.status, 200);

  const ids = res.body.agentOptions.map((a) => a.id);
  assert.ok(!ids.includes("hana-artisan"), "池成员不进 Agent 筛选下拉");
  assert.ok(ids.includes("sol-architect"));

  const artisan = res.body.actors.find((a) => a.id === "hana-artisan");
  assert.equal(artisan.totalTokens, 40, "但执行者清单里仍然是它自己");
  assert.equal(res.body.agentNames["hana-artisan"], "DeepSeek", "名字来自本机配置");
  assert.deepEqual(res.body.poolAgentIds, ["hana-artisan"]);
});
