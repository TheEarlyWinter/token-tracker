import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiQuotaService } from "../lib/gemini-quota.mjs";

const CPA_BASE_URL = "https://cpa.example.invalid";
const CREDENTIALS_URL = `${CPA_BASE_URL}/v8/management/credentials`;
const API_CALL_URL = `${CPA_BASE_URL}/v8/management/requests/api-call`;
const QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gemini-quota-"));
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

function quotaPayload() {
  return {
    groups: [
      {
        displayName: "Gemini shared",
        buckets: [
          { bucketId: "daily", displayName: "Daily", remainingFraction: 0, resetTime: "2026-10-29T00:00:00Z" },
          { bucketId: "weekly", displayName: "Weekly", remainingFraction: "25%", resetTime: "not-a-time" },
          { bucketId: "invalid", displayName: "Invalid", remainingFraction: "not-a-number" },
        ],
      },
    ],
  };
}

async function configuredService(fetchFn, options = {}) {
  const dataDir = tempDir();
  const service = new GeminiQuotaService({ dataDir, fetchFn, ...options });
  const saved = await service.saveConfig({ action: "save", managementKey: "synthetic-management-key" });
  assert.equal(saved.ok, true);
  return { dataDir, service };
}

function cleanup(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

test("未配置时返回严格安全 DTO 且零出网", async () => {
  const dataDir = tempDir();
  let calls = 0;
  const service = new GeminiQuotaService({
    dataDir,
    fetchFn: async () => { calls++; throw new Error("network must not run"); },
  });
  try {
    assert.deepEqual(service.getConfig(), { configured: false, baseUrl: CPA_BASE_URL });
    assert.deepEqual(await service.getQuota(), {
      configured: false,
      connected: false,
      reason: "not_configured",
      updatedAt: null,
      accounts: [],
    });
    assert.equal(calls, 0);
  } finally {
    cleanup(dataDir);
  }
});

test("保存与清空只返回安全状态，文件权限固定为 0600 且 clear 不删除文件", async () => {
  const dataDir = tempDir();
  const service = new GeminiQuotaService({ dataDir, fetchFn: async () => response(200, {}) });
  const secret = "synthetic-management-key";
  try {
    const saved = await service.saveConfig({ action: "save", managementKey: secret });
    assert.equal(saved.ok, true);
    assert.equal(saved.configured, true);
    assert.equal(saved.baseUrl, CPA_BASE_URL);
    assert.doesNotMatch(JSON.stringify(saved), /synthetic-management-key/);

    const configPath = path.join(dataDir, "gemini-cpa.json");
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).managementKey, secret);
    assert.deepEqual(service.getConfig(), { configured: true, baseUrl: CPA_BASE_URL });

    const invalid = await service.saveConfig({ action: "save", managementKey: "" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "INVALID_INPUT");
    assert.doesNotMatch(JSON.stringify(invalid), /synthetic-management-key/);

    const cleared = await service.saveConfig({ action: "clear" });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.configured, false);
    assert.equal(fs.existsSync(configPath), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {});
    assert.deepEqual(service.getConfig(), { configured: false, baseUrl: CPA_BASE_URL });
  } finally {
    cleanup(dataDir);
  }
});

test("只选择 Antigravity，health 与 quotaStatus 分离，并保留 0、百分比和合法 resetTime", async () => {
  const files = [
    { provider: "antigravity", auth_index: 7, email: "alice@example.com", project_id: "project-alpha", status: "active" },
    { provider: "antigravity", auth_index: 8, email: "disabled@example.com", project_id: "project-disabled", disabled: true },
    { provider: "antigravity", auth_index: 9, email: "down@example.com", project_id: "project-down", status: "error" },
    { provider: "antigravity", auth_index: 10, email: "missing@example.com", status: "ready" },
    { provider: "codex", auth_index: 11, email: "codex@example.com", project_id: "codex-project", status: "active" },
  ];
  const calls = [];
  const { dataDir, service } = await configuredService(async (url, init) => {
    calls.push({ url, init });
    if (url === CREDENTIALS_URL) return response(200, { files });
    assert.equal(url, API_CALL_URL);
    const body = JSON.parse(init.body);
    assert.equal(body.method, "POST");
    return response(200, { status_code: 200, body: JSON.stringify(quotaPayload()) });
  });
  try {
    const dto = await service.getQuota();
    assert.equal(dto.configured, true);
    assert.equal(dto.connected, true);
    assert.equal(dto.reason, null);
    assert.equal(typeof dto.updatedAt, "number");
    assert.equal(dto.accounts.length, 4);

    const [alice, disabled, down, missing] = dto.accounts;
    assert.ok(alice && disabled && down && missing);
    assert.notEqual(alice.label, "alice@example.com");
    assert.equal(alice.health, "healthy");
    assert.equal(alice.quotaStatus, "ok");
    assert.equal(alice.groups[0].buckets[0].remainingFraction, 0);
    assert.equal(alice.groups[0].buckets[1].remainingFraction, 0.25);
    assert.equal(alice.groups[0].buckets[0].resetTime, "2026-10-29T00:00:00.000Z");
    assert.equal(alice.groups[0].buckets[1].resetTime, null);
    assert.equal(disabled.health, "disabled");
    assert.equal(disabled.quotaStatus, "not_checked");
    assert.equal(disabled.groups.length, 0);
    assert.equal(down.health, "unavailable");
    assert.equal(down.quotaStatus, "ok");
    assert.equal(missing.health, "healthy");
    assert.equal(missing.quotaStatus, "missing_project");

    const serialized = JSON.stringify(dto);
    for (const secret of ["synthetic-management-key", "project-alpha", "project-disabled", "project-down", "codex@example.com", "auth_index"]) {
      assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.equal(calls.filter((call) => call.url === CREDENTIALS_URL).length, 1);
    const quotaCalls = calls.filter((call) => call.url === API_CALL_URL);
    assert.equal(quotaCalls.length, 2);
    const requestBody = JSON.parse(quotaCalls[0].init.body);
    assert.equal(requestBody.auth_index, "7");
    assert.equal(requestBody.url, QUOTA_URLS[0]);
    assert.deepEqual(requestBody.header, {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
    });
    assert.equal(JSON.parse(requestBody.data).project, "project-alpha");
    assert.equal(quotaCalls[0].init.redirect, "error");
  } finally {
    cleanup(dataDir);
  }
});

test("quota 依次回退三条官方目标，外层和内层失败都只返回安全状态", async () => {
  let mode = "fallback";
  const calls = [];
  const { dataDir, service } = await configuredService(async (url, init) => {
    calls.push({ url, init });
    if (url === CREDENTIALS_URL) {
      return response(200, { files: [{ provider: "antigravity", auth_index: 1, email: "a@example.com", project_id: "p" }] });
    }
    if (mode === "fallback") {
      const quotaUrl = JSON.parse(init.body).url;
      if (quotaUrl === QUOTA_URLS[0]) return response(200, { status_code: 500, body: "upstream secret body" });
      return response(200, { status_code: 200, body: JSON.stringify(quotaPayload()) });
    }
    return response(200, { status_code: 403, body: JSON.stringify({ error: "private upstream detail" }) });
  });
  try {
    const fallback = await service.getQuota();
    assert.equal(fallback.accounts[0].quotaStatus, "ok");
    assert.deepEqual(calls.filter((call) => call.url === API_CALL_URL).map((call) => JSON.parse(call.init.body).url), [QUOTA_URLS[0], QUOTA_URLS[1]]);

    mode = "error";
    await service.saveConfig({ action: "save", managementKey: "synthetic-management-key-2" });
    const failed = await service.getQuota();
    assert.equal(failed.connected, true);
    assert.equal(failed.accounts[0].quotaStatus, "error");
    assert.doesNotMatch(JSON.stringify(failed), /private upstream detail|upstream secret body/);
  } finally {
    cleanup(dataDir);
  }
});

test("成功和失败共享 60 秒缓存，inflight 单飞，配置 epoch 不让旧结果回填", async () => {
  let now = 1000;
  let releaseCredentials;
  let releaseOld;
  let credentialCalls = 0;
  const files = [{ provider: "antigravity", auth_index: 1, email: "a@example.com", project_id: "p" }];
  const { dataDir, service } = await configuredService(async (url) => {
    if (url === CREDENTIALS_URL) {
      credentialCalls++;
      if (credentialCalls === 1) {
        return new Promise((resolve) => { releaseCredentials = () => resolve(response(200, { files })); });
      }
      if (credentialCalls === 3) {
        return new Promise((resolve) => { releaseOld = () => resolve(response(200, { files })); });
      }
      return response(200, { files });
    }
    return response(200, { status_code: 200, body: JSON.stringify(quotaPayload()) });
  }, { now: () => now, ttlMs: 60 });
  try {
    const first = service.getQuota();
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.getQuota();
    assert.equal(credentialCalls, 1);
    releaseCredentials();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.accounts.length, 1);
    assert.equal(secondResult.accounts.length, 1);

    now += 59;
    await service.getQuota();
    assert.equal(credentialCalls, 1);
    now += 2;
    await service.getQuota();
    assert.equal(credentialCalls, 2);

    now += 61;
    const oldResultPromise = service.getQuota();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(credentialCalls, 3);
    await service.saveConfig({ action: "clear" });
    releaseOld?.();
    const oldResult = await oldResultPromise;
    assert.equal(oldResult.configured, false);
    assert.equal(oldResult.accounts.length, 0);
  } finally {
    cleanup(dataDir);
  }
});

test("优先使用 network.fetch，fetchFn 回退时带 AbortSignal、redirect 和响应上限", async () => {
  const networkCalls = [];
  const networkServiceData = tempDir();
  const networkService = new GeminiQuotaService({
    dataDir: networkServiceData,
    fetchFn: async () => { throw new Error("fetchFn must not run when network exists"); },
    network: {
      async fetch(url, init) {
        networkCalls.push({ url, init });
        if (url === CREDENTIALS_URL) return response(200, { files: [] });
        return response(200, { status_code: 200, body: JSON.stringify({ groups: [] }) });
      },
    },
  });
  const fallbackCalls = [];
  const fallbackData = tempDir();
  const fallbackService = new GeminiQuotaService({
    dataDir: fallbackData,
    fetchFn: async (url, init) => {
      fallbackCalls.push({ url, init });
      if (url === CREDENTIALS_URL) return response(200, { files: [] });
      return response(200, { status_code: 200, body: JSON.stringify({ groups: [] }) });
    },
  });
  try {
    await networkService.saveConfig({ action: "save", managementKey: "network-key" });
    await networkService.getQuota();
    assert.ok(networkCalls.length > 0);
    assert.ok(networkCalls.every(({ init }) => init.redirect === "error" && init.maxResponseBytes === 1_048_576));
    assert.ok(networkCalls.every(({ init }) => init.timeoutMs <= 8_000));

    await fallbackService.saveConfig({ action: "save", managementKey: "fallback-key" });
    await fallbackService.getQuota();
    assert.ok(fallbackCalls.length > 0);
    assert.ok(fallbackCalls.every(({ init }) => init.signal instanceof AbortSignal));
  } finally {
    cleanup(networkServiceData);
    cleanup(fallbackData);
  }
});

test("整轮 deadline 包含慢 credentials，quota 只使用剩余预算", async () => {
  let quotaCalls = 0;
  const { dataDir, service } = await configuredService(async (url) => {
    if (url === CREDENTIALS_URL) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return response(200, { files: [{ provider: "antigravity", auth_index: 1, email: "slow@example.com", project_id: "slow-project", status: "ready" }] });
    }
    quotaCalls++;
    return new Promise(() => {});
  }, { timeoutMs: 80 });
  try {
    const startedAt = Date.now();
    const dto = await service.getQuota();
    assert.ok(Date.now() - startedAt < 250);
    assert.equal(quotaCalls, 1);
    assert.equal(dto.accounts[0].health, "healthy");
    assert.equal(dto.accounts[0].quotaStatus, "timeout");
  } finally {
    cleanup(dataDir);
  }
});

test("quota 在共享 deadline 截止时取消在途请求，并保留已完成账号结果", async () => {
  let quotaCalls = 0;
  let aborted = false;
  const files = [
    { provider: "antigravity", auth_index: 1, email: "fast@example.com", project_id: "fast-project", status: "ready" },
    { provider: "antigravity", auth_index: 2, email: "slow@example.com", project_id: "slow-project", status: "ready" },
  ];
  const { dataDir, service } = await configuredService(async (url, init) => {
    if (url === CREDENTIALS_URL) return response(200, { files });
    quotaCalls++;
    const body = JSON.parse(init.body);
    if (String(body.auth_index) === "1") return response(200, { status_code: 200, body: JSON.stringify(quotaPayload()) });
    init.signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(() => {});
  }, { timeoutMs: 50 });
  try {
    const dto = await service.getQuota();
    assert.equal(quotaCalls, 2);
    assert.equal(dto.accounts[0].quotaStatus, "ok");
    assert.equal(dto.accounts[1].quotaStatus, "timeout");
    assert.equal(aborted, true);
  } finally {
    cleanup(dataDir);
  }
});

test("同邮箱不同 auth_index 的账号 ID 不碰撞，且 auth_index 按 Go string 发出", async () => {
  const files = [
    { provider: "antigravity", auth_index: 0, email: "same@example.com", project_id: "project-zero" },
    { provider: "antigravity", auth_index: 1, email: "same@example.com", project_id: "project-one" },
  ];
  const requestBodies = [];
  const { dataDir, service } = await configuredService(async (url, init) => {
    if (url === CREDENTIALS_URL) return response(200, { files });
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    return response(200, { status_code: 200, body: JSON.stringify(quotaPayload()) });
  });
  try {
    const dto = await service.getQuota();
    assert.equal(dto.accounts.length, 2);
    assert.notEqual(dto.accounts[0].id, dto.accounts[1].id);
    assert.deepEqual(requestBodies.map((body) => body.auth_index).sort(), ["0", "1"]);
    assert.ok(requestBodies.every((body) => typeof body.auth_index === "string"));
  } finally {
    cleanup(dataDir);
  }
});

test("空百分数和非 ISO resetTime 不伪造额度或时间", async () => {
  const { dataDir, service } = await configuredService(async (url) => {
    if (url === CREDENTIALS_URL) {
      return response(200, { files: [{ provider: "antigravity", auth_index: "1", email: "a@example.com", project_id: "p" }] });
    }
    return response(200, {
      status_code: 200,
      body: JSON.stringify({
        groups: [{
          displayName: "Quota",
          buckets: [
            { bucketId: "empty", remainingFraction: "%", resetTime: "2026-10-29T00:00:00Z" },
            { bucketId: "bool", remainingFraction: "50%", resetTime: true },
            { bucketId: "object", remainingFraction: "25%", resetTime: {} },
            { bucketId: "valid", remainingFraction: 0, resetTime: "2026-10-29T00:00:00Z" },
          ],
        }],
      }),
    });
  });
  try {
    const buckets = (await service.getQuota()).accounts[0].groups[0].buckets;
    assert.deepEqual(buckets.map((bucket) => bucket.id), ["bool", "object", "valid"]);
    assert.equal(buckets[0].resetTime, null);
    assert.equal(buckets[1].resetTime, null);
    assert.equal(buckets[2].resetTime, "2026-10-29T00:00:00.000Z");
  } finally {
    cleanup(dataDir);
  }
});

test("credentials headers 已返回但 JSON body pending 时仍受总 deadline 限制", async () => {
  let aborted = false;
  const { dataDir, service } = await configuredService(async (url, init) => {
    assert.equal(url, CREDENTIALS_URL);
    init.signal.addEventListener("abort", () => { aborted = true; });
    return {
      status: 200,
      ok: true,
      async json() { return new Promise(() => {}); },
    };
  }, { timeoutMs: 40 });
  try {
    const hung = Symbol("hung");
    let guard;
    const result = await Promise.race([
      service.getQuota(),
      new Promise((resolve) => { guard = setTimeout(() => resolve(hung), 160); }),
    ]);
    clearTimeout(guard);
    assert.notEqual(result, hung);
    assert.equal(result.reason, "timeout");
    assert.equal(aborted, true);
  } finally {
    cleanup(dataDir);
  }
});

test("quota JSON body pending 时到总 deadline 返回 partial，并取消在途 signal", async () => {
  let aborted = false;
  const files = [
    { provider: "antigravity", auth_index: "1", email: "fast@example.com", project_id: "fast-project" },
    { provider: "antigravity", auth_index: "2", email: "slow@example.com", project_id: "slow-project" },
  ];
  const { dataDir, service } = await configuredService(async (url, init) => {
    if (url === CREDENTIALS_URL) return response(200, { files });
    const body = JSON.parse(init.body);
    if (String(body.auth_index) === "1") {
      return response(200, { status_code: 200, body: JSON.stringify(quotaPayload()) });
    }
    init.signal.addEventListener("abort", () => { aborted = true; });
    return {
      status: 200,
      ok: true,
      async json() { return new Promise(() => {}); },
    };
  }, { timeoutMs: 55 });
  try {
    const hung = Symbol("hung");
    let guard;
    const result = await Promise.race([
      service.getQuota(),
      new Promise((resolve) => { guard = setTimeout(() => resolve(hung), 180); }),
    ]);
    clearTimeout(guard);
    assert.notEqual(result, hung);
    assert.equal(result.connected, true);
    assert.equal(result.accounts[0].quotaStatus, "ok");
    assert.equal(result.accounts[1].quotaStatus, "timeout");
    assert.equal(aborted, true);
  } finally {
    cleanup(dataDir);
  }
});

test("管理 credentials 401/403 在 epoch 内暂停 TTL 后的轮询，重新保存恢复", async () => {
  let now = 1000;
  let unauthorized = true;
  let credentialCalls = 0;
  const { dataDir, service } = await configuredService(async (url) => {
    assert.equal(url, CREDENTIALS_URL);
    credentialCalls++;
    if (unauthorized) return response(401, { error: "private" });
    return response(200, { files: [] });
  }, { now: () => now, ttlMs: 10 });
  try {
    assert.equal((await service.getQuota()).reason, "unauthorized");
    now += 11;
    assert.equal((await service.getQuota()).reason, "unauthorized");
    assert.equal(credentialCalls, 1);

    unauthorized = false;
    assert.equal((await service.saveConfig({ action: "save", managementKey: "synthetic-management-key-2" })).ok, true);
    const recovered = await service.getQuota();
    assert.equal(recovered.reason, "no_accounts");
    assert.equal(credentialCalls, 2);
  } finally {
    cleanup(dataDir);
  }
});

test("内层 quota status 401 不暂停管理凭据，外层 api-call 401 短路 fallback 和新增账号", async () => {
  let now = 1000;
  let innerCalls = 0;
  const innerSetup = await configuredService(async (url) => {
    if (url === CREDENTIALS_URL) {
      return response(200, { files: [{ provider: "antigravity", auth_index: "1", email: "a@example.com", project_id: "p" }] });
    }
    innerCalls++;
    return response(200, { status_code: 401, body: JSON.stringify({ error: "account only" }) });
  }, { now: () => now, ttlMs: 10 });
  try {
    const first = await innerSetup.service.getQuota();
    assert.equal(first.reason, null);
    assert.equal(first.accounts[0].quotaStatus, "error");
    const callsAfterFirst = innerCalls;
    now += 11;
    const second = await innerSetup.service.getQuota();
    assert.equal(second.reason, null);
    assert.ok(innerCalls > callsAfterFirst);
  } finally {
    cleanup(innerSetup.dataDir);
  }

  let outerCalls = 0;
  const outerSetup = await configuredService(async (url) => {
    if (url === CREDENTIALS_URL) {
      return response(200, {
        files: [
          { provider: "antigravity", auth_index: "1", email: "a@example.com", project_id: "p1" },
          { provider: "antigravity", auth_index: "2", email: "b@example.com", project_id: "p2" },
        ],
      });
    }
    outerCalls++;
    return response(401, { error: "management key rejected" });
  });
  try {
    const failed = await outerSetup.service.getQuota();
    assert.equal(failed.reason, "unauthorized");
    assert.deepEqual(failed.accounts, []);
    assert.ok(outerCalls <= 2);
  } finally {
    cleanup(outerSetup.dataDir);
  }
});

test("旧 epoch 的管理失败不能暂停新配置", async () => {
  let releaseOld;
  let credentialCalls = 0;
  const { dataDir, service } = await configuredService(async (url) => {
    assert.equal(url, CREDENTIALS_URL);
    credentialCalls++;
    if (credentialCalls === 1) {
      return new Promise((resolve) => { releaseOld = () => resolve(response(401, {})); });
    }
    return response(200, { files: [] });
  });
  try {
    const oldResultPromise = service.getQuota();
    await new Promise((resolve) => setImmediate(resolve));
    await service.saveConfig({ action: "save", managementKey: "new-management-key" });
    const newResult = await service.getQuota();
    assert.equal(newResult.reason, "no_accounts");
    releaseOld();
    const oldResult = await oldResultPromise;
    assert.equal(oldResult.reason, "not_checked");
  } finally {
    cleanup(dataDir);
  }
});

test("最多三账号并发，预算耗尽后不新增请求且未取账号标 timeout", async () => {
  const files = Array.from({ length: 4 }, (_, index) => ({
    provider: "antigravity",
    auth_index: index,
    email: `a${index}@example.com`,
    project_id: `p${index}`,
  }));
  let quotaCalls = 0;
  const { dataDir, service } = await configuredService(async (url) => {
    if (url === CREDENTIALS_URL) return response(200, { files });
    quotaCalls++;
    return new Promise(() => {});
  }, { timeoutMs: 40 });
  try {
    const startedAt = Date.now();
    const dto = await service.getQuota();
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(quotaCalls, 3);
    assert.equal(dto.accounts.length, 4);
    assert.ok(dto.accounts.every((account) => account.quotaStatus === "timeout"));
  } finally {
    cleanup(dataDir);
  }
});
