import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CodexQuotaService,
} from "../lib/codex-quota.mjs";
import {
  buildMonths,
  DeepSeekUsageService,
} from "../lib/deepseek-usage.mjs";
import { DeepSeekBalanceService } from "../lib/deepseek-balance.mjs";
import { LithosBalanceService } from "../lib/lithos-balance.mjs";
import registerRoutes from "../server/dashboard.js";

const TOKEN_A = "FAKEplatformTokenA0123456789abcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_B = "FAKEplatformTokenB0123456789abcdefghijklmnopqrstuvwxyz0123456789";
const SESSION_A = "__Host-console_session=session-a";
const CSRF_A = "__Host-console_csrf=csrf-a";
const SESSION_B = "__Host-console_session=session-b";
const CSRF_B = "__Host-console_csrf=csrf-b";

function tmpDir(prefix = "tt-review-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
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
    text: (value, nextStatus = 200) => {
      status = nextStatus;
      responseBody = value;
      return { status, body: value };
    },
  });
  return { status, body: responseBody ?? result };
}

function dashboardContext(dataDir, { network = null, models = [] } = {}) {
  return {
    dataDir,
    network,
    _tokenCache: {
      ready: true,
      dataDir,
      data: { sessions: {}, agentNames: {} },
      realtime: {},
    },
    bus: {
      async request(type, payload) {
        if (type === "model:list") return { models };
        if (type === "agent:list") return { agents: [] };
        if (type === "media:task:list") return { tasks: [] };
        if (type === "provider:credentials") return { apiKey: "fake-provider-key" };
        return {};
      },
    },
  };
}

test("Codex 核销只有 HTTP 成功且 JSON 明确 code=reset 才确认成功", async () => {
  const cases = [
    { response: jsonResponse(200, {}), code: "unknown_response" },
    { response: { status: 200, ok: true, json: async () => { throw new Error("invalid json"); } }, code: "invalid_response" },
    { response: jsonResponse(500, { code: "reset" }), code: "http_500" },
  ];

  for (const item of cases) {
    let calls = 0;
    const service = new CodexQuotaService({
      bus: { request: async () => ({ apiKey: "fake-codex-key" }) },
      fetchFn: async () => {
        calls += 1;
        return item.response;
      },
    });
    const result = await service.consumeResetCredit({ creditId: "credit-1" });
    assert.equal(calls, 1, "未知结果不得自动重试核销");
    assert.equal(result.ok, false);
    assert.equal(result.code, item.code);
    assert.notEqual(result.code, "reset");
    assert.doesNotMatch(result.message, /已清空/);
  }

  const service = new CodexQuotaService({
    bus: { request: async () => ({ apiKey: "fake-codex-key" }) },
    fetchFn: async () => jsonResponse(200, { code: "reset" }),
  });
  const result = await service.consumeResetCredit({ creditId: "credit-1" });
  assert.deepEqual({ ok: result.ok, code: result.code }, { ok: true, code: "reset" });
  assert.equal("raw" in result, false, "核销响应不再回传无消费必要的 raw");
});

test("Codex 查询不打印原始响应，核销请求 ID只接受有界字符串", async () => {
  let logged = false;
  const originalLog = console.log;
  console.log = () => { logged = true; };
  try {
    const service = new CodexQuotaService({
      bus: { request: async () => ({ apiKey: "fake-codex-key" }) },
      fetchFn: async () => jsonResponse(200, { plan_type: "plus", secret: "must-not-log" }),
    });
    await service.getQuota({ force: true });
  } finally {
    console.log = originalLog;
  }
  assert.equal(logged, false);

  let requestBody;
  const service = new CodexQuotaService({
    bus: { request: async () => ({ apiKey: "fake-codex-key" }) },
    fetchFn: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return jsonResponse(200, { code: "reset" });
    },
  });
  const ok = await service.consumeResetCredit({ creditId: "credit-1", redeemRequestId: "stable-request-1" });
  assert.equal(ok.ok, true);
  assert.equal(requestBody.redeem_request_id, "stable-request-1");

  const bad = await service.consumeResetCredit({ creditId: "credit-1", redeemRequestId: { bad: true } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid_param");
});

test("Codex 路由透传 redeemRequestId，不替换成新的请求 ID", async () => {
  const dir = tmpDir();
  const app = createMockApp();
  let requestBody;
  registerRoutes(app, {
    ...dashboardContext(dir),
    network: {
      fetch: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return jsonResponse(200, { code: "reset" });
      },
    },
  });

  const result = await invoke(app.routes.POST["/codex-reset-credits/consume"], {
    body: { creditId: "credit-1", redeemRequestId: "route-request-1" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(requestBody.redeem_request_id, "route-request-1");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DeepSeek 自定义月份严格校验真实日期、成对区间、顺序和12个月上限", () => {
  assert.deepEqual(
    buildMonths("custom", new Date("2026-10-27T00:00:00Z"), { start: "2026-10-01", end: "2026-10-31" }),
    [{ year: 2026, month: 10 }]
  );

  for (const range of [
    { start: "2026-02-30", end: "2026-03-01" },
    { start: "2026-10-01", end: "2026-09-30" },
    { start: "2026-01-01" },
    { end: "2026-01-01" },
    { start: "2025-01-01", end: "2026-01-01" },
  ]) {
    assert.throws(
      () => buildMonths("custom", new Date("2026-10-27T00:00:00Z"), range),
      (error) => error instanceof RangeError && error.code === "invalid_range"
    );
  }
});

test("DeepSeek 非法自定义区间在出网前返回 invalid_range", async () => {
  const dir = tmpDir();
  let calls = 0;
  const service = new DeepSeekUsageService({
    dataDir: dir,
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(200, {});
    },
  });
  service.saveToken(TOKEN_A);
  const result = await service.getUsage({ start: "2026-10-02", end: "2026-09-01" });
  assert.equal(result.connected, false);
  assert.equal(result.reason, "invalid_range");
  assert.equal(calls, 0, "非法区间不应触发上游请求");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("三类凭据保存会把已存在的0644文件修正为0600", async () => {
  const dir = tmpDir();

  const usageFile = path.join(dir, "deepseek-platform.json");
  fs.writeFileSync(usageFile, JSON.stringify({ token: TOKEN_A }), { mode: 0o644 });
  const usage = new DeepSeekUsageService({ dataDir: dir });
  assert.equal(usage.saveToken(TOKEN_B).ok, true);
  assert.equal(fs.statSync(usageFile).mode & 0o777, 0o600);

  const lithosFile = path.join(dir, "lithos-console.json");
  fs.writeFileSync(lithosFile, JSON.stringify({ cookie: `${SESSION_A}; ${CSRF_A}` }), { mode: 0o644 });
  const lithos = new LithosBalanceService({ dataDir: dir });
  assert.equal(lithos.saveCookie(`${SESSION_B}; ${CSRF_B}`).ok, true);
  assert.equal(fs.statSync(lithosFile).mode & 0o777, 0o600);

  const balanceFile = path.join(dir, "balance-apis.json");
  fs.writeFileSync(balanceFile, JSON.stringify({}), { mode: 0o644 });
  const app = createMockApp();
  registerRoutes(app, dashboardContext(dir));
  const result = await invoke(app.routes.POST["/balance-apis"], {
    body: { deepseek: { apiKey: "fake-key" } },
  });
  assert.equal(result.status, 200);
  assert.equal(fs.statSync(balanceFile).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("余额配置只接受 HTTPS、无认证信息且命中 manifest allowlist 的 URL", async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  for (const host of ["api.deepseek.com", "open.bigmodel.cn", "api.moonshot.cn", "api.minimaxi.com"]) {
    assert.ok(manifest.network.allowedHosts.includes(host), `${host} 必须保留在宿主白名单`);
  }

  const dir = tmpDir();
  const app = createMockApp();
  registerRoutes(app, dashboardContext(dir));
  for (const url of [
    "https://evil.example/balance",
    "http://api.deepseek.com/user/balance",
    "https://user:pass@api.deepseek.com/user/balance",
  ]) {
    const before = await invoke(app.routes.POST["/balance-apis"], {
      body: { custom: { url, apiKey: "must-not-save" } },
    });
    assert.equal(before.status, 400);
    assert.equal(before.body.code, "INVALID_BALANCE_URL");
    assert.equal(fs.existsSync(path.join(dir, "balance-apis.json")), false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("旧配置中的未知余额主机不可查询，允许主机通过宿主 network.fetch 查询", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({
    rogue: { url: "https://evil.example/balance", apiKey: "rogue-key" },
    deepseek: { url: "https://evil.example/balance", apiKey: "relay-key" },
  }));
  const calls = [];
  const app = createMockApp();
  registerRoutes(app, {
    ...dashboardContext(dir, { models: [
      { id: "rogue/model", provider: "rogue", modelId: "model" },
      { id: "deepseek/model", provider: "deepseek", modelId: "model" },
    ] }),
    network: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("open.er-api.com")) return jsonResponse(503, {});
        return jsonResponse(200, { balance_infos: [{ total_balance: "3.25", currency: "CNY" }] });
      },
    },
  });

  const data = await invoke(app.routes.GET["/data"]);
  assert.equal(data.status, 200);
  assert.equal(calls.some((call) => call.url.includes("evil.example")), false);
  assert.equal(data.body._balanceApis.rogue.configError, "invalid_url", "旧未知主机配置必须保留为明确的无效状态");
  assert.equal(data.body._balanceApis.deepseek.configError, "invalid_url", "已知 Provider 的旧非法 URL 也必须保留无效状态");
  const rejected = data.body._balances.find((item) => item.provider === "rogue");
  assert.equal(rejected.type, "config-error");
  assert.equal(data.body._balances.find((item) => item.provider === "deepseek").type, "config-error");
  assert.equal(calls.some((call) => call.url.includes("api.deepseek.com")), false, "不得回退到默认官方 URL");

  const allowedDir = tmpDir();
  const allowedCalls = [];
  const allowedApp = createMockApp();
  registerRoutes(allowedApp, {
    ...dashboardContext(allowedDir, { models: [{ id: "custom/model", provider: "custom", modelId: "model" }] }),
    network: {
      fetch: async (url, init) => {
        allowedCalls.push({ url: String(url), init });
        if (String(url).includes("open.er-api.com")) return jsonResponse(503, {});
        return jsonResponse(200, { balance_infos: [{ total_balance: "3.25", currency: "CNY" }] });
      },
    },
  });
  const saved = await invoke(allowedApp.routes.POST["/balance-apis"], {
    body: { custom: { url: "https://api.deepseek.com/custom-balance", apiKey: "fake-provider-key" } },
  });
  assert.equal(saved.status, 200);
  const allowedData = await invoke(allowedApp.routes.GET["/data"]);
  const balance = allowedData.body._balances.find((item) => item.provider === "custom");
  assert.equal(balance.type, "money");
  assert.equal(balance.total, 3.25);
  const balanceCall = allowedCalls.find((call) => call.url.includes("/custom-balance"));
  assert.ok(balanceCall);
  assert.equal(balanceCall.init.method, "GET");
  assert.equal(balanceCall.init.redirect, "error");
  assert.equal(balanceCall.init.headers.Authorization, "Bearer fake-provider-key");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(allowedDir, { recursive: true, force: true });
});

test("余额 token-plan 仍通过宿主 network.fetch 并保留原解析结果", async () => {
  const dir = tmpDir();
  const calls = [];
  const app = createMockApp();
  registerRoutes(app, {
    ...dashboardContext(dir, { models: [{ id: "minimax-token-plan/plan", provider: "minimax-token-plan", modelId: "plan" }] }),
    network: {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("open.er-api.com")) return jsonResponse(503, {});
        return jsonResponse(200, { base_resp: { status_code: 0 } });
      },
    },
  });

  const result = await invoke(app.routes.GET["/data"]);
  assert.equal(result.status, 200);
  const plan = result.body._balances.find((item) => item.provider === "minimax-token-plan");
  assert.deepEqual({ type: plan.type, display: plan.display }, { type: "token-plan", display: "已获取" });
  const planCall = calls.find((call) => call.url.includes("token_plan/remains"));
  assert.ok(planCall);
  assert.equal(planCall.init.method, "GET");
  assert.equal(planCall.init.redirect, "error");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DeepSeek 余额保存新 key 后立即失效服务缓存", async () => {
  const dir = tmpDir();
  const seenKeys = [];
  const app = createMockApp();
  registerRoutes(app, {
    ...dashboardContext(dir),
    network: {
      fetch: async (_url, init) => {
        const key = String(init.headers.Authorization).replace(/^Bearer\s+/, "");
        seenKeys.push(key);
        return jsonResponse(200, {
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: key === "key-a" ? "1.00" : "2.00" }],
        });
      },
    },
  });

  await invoke(app.routes.POST["/balance-apis"], { body: { deepseek: { apiKey: "key-a" } } });
  const first = await invoke(app.routes.GET["/deepseek-balance"]);
  assert.equal(first.body.display, "¥1.00");

  await invoke(app.routes.POST["/balance-apis"], { body: { deepseek: { apiKey: "key-b" } } });
  const second = await invoke(app.routes.GET["/deepseek-balance"]);
  assert.equal(second.body.display, "¥2.00");
  assert.deepEqual(seenKeys, ["key-a", "key-b"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DeepSeek 平台令牌轮换后，旧在途 summary 不得污染新令牌缓存", async () => {
  const dir = tmpDir();
  let releaseOld;
  let oldStartedResolve;
  const oldStarted = new Promise((resolve) => { oldStartedResolve = resolve; });
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  let calls = 0;
  const service = new DeepSeekUsageService({
    dataDir: dir,
    fetchFn: async (_url, init) => {
      calls += 1;
      const token = String(init.headers.Authorization).replace(/^Bearer\s+/, "");
      if (token === TOKEN_A) {
        oldStartedResolve();
        await oldGate;
        return jsonResponse(200, { code: 0, data: { biz_code: 0, biz_data: { normal_wallets: [{ currency: "CNY", balance: "1.00" }] } } });
      }
      return jsonResponse(200, { code: 0, data: { biz_code: 0, biz_data: { normal_wallets: [{ currency: "CNY", balance: "2.00" }] } } });
    },
  });

  service.saveToken(TOKEN_A);
  const oldRequest = service.getSummary({ force: true });
  await oldStarted;
  service.saveToken(TOKEN_B);
  const fresh = await service.getSummary({ force: true });
  assert.equal(fresh.balanceDisplay, "¥2.00");
  releaseOld();
  await oldRequest;
  const cached = await service.getSummary();
  assert.equal(cached.balanceDisplay, "¥2.00");
  assert.equal(calls, 2, "旧请求完成后不得再次触发新令牌请求");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Lithos 保存新 Cookie 后清空余额、组织和消费缓存", async () => {
  const dir = tmpDir();
  const calls = [];
  const service = new LithosBalanceService({
    dataDir: dir,
    fetchFn: async (url, init) => {
      const cookie = init.headers.cookie;
      calls.push({ url, cookie });
      const isA = cookie.includes("session-a");
      if (String(url).endsWith("/api/me")) return jsonResponse(200, { organization: { id: isA ? "org-a" : "org-b" } });
      if (String(url).includes("/api/billing/spend")) return jsonResponse(200, { days: [{ day: "2026-10-01", modelId: "m", nanos: isA ? 1_000_000_000 : 2_000_000_000 }] });
      return jsonResponse(200, { balanceNanos: isA ? 1_000_000_000 : 2_000_000_000 });
    },
  });

  service.saveCookie(`${SESSION_A}; ${CSRF_A}`);
  assert.equal((await service.getBalance()).display, "$1.00");
  assert.equal((await service.getSpend({ start: "2026-10-01", end: "2026-10-01" })).totalDisplay, "$1.00");

  service.saveCookie(`${SESSION_B}; ${CSRF_B}`);
  assert.equal((await service.getBalance()).display, "$2.00");
  assert.equal((await service.getSpend({ start: "2026-10-01", end: "2026-10-01" })).totalDisplay, "$2.00");
  assert.ok(calls.some((call) => call.cookie.includes("session-b")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("/turn 详情费用按 Asia/Shanghai 选择价格时段，fallback turns 日期也使用同一时区", async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "UTC";
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "usage-archive.jsonl"), JSON.stringify({
    rid: "turn-1",
    v: {
      requestId: "turn-1",
      sessionId: "session-1",
      startedAt: "2026-10-27T16:30:00.000Z",
      endedAt: "2026-10-27T16:30:01.000Z",
      status: "ok",
      provider: "custom",
      model: "model",
      inputTokens: 1_000_000,
      inputUncachedTokens: 1_000_000,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 1_000_000,
    },
  }) + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "price-table.json"), JSON.stringify({
    "custom/model": {
      slots: [
        { from: "00:00", to: "01:00", unit: "token", inputPerM: 1, inputCachePerM: 0, outputPerM: 0, cacheWritePerM: 0 },
        { from: "16:00", to: "17:00", unit: "token", inputPerM: 9, inputCachePerM: 0, outputPerM: 0, cacheWritePerM: 0 },
      ],
    },
  }), "utf8");

  const app = createMockApp();
  const context = dashboardContext(dir);
  context._tokenCache.data.turnsIndexReady = false;
  context._tokenCache.data.sessions = {
    "session-1::desktop::2026-10-28": {
      agent: "agent-a",
      type: "desktop",
      conversations: [{ time: "2026-10-27T16:30:00.000Z", provider: "custom", model: "model", totalTokens: 10 }],
    },
  };
  registerRoutes(app, context);

  const detail = await invoke(app.routes.GET["/turn"], { query: { requestId: "turn-1" } });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.calls[0].cost, 1, "16:30Z 在上海是次日 00:30，应命中 00:00 时段");

  const turns = await invoke(app.routes.GET["/turns"], { query: { from: "2026-10-28", to: "2026-10-28" } });
  assert.equal(turns.status, 200);
  assert.equal(turns.body.total, 1, "fallback turns 日期应按上海时区为 2026-10-28");

  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Lithos Cookie 轮换隔离旧在途余额请求，不回写新账号缓存", async () => {
  const dir = tmpDir();
  let releaseOld;
  let oldStartedResolve;
  const oldStarted = new Promise((resolve) => { oldStartedResolve = resolve; });
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const service = new LithosBalanceService({
    dataDir: dir,
    fetchFn: async (url, init) => {
      const cookie = init.headers.cookie;
      if (cookie.includes("session-a")) {
        oldStartedResolve();
        await oldGate;
        return String(url).endsWith("/api/me")
          ? jsonResponse(200, { organization: { id: "org-a" } })
          : jsonResponse(200, { balanceNanos: 1_000_000_000 });
      }
      return String(url).endsWith("/api/me")
        ? jsonResponse(200, { organization: { id: "org-b" } })
        : jsonResponse(200, { balanceNanos: 2_000_000_000 });
    },
  });

  service.saveCookie(`${SESSION_A}; ${CSRF_A}`);
  const oldRequest = service.getBalance({ force: true });
  await oldStarted;
  service.saveCookie(`${SESSION_B}; ${CSRF_B}`);
  const fresh = await service.getBalance({ force: true });
  assert.equal(fresh.display, "$2.00");
  releaseOld();
  await oldRequest;
  const cached = await service.getBalance();
  assert.equal(cached.display, "$2.00");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("余额 global fetch 传入真实 AbortSignal 超时边界", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({
    custom: { url: "https://api.deepseek.com/custom-balance", apiKey: "fake-key" },
  }));
  const originalFetch = globalThis.fetch;
  let balanceInit = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("custom-balance")) {
      balanceInit = init;
      return jsonResponse(200, { balance_infos: [{ total_balance: "1.00", currency: "CNY" }] });
    }
    return jsonResponse(503, {});
  };
  try {
    const app = createMockApp();
    registerRoutes(app, dashboardContext(dir, { models: [{ id: "custom/model", provider: "custom", modelId: "model" }] }));
    const result = await invoke(app.routes.GET["/data"]);
    assert.equal(result.status, 200);
    assert.ok(balanceInit?.signal, "global fetch 必须带真实 AbortSignal");
    assert.equal(typeof balanceInit.signal.addEventListener, "function");
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
