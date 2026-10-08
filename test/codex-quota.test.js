import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCodexCredentials,
  resolveCodexCredentials,
  sanitizeCodexUsage,
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
