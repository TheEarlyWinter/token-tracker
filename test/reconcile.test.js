import test from "node:test";
import assert from "node:assert/strict";

import {
  bucketTurns,
  dayCount,
  deltaPct,
  isIsoDay,
  reconcile,
  shiftIsoDay,
  utcDayOf,
} from "../lib/reconcile.mjs";

test("utcDayOf 按 UTC 切日，不跟本机时区走", () => {
  // 本机在东八区，10-28 早上 07:30 本地时间其实是 UTC 10-27 23:30——必须归到 27 号。
  assert.equal(utcDayOf("2026-10-27T23:30:00.000Z"), "2026-10-27");
  assert.equal(utcDayOf("2026-10-28T00:00:00.000Z"), "2026-10-28");
  assert.equal(utcDayOf("2026-10-28T15:59:59.999Z"), "2026-10-28");
  assert.equal(utcDayOf("2026-10-28T16:00:00.000Z"), "2026-10-28");
  assert.equal(utcDayOf(""), "");
  assert.equal(utcDayOf(null), "");
  assert.equal(utcDayOf("2026-13-45T00:00:00.000Z"), "");
});

test("shiftIsoDay 跨月跨年，非法输入返回空串", () => {
  assert.equal(shiftIsoDay("2026-10-01", -1), "2026-09-30");
  assert.equal(shiftIsoDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftIsoDay("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftIsoDay("2026-10-05", 0), "2026-10-05");
  assert.equal(shiftIsoDay("", 1), "");
  assert.equal(shiftIsoDay("2026/10/05", 1), "");
});

test("isIsoDay 与 dayCount 按含首尾算天数", () => {
  assert.equal(isIsoDay("2026-10-28"), true);
  assert.equal(isIsoDay("2026-10-8"), false);
  assert.equal(dayCount("2026-10-01", "2026-10-01"), 1);
  assert.equal(dayCount("2026-10-01", "2026-10-31"), 31);
  assert.equal(dayCount("2026-10-31", "2026-10-01"), 0);
  assert.equal(dayCount("2026-10-01", ""), 0);
});

test("deltaPct 在官方为 0 时返回 null，不造 Infinity", () => {
  assert.equal(deltaPct(1, 0.9), -10);
  assert.equal(deltaPct(1, 1.1), 10);
  assert.equal(deltaPct(0, 0.5), null);
  assert.equal(deltaPct(Number.NaN, 1), null);
});

test("bucketTurns 按 UTC 日 × 供应商 × 模型聚合，缺 at 的行丢弃", () => {
  const rows = [
    { at: "2026-10-27T23:30:00.000Z", provider: "deepseek", model: "m1", input: 100, cacheRead: 900, output: 50, total: 1050, calls: 1 },
    { at: "2026-10-27T23:40:00.000Z", provider: "deepseek", model: "m1", input: 200, cacheRead: 800, output: 40, total: 1040, calls: 2 },
    { at: "2026-10-28T01:00:00.000Z", provider: "deepseek", model: "m1", input: 10, cacheRead: 0, output: 5, total: 15, calls: 1 },
    { at: "2026-10-28T01:00:00.000Z", provider: "other", model: "m1", input: 7, cacheRead: 0, output: 3, total: 10, calls: 1 },
    { at: "", provider: "deepseek", model: "m1", input: 1, cacheRead: 0, output: 1, total: 2, calls: 1 },
  ];
  const buckets = bucketTurns(rows);
  assert.equal(buckets.length, 3);
  const d27 = buckets.find((b) => b.day === "2026-10-27");
  assert.equal(d27.input, 300);
  assert.equal(d27.cacheRead, 1700);
  assert.equal(d27.output, 90);
  assert.equal(d27.calls, 3);
  // 同一天同模型但不同供应商必须分开：价格不同，混一起算必然错。
  assert.equal(buckets.filter((b) => b.day === "2026-10-28" && b.model === "m1").length, 2);
});

function costOk(perM) {
  return (provider, model, mv) => {
    if (model === "__missing__") return { cost: null, currency: null };
    const total = (mv.input || 0) + (mv.cacheRead || 0) + (mv.output || 0);
    return { cost: (total / 1e6) * perM, currency: "USD" };
  };
}

test("reconcile 正常匹配：差额与偏差按官方为基准算", () => {
  const officialRows = [
    { day: "2026-10-27", modelId: "m1", usd: 1.0, inputTokens: 100, cachedTokens: 900, outputTokens: 50 },
  ];
  const buckets = [
    { day: "2026-10-27", provider: "deepseek", model: "m1", input: 100, cacheRead: 900, output: 0, total: 1000, calls: 1 },
  ];
  const result = reconcile({ officialRows, buckets, costOf: costOk(900) });
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.status, "matched");
  assert.equal(row.officialUsd, 1);
  assert.equal(row.estimateUsd, 0.9);
  assert.equal(row.deltaUsd, -0.1);
  assert.equal(row.deltaPct, -10);
  assert.equal(result.totals.missingPriceModels.length, 0);
  assert.equal(result.totals.matchedModels, 1);
});

test("reconcile 缺价时估算整体给 null，不用 0 冒充", () => {
  const officialRows = [
    { day: "2026-10-27", modelId: "__missing__", usd: 3.12, inputTokens: 1200000, cachedTokens: 8300000, outputTokens: 63900 },
  ];
  const buckets = [
    { day: "2026-10-27", provider: "deepseek", model: "__missing__", input: 1200000, cacheRead: 8300000, output: 63900, total: 9563900, calls: 10 },
  ];
  const result = reconcile({ officialRows, buckets, costOf: costOk(0.3) });
  const row = result.rows[0];
  assert.equal(row.status, "missing_price");
  assert.equal(row.estimateUsd, null);
  assert.equal(row.deltaUsd, null);
  assert.equal(row.deltaPct, null);
  assert.equal(result.totals.estimateUsd, null, "有缺价时合计估算必须是 null");
  assert.deepEqual(result.totals.missingPriceModels, ["__missing__"]);
  assert.equal(result.totals.matchedModels, 0);
  // 官方侧数字照样要有：缺价不等于没花钱。
  assert.equal(result.totals.officialUsd, 3.12);
  assert.equal(result.models[0].status, "missing_price");
});

test("reconcile 只对同渠道：模型名不在官方账单里的本地行不算缺口", () => {
  const officialRows = [
    { day: "2026-10-27", modelId: "m1", usd: 1, inputTokens: 1000, cachedTokens: 0, outputTokens: 0 },
  ];
  const buckets = [
    { day: "2026-10-27", provider: "deepseek", model: "m1", input: 1000, cacheRead: 0, output: 0, total: 1000, calls: 1 },
    // 同一天、同一个模型，但本地多出一条官方没结账的调用——这才是真缺口。
    { day: "2026-10-28", provider: "deepseek", model: "m1", input: 500, cacheRead: 0, output: 0, total: 500, calls: 1 },
    // 其他渠道的模型：不对账，只计入 excludedBuckets，不拿来充「本地有官方无」。
    { day: "2026-10-28", provider: "openai-codex", model: "gpt-x", input: 5000, cacheRead: 0, output: 0, total: 5000, calls: 2 },
  ];
  const result = reconcile({ officialRows, buckets, costOf: costOk(1000) });
  assert.equal(result.unmatched.officialOnly.length, 0);
  assert.equal(result.unmatched.estimateOnly.length, 1);
  assert.equal(result.unmatched.estimateOnly[0].day, "2026-10-28");
  assert.equal(result.unmatched.estimateOnly[0].modelId, "m1");
  assert.equal(result.scope.excludedBuckets, 1);
  assert.deepEqual(result.scope.providers, ["deepseek"]);
  // 1 美金官方 vs 1 美金估算；本地独有那条不能掺进合计。
  assert.equal(result.totals.officialUsd, 1);
  assert.equal(result.totals.estimateUsd, 1);
});

test("reconcile 的官方独有：官方记了但本地没有对应调用", () => {
  const officialRows = [
    { day: "2026-10-27", modelId: "m1", usd: 1, inputTokens: 1000, cachedTokens: 0, outputTokens: 0 },
    { day: "2026-10-28", modelId: "ghost", usd: 0.02, inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
  ];
  const buckets = [
    { day: "2026-10-27", provider: "deepseek", model: "m1", input: 1000, cacheRead: 0, output: 0, total: 1000, calls: 1 },
  ];
  const result = reconcile({ officialRows, buckets, costOf: costOk(1000) });
  assert.equal(result.unmatched.officialOnly.length, 1);
  assert.equal(result.unmatched.officialOnly[0].modelId, "ghost");
  assert.equal(result.totals.officialUsd, 1.02);
  // ghost 没有本地调用，所以官方合计里算它，估算里没有它 → 合计估算仍只算 m1。
  assert.equal(result.totals.estimateUsd, 1);
  assert.ok(result.totals.missingPriceModels.length === 0);
});

test("reconcile 丢掉 UTC 区间外的一两天，并在 scope 里报数", () => {
  const officialRows = [
    { day: "2026-10-27", modelId: "m1", usd: 1, inputTokens: 1000, cachedTokens: 0, outputTokens: 0 },
  ];
  const buckets = [
    { day: "2026-10-27", provider: "deepseek", model: "m1", input: 1000, cacheRead: 0, output: 0, total: 1000, calls: 1 },
    { day: "2026-10-29", provider: "deepseek", model: "m1", input: 9999, cacheRead: 0, output: 0, total: 9999, calls: 3 },
  ];
  const result = reconcile({ officialRows, buckets, costOf: costOk(1000), start: "2026-10-27", end: "2026-10-27" });
  assert.equal(result.scope.outOfWindowBuckets, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.totals.tokens.total, 1000);
});

test("reconcile 官方实测单价按官方 token 总数算混合价", () => {
  const officialRows = [
    { day: "2026-10-26", modelId: "m1", usd: 2, inputTokens: 1000000, cachedTokens: 0, outputTokens: 0 },
    { day: "2026-10-27", modelId: "m1", usd: 1, inputTokens: 0, cachedTokens: 3000000, outputTokens: 0 },
  ];
  const buckets = [
    { day: "2026-10-26", provider: "p", model: "m1", input: 1000000, cacheRead: 0, output: 0, total: 1000000, calls: 1 },
    { day: "2026-10-27", provider: "p", model: "m1", input: 0, cacheRead: 3000000, output: 0, total: 3000000, calls: 1 },
  ];
  const result = reconcile({ officialRows, buckets, costOf: costOk(1) });
  const model = result.models[0];
  assert.equal(model.tokens.total, 4000000);
  assert.equal(model.officialUsd, 3);
  // 3 美金 / 400 万 token = 0.75 美金每百万
  assert.equal(model.impliedPerMUsd, 0.75);
  assert.equal(model.ourBlendedPerMUsd, 1);
  assert.equal(model.deltaPct, 33.3);
  // 官方 ÷ 估算 = 0.75，说明价目表整体报高了三分之一；只能整体缩放，分不出是哪种 token 价错。
  assert.equal(model.scaleSuggestion, 0.75);
});
