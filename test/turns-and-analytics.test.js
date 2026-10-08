import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSqliteTurnsStore,
  openTurnsStore,
  queryTurns,
  queryTurnSizes,
  loadSqliteDriver,
} from "../runtime/engine/services/turns-store.js";
import { buildDetailsCSV, hitRate } from "../runtime/engine/services/details-csv.js";
import {
  summarizeTurns,
  buildVisualAnalytics,
} from "../runtime/engine/services/visual-analytics.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "turns-test-"));
}

test("turns-store creates SQLite schema, indexes records, and supports uncached/tokens sorting", () => {
  const DatabaseSync = loadSqliteDriver();
  assert.ok(DatabaseSync, "node:sqlite DatabaseSync should be available");

  const dir = tempDir();
  const dbFile = path.join(dir, "test-turns.sqlite");
  const store = createSqliteTurnsStore({ DatabaseSync, file: dbFile });

  try {
    const sessionData = {
      agent: "gemini-coder",
      type: "desktop",
      conversations: [
        {
          time: "2026-10-07T10:00:00Z",
          provider: "gemini",
          model: "gemini-3.8-flash-high",
          totalTokens: 1000,
          inTokens: 200,
          outTokens: 200,
          cacheRead: 600,
        },
        {
          time: "2026-10-07T11:00:00Z",
          provider: "gemini",
          model: "gemini-3.8-flash-high",
          totalTokens: 5000,
          inTokens: 4000,
          outTokens: 500,
          cacheRead: 500,
        },
        {
          time: "2026-10-07T12:00:00Z",
          provider: "deepseek",
          model: "deepseek-chat",
          totalTokens: 20000,
          inTokens: 1000,
          outTokens: 2000,
          cacheRead: 17000,
        },
      ],
    };

    store.replaceSession("session-1", sessionData);
    assert.equal(store.count(), 3);

    // 1. 默认按时间倒序
    const resTime = queryTurns(store, { sortKey: "time", order: "desc" });
    assert.equal(resTime.total, 3);
    assert.equal(resTime.rows[0].total, 20000);

    // 2. 按未命中输入倒序：中间轮次 inTokens = 4000 最大，排第一
    const resUncached = queryTurns(store, { sortKey: "uncached", order: "desc" });
    assert.equal(resUncached.rows[0].total, 5000);
    assert.equal(resUncached.rows[0].input, 4000);

    // 3. 按命中率倒序：第三轮 cacheRead / (input + cacheRead) = 17000 / 18000 = 94.4% 最高，排第一
    const resHit = queryTurns(store, { sortKey: "hit", order: "desc" });
    assert.equal(resHit.rows[0].model, "deepseek-chat");
    assert.equal(resHit.rows[0].cacheRead, 17000);

    // 4. 门槛筛选：minTokens >= 10000
    const resFilter = queryTurns(store, { minTokens: 10000 });
    assert.equal(resFilter.total, 1);
    assert.equal(resFilter.rows[0].model, "deepseek-chat");

    // 4. 单轮大小提取
    const sizes = queryTurnSizes(store, {});
    assert.equal(sizes.length, 3);
    assert.equal(sizes.find((s) => s.model === "deepseek-chat").totalTokens, 20000);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("details-csv formats UTF-8 BOM CSV with cache hit rates", () => {
  const rows = [
    {
      at: "2026-10-07 10:00:00",
      agent: "gemini-coder",
      provider: "gemini",
      model: "gemini-3.8-flash-high",
      input: 200,
      output: 200,
      cacheRead: 800,
      calls: 1,
      total: 1200,
    },
  ];

  const csv = buildDetailsCSV(rows);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"时间","Agent","Provider"'));
  assert.ok(csv.includes("80.0%"));
  assert.ok(csv.includes("gemini-coder"));
});

test("visual-analytics computes quantiles, bins and multi-agent summaries", () => {
  const rows = [
    { model: "model-a", totalTokens: 100 },
    { model: "model-a", totalTokens: 500 },
    { model: "model-a", totalTokens: 1000 },
    { model: "model-b", totalTokens: 5000 },
  ];

  const summary = summarizeTurns(rows);
  assert.equal(summary.turnCount, 4);
  assert.equal(summary.models.length, 2);

  const modelA = summary.models.find((m) => m.id === "model-a");
  assert.equal(modelA.count, 3);
  assert.equal(modelA.bins.length, 32);
  assert.ok(modelA.p50 > 0);

  const sessions = [
    {
      agent: "gemini-coder",
      dailyBreakdown: {
        "2026-10-07": {
          totalTokens: 10000,
          desktop: 10000,
          models: { "gemini-3.8-flash-high": { totalTokens: 10000, count: 2 } },
        },
      },
      hourlyBreakdown: {},
    },
    {
      agent: "sol-architect",
      dailyBreakdown: {
        "2026-10-07": {
          totalTokens: 5000,
          desktop: 5000,
          models: { "gpt-6.1-sol": { totalTokens: 5000, count: 1 } },
        },
      },
      hourlyBreakdown: {},
    },
  ];

  const analytics = buildVisualAnalytics(sessions);
  assert.equal(analytics.daily.length, 1);
  assert.equal(analytics.daily[0].totalTokens, 15000);
  assert.equal(analytics.agents.length, 2);
  assert.equal(analytics.agents[0].id, "gemini-coder");
  assert.equal(analytics.agents[0].totalTokens, 10000);
});
