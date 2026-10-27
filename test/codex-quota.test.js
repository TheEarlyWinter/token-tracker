import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCodexCredentials,
  resolveCodexCredentials,
  sanitizeCodexUsage,
  parseResetCredit,
  CodexQuotaService,
} from "../lib/codex-quota.mjs";

test("normalizeCodexCredentials extracts bearer token and accountId correctly", () => {
  assert.equal(normalizeCodexCredentials(null), null);
  assert.equal(normalizeCodexCredentials({ error: "denied" }), null);

  const cred1 = normalizeCodexCredentials({ apiKey: "tok_123", accountId: "acc_456" });
  assert.deepEqual(cred1, { apiKey: "tok_123", accountId: "acc_456" });

  const cred2 = normalizeCodexCredentials({
    headers: { Authorization: "Bearer tok_bearer" },
    account_id: "acc_789",
  });
  assert.deepEqual(cred2, { apiKey: "tok_bearer", accountId: "acc_789" });
});

test("resolveCodexCredentials gracefully returns null when bus refuses or errors", async () => {
  const mockBusReject = {
    request: async () => {
      throw new Error("not allowed");
    },
  };
  const result = await resolveCodexCredentials(mockBusReject);
  assert.equal(result, null);
});

test("resolveCodexCredentials tries oauth provider first then falls back to openai-codex", async () => {
  const seen = [];
  const mockBus = {
    request: async (type, payload) => {
      seen.push(payload.providerId);
      if (payload.providerId === "openai-codex") {
        return { apiKey: "key_codex" };
      }
      return { error: "none" };
    },
  };
  const creds = await resolveCodexCredentials(mockBus);
  assert.deepEqual(seen, ["openai-codex-oauth", "openai-codex"]);
  assert.equal(creds?.apiKey, "key_codex");
});

test("sanitizeCodexUsage processes wham/usage rate limits and windows cleanly", () => {
  const sample = {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 20,
        limit_window_seconds: 18000,
        reset_after_seconds: 10280,
        reset_at: 1791440545,
      },
      secondary_window: {
        used_percent: 31,
        limit_window_seconds: 604800,
        reset_after_seconds: 518332,
        reset_at: 1791948597,
      },
    },
    rate_limit_reset_credits: {
      available_count: 3,
    },
    credits: {
      has_credits: true,
      balance: "$5.00",
    },
  };

  const clean = sanitizeCodexUsage(sample);
  assert.equal(clean.connected, true);
  assert.equal(clean.planType, "plus");
  assert.equal(clean.planLabel, "Plus");
  assert.equal(clean.primary.usedPercent, 20);
  assert.equal(clean.primary.remainingPercent, 80);
  assert.equal(clean.primary.resetAfterSeconds, 10280);
  assert.equal(clean.secondary.usedPercent, 31);
  assert.equal(clean.secondary.remainingPercent, 69);
  assert.equal(clean.resetCredits, 3);
  assert.equal(clean.creditsBalance, "$5.00");
  assert.equal(clean.hasCredits, true);
});

test("CodexQuotaService uses in-memory cache and prevents redundant fetching", async () => {
  let fetchCount = 0;
  const mockBus = {
    request: async () => ({ apiKey: "valid_key", accountId: "acc_1" }),
  };
  const mockFetch = async () => {
    fetchCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 50 },
        },
      }),
    };
  };

  const service = new CodexQuotaService({
    bus: mockBus,
    fetchFn: mockFetch,
    ttlMs: 5000,
  });

  const res1 = await service.getQuota();
  const res2 = await service.getQuota();

  assert.equal(fetchCount, 1, "两次调用在 TTL 周期内只发起一次网络请求");
  assert.equal(res1.planLabel, "Pro");
  assert.equal(res2.planLabel, "Pro");
});

test("CodexQuotaService handles 401 gracefully with quiet message", async () => {
  const mockBus = {
    request: async () => ({ apiKey: "expired_key" }),
  };
  const mockFetch = async () => ({
    ok: false,
    status: 401,
  });

  const service = new CodexQuotaService({
    bus: mockBus,
    fetchFn: mockFetch,
  });

  const res = await service.getQuota();
  assert.equal(res.connected, false);
  assert.equal(res.reason, "unauthorized");
  assert.match(res.message, /失效/);
});

test("parseResetCredit parses and normalizes credit fields cleanly", () => {
  assert.equal(parseResetCredit(null), null);
  assert.equal(parseResetCredit({}), null);

  const parsed = parseResetCredit({
    id: "credit_123",
    reset_type: "codex_rate_limits",
    status: "available",
    granted_at: "2026-06-01T00:00:00Z",
    expires_at: "2026-09-01T00:00:00Z",
    title: "限额重置卡 1",
    description: "立即重置速率限制",
  });
  assert.equal(parsed.id, "credit_123");
  assert.equal(parsed.status, "available");
  assert.equal(parsed.expiresAt, "2026-09-01T00:00:00Z");
  assert.equal(parsed.title, "限额重置卡 1");
});

test("CodexQuotaService getResetCredits and consumeResetCredit work with cache busting", async () => {
  let postBody = null;
  const mockBus = {
    request: async () => ({ apiKey: "valid_key", accountId: "acc_test" }),
  };
  const mockFetch = async (url, init) => {
    if (init?.method === "POST") {
      postBody = JSON.parse(init.body);
      if (postBody.credit_id === "credit_already_spent") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ code: "already_redeemed" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "reset" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        credits: [
          { id: "credit_1", status: "available", expires_at: "2026-11-01T00:00:00Z", title: "月度重置卡" },
          { id: "credit_2", status: "redeemed", title: "已用卡" },
        ],
        available_count: 1,
      }),
    };
  };

  const service = new CodexQuotaService({
    bus: mockBus,
    fetchFn: mockFetch,
    ttlMs: 5000,
  });

  const list = await service.getResetCredits();
  assert.equal(list.connected, true);
  assert.equal(list.availableCount, 1);
  assert.equal(list.credits.length, 2);
  assert.equal(list.credits[0].id, "credit_1");

  // 失败分支（已核销）
  const failRes = await service.consumeResetCredit({ creditId: "credit_already_spent" });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.code, "already_redeemed");
  assert.match(failRes.message, /使用过/);

  // 成功分支
  const succRes = await service.consumeResetCredit({ creditId: "credit_1" });
  assert.equal(succRes.ok, true);
  assert.equal(succRes.code, "reset");
  assert.match(succRes.message, /成功/);
  assert.equal(postBody.credit_id, "credit_1");
  assert.equal(postBody.account_id, "acc_test");
  assert.ok(postBody.redeem_request_id, "包含幂等请求 UUID");
});
