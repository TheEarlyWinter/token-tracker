import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import registerRoutes from "../server/dashboard.js";

const source = fs.readFileSync(new URL("../server/dashboard.js", import.meta.url), "utf8");
const context = vm.createContext({
  fs,
  path,
  Intl,
  Date,
  hitRatePercent: (hit, total) => total > 0 ? (hit / total) * 100 : null,
  buildVisualAnalytics: () => null,
});
vm.runInContext(source.slice(source.indexOf("function pickPrice("), source.indexOf("// 缓存汇率")), context);
vm.runInContext(`
  function loadPriceTable() { return globalThis.__priceTable || {}; }
  function normalizeSourceClassification() { return { status: "complete", unresolvedSessionCount: 0, unresolvedRecordCount: 0 }; }
  function buildPredictionResponse() { return null; }
`, context);
vm.runInContext(source.slice(source.indexOf("function resolvePriceEntry("), source.indexOf("// 价格表与余额配置加载")), context);
vm.runInContext(source.slice(source.indexOf("function build(cache,"), source.indexOf("// 来源分类完整性")), context);
const build = context.build;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-provider-cost-"));
}

function stats(provider, input) {
  return {
    provider,
    model: "shared-model",
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input,
    assistantCount: 1,
    subTokens: 0,
  };
}

function fixture(dataDir = "") {
  const day = "2026-10-27";
  const providerA = stats("provider-a", 1_000_000);
  const providerB = stats("provider-b", 1_000_000);
  return {
    dataDir,
    agentNames: { "test-agent": "测试 Agent" },
    sessions: {
      "session-1::desktop::2026-10-27": {
        agent: "test-agent",
        type: "desktop",
        providers: {
          "provider-a/shared-model": { provider: "provider-a" },
          "provider-b/shared-model": { provider: "provider-b" },
        },
        models: {
          "shared-model": {
            input: 2_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2_000_000,
            assistantCount: 2,
          },
        },
        dailyBreakdown: {
          [day]: {
            input: 2_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2_000_000,
            assistantCount: 2,
            models: { "shared-model": { ...providerA, input: 2_000_000, totalTokens: 2_000_000, assistantCount: 2 } },
            providerTotals: {
              "provider-a/shared-model": providerA,
              "provider-b/shared-model": providerB,
            },
            actors: {
              "actor-1": {
                totalTokens: 2_000_000,
                input: 2_000_000,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                assistantCount: 2,
                delegatedTokens: 0,
                models: {
                  "shared-model": {
                    provider: "provider-a",
                    model: "shared-model",
                    input: 2_000_000,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2_000_000,
                    assistantCount: 2,
                  },
                },
                providerTotals: {
                  "provider-a/shared-model": providerA,
                  "provider-b/shared-model": providerB,
                },
              },
            },
          },
        },
      },
    },
  };
}

function price(inputPerM, currency = "USD") {
  return {
    currency,
    defaultPrice: { unit: "token", inputPerM, inputCachePerM: 0, outputPerM: 0, cacheWritePerM: 0 },
  };
}

function createMockApp() {
  const routes = { GET: {}, POST: {} };
  return {
    routes,
    get(route, handler) { routes.GET[route] = handler; },
    post(route, handler) { routes.POST[route] = handler; },
  };
}

async function invoke(handler, { query = {}, body = null } = {}) {
  let status = 200;
  let responseBody;
  const result = await handler({
    req: {
      query: (key) => (key ? query[key] : query),
      json: async () => body,
    },
    json: (value, nextStatus = 200) => {
      status = nextStatus;
      responseBody = value;
      return { status, body: value };
    },
  });
  return { status, body: responseBody ?? result };
}

function dashboardContext(dataDir, data, network = null) {
  return {
    dataDir,
    network,
    _tokenCache: { ready: true, dataDir, data, realtime: {} },
    bus: {
      async request(type) {
        if (type === "model:list") {
          return {
            models: [
              { id: "shared-model", modelId: "shared-model", provider: "provider-a" },
              { id: "shared-model", modelId: "shared-model", provider: "provider-b" },
            ],
          };
        }
        if (type === "agent:list") return { agents: [] };
        if (type === "media:task:list") return { tasks: [] };
        if (type === "provider:credentials") return { error: "not configured" };
        return {};
      },
    },
  };
}

test("provider 过滤同时使用 actor.providerTotals，summary 与 actor/model 维度一致", () => {
  const cache = fixture();
  const providerA = build(cache, "all", { provider: "provider-a" });
  assert.equal(providerA.summary.totalTokens, 1_000_000);
  assert.equal(providerA.actors.length, 1);
  assert.equal(providerA.actors[0].totalTokens, 1_000_000);
  assert.equal(providerA.actors[0].models["shared-model"], 1_000_000);

  const providerB = build(cache, "all", { provider: "provider-b" });
  assert.equal(providerB.summary.totalTokens, 1_000_000);
  assert.equal(providerB.actors.length, 1);
  assert.equal(providerB.actors[0].totalTokens, 1_000_000);
  assert.equal(providerB.actors[0].models["shared-model"], 1_000_000);
});

test("build 按 provider/model 输出独立用量组，不合并同名模型", () => {
  context.__priceTable = {
    "provider-a/shared-model": price(1),
    "provider-b/shared-model": price(10),
  };
  const result = build(fixture(), "all", {});
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.modelUsageByProvider.map((row) => [row.provider, row.model, row.input]))),
    [["provider-a", "shared-model", 1_000_000], ["provider-b", "shared-model", 1_000_000]]
  );
  assert.equal(result.summary.estimatedCost, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(result.summary.estimatedCostByCurrency)), { USD: 11 });
});

test("/data 的 _modelCosts 按 provider/model 计费，筛选 B 不借用 A 价格且不混算币种", async () => {
  const dir = tmpDir();
  const data = fixture(dir);
  fs.writeFileSync(path.join(dir, "price-table.json"), JSON.stringify({
    "provider-a/shared-model": price(1, "USD"),
    "provider-b/shared-model": price(10, "USD"),
  }));
  const network = { fetch: async (url) => String(url).includes("open.er-api.com")
    ? { status: 503, ok: false, json: async () => ({}) }
    : { status: 200, ok: true, json: async () => ({}) } };
  const app = createMockApp();
  registerRoutes(app, dashboardContext(dir, data, network));

  const all = await invoke(app.routes.GET["/data"]);
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.body._modelCosts.map((row) => [row.provider, row.model, row.cost, row.priced]),
    [["provider-a", "shared-model", 1, true], ["provider-b", "shared-model", 10, true]]
  );
  assert.equal(all.body.summary.estimatedCost, 11);

  const onlyB = await invoke(app.routes.GET["/data"], { query: { provider: "provider-b" } });
  assert.deepEqual(onlyB.body._modelCosts.map((row) => [row.provider, row.cost]), [["provider-b", 10]]);

  fs.writeFileSync(path.join(dir, "price-table.json"), JSON.stringify({
    "provider-a/shared-model": price(1, "USD"),
  }));
  const missingB = await invoke(app.routes.GET["/data"], { query: { provider: "provider-b" } });
  assert.equal(missingB.body._modelCosts.length, 1);
  assert.equal(missingB.body._modelCosts[0].priced, false);
  assert.equal(missingB.body._modelCosts[0].costSource, "unpriced");
  assert.equal(missingB.body.summary.estimatedCost, null);

  fs.writeFileSync(path.join(dir, "price-table.json"), JSON.stringify({
    "provider-a/shared-model": price(1, "USD"),
    "provider-b/shared-model": price(10, "CNY"),
  }));
  const mixed = await invoke(app.routes.GET["/data"]);
  assert.equal(mixed.body.summary.estimatedCost, null);
  assert.deepEqual(mixed.body.summary.estimatedCostByCurrency, { USD: 1, CNY: 10 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("/turn 详情按调用 provider 取价，缺精确 provider 价不借用别家", async () => {
  const dir = tmpDir();
  const records = ["provider-a", "provider-b"].map((provider, index) => JSON.stringify({
    rid: `turn-${index}`,
    v: {
      requestId: `turn-${index}`,
      sessionId: "session-cost",
      startedAt: `2026-10-27T10:00:0${index}.000Z`,
      endedAt: `2026-10-27T10:00:0${index}.000Z`,
      status: "ok",
      provider,
      model: "shared-model",
      inputTokens: 1_000_000,
      inputUncachedTokens: 1_000_000,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 1_000_000,
    },
  })).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "usage-archive.jsonl"), records);
  fs.writeFileSync(path.join(dir, "price-table.json"), JSON.stringify({
    "provider-a/shared-model": price(1),
    "provider-b/shared-model": price(10),
  }));
  const app = createMockApp();
  registerRoutes(app, dashboardContext(dir, { sessions: {} }));

  const both = await invoke(app.routes.GET["/turn"], { query: { sessionId: "session-cost" } });
  assert.deepEqual(both.body.calls.map((call) => [call.provider, call.cost]), [["provider-a", 1], ["provider-b", 10]]);

  fs.writeFileSync(path.join(dir, "price-table.json"), JSON.stringify({
    "provider-a/shared-model": price(1),
  }));
  const oneUnpriced = await invoke(app.routes.GET["/turn"], { query: { sessionId: "session-cost" } });
  assert.equal(oneUnpriced.body.calls.find((call) => call.provider === "provider-a").cost, 1);
  assert.equal(oneUnpriced.body.calls.find((call) => call.provider === "provider-b").cost, null);
  assert.equal(oneUnpriced.body.totalCost, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
