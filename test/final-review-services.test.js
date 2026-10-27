import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeCodexUsage,
  CodexQuotaService,
} from "../lib/codex-quota.mjs";
import { parseDeepSeekBalance } from "../lib/deepseek-balance.mjs";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function quotaBody(usedPercent) {
  return {
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: usedPercent },
    },
  };
}

function quotaBus() {
  return { request: async () => ({ apiKey: "codex-test-key" }) };
}

test("Codex 空壳响应必须拒绝，正常单窗口和零百分比仍可用", () => {
  for (const raw of [
    {},
    [],
    { error: "upstream failure" },
    { plan_type: "plus" },
    { rate_limit: {} },
  ]) {
    const result = sanitizeCodexUsage(raw);
    assert.equal(result.connected, false, JSON.stringify(raw));
    assert.equal(result.reason, "invalid_response", JSON.stringify(raw));
  }

  const zero = sanitizeCodexUsage({
    plan_type: "free",
    rate_limit: { primary_window: { used_percent: 0 } },
  });
  assert.equal(zero.connected, true);
  assert.equal(zero.primary.usedPercent, 0);
  assert.equal(zero.primary.remainingPercent, 100);
  assert.equal(zero.secondary, null);

  const secondaryOnly = sanitizeCodexUsage({
    rate_limit: { secondary_window: { used_percent: 100 } },
  });
  assert.equal(secondaryOnly.connected, true);
  assert.equal(secondaryOnly.primary, null);
  assert.equal(secondaryOnly.secondary.remainingPercent, 0);
});

test("Codex credits-only 的有效余额字段仍可确认已连接", () => {
  const result = sanitizeCodexUsage({
    credits: { has_credits: false, balance: "$0.00" },
  });
  assert.equal(result.connected, true);
  assert.equal(result.creditsBalance, "$0.00");
  assert.equal(result.hasCredits, false);
});

test("Codex 核销后新 epoch 强刷，旧 GET 不能覆盖新缓存", async () => {
  const oldGate = deferred();
  const oldStarted = deferred();
  let getCalls = 0;
  let postCalls = 0;
  const service = new CodexQuotaService({
    bus: quotaBus(),
    fetchFn: async (_url, init) => {
      if (init?.method === "POST") {
        postCalls++;
        return response({ code: "reset" });
      }
      getCalls++;
      if (getCalls === 1) {
        oldStarted.resolve();
        return oldGate.promise;
      }
      if (getCalls === 2) return response(quotaBody(20));
      throw new Error("unexpected third GET");
    },
  });

  const oldRequest = service.getQuota({ force: true });
  await oldStarted.promise;
  const consumed = await service.consumeResetCredit({ creditId: "credit-1" });
  assert.equal(consumed.ok, true);

  const freshPromise = service.getQuota({ force: true });
  oldGate.resolve(response(quotaBody(80)));
  const fresh = await freshPromise;
  assert.equal(fresh.primary.usedPercent, 20);
  assert.equal(getCalls, 2);

  const oldResult = await oldRequest;
  assert.equal(oldResult.primary.usedPercent, 80);

  const cached = await service.getQuota();
  assert.equal(cached.primary.usedPercent, 20);
  assert.equal(getCalls, 2, "旧 epoch 完成后不能覆盖新缓存");
  assert.equal(postCalls, 1);
});

test("Codex 旧 epoch 的 finally 不能清掉新 epoch 的 inFlight", async () => {
  const oldGate = deferred();
  const newGate = deferred();
  const oldStarted = deferred();
  let getCalls = 0;
  const service = new CodexQuotaService({
    bus: quotaBus(),
    fetchFn: async (_url, init) => {
      if (init?.method === "POST") return response({ code: "reset" });
      getCalls++;
      if (getCalls === 1) {
        oldStarted.resolve();
        return oldGate.promise;
      }
      if (getCalls === 2) return newGate.promise;
      throw new Error("unexpected third GET");
    },
  });

  const oldRequest = service.getQuota({ force: true });
  await oldStarted.promise;
  await service.consumeResetCredit({ creditId: "credit-1" });
  const newRequest = service.getQuota({ force: true });

  oldGate.resolve(response(quotaBody(80)));
  await oldRequest;
  const sameEpochRequest = service.getQuota({ force: true });
  assert.equal(getCalls, 2, "同一新 epoch 的 inFlight 仍应复用");

  newGate.resolve(response(quotaBody(20)));
  const [fresh, reused] = await Promise.all([newRequest, sameEpochRequest]);
  assert.equal(fresh.primary.usedPercent, 20);
  assert.equal(reused.primary.usedPercent, 20);
  assert.equal(getCalls, 2);
});

test("Codex 核销成功会清除 rate-limit 冷却并允许新的 quota GET", async () => {
  let getCalls = 0;
  const service = new CodexQuotaService({
    bus: quotaBus(),
    fetchFn: async (_url, init) => {
      if (init?.method === "POST") return response({ code: "reset" });
      getCalls++;
      if (getCalls === 1) return response({}, 429);
      return response(quotaBody(0));
    },
  });

  const limited = await service.getQuota({ force: true });
  assert.equal(limited.reason, "rate_limited");
  await service.consumeResetCredit({ creditId: "credit-1" });
  const fresh = await service.getQuota({ force: true });
  assert.equal(fresh.connected, true);
  assert.equal(fresh.primary.remainingPercent, 100);
  assert.equal(getCalls, 2);
});

test("Codex 核销后旧 reset-credit 列表不能覆盖新缓存", async () => {
  const oldGate = deferred();
  const oldStarted = deferred();
  let listCalls = 0;
  const service = new CodexQuotaService({
    bus: quotaBus(),
    fetchFn: async (_url, init) => {
      if (init?.method === "POST") return response({ code: "reset" });
      listCalls++;
      if (listCalls === 1) {
        oldStarted.resolve();
        return oldGate.promise;
      }
      if (listCalls === 2) return response({ credits: [], available_count: 0 });
      throw new Error("unexpected third reset-credit GET");
    },
  });

  const oldRequest = service.getResetCredits({ force: true });
  await oldStarted.promise;
  await service.consumeResetCredit({ creditId: "credit-1" });

  const fresh = await service.getResetCredits({ force: true });
  assert.equal(fresh.availableCount, 0);
  assert.equal(listCalls, 2);

  oldGate.resolve(response({ credits: [], available_count: 1 }));
  const oldResult = await oldRequest;
  assert.equal(oldResult.availableCount, 1);

  const cached = await service.getResetCredits();
  assert.equal(cached.availableCount, 0);
  assert.equal(listCalls, 2, "旧列表响应不能覆盖新缓存");
});

test("DeepSeek 非法 total_balance 和明确非法可选金额都拒绝，不伪装成零", () => {
  for (const value of ["not-a-number", "Infinity", "", "123oops"]) {
    const result = parseDeepSeekBalance({
      balance_infos: [{ currency: "CNY", total_balance: value }],
    });
    assert.equal(result.connected, false, value);
    assert.equal(result.reason, "invalid_response", value);
  }

  const badOptional = parseDeepSeekBalance({
    balance_infos: [{ currency: "CNY", total_balance: "1.00", granted_balance: "oops" }],
  });
  assert.equal(badOptional.connected, false);
  assert.equal(badOptional.reason, "invalid_response");
});

test("DeepSeek 正常零值、负余额和 CNY 优先级保持兼容", () => {
  const zero = parseDeepSeekBalance({
    balance_infos: [
      { currency: "USD", total_balance: "9.00" },
      { currency: "CNY", total_balance: "0.00" },
    ],
  });
  assert.equal(zero.connected, true);
  assert.equal(zero.currency, "CNY");
  assert.equal(zero.total, 0);
  assert.equal(zero.granted, 0);
  assert.equal(zero.toppedUp, 0);
  assert.equal(zero.display, "¥0.00");

  const negative = parseDeepSeekBalance({
    balance_infos: [{ currency: "CNY", total_balance: "-1.25" }],
  });
  assert.equal(negative.connected, true);
  assert.equal(negative.total, -1.25);
  assert.equal(negative.display, "¥-1.25");
});
