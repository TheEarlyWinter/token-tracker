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
  assert.deepEqual(creds, { apiKey: "sk-ds-real" });

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
