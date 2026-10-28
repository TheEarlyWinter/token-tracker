import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import registerRoutes from "../server/dashboard.js";

// 一个可控的路由壳：只记 GET/POST，不依赖宿主。
function createMockApp() {
  const routes = { GET: {}, POST: {} };
  return {
    routes,
    get(route, handler) { routes.GET[route] = handler; },
    post(route, handler) { routes.POST[route] = handler; },
    async dispatch(method, route, query = {}) {
      const handler = routes[method][route];
      assert.equal(typeof handler, "function", `${method} ${route} must be registered`);
      let result;
      const context = {
        req: { query: (key) => (key ? query[key] : query), json: async () => ({}) },
        json: (payload, status = 200) => {
          result = { status, body: payload };
          return result;
        },
      };
      await handler(context);
      return result;
    },
  };
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, async json() { return body; } };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lithos-reconcile-"));
}

// 直接建 turns 表并塞数据：这是对账的输入侧，必须是真的 SQLite，不能用假对象代替。
function seedTurns(dataDir, rows) {
  const file = path.join(dataDir, "cache.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS turns (
    session_key TEXT NOT NULL, seq INTEGER NOT NULL,
    at TEXT NOT NULL, day TEXT NOT NULL,
    agent TEXT NOT NULL, type TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL,
    total INTEGER NOT NULL, input INTEGER, output INTEGER,
    cache_read INTEGER, calls INTEGER, request_id TEXT,
    PRIMARY KEY (session_key, seq))`);
  const stmt = db.prepare(
    "INSERT INTO turns (session_key, seq, at, day, agent, type, provider, model, total, input, output, cache_read, calls, request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  rows.forEach((r, i) => {
    stmt.run("s" + i, i, r.at, r.day, "hanako", "desktop", r.provider, r.model, r.total, r.input, r.output, r.cacheRead, r.calls, null);
  });
  db.close();
}

function writeCookie(dataDir) {
  fs.writeFileSync(
    path.join(dataDir, "lithos-console.json"),
    JSON.stringify({ cookie: "__Host-console_session=testsession; __Host-console_csrf=testcsrf", savedAt: new Date().toISOString() }),
    { mode: 0o600 }
  );
}

function ctxWith(dataDir, handler) {
  return {
    dataDir,
    _tokenCache: {},
    network: {
      async fetch(url, init) {
        return handler(url, init);
      },
    },
  };
}

const SPEND_URL_PREFIX = "https://console.lithosai.cloud/api/billing/spend";

test("没配 Cookie 时对账接口说 not_configured，而不是报错或给 0", async () => {
  const dataDir = tempDir();
  const app = createMockApp();
  registerRoutes(app, ctxWith(dataDir, async () => response(500, {})));
  try {
    assert.equal(typeof app.routes.GET["/dashboard/lithos-reconcile"], "function");
    assert.equal(typeof app.routes.GET["/lithos-reconcile"], "function");
    const res = await app.dispatch("GET", "/lithos-reconcile");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, "not_configured");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("区间非法或跨度过大时直接拒，不去打官方接口", async () => {
  const dataDir = tempDir();
  writeCookie(dataDir);
  let called = 0;
  const app = createMockApp();
  registerRoutes(app, ctxWith(dataDir, async () => { called += 1; return response(200, {}); }));
  try {
    const bad = await app.dispatch("GET", "/lithos-reconcile", { start: "2026/10/01", end: "2026-10-28" });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.code, "invalid_range");

    const tooLong = await app.dispatch("GET", "/lithos-reconcile", { start: "2026-01-01", end: "2026-10-28" });
    assert.equal(tooLong.body.code, "invalid_range");
    assert.equal(called, 0, "参数不合法不该发网络请求");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("对账路由把官方扣费与本地估算对上，并对缺价模型给 null", async () => {
  const dataDir = tempDir();
  writeCookie(dataDir);
  // 本地：一条有价模型、一条没有价目表条目；再一条属于别的渠道（不该进对账）。
  seedTurns(dataDir, [
    { at: "2026-10-27T23:30:00.000Z", day: "2026-10-28", provider: "deepseek", model: "m1", total: 1000, input: 1000, output: 0, cacheRead: 0, calls: 1 },
    { at: "2026-10-27T10:00:00.000Z", day: "2026-10-27", provider: "deepseek", model: "m2", total: 500, input: 0, output: 0, cacheRead: 500, calls: 1 },
    { at: "2026-10-27T10:00:00.000Z", day: "2026-10-27", provider: "openai-codex", model: "gpt-x", total: 999, input: 999, output: 0, cacheRead: 0, calls: 1 },
  ]);

  const app = createMockApp();
  registerRoutes(app, ctxWith(dataDir, async (url) => {
    if (url.endsWith("/api/me")) {
      return response(200, { activeOrganization: { id: "org_test", name: "测试组织" }, user: { email: "t@example.com" } });
    }
    if (url.startsWith(SPEND_URL_PREFIX)) {
      return response(200, {
        start: "2026-10-27",
        end: "2026-10-28",
        days: [
          { day: "2026-10-27", modelId: "m1", apiKeyId: "k1", nanos: 1_000_000_000, inputTokens: 1000, cachedTokens: 0, outputTokens: 0 },
          { day: "2026-10-27", modelId: "m2", apiKeyId: "k1", nanos: 200_000_000, inputTokens: 0, cachedTokens: 500, outputTokens: 0 },
        ],
      });
    }
    throw new Error("unexpected url " + url);
  }));

  try {
    const res = await app.dispatch("GET", "/lithos-reconcile", { start: "2026-10-27", end: "2026-10-28" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.range, { start: "2026-10-27", end: "2026-10-28", dayCount: 2 });
    assert.equal(res.body.currency, "USD");

    // 默认价目表没有 deepseek/m1，所以两者都缺价：估算必须是 null，合计也必须是 null。
    assert.equal(res.body.totals.officialUsd, 1.2);
    assert.equal(res.body.totals.estimateUsd, null);
    assert.deepEqual(res.body.totals.missingPriceModels.sort(), ["m1", "m2"]);
    for (const row of res.body.rows) {
      assert.equal(row.estimateUsd, null);
      assert.equal(row.status, "missing_price");
    }
    // 其他渠道的调用不进对账范围，只在 scope 里报个数。
    assert.equal(res.body.scope.excludedBuckets, 1);
    assert.deepEqual(res.body.scope.providers, ["deepseek"]);
    assert.equal(res.body.scannedTurns, 3);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("官方接口 401 时如实报会话过期，不拿旧数硬撑", async () => {
  const dataDir = tempDir();
  writeCookie(dataDir);
  const app = createMockApp();
  registerRoutes(app, ctxWith(dataDir, async (url) => {
    if (url.endsWith("/api/me")) return response(401, { error: "unauthorized" });
    return response(401, {});
  }));
  try {
    const res = await app.dispatch("GET", "/lithos-reconcile", { start: "2026-10-27", end: "2026-10-28" });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, "session_expired");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
