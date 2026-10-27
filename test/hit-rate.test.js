// 命中率口径：一个式子，两处实现（JS 与 SQL），这里把它们钉在一起。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { hitRate, hitRatePercent, hitRatePercentText, hitRateLabel } from "../ui/hit-rate.js";
import { openTurnsStore, HIT_SORT_EXPR } from "../runtime/engine/services/turns-store.js";
import registerRoutes from "../server/dashboard.js";

test("命中率 = 缓存读 / 输入总量（含缓存读）", () => {
  assert.equal(hitRate(900, 1000), 0.9);
  assert.equal(hitRate(0, 1000), 0);
  // 分母无效 → null：没有输入就没有命中率，不能写成 0%
  assert.equal(hitRate(0, 0), null);
  assert.equal(hitRate(100, null), null);
  // 账本偶尔给出超过输入总量的缓存读，夹在 1
  assert.equal(hitRate(1200, 1000), 1);
});

test("三种展示形态各自守住自己的契约", () => {
  assert.equal(hitRatePercent(967, 1000), 96.7);
  assert.equal(hitRatePercent(0, 0), 0, "KPI 那一格历来显示 0.0%，不改契约");
  assert.equal(hitRatePercentText(967, 1000), "96.7");
  assert.equal(hitRateLabel(967, 1000), "96.7%");
  assert.equal(hitRateLabel(0, 0), "—", "明细行没数据要给破折号，不写 0%");
});

test("调用明细把未命中输入转成含缓存输入后再格式化命中率", () => {
  const source = fs.readFileSync(new URL("../ui/modules/turns-inspector.js", import.meta.url), "utf8");
  const start = source.indexOf("  function fmtPct(");
  const end = source.indexOf("\n  }", start) + 4;
  const context = vm.createContext({ hitRateLabel });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.fmtPct(90, 10), "90.0%");
  assert.equal(context.fmtPct(10, 90), "10.0%");
  assert.equal(context.fmtPct(0, 0), "—");
});

test("SQL 排序表达式与 JS 实现同一口径", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-hit-"));
  const store = openTurnsStore({ file: path.join(dir, "cache.sqlite") });
  assert.ok(store, "需要 node:sqlite");
  const samples = [
    { input: 100, cacheRead: 900 }, // 0.9
    { input: 500, cacheRead: 500 }, // 0.5
    { input: 0, cacheRead: 0 }, // null
    { input: 1000, cacheRead: 0 }, // 0
  ];
  store.replaceSession("a::desktop::2026-01-01", {
    agent: "a",
    type: "desktop",
    conversations: samples.map((s, i) => ({
      time: `2026-01-01T0${i}:00:00.000Z`,
      provider: "p",
      model: "m",
      totalTokens: s.input + s.cacheRead,
      inTokens: s.input,
      outTokens: 0,
      cacheRead: s.cacheRead,
    })),
  });

  const rows = store.query({ sortKey: "hit", order: "desc", all: true }).rows;
  const sqlOrder = rows.map((r) => r.seq);
  // JS 侧自己排一遍：非空降序在前，空值垫底（与 SQL 的 (expr IS NULL) ASC 一致）
  const jsOrder = samples
    .map((s, i) => ({ seq: i + 1, v: hitRate(s.cacheRead, s.input + s.cacheRead) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.seq - b.seq;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return b.v - a.v;
    })
    .map((x) => x.seq);

  assert.deepEqual(sqlOrder, jsOrder, "SQL 与 JS 排出来的顺序必须一致");
  assert.match(HIT_SORT_EXPR, /cache_read/, "排序表达式用的是 cache_read 列");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("看板 KPI 用统一口径，不再拿总 token 当分母", async () => {
  const routes = {};
  const mockApp = { get: (p, fn) => { routes["GET " + p] = fn; }, post: () => {} };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const cache = {
    ready: true,
    dataDir: os.tmpdir(),
    data: {
      lastScan: today + "T00:00:00Z",
      sessions: {
        s1: {
          agent: "hanako",
          type: "desktop",
          dailyBreakdown: {
            [today]: {
              totalTokens: 4000, // 输入 1000（未命中 100 + 命中 900）+ 输出 3000
              input: 100,
              output: 3000,
              cacheRead: 900,
              desktop: 4000,
              models: { m1: { totalTokens: 4000, input: 100, output: 3000, cacheRead: 900, assistantCount: 1 } },
              providerTotals: { "p/m1": { totalTokens: 4000, input: 100, output: 3000, cacheRead: 900, assistantCount: 1 } },
              baseTotals: { desktop: 4000 },
            },
          },
          models: { m1: { totalTokens: 4000 } },
        },
      },
    },
  };
  registerRoutes(mockApp, { _tokenCache: cache, dataDir: os.tmpdir(), bus: { request: async () => ({}) } });
  const res = await routes["GET /data"]({ req: { query: (k) => (k === "range" ? "today" : "") }, json: (body, status = 200) => ({ body, status }) });
  assert.equal(res.status, 200);

  // 新口径：900 / (100 + 900) = 90.0%
  assert.equal(res.body.summary.cacheHitRate, 90);
  // 旧口径 900 / 4000 = 22.5% —— 分母带了输出，正是要对不上的那个数
  assert.notEqual(res.body.summary.cacheHitRate, 22.5);
});
