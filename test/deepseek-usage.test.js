import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parsePlatformToken,
  buildMonths,
  monthKey,
  normalizeMonth,
  mergeMonths,
  matchModelName,
  sliceUsage,
  DeepSeekUsageService,
} from "../lib/deepseek-usage.mjs";

// 下面两个 fixture 是 2026-10-27 从平台真响应里裁出来的（只留两天、去掉全零模型），
// 字段名与数值形状一比一，别按文档臆造。
const AMOUNT = {
  code: 0,
  msg: "",
  data: {
    biz_code: 0,
    biz_msg: "",
    biz_data: {
      total: [],
      days: [
        {
          date: "2026-10-26",
          data: [
            { model: "deepseek-flash", usage: [
              { type: "PROMPT_TOKEN", amount: "0" },
              { type: "PROMPT_CACHE_HIT_TOKEN", amount: "48390912" },
              { type: "PROMPT_CACHE_MISS_TOKEN", amount: "458240" },
              { type: "RESPONSE_TOKEN", amount: "243529" },
              { type: "REQUEST", amount: "242" },
            ] },
            { model: "deepseek-v4-pro", usage: [
              { type: "PROMPT_TOKEN", amount: "0" },
              { type: "PROMPT_CACHE_HIT_TOKEN", amount: "0" },
              { type: "PROMPT_CACHE_MISS_TOKEN", amount: "344" },
              { type: "RESPONSE_TOKEN", amount: "82" },
              { type: "REQUEST", amount: "1" },
            ] },
            { model: "deepseek-v4-flash", usage: [
              { type: "PROMPT_TOKEN", amount: "0" },
              { type: "PROMPT_CACHE_HIT_TOKEN", amount: "0" },
              { type: "REQUEST", amount: "0" },
            ] },
          ],
        },
        {
          date: "2026-10-27",
          data: [
            { model: "deepseek-flash", usage: [
              { type: "PROMPT_CACHE_HIT_TOKEN", amount: "2872960" },
              { type: "PROMPT_CACHE_MISS_TOKEN", amount: "11977" },
              { type: "RESPONSE_TOKEN", amount: "7039" },
              { type: "REQUEST", amount: "8" },
            ] },
          ],
        },
        // 平台会把未来日期也列出来，全是 0——不该出现在图上
        {
          date: "2026-10-31",
          data: [
            { model: "deepseek-flash", usage: [
              { type: "PROMPT_CACHE_HIT_TOKEN", amount: "0" },
              { type: "PROMPT_CACHE_MISS_TOKEN", amount: "0" },
              { type: "RESPONSE_TOKEN", amount: "0" },
              { type: "REQUEST", amount: "0" },
            ] },
          ],
        },
      ],
    },
  },
};

const COST = {
  code: 0,
  msg: "",
  data: {
    biz_code: 0,
    biz_msg: "",
    biz_data: [
      {
        currency: "CNY",
        total: [],
        days: [
          {
            date: "2026-10-26",
            data: [
              { model: "deepseek-flash", usage: [
                { type: "PROMPT_CACHE_HIT_TOKEN", amount: "0.9678182400000000" },
                { type: "PROMPT_CACHE_MISS_TOKEN", amount: "0.4582400000000000" },
                { type: "RESPONSE_TOKEN", amount: "0.9741160000000000" },
                { type: "REQUEST", amount: "0" },
              ] },
              { model: "deepseek-v4-pro", usage: [
                { type: "PROMPT_CACHE_MISS_TOKEN", amount: "0.0015480000000000" },
                { type: "RESPONSE_TOKEN", amount: "0.0011070000000000" },
              ] },
            ],
          },
          {
            date: "2026-10-27",
            data: [
              { model: "deepseek-flash", usage: [
                { type: "PROMPT_CACHE_HIT_TOKEN", amount: "0.1149184000000000" },
                { type: "PROMPT_CACHE_MISS_TOKEN", amount: "0.0239540000000000" },
                { type: "RESPONSE_TOKEN", amount: "0.0563120000000000" },
              ] },
            ],
          },
        ],
      },
    ],
  },
};

const SUMMARY = {
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      normal_wallets: [{ currency: "CNY", balance: "14.9641625400000000", token_estimation: "0" }],
      bonus_wallets: [{ currency: "CNY", balance: "0", token_estimation: "0" }],
      total_costs: [{ currency: "CNY", amount: "57.9282517000000000" }],
    },
  },
};

const TOKEN = "FAKEplatformTokenForTests0123456789abcdefghijklmnopqrstuvwxyz0123456";

test("令牌清洗：把 API Key 误当令牌时当场拦下", () => {
  assert.equal(parsePlatformToken("").ok, false);
  const apiKey = parsePlatformToken("sk-fake0000000000000000000000000000");
  assert.equal(apiKey.ok, false);
  assert.equal(apiKey.code, "API_KEY_NOT_TOKEN");
  assert.match(apiKey.message, /userToken/);

  const ok = parsePlatformToken(`Bearer ${TOKEN}`);
  assert.equal(ok.ok, true);
  assert.equal(ok.token, TOKEN);
  assert.equal(parsePlatformToken("short").code, "TOO_SHORT");
});

test("月份区间：本月 / 上月 / 近三个月，跨年也要对", () => {
  const now = new Date("2026-10-27T08:00:00+08:00");
  assert.deepEqual(buildMonths("month", now), [{ year: 2026, month: 10 }]);
  assert.deepEqual(buildMonths("last", now), [{ year: 2026, month: 9 }]);
  assert.deepEqual(buildMonths("q3", now), [
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
    { year: 2026, month: 10 },
  ]);
  const jan = new Date("2026-01-15T12:00:00+08:00");
  assert.deepEqual(buildMonths("q3", jan), [
    { year: 2025, month: 11 },
    { year: 2025, month: 12 },
    { year: 2026, month: 1 },
  ]);
  assert.equal(monthKey({ year: 2026, month: 9 }), "2026-09");
});

test("归一化：amount 给 token，cost 给钱，按天与按模型都对得上", () => {
  const res = normalizeMonth(AMOUNT, COST, { year: 2026, month: 10 });
  assert.equal(res.connected, true);
  assert.equal(res.month, "2026-10");
  assert.equal(res.currency, "CNY");

  // 26 号：flash 0.96781824+0.45824+0.974116 = 2.40017424，加 pro 0.001548+0.001107 = 0.002655
  //       合计 2.40282924 → 2.4028；27 号 0.1951844 → 0.1952
  assert.equal(res.days.length, 2, "全零的未来日期要被过滤掉");
  assert.equal(res.days[0].day, "2026-10-26");
  assert.equal(res.days[0].cost, 2.4028);
  assert.equal(res.days[1].cost, 0.1952);
  assert.equal(res.totalCost, 2.598);

  const flash = res.models.find((m) => m.model === "deepseek-flash");
  assert.equal(flash.tokens, 49092681 + 2891976);
  assert.equal(flash.requests, 250);
  assert.equal(flash.days, 2);
  const pro = res.models.find((m) => m.model === "deepseek-v4-pro");
  assert.equal(pro.tokens, 426);
  assert.equal(pro.requests, 1);
  assert.equal(res.models.length, 2, "全是 0 的模型不进表");

  assert.ok(Math.abs(res.hitRate - 51263872 / (51263872 + 470561)) < 1e-9, "命中率 = 命中 / (命中 + 未命中)");
  assert.equal(res.models[0].model, "deepseek-flash", "按金额降序");
  assert.ok(Math.abs(res.models.reduce((a, m) => a + m.share, 0) - 1) < 1e-9);
});

test("归一化：结构变了就说结构变了，不拼个假的出来", () => {
  const res = normalizeMonth({ code: 0, data: { biz_data: { unexpected: [] } } }, COST, { year: 2026, month: 10 });
  assert.equal(res.connected, false);
  assert.equal(res.reason, "shape_changed");
  assert.match(res.message, /结构变了/);
});

test("多月合并：天按日期串起来，模型按名字累加", () => {
  const sep = normalizeMonth(
    { data: { biz_data: { days: [{ date: "2026-09-30", data: [{ model: "deepseek-flash", usage: [
      { type: "PROMPT_CACHE_HIT_TOKEN", amount: "100" }, { type: "PROMPT_CACHE_MISS_TOKEN", amount: "10" },
      { type: "RESPONSE_TOKEN", amount: "5" }, { type: "REQUEST", amount: "2" }] }] }] } } },
    { data: { biz_data: [{ currency: "CNY", days: [{ date: "2026-09-30", data: [{ model: "deepseek-flash", usage: [
      { type: "PROMPT_CACHE_HIT_TOKEN", amount: "0.5" }] }] }] }] } },
    { year: 2026, month: 9 }
  );
  const oct = normalizeMonth(AMOUNT, COST, { year: 2026, month: 10 });
  const merged = mergeMonths([sep, oct]);
  assert.equal(merged.connected, true);
  assert.deepEqual(merged.months, ["2026-09", "2026-10"]);
  assert.equal(merged.days.length, 3);
  assert.equal(merged.days[0].day, "2026-09-30", "按日期排序");
  assert.equal(merged.models.length, 2, "两家模型各一列，同名才算合并");
  assert.equal(merged.models[0].model, "deepseek-flash", "按金额降序");
  // flash 才是那一列：9 月 0.5 + 10 月 flash 的 2.59535864 = 3.09535864
  assert.equal(merged.models[0].cost, 3.0954);
  assert.equal(merged.models[0].days, 3);
});

test("服务：没配令牌不发请求；40003 报令牌失效", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dsu-"));
  let calls = 0;
  const svc = new DeepSeekUsageService({
    dataDir: dir,
    fetchFn: async () => {
      calls += 1;
      return { status: 200, ok: true, json: async () => ({ code: 40003, msg: "Authorization Failed (invalid token)", data: null }) };
    },
  });

  const none = await svc.getUsage({ range: "month" });
  assert.equal(none.reason, "not_configured");
  assert.equal(calls, 0, "没令牌就不该发请求");

  svc.saveToken(TOKEN);
  const bad = await svc.getUsage({ range: "month" });
  assert.equal(bad.connected, false);
  assert.equal(bad.reason, "unauthorized");
  assert.match(bad.message, /userToken/);

  const summary = await svc.getSummary({ force: true });
  assert.equal(summary.connected, false);
  assert.equal(summary.reason, "unauthorized");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("服务：走按月端点，请求要装成浏览器（否则被 WAF 挡）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dsu-"));
  const urls = [];
  let seenHeaders = null;
  const svc = new DeepSeekUsageService({
    dataDir: dir,
    fetchFn: async (url, init) => {
      urls.push(String(url));
      seenHeaders = init.headers;
      if (String(url).includes("/usage/amount")) return { status: 200, ok: true, json: async () => AMOUNT };
      if (String(url).includes("/usage/cost")) return { status: 200, ok: true, json: async () => COST };
      return { status: 404, ok: false, json: async () => ({}) };
    },
  });
  svc.saveToken(TOKEN);
  const res = await svc.getUsage({ range: "month", force: true });
  assert.equal(res.connected, true);
  assert.equal(res.totalCost, 2.598);
  assert.ok(urls.some((u) => /\/api\/v0\/usage\/amount\?month=10&year=\d{4}/.test(u)), "按月端点");
  assert.match(String(seenHeaders.Authorization), /^Bearer FAKEplatformToken/);
  assert.ok(seenHeaders.Referer, "WAF 会看 Referer");
  assert.ok(seenHeaders["Accept-Language"], "也要 Accept-Language");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("服务：余额字段按真实形状解析，四位小数不直接显示", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dsu-"));
  const svc = new DeepSeekUsageService({
    dataDir: dir,
    fetchFn: async () => ({ status: 200, ok: true, json: async () => SUMMARY }),
  });
  svc.saveToken(TOKEN);
  const s = await svc.getSummary({ force: true });
  assert.equal(s.connected, true);
  assert.equal(s.balanceDisplay, "¥14.96", "平台给 14.96416254…");
  assert.equal(s.bonusBalance, 0);
  assert.equal(s.totalCosts[0].amount, 57.9282517);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("服务：缓存 60 秒，force 能穿透", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dsu-"));
  let n = 0;
  const svc = new DeepSeekUsageService({
    dataDir: dir,
    fetchFn: async (url) => {
      n += 1;
      const body = String(url).includes("/amount") ? AMOUNT : COST;
      return { status: 200, ok: true, json: async () => body };
    },
  });
  svc.saveToken(TOKEN);
  await svc.getUsage({ range: "month", force: true });
  const afterFirst = n;
  await svc.getUsage({ range: "month" });
  assert.equal(n, afterFirst, "第二次命中缓存");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("路由：GET 默认本月、POST 存令牌后当场验活", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dsu-route-"));
  const registerRoutes = (await import("../server/dashboard.js")).default;
  const routes = {};
  const mockApp = { get: (p, fn) => { routes["GET " + p] = fn; }, post: (p, fn) => { routes["POST " + p] = fn; } };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("get_user_summary")) return { status: 200, ok: true, json: async () => SUMMARY };
    if (String(url).includes("/usage/amount")) return { status: 200, ok: true, json: async () => AMOUNT };
    if (String(url).includes("/usage/cost")) return { status: 200, ok: true, json: async () => COST };
    return { status: 404, ok: false, json: async () => ({}) };
  };

  registerRoutes(mockApp, {
    _tokenCache: { ready: true, dataDir: dir, data: { sessions: {} } },
    dataDir: dir,
    bus: { request: async () => { throw new Error("nope"); } },
  });

  const before = await routes["GET /deepseek-usage"]({ req: { query: () => "" }, json: (b, s = 200) => ({ body: b, status: s }) });
  assert.equal(before.body.connected, false);
  assert.equal(before.body.reason, "not_configured");

  const saved = await routes["POST /deepseek-usage"]({
    req: { json: async () => ({ token: TOKEN }) },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.verified, true);
  assert.equal(saved.body.summary.balanceDisplay, "¥14.96");
  assert.equal(fs.statSync(path.join(dir, "deepseek-platform.json")).mode & 0o777, 0o600);

  const after = await routes["GET /deepseek-usage"]({
    req: { query: (k) => (k === "refresh" ? "1" : "") },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  assert.equal(after.body.connected, true);
  assert.equal(after.body.totalCost, 2.598);
  assert.equal(after.body.balance.connected, true);

  const wrong = await routes["POST /deepseek-usage"]({
    req: { json: async () => ({ token: "sk-fake0000000000000000000000000000" }) },
    json: (b, s = 200) => ({ body: b, status: s }),
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.message, /userToken/);

  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("页签接线：入口页有 ds-usage 视图与区块", () => {
  const app = fs.readFileSync(new URL("../ui/dashboard-app.js", import.meta.url), "utf8");
  assert.match(app, /data-view="ds-usage"/);
  assert.match(app, /id="ds-usage-section"/);
  assert.match(app, /createDeepSeekUsage/);

  const mod = fs.readFileSync(new URL("../ui/modules/deepseek-usage.js", import.meta.url), "utf8");
  assert.match(mod, /\/deepseek-usage/);
  assert.match(mod, /userToken/, "空状态要告诉人去哪拿令牌");
  assert.match(mod, /官方账单/, "口径说明要在界面上");
  assert.match(mod, /key: "last"/, "区间要按月");
  assert.doesNotMatch(mod, /d7|d30/, "平台没有按天的区间接口，不该摆出来");
});

test("外部账单筛选联动：DeepSeek 视图支持模型过滤与清除，并接入 getFilters", async () => {
  const mod = await import("../ui/modules/deepseek-usage.js");
  assert.equal(typeof mod.createDeepSeekUsage, "function");

  const container = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  let cleared = false;
  const instance = mod.createDeepSeekUsage({
    container,
    fetchFn: async () => ({ ok: true, json: async () => ({ connected: true, days: [], models: [] }) }),
    getFilters: () => ({ model: "deepseek-chat" }),
    onClearModel: () => { cleared = true; },
  });

  assert.ok(instance, "createDeepSeekUsage should return instance");
  assert.equal(typeof instance.reloadWithFilters, "function");
});

test("外部账单筛选联动：DeepSeek 视图支持日期范围联动与按天切片", async () => {
  const oct = normalizeMonth(AMOUNT, COST, { year: 2026, month: 10 });
  assert.equal(oct.days.length, 2);

  // 切到 10-26（单日，如「昨天」）
  const d26 = sliceUsage(oct, { start: "2026-10-26", end: "2026-10-26" });
  assert.equal(d26.days.length, 1);
  assert.equal(d26.days[0].day, "2026-10-26");
  assert.equal(d26.totalCost, 2.4028);
  assert.equal(d26.models.length, 2);
  const flash26 = d26.models.find((m) => m.model === "deepseek-flash");
  assert.equal(flash26.cost, 2.4002);
  assert.equal(flash26.days, 1);
  assert.equal(flash26.requests, 242);

  // 切到 10-27（单日，如「今日」）
  const d27 = sliceUsage(oct, { start: "2026-10-27", end: "2026-10-27" });
  assert.equal(d27.days.length, 1);
  assert.equal(d27.days[0].day, "2026-10-27");
  assert.equal(d27.totalCost, 0.1952);
  assert.equal(d27.models.length, 1, "27号只有 flash 有记录");

  // 切到 10-26 ~ 10-27 并叠加模型过滤
  const d26Pro = sliceUsage(oct, { start: "2026-10-26", end: "2026-10-27", model: "deepseek-v4-pro" });
  assert.equal(d26Pro.days.length, 1);
  assert.equal(d26Pro.models.length, 1);
  assert.equal(d26Pro.models[0].model, "deepseek-v4-pro");
  assert.equal(d26Pro.totalCost, 0.0027);

  // 日期范围跨月生成月份覆盖
  const months = buildMonths("custom", new Date("2026-10-27"), { start: "2026-08-15", end: "2026-10-27" });
  assert.deepEqual(months, [
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
    { year: 2026, month: 10 },
  ]);

  // 前端组件装配与过滤参数传递
  const mod = await import("../ui/modules/deepseek-usage.js");
  const container = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const urls = [];
  const instance = mod.createDeepSeekUsage({
    container,
    fetchFn: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ connected: true, days: [], models: [] }) };
    },
    getFilters: () => ({ model: "deepseek-flash", from: "2026-10-26", to: "2026-10-26" }),
  });

  instance.ensure();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(urls.some((u) => u.includes("start=2026-10-26") && u.includes("end=2026-10-26")), "携带日期范围参数");
});

test("外部账单筛选联动：LithosAI 视图支持日期与模型联动，并在账单视图下置灰不支持项", async () => {
  const mod = await import("../ui/modules/lithos-spend.js");
  assert.equal(typeof mod.createLithosSpend, "function");

  const container = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const instance = mod.createLithosSpend({
    container,
    fetchFn: async () => ({ ok: true, json: async () => ({ connected: true, days: [], models: [] }) }),
    getFilters: () => ({ model: "DeepSeek-V4.1-Flash", from: "2026-10-01", to: "2026-10-27" }),
  });

  assert.ok(instance, "createLithosSpend should return instance");
  assert.equal(typeof instance.reloadWithFilters, "function");

  const app = fs.readFileSync(new URL("../ui/dashboard-app.js", import.meta.url), "utf8");
  assert.match(app, /cs-disabled-billing/);
  assert.match(app, /reloadWithFilters/);

  const css = fs.readFileSync(new URL("../ui/base.css", import.meta.url), "utf8");
  assert.match(css, /\.cs\.cs-disabled-billing/);
  assert.match(css, /\.ls-filter-badge/);
});
