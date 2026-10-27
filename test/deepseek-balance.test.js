import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDeepSeekCredentials,
  resolveDeepSeekCredentials,
  parseDeepSeekBalance,
  DeepSeekBalanceService,
} from "../lib/deepseek-balance.mjs";
import { renderDeepSeekCard } from "../ui/modules/deepseek-card.js";

test("normalizeDeepSeekCredentials 提取有效 apiKey", () => {
  assert.equal(normalizeDeepSeekCredentials(null), null);
  assert.equal(normalizeDeepSeekCredentials({ error: "permission_denied" }), null);
  assert.deepEqual(normalizeDeepSeekCredentials({ apiKey: "sk-test-123" }), { apiKey: "sk-test-123" });
  assert.deepEqual(normalizeDeepSeekCredentials({ api_key: "sk-test-456" }), { apiKey: "sk-test-456" });
  assert.deepEqual(normalizeDeepSeekCredentials({ access: "sk-test-789" }), { apiKey: "sk-test-789" });
  assert.deepEqual(normalizeDeepSeekCredentials({ headers: { Authorization: "Bearer sk-test-bearer" } }), { apiKey: "sk-test-bearer" });
});

test("resolveDeepSeekCredentials 尝试从 bus 获取凭据", async () => {
  const fakeBus = {
    async request(event, payload) {
      if (payload.providerId === "deepseek") {
        return { apiKey: "sk-ds-real" };
      }
      throw new Error("not found");
    },
  };

  const creds = await resolveDeepSeekCredentials(fakeBus);
  // 带 source 标明来源：401 时的提示文案要靠它区分「官方 key」还是「宿主供应商的 key」
  assert.deepEqual(creds, { apiKey: "sk-ds-real", source: "bus", providerId: "deepseek" });

  const emptyBus = {
    async request() {
      throw new Error("provider error");
    },
  };
  const none = await resolveDeepSeekCredentials(emptyBus);
  assert.equal(none, null);
});

test("parseDeepSeekBalance 解析官方返回的 CNY / USD 余额与赠送金额", () => {
  const mockPayload = {
    is_available: true,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: "18.50",
        granted_balance: "10.00",
        topped_up_balance: "8.50",
      },
      {
        currency: "USD",
        total_balance: "0.00",
        granted_balance: "0.00",
        topped_up_balance: "0.00",
      },
    ],
  };

  const parsed = parseDeepSeekBalance(mockPayload);
  assert.equal(parsed.connected, true);
  assert.equal(parsed.currency, "CNY");
  assert.equal(parsed.symbol, "¥");
  assert.equal(parsed.total, 18.5);
  assert.equal(parsed.granted, 10);
  assert.equal(parsed.toppedUp, 8.5);
  assert.equal(parsed.display, "¥18.50");

  const invalid = parseDeepSeekBalance(null);
  assert.equal(invalid.connected, false);
});

test("DeepSeekBalanceService 60秒防刷缓存与并发去重", async () => {
  let networkCalls = 0;
  const fakeFetch = async () => {
    networkCalls++;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "25.00" }],
        };
      },
    };
  };

  const fakeBus = {
    async request() {
      return { apiKey: "sk-ds-valid" };
    },
  };

  const service = new DeepSeekBalanceService({
    bus: fakeBus,
    fetchFn: fakeFetch,
    ttlMs: 60_000,
  });

  const res1 = await service.getBalance();
  const res2 = await service.getBalance();
  assert.equal(networkCalls, 1, "60s 内第二次调用应命中缓存");
  assert.equal(res1.display, "¥25.00");
  assert.equal(res2.display, "¥25.00");

  // force 穿透
  const res3 = await service.getBalance({ force: true });
  assert.equal(networkCalls, 2, "force 为 true 时穿透缓存");
  assert.equal(res3.display, "¥25.00");
});

test("DeepSeekBalanceService 处理 429 退避与无凭据降级", async () => {
  const serviceWithoutCreds = new DeepSeekBalanceService({
    bus: { async request() { return null; } },
    fetchFn: async () => assert.fail("不应发出网络请求"),
  });

  const noCreds = await serviceWithoutCreds.getBalance();
  assert.equal(noCreds.connected, false);
  assert.equal(noCreds.reason, "not_connected");

  let calls = 0;
  const service429 = new DeepSeekBalanceService({
    bus: { async request() { return { apiKey: "sk-test" }; } },
    fetchFn: async () => {
      calls++;
      return { ok: false, status: 429 };
    },
  });

  const rateLimited = await service429.getBalance();
  assert.equal(rateLimited.connected, false);
  assert.equal(rateLimited.reason, "rate_limited");

  // 冷却中不再发网络请求
  const cachedCool = await service429.getBalance();
  assert.equal(calls, 1, "冷却期内不应重复发起请求");
  assert.equal(cachedCool.reason, "rate_limited");
});

test("renderDeepSeekCard 渲染纯白微卡并在未配置时静默隐藏父节点", () => {
  const parent = { style: { display: "" } };
  const container = {
    parentElement: parent,
    innerHTML: "",
  };

  // 未连接时静默折叠
  renderDeepSeekCard(container, { connected: false });
  assert.equal(parent.style.display, "none");
  assert.equal(container.innerHTML, "");

  // 成功连接渲染
  renderDeepSeekCard(container, {
    connected: true,
    currency: "CNY",
    symbol: "¥",
    display: "¥18.50",
    granted: 10,
    grantedBalance: "10.00",
  });
  assert.equal(parent.style.display, "");
  assert.ok(container.innerHTML.includes("DeepSeek 余额"));
  assert.ok(container.innerHTML.includes("¥18.50"));
  assert.ok(container.innerHTML.includes("含赠送 ¥10.00"));
});

// ── 宿主里删掉 DeepSeek 供应商之后，余额卡不该跟着消失 ──
test("供应商不在了也能用单独填的 key 查余额", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ds-"));
  // 宿主总线里没有 deepseek（用户删了供应商），只剩本机 balance-apis.json
  const bus = { request: async () => { throw new Error("provider not found"); } };
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({ deepseek: { apiKey: "sk-only-balance" } }));

  const svc = new DeepSeekBalanceService({
    bus,
    dataDir: dir,
    fetchFn: async (url, init) => {
      assert.match(String(init.headers.Authorization), /Bearer sk-only-balance/);
      return {
        status: 200,
        ok: true,
        json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.34", granted_balance: "0.00", topped_up_balance: "12.34" }] }),
      };
    },
  });
  const res = await svc.getBalance({ force: true });
  assert.equal(res.connected, true, "有 key 就该查到，与供应商是否在册无关");
  assert.equal(res.display, "¥12.34");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("没 key 时明确报未连接，让设置页能说清楚原因", async () => {
  const svc = new DeepSeekBalanceService({
    bus: { request: async () => { throw new Error("none"); } },
    dataDir: "",
    fetchFn: async () => ({ status: 200, ok: true, json: async () => ({}) }),
  });
  const res = await svc.getBalance({ force: true });
  assert.equal(res.connected, false);
  assert.equal(res.reason, "not_connected", "界面按这个 reason 决定隐藏还是报错");
});

test("卡片：只有「未配置」才隐藏，密钥失效要留在面板上", () => {
  const mk = () => ({ parentElement: { style: { display: "" } }, innerHTML: "" });

  const hidden = mk();
  renderDeepSeekCard(hidden, { connected: false, reason: "not_connected", message: "未配置 DeepSeek" });
  assert.equal(hidden.parentElement.style.display, "none");
  assert.equal(hidden.innerHTML, "");

  const broken = mk();
  renderDeepSeekCard(broken, { connected: false, reason: "unauthorized", message: "DeepSeek API Key 无效" });
  assert.equal(broken.parentElement.style.display, "", "有 key 但失效：卡要留着");
  assert.match(broken.innerHTML, /Key 无效/);
});

test("设置页存的 key 会被余额接口读到（balance-apis 路由闭环）", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const registerRoutes = (await import("../server/dashboard.js")).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ds-route-"));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "7.77", granted_balance: "0.00", topped_up_balance: "7.77" }] }),
  });

  const routes = {};
  const mockApp = { get: (p, fn) => { routes["GET " + p] = fn; }, post: (p, fn) => { routes["POST " + p] = fn; } };
  registerRoutes(mockApp, {
    _tokenCache: { ready: true, dataDir: dir, data: { sessions: {} } },
    dataDir: dir,
    bus: { request: async () => { throw new Error("provider not found"); } },
  });

  const save = await routes["POST /balance-apis"]({
    req: { json: async () => ({ deepseek: { apiKey: "sk-from-settings" } }) },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  assert.ok(save.status === 200 || save.body?.ok !== false);

  const stored = JSON.parse(fs.readFileSync(path.join(dir, "balance-apis.json"), "utf-8"));
  assert.equal(stored.deepseek.apiKey, "sk-from-settings");

  const bal = await routes["GET /deepseek-balance"]({
    req: { query: (k) => (k === "refresh" ? "1" : "") },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  assert.equal(bal.body.connected, true);
  assert.equal(bal.body.display, "¥7.77");

  // 掩码值不能覆盖已存的 key
  await routes["POST /balance-apis"]({
    req: { json: async () => ({ deepseek: { apiKey: "••••••••" } }) },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  const after = JSON.parse(fs.readFileSync(path.join(dir, "balance-apis.json"), "utf-8"));
  assert.equal(after.deepseek.apiKey, "sk-from-settings");

  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("历史 reason（no_credentials）同样按未配置处理", () => {
  const container = { parentElement: { style: { display: "" } }, innerHTML: "" };
  renderDeepSeekCard(container, { connected: false, reason: "no_credentials" });
  assert.equal(container.parentElement.style.display, "none");
  assert.equal(container.innerHTML, "");
});

test("显式填的 key 优先于宿主总线（providerId 可能指向中转站）", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ds-order-"));
  fs.writeFileSync(path.join(dir, "balance-apis.json"), JSON.stringify({ deepseek: { apiKey: "sk-official" } }));

  const bus = { request: async () => ({ apiKey: "relay-key-pointing-elsewhere" }) };
  const creds = await resolveDeepSeekCredentials(bus, { dataDir: dir });
  assert.equal(creds.apiKey, "sk-official", "设置页显式填的赢");
  assert.equal(creds.source, "explicit");

  // 没显式 key 时才回落到总线，并标明来源
  const busOnly = await resolveDeepSeekCredentials(bus, { dataDir: "" });
  assert.equal(busOnly.apiKey, "relay-key-pointing-elsewhere");
  assert.equal(busOnly.source, "bus");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("用总线凭据被 401 时，错误里说清 key 是哪来的", async () => {
  const svc = new DeepSeekBalanceService({
    bus: { request: async () => ({ apiKey: "relay-key" }) },
    dataDir: "",
    fetchFn: async () => ({ status: 401, ok: false, json: async () => ({}) }),
  });
  const res = await svc.getBalance({ force: true });
  assert.equal(res.reason, "unauthorized");
  assert.match(res.message, /供应商/, "要提一句这把 key 来自宿主供应商");
  assert.match(res.message, /中转站|单独填/, "并给出修法");
});
