// LithosAI 余额：公开 API 没有余额端点，只能走控制台会话（两个 cookie + 组织头 + csrf 回显）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LithosBalanceService, parseConsoleCookie, formatUsdFromNanos, looseCookieValues } from "../lib/lithos-balance.mjs";
import registerRoutes from "../server/dashboard.js";

const SESSION = "__Host-console_session=abc123";
const CSRF = "__Host-console_csrf=xyz789";

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test("Cookie 解析：整行请求头、缺项、多余项", () => {
  const ok = parseConsoleCookie(`Cookie: ${SESSION}; ${CSRF}; theme=dark`);
  assert.equal(ok.ok, true);
  // 只发这两个，别的 cookie 不带出去
  assert.equal(ok.cookie, `${SESSION}; ${CSRF}`);
  assert.equal(ok.csrf, "xyz789");

  const noPrefix = parseConsoleCookie(`${SESSION}; ${CSRF}`);
  assert.equal(noPrefix.ok, true);

  const missingCsrf = parseConsoleCookie(SESSION);
  assert.equal(missingCsrf.ok, false);
  assert.equal(missingCsrf.code, "MISSING_COOKIE");
  assert.deepEqual(missingCsrf.missing, ["__Host-console_csrf"]);

  assert.equal(parseConsoleCookie("").code, "EMPTY");
  assert.equal(parseConsoleCookie(null).code, "EMPTY");
});

test("纳美元换算：小于一分钱不四舍五入成 $0.00", () => {
  assert.deepEqual(formatUsdFromNanos(2_570_000_000), { usd: 2.57, display: "$2.57" });
  assert.deepEqual(formatUsdFromNanos(0), { usd: 0, display: "$0.00" });
  assert.deepEqual(formatUsdFromNanos(-1_500_000_000), { usd: -1.5, display: "-$1.50" });
  assert.deepEqual(formatUsdFromNanos(3_000_000), { usd: 0.003, display: "低于 $0.01" });
  assert.deepEqual(formatUsdFromNanos(-3_000_000), { usd: -0.003, display: "-低于 $0.01" });
  assert.equal(formatUsdFromNanos(undefined).usd, null);
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-lithos-"));
}

function service(dir, calls, fetchImpl) {
  return new LithosBalanceService({
    dataDir: dir,
    fetchFn: async (url, opts) => {
      calls.push({ url, headers: opts?.headers || {} });
      return fetchImpl(url, opts);
    },
  });
}

test("没配 Cookie 时不发请求，如实报未配置", async () => {
  const dir = tmpDir();
  const calls = [];
  const svc = service(dir, calls, () => jsonResponse(500, {}));
  const res = await svc.getBalance();
  assert.equal(res.connected, false);
  assert.equal(res.configured, false);
  assert.equal(res.reason, "not_configured");
  assert.equal(calls.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("正常路径：/api/me 拿组织，/api/billing 带组织头与 csrf 回显", async () => {
  const dir = tmpDir();
  const calls = [];
  const svc = service(dir, calls, (url) => {
    if (url.endsWith("/api/me")) {
      // 真实响应里活动组织叫 activeOrganization
      return jsonResponse(200, { user: { email: "me@example.com" }, activeOrganization: { id: "org_1", name: "示例组织" } });
    }
    if (url.endsWith("/api/billing")) {
      return jsonResponse(200, { balanceNanos: 12_340_000_000, hasCard: true, onHold: false });
    }
    return jsonResponse(404, {});
  });
  assert.equal(svc.saveCookie(`${SESSION}; ${CSRF}`).ok, true);

  const res = await svc.getBalance();
  assert.equal(res.connected, true);
  assert.equal(res.balance, 12.34);
  assert.equal(res.display, "$12.34");
  assert.equal(res.currency, "USD");
  assert.equal(res.hasCard, true);
  assert.equal(res.onHold, false);
  assert.equal(res.organization.name, "示例组织");
  assert.equal(res.account, "me@example.com");

  const billing = calls.find((c) => c.url.endsWith("/api/billing"));
  assert.equal(billing.headers["x-organization-id"], "org_1", "必须把活动组织打成 X-Organization-Id");
  assert.equal(billing.headers["x-console-csrf"], "xyz789", "csrf 要回显");
  assert.equal(billing.headers.cookie, `${SESSION}; ${CSRF}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("401 报会话过期，不静默沿用旧数", async () => {
  const dir = tmpDir();
  const calls = [];
  const svc = service(dir, calls, () => jsonResponse(401, { error: "unauthenticated" }));
  svc.saveCookie(`${SESSION}; ${CSRF}`);
  const res = await svc.getBalance();
  assert.equal(res.connected, false);
  assert.equal(res.configured, true);
  assert.equal(res.reason, "session_expired");
  assert.match(res.message, /重新登录|过期/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("账单接口 403 与网络异常都给明确原因", async () => {
  const dir = tmpDir();
  const calls = [];
  const forbidden = service(dir, calls, (url) =>
    url.endsWith("/api/me")
      ? jsonResponse(200, { organization: { id: "o" } })
      : jsonResponse(403, { error: "forbidden" })
  );
  forbidden.saveCookie(`${SESSION}; ${CSRF}`);
  const f = await forbidden.getBalance();
  assert.equal(f.connected, false);
  assert.equal(f.reason, "http_403");

  const dir2 = tmpDir();
  const broken = service(dir2, [], () => {
    throw new Error("ECONNREFUSED");
  });
  broken.saveCookie(`${SESSION}; ${CSRF}`);
  const b = await broken.getBalance();
  assert.equal(b.connected, false);
  assert.equal(b.reason, "network");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test("缓存 60 秒，force 能穿透", async () => {
  const dir = tmpDir();
  const calls = [];
  const svc = service(dir, calls, (url) =>
    url.endsWith("/api/me")
      ? jsonResponse(200, { organization: { id: "o" } })
      : jsonResponse(200, { balanceNanos: 1_000_000_000 })
  );
  svc.saveCookie(`${SESSION}; ${CSRF}`);
  await svc.getBalance();
  const afterFirst = calls.length;
  await svc.getBalance();
  assert.equal(calls.length, afterFirst, "第二次走缓存，不再出网");
  await svc.getBalance({ force: true });
  assert.equal(calls.length, afterFirst + 2, "force 重新查 me + billing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Cookie 落盘 0600，清空后回到未配置", async () => {
  const dir = tmpDir();
  const svc = service(dir, [], () => jsonResponse(200, {}));
  svc.saveCookie(`${SESSION}; ${CSRF}`);
  const file = path.join(dir, "lithos-console.json");
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, "登录态文件只给自己读");
  assert.equal(svc.configured(), true);
  svc.clearCookie();
  assert.equal(svc.configured(), false);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("路由：保存 Cookie 后立刻返回余额，缺项给 400", async () => {
  const dir = tmpDir();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/api/me")
      ? jsonResponse(200, { organization: { id: "org_9", name: "测试组织" } })
      : jsonResponse(200, { balanceNanos: 2_500_000_000, hasCard: false, onHold: false });

  const routes = {};
  const mockApp = { get: (p, fn) => { routes["GET " + p] = fn; }, post: (p, fn) => { routes["POST " + p] = fn; } };
  registerRoutes(mockApp, { _tokenCache: { ready: true, dataDir: dir, data: { sessions: {} } }, dataDir: dir, bus: { request: async () => ({}) } });

  const before = await routes["GET /lithos-balance"]({ req: { query: () => "" }, json: (body, status = 200) => ({ body, status }) });
  assert.equal(before.body.configured, false);

  const saved = await routes["POST /lithos-balance"]({
    req: { query: () => "", json: async () => ({ cookie: `${SESSION}; ${CSRF}` }) },
    json: (body, status = 200) => ({ body, status }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.balance.connected, true);
  assert.equal(saved.body.balance.display, "$2.50");

  const rejected = await routes["POST /lithos-balance"]({
    req: { query: () => "", json: async () => ({ cookie: "foo=bar" }) },
    json: (body, status = 200) => ({ body, status }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "MISSING_COOKIE");

  const cleared = await routes["POST /lithos-balance"]({
    req: { query: () => "", json: async () => ({ action: "clear" }) },
    json: (body, status = 200) => ({ body, status }),
  });
  assert.equal(cleared.body.configured, false);
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});


test("真实响应形状：activeOrganization 也能认出组织", async () => {
  const dir = tmpDir();
  const calls = [];
  const svc = service(dir, calls, (url) =>
    url.endsWith("/api/me")
      ? jsonResponse(200, { activeOrganization: { id: "org_example", name: "示例组织" }, user: { email: "a@b.c" } })
      : jsonResponse(200, { balanceNanos: 21_938_009_158, billed: true, hasCard: false, onHold: false, publishableKey: "pk_live_secret" })
  );
  svc.saveCookie(`${SESSION}; ${CSRF}`);
  const res = await svc.getBalance();
  assert.equal(res.connected, true);
  assert.equal(res.display, "$21.94");
  assert.equal(res.organization.id, "org_example");
  // 账单响应里的敏感字段不往外带
  assert.equal(res.publishableKey, undefined);
  assert.equal(res.recaptchaSiteKey, undefined);
  const billing = calls.find((c) => c.url.endsWith("/api/billing"));
  assert.equal(billing.headers["x-organization-id"], "org_example");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("只贴两串裸值时按实测认序，不靠猜", () => {
  assert.deepEqual(looseCookieValues("AAA BBB"), ["AAA", "BBB"]);
  assert.deepEqual(looseCookieValues("AAA\nBBB"), ["AAA", "BBB"]);
  assert.equal(looseCookieValues("__Host-console_session=AAA; __Host-console_csrf=BBB"), null, "带名字的走严格解析");
  assert.equal(looseCookieValues("AAA BBB CCC"), null, "三串无法判定");
  assert.equal(looseCookieValues("AAA AAA"), null, "同一串两份没意义");
});

test("裸值认序：第一种顺序被拒就用第二种", async () => {
  const dir = tmpDir();
  const seen = [];
  const SESSION_VAL = "session-value", CSRF_VAL = "csrf-value";
  const svc = service(dir, seen, (url, opts) => {
    const cookie = opts.headers.cookie || "";
    // 只有 session=session-value 才认
    if (String(url).endsWith("/api/me")) {
      return cookie.includes(`__Host-console_session=${SESSION_VAL}`)
        ? jsonResponse(200, { activeOrganization: { id: "o1" } })
        : jsonResponse(401, { error: "unauthenticated" });
    }
    return jsonResponse(200, { balanceNanos: 1_000_000_000 });
  });

  // 用户把 csrf 放前面了
  const resolved = await svc.resolveLooseCookie([CSRF_VAL, SESSION_VAL]);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.order, "ba", "第二次尝试才通");
  assert.equal(svc.saveCookie(resolved.cookie).ok, true);
  assert.equal(seen.length, 2, "两种顺序各认一次");

  const bad = await svc.resolveLooseCookie(["x", "y"]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "AUTH_FAILED");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("出网走宿主的 network 桥（App 沙箱里 globalThis.fetch 会被挡）", async () => {
  const dir = tmpDir();
  const bridged = [];
  const svc = new LithosBalanceService({
    dataDir: dir,
    // 主进程里的 fetch：沙箱会直接抛 fetch failed
    fetchFn: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); },
    network: {
      fetch: async (url, opts) => {
        bridged.push({ url, cookie: opts.headers.cookie });
        return String(url).endsWith("/api/me")
          ? jsonResponse(200, { activeOrganization: { id: "o-bridge" } })
          : jsonResponse(200, { balanceNanos: 5_000_000_000 });
      },
    },
  });
  svc.saveCookie(`${SESSION}; ${CSRF}`);
  const res = await svc.getBalance();
  assert.equal(res.connected, true, "走桥就该成功，不能落到被沙箱挡掉的 fetch 上");
  assert.equal(res.display, "$5.00");
  assert.equal(bridged.length, 2);
  assert.match(bridged[0].cookie, /__Host-console_session=/, "cookie 要经桥发出去");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("卡面只标影响当下使用的状态：冻结要标，未绑卡不标", async () => {
  const src = fs.readFileSync(new URL("../ui/modules/lithos-card.js", import.meta.url), "utf8");
  assert.match(src, /onHold/, "冻结要继续提示");
  // 只断言卡面输出里没有这个标签（注释里解释「为什么不放」不算）
  assert.doesNotMatch(src, />未绑卡</, "未绑卡不挂在卡面上");
});

test("消费接口归一化：按天/按模型聚合，纳美元换算正确", async () => {
  const { normalizeSpend, monthToDateUtc } = await import("../lib/lithos-balance.mjs");
  const body = {
    days: [
      { day: "2026-10-24", modelId: "deepseek-ai/DeepSeek-V4.1-Flash", nanos: 231099432, inputTokens: 29645884, cachedTokens: 29337344, outputTokens: 161344 },
      { day: "2026-10-25", modelId: "deepseek-ai/DeepSeek-V4.1-Flash", nanos: 1070392236, inputTokens: 128218382, cachedTokens: 126701312, outputTokens: 771213 },
      { day: "2026-10-25", modelId: "moonshotai/Kimi-K3", nanos: 100000000, inputTokens: 1000, cachedTokens: 0, outputTokens: 200 },
      { day: "2026-10-25", modelId: "moonshotai/Kimi-K3", nanos: 50000000, inputTokens: 500, cachedTokens: 0, outputTokens: 100 },
    ],
  };
  const res = normalizeSpend(body, { start: "2026-10-01", end: "2026-10-27" });
  assert.equal(res.connected, true);
  assert.equal(res.totalNanos, 1451491668);
  assert.equal(res.totalUsd.toFixed(4), "1.4515");
  assert.equal(res.days.length, 2, "两天");
  assert.equal(res.days[0].day, "2026-10-24");
  assert.equal(res.days[1].byModel["moonshotai/Kimi-K3"].toFixed(2), "0.15", "同日同模型两个 key 要并起来");
  assert.equal(res.models.length, 2);
  assert.equal(res.models[0].modelId, "deepseek-ai/DeepSeek-V4.1-Flash", "按金额降序");
  assert.equal(res.models[0].days, 2);
  assert.equal(res.models[1].days, 1, "同一天多条只算一天");
  assert.ok(Math.abs(res.models.reduce((a, m) => a + m.share, 0) - 1) < 1e-9, "占比合计为 1");

  const m = monthToDateUtc(new Date("2026-10-27T08:00:00Z"));
  assert.deepEqual(m, { start: "2026-10-01", end: "2026-10-27" });
});

test("消费接口失败路径与余额一致：401 / 未配置 / 区间不合法", async () => {
  const dir = tmpDir();
  const svc = service(dir, [], () => jsonResponse(401, { error: "unauthenticated" }));
  const notConfigured = await svc.getSpend({ start: "2026-10-01", end: "2026-10-27" });
  assert.equal(notConfigured.reason, "not_configured");

  svc.saveCookie(`${SESSION}; ${CSRF}`);
  const expired = await svc.getSpend({ start: "2026-10-01", end: "2026-10-27" });
  assert.equal(expired.connected, false);
  assert.equal(expired.reason, "session_expired");

  const bad = await svc.getSpend({ start: "10/01", end: "2026-10-27" });
  assert.equal(bad.reason, "bad_range");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("路由 /lithos-spend 默认本月至今，并把区间透给控制台", async () => {
  const dir = tmpDir();
  const seenUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    if (String(url).endsWith("/api/me")) return jsonResponse(200, { activeOrganization: { id: "org_x" } });
    if (String(url).includes("/api/billing/spend")) {
      return jsonResponse(200, { days: [{ day: "2026-10-26", modelId: "m", nanos: 400000000 }] });
    }
    return jsonResponse(404, {});
  };
  const routes = {};
  const mockApp = { get: (p, fn) => { routes["GET " + p] = fn; }, post: (p, fn) => { routes["POST " + p] = fn; } };
  registerRoutes(mockApp, { _tokenCache: { ready: true, dataDir: dir, data: { sessions: {} } }, dataDir: dir, bus: { request: async () => ({}) } });
  const saved = await routes["POST /lithos-balance"]({
    req: { query: () => "", json: async () => ({ cookie: `${SESSION}; ${CSRF}` }) },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  assert.equal(saved.body.ok, true);

  const res = await routes["GET /lithos-spend"]({ req: { query: () => "" }, json: (b, s = 200) => ({ body: b, status: s }) });
  assert.equal(res.body.connected, true);
  assert.equal(res.body.totalDisplay, "$0.40");
  const spendUrl = seenUrls.find((u) => u.includes("/api/billing/spend"));
  assert.match(spendUrl, /start=\d{4}-\d{2}-01/, "默认从本月 1 日开始");
  assert.match(spendUrl, /end=\d{4}-\d{2}-\d{2}/);

  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("消费页签接在 /lithos-spend 上，且不自己编口径文案", async () => {
  const fsMod = fs;
  const src = fsMod.readFileSync(new URL("../ui/modules/lithos-spend.js", import.meta.url), "utf8");
  assert.match(src, /\/lithos-spend/, "数据来自路由，不在前端算");
  assert.match(src, /\/lithos-balance/, "余额同屏要一起取");
  assert.match(src, /UTC/, "区间口径要写明是 UTC");
  const app = fsMod.readFileSync(new URL("../ui/dashboard-app.js", import.meta.url), "utf8");
  assert.match(app, /data-view="lithos"/, "要有独立页签");
  assert.match(app, /tt-view/, "页签选择要记住");
});
