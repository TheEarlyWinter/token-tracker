import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENCODE_USAGE_URL,
  normalizeOpenCodeCredentials,
  normalizeOpenCodeUsage,
  resolveOpenCodeCredentials,
  OpenCodeQuotaService,
} from "../lib/opencode-quota.mjs";

const NOW = Date.parse("2026-11-01T02:00:00Z");

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-og-" + tag + "-"));
}

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function happyPayload() {
  return {
    usage: {
      rolling: { percent: 25, resetsAt: "2026-11-01T05:00:00Z" },
      weekly: { percent: 62.5, resetsAt: "2026-11-04T00:00:00Z" },
      monthly: { percent: 80, resetsAt: "2026-11-16T12:00:00Z" },
    },
  };
}

test("凭据归一化：认 apiKey/api_key/access/Bearer 头，挡住控制台 Cookie", () => {
  assert.deepEqual(normalizeOpenCodeCredentials({ apiKey: "  oc_sk_abc  " }), { apiKey: "oc_sk_abc" });
  assert.deepEqual(normalizeOpenCodeCredentials({ api_key: "oc_sk_b" }), { apiKey: "oc_sk_b" });
  assert.deepEqual(normalizeOpenCodeCredentials({ access: "oc_sk_c" }), { apiKey: "oc_sk_c" });
  assert.deepEqual(
    normalizeOpenCodeCredentials({ headers: { Authorization: "Bearer oc_sk_d" } }),
    { apiKey: "oc_sk_d" }
  );
  // 控制台 Cookie 拿去请求只会 401，不该被当成 Key
  assert.equal(normalizeOpenCodeCredentials({ apiKey: "Fe26.2**deadbeef" }), null);
  assert.equal(normalizeOpenCodeCredentials({ apiKey: "a b" }), null);
  assert.equal(normalizeOpenCodeCredentials({ error: "forbidden" }), null);
  assert.equal(normalizeOpenCodeCredentials(null), null);
});

test("用量归一化：窗口齐全时算出已用/剩余与重置秒数", () => {
  const out = normalizeOpenCodeUsage(happyPayload(), { now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.windows.length, 3);
  const [rolling, weekly, monthly] = out.windows;
  assert.deepEqual(
    out.windows.map((w) => w.level),
    ["rolling", "weekly", "monthly"]
  );
  assert.equal(rolling.usedPercent, 25);
  assert.equal(rolling.remainingPercent, 75);
  assert.equal(rolling.resetInSec, 3 * 3600);
  assert.equal(weekly.usedPercent, 62.5);
  assert.equal(monthly.usedPercent, 80);
  assert.equal(monthly.resetsAt, "2026-11-16T12:00:00Z");
});

test("用量归一化：字符串百分比、越界钳到 0-100、used/limit 兜底也算得出来", () => {
  const asString = normalizeOpenCodeUsage({ usage: { rolling: { percent: "42.35" } } }, { now: NOW });
  assert.equal(asString.ok, true);
  assert.equal(asString.windows[0].usedPercent, 42.4);

  const clamped = normalizeOpenCodeUsage({ usage: { rolling: { percent: 180 }, weekly: { percent: -5 } } }, { now: NOW });
  assert.equal(clamped.windows[0].usedPercent, 100);
  assert.equal(clamped.windows[1].usedPercent, 0);

  const money = normalizeOpenCodeUsage({ usage: { monthly: { used: 15, limit: 60 } } }, { now: NOW });
  assert.equal(money.windows[2].usedPercent, 25);
});

test("用量归一化：缺窗口标 unknown，不给假 0；一个窗口都没有算结构变了", () => {
  const partial = normalizeOpenCodeUsage({ usage: { rolling: { percent: 10 } } }, { now: NOW });
  assert.equal(partial.ok, true);
  assert.equal(partial.windows[0].known, true);
  assert.equal(partial.windows[1].known, false);
  assert.equal(partial.windows[1].usedPercent, null);
  assert.equal(partial.windows[2].resetInSec, null);

  const broken = normalizeOpenCodeUsage({ usage: { somethingElse: {} } }, { now: NOW });
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "shape_changed");
});

test("用量归一化：也认上游 PR 那种 windows[] 形状，并带出官方美元 used/limit", () => {
  const out = normalizeOpenCodeUsage({
    plan: "Go (Lite)",
    useBalance: false,
    windows: [
      { name: "5-hour", status: "ok", usagePercent: 70, resetInSec: 8100, used: 8.42, limit: 12 },
      { name: "weekly", usagePercent: 61, resetInSec: 273600, used: 18.3, limit: 30 },
      { name: "monthly", usagePercent: 37, resetInSec: 1036800, used: 22.1, limit: 60 },
    ],
  }, { now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.plan, "Go (Lite)");
  const [rolling, weekly, monthly] = out.windows;
  assert.equal(rolling.level, "rolling");
  assert.equal(rolling.usedPercent, 70);
  assert.equal(rolling.resetInSec, 8100);
  assert.equal(rolling.usedUsd, 8.42);
  assert.equal(rolling.limitUsd, 12);
  assert.equal(weekly.level, "weekly");
  assert.equal(monthly.usedPercent, 37);
});

test("用量归一化：windows[] 里一个窗口名都认不出也算结构变了", () => {
  const out = normalizeOpenCodeUsage({ windows: [{ name: "daily", usagePercent: 10 }] }, { now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "shape_changed");
});

test("凭据解析：本设置页显式填的 Key 优先于宿主总线", async () => {
  const dir = tmpDir("cred");
  fs.writeFileSync(path.join(dir, "opencode-go.json"), JSON.stringify({ apiKey: "oc_sk_explicit" }));
  let busAsked = 0;
  const bus = {
    request: async () => {
      busAsked += 1;
      return { apiKey: "oc_sk_frombus" };
    },
  };
  const got = await resolveOpenCodeCredentials(bus, { dataDir: dir });
  assert.equal(got.apiKey, "oc_sk_explicit");
  assert.equal(got.source, "explicit");
  assert.equal(busAsked, 0);

  const busOnly = await resolveOpenCodeCredentials(bus, { dataDir: tmpDir("empty") });
  assert.equal(busOnly.apiKey, "oc_sk_frombus");
  assert.equal(busOnly.source, "bus");
  assert.equal(busOnly.providerId, "opencode-go");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("服务：200 时给出三个窗口，走 Bearer 打官方端点", async () => {
  const dir = tmpDir("ok");
  fs.writeFileSync(path.join(dir, "opencode-go.json"), JSON.stringify({ apiKey: "oc_sk_ok" }));
  const seen = [];
  const svc = new OpenCodeQuotaService({
    dataDir: dir,
    now: () => NOW,
    fetchFn: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(happyPayload());
    },
  });

  const quota = await svc.getQuota();
  assert.equal(quota.connected, true);
  assert.equal(quota.windows.length, 3);
  assert.equal(quota.windows[2].usedPercent, 80);
  assert.equal(seen[0].url, OPENCODE_USAGE_URL);
  assert.equal(seen[0].init.headers.Authorization, "Bearer oc_sk_ok");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("服务：401/403/404/429 分别给不同原因，不合并成一个失败", async () => {
  const dir = tmpDir("err");
  fs.writeFileSync(path.join(dir, "opencode-go.json"), JSON.stringify({ apiKey: "oc_sk_ok" }));
  const make = (status) => new OpenCodeQuotaService({
    dataDir: dir,
    now: () => NOW,
    fetchFn: async () => jsonResponse({ error: "x" }, status),
  });

  assert.equal((await make(401).getQuota()).reason, "unauthorized");
  assert.equal((await make(403).getQuota()).reason, "forbidden");
  assert.equal((await make(404).getQuota()).reason, "endpoint_missing");
  const limited = await make(429).getQuota();
  assert.equal(limited.reason, "rate_limited");
  assert.equal(limited.connected, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("服务：没配 Key 说未配置，网络异常不冒充零用量", async () => {
  const dir = tmpDir("nokey");
  const svc = new OpenCodeQuotaService({ dataDir: dir, now: () => NOW, bus: null, fetchFn: async () => jsonResponse({}) });
  const quota = await svc.getQuota();
  assert.equal(quota.connected, false);
  assert.equal(quota.reason, "not_configured");
  assert.deepEqual(quota.windows, []);

  fs.writeFileSync(path.join(dir, "opencode-go.json"), JSON.stringify({ apiKey: "oc_sk_x" }));
  const boom = new OpenCodeQuotaService({
    dataDir: dir,
    now: () => NOW,
    fetchFn: async () => { throw new Error("ECONNREFUSED"); },
  });
  const failed = await boom.getQuota();
  assert.equal(failed.connected, false);
  assert.equal(failed.reason, "network_error");
  assert.deepEqual(failed.windows, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("服务：60 秒缓存命中，force 能穿透", async () => {
  const dir = tmpDir("cache");
  fs.writeFileSync(path.join(dir, "opencode-go.json"), JSON.stringify({ apiKey: "oc_sk_ok" }));
  let calls = 0;
  const svc = new OpenCodeQuotaService({
    dataDir: dir,
    now: () => NOW,
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(happyPayload());
    },
  });
  await svc.getQuota();
  await svc.getQuota();
  assert.equal(calls, 1, "缓存内第二次不发请求");
  await svc.getQuota({ force: true });
  assert.equal(calls, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("路由：注册后 GET 能查、POST 能存能清", async () => {
  const dir = tmpDir("route");
  const registerRoutes = (await import("../server/dashboard.js")).default;
  const routes = {};
  const mockApp = {
    get: (p, fn) => { routes["GET " + p] = fn; },
    post: (p, fn) => { routes["POST " + p] = fn; },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(happyPayload());
  const quiet = () => {};
  registerRoutes(mockApp, {
    _tokenCache: { ready: true, dataDir: dir, data: { sessions: {} } },
    dataDir: dir,
    bus: { request: async () => { throw new Error("nope"); } },
    log: { info: quiet, warn: quiet, error: quiet, debug: quiet },
  });

  assert.equal(typeof routes["GET /opencode-quota"], "function", "路由应已注册");
  assert.equal(typeof routes["POST /opencode-quota/config"], "function");

  const status = await routes["GET /opencode-quota"]({
    req: { query: () => "" },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  assert.equal(status.body.connected, false);
  assert.equal(status.body.reason, "not_configured");

  const saved = await routes["POST /opencode-quota/config"]({
    req: { json: async () => ({ apiKey: "oc_sk_route" }) },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.quota.connected, true, "存完当场验活");
  assert.equal(saved.body.quota.windows.length, 3);

  const cleared = await routes["POST /opencode-quota/config"]({
    req: { json: async () => ({ action: "clear" }) },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  assert.equal(cleared.body.configured, false);

  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("服务：保存 Key 落 0600，Cookie 与空值被拒，清空后回到未配置", async () => {
  const dir = tmpDir("save");
  const svc = new OpenCodeQuotaService({ dataDir: dir, now: () => NOW });

  const bad = await svc.saveApiKey("Fe26.2**abc");
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "INVALID_KEY");

  const empty = await svc.saveApiKey("   ");
  assert.equal(empty.ok, false);

  const saved = await svc.saveApiKey("oc_sk_saved");
  assert.equal(saved.ok, true);
  assert.equal(svc.describeConfig().configured, true);
  const file = path.join(dir, "opencode-go.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).apiKey, "oc_sk_saved");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }

  const cleared = await svc.clearApiKey();
  assert.equal(cleared.ok, true);
  assert.equal(svc.describeConfig().configured, false);
  assert.equal((await svc.getQuota()).reason, "not_configured");
  fs.rmSync(dir, { recursive: true, force: true });
});
