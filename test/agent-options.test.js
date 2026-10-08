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

  const mockData = {
    lastScan: "2026-10-08T00:00:00Z",
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
          "2026-10-08": { totalTokens: 1000, input: 800, output: 200, models: { "m1": { totalTokens: 1000 } } },
        },
      },
      // 历史会话中存在一个已经被废弃/删除的 agent
      "s2": {
        agent: "retired-agent",
        type: "desktop",
        dailyBreakdown: {
          "2026-09-01": { totalTokens: 500, input: 400, output: 100, models: { "m1": { totalTokens: 500 } } },
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

  // 但 agentOptions 必须包含全部 6 个注册 Agent + 1 个历史 Agent = 7 个选项！
  assert.ok(Array.isArray(data.agentOptions), "必须返回 agentOptions");
  assert.equal(data.agentOptions.length, 7);

  const ids = data.agentOptions.map((a) => a.id);
  assert.ok(ids.includes("gemini-coder"));
  assert.ok(ids.includes("luna-tester"));
  assert.ok(ids.includes("sol-architect"));
  assert.ok(ids.includes("cixiaogui"));
  assert.ok(ids.includes("hakimi"));
  assert.ok(ids.includes("hanako"));
  assert.ok(ids.includes("retired-agent"));

  const retired = data.agentOptions.find((a) => a.id === "retired-agent");
  assert.equal(retired.deleted, true, "已移除的 Agent 必须标记为 deleted");

  const luna = data.agentOptions.find((a) => a.id === "luna-tester");
  assert.equal(luna.deleted, false);
  assert.equal(luna.name, "Luna 质检测试");
});
