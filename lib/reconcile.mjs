// 对账：把「官方实际扣费」和「本地按价目表估算」并排放。
//
// 三条口径必须写死在代码里，因为它们是这个页面所有数字的前提：
//   1. 官方按 UTC 切日。本地 turns 里的 day 是本机自然日，两者差 8 小时，
//      所以这里一律用 at 时间戳重新切 UTC 日，不复用 turns.day。
//   2. 官方只给总额，不给输入/输出/缓存的分项金额。因此差额只能定位到「模型×日」，
//      定位不到「token 类型」——不要在这里假装能拆开。
//   3. 价目表查不到就是不查得到，返回 null，不许拿 0 顶上。
//      0 会让「估算 0 vs 官方 3.12」看着像严重偏差，实际是缺价，那是两种完全不同的结论。

/** 从 ISO 时间戳取 UTC 日（YYYY-MM-DD）。非法输入返回空串，交给上层丢弃。 */
export function utcDayOf(at) {
  if (typeof at !== "string") return "";
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(at);
  if (!m) return "";
  const day = m[1];
  return Number.isNaN(Date.parse(day + "T00:00:00Z")) ? "" : day;
}

/** YYYY-MM-DD 加减天数，用于把 UTC 区间放宽到本地日区间（时区差最多一天）。 */
export function shiftIsoDay(day, delta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return "";
  const base = Date.parse(day + "T00:00:00Z");
  if (Number.isNaN(base)) return "";
  return new Date(base + Number(delta || 0) * 86400000).toISOString().slice(0, 10);
}

export function isIsoDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

/** 天数（含首尾）；区间非法返回 0。 */
export function dayCount(start, end) {
  if (!isIsoDay(start) || !isIsoDay(end)) return 0;
  const a = Date.parse(start + "T00:00:00Z");
  const b = Date.parse(end + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

function roundTo(value, digits) {
  if (!Number.isFinite(value)) return null;
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

/** 偏差百分比：以官方为基准。官方为 0 时无意义，返回 null 而不是 Infinity。 */
export function deltaPct(officialUsd, estimateUsd) {
  if (!Number.isFinite(officialUsd) || !Number.isFinite(estimateUsd)) return null;
  if (officialUsd === 0) return null;
  return roundTo(((estimateUsd - officialUsd) / officialUsd) * 100, 1);
}

/**
 * 把本地 turns 行按 UTC 日 × 供应商 × 模型聚成桶。
 * 带供应商是因为同一个模型名可能走不同渠道、不同价；混在一起算价必然错。
 */
export function bucketTurns(rows) {
  const buckets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = utcDayOf(row?.at);
    if (!day) continue;
    const provider = String(row?.provider ?? "");
    const model = String(row?.model ?? "");
    if (!model) continue;
    const key = day + "\u0000" + provider + "\u0000" + model;
    const acc = buckets.get(key) || {
      day,
      provider,
      model,
      input: 0,
      cacheRead: 0,
      output: 0,
      total: 0,
      calls: 0,
    };
    acc.input += Number(row?.input) || 0;
    acc.cacheRead += Number(row?.cacheRead) || 0;
    acc.output += Number(row?.output) || 0;
    acc.total += Number(row?.total) || 0;
    acc.calls += Number(row?.calls) || 0;
    buckets.set(key, acc);
  }
  return [...buckets.values()];
}

/**
 * 官方与本地两边的连接。
 *
 * @param officialRows 官方原始行 [{day, modelId, usd, inputTokens, cachedTokens, outputTokens}]
 * @param buckets      bucketTurns 的结果
 * @param costOf       (provider, model, mv) => { cost: number|null, currency: string }
 *                     cost 为 null 表示价目表缺这一条；绝不用 0 冒充。
 */
export function reconcile({ officialRows, buckets, costOf, start = "", end = "" }) {
  const official = new Map();
  for (const row of Array.isArray(officialRows) ? officialRows : []) {
    const day = isIsoDay(row?.day) ? row.day : "";
    if (!day) continue;
    const modelId = String(row?.modelId ?? "unknown");
    const key = day + "\u0000" + modelId;
    const acc = official.get(key) || { day, modelId, usd: 0, input: 0, cacheRead: 0, output: 0 };
    acc.usd += Number(row?.usd) || 0;
    acc.input += Number(row?.inputTokens) || 0;
    acc.cacheRead += Number(row?.cachedTokens) || 0;
    acc.output += Number(row?.outputTokens) || 0;
    official.set(key, acc);
  }

  const estimate = new Map();
  // 对账只谈「同一个渠道」。本地 turns 里混着 OpenAI、Gemini 等别的渠道，
  // 把它们列进「本地有官方无」是噪音，不是缺口。所以先把范围收到
  // 「模型名曾出现在官方账单里的那些供应商」，其余只报个数量。
  const officialModels = new Set([...official.values()].map((r) => r.modelId));
  const allBuckets = Array.isArray(buckets) ? buckets : [];
  const scopedBuckets = allBuckets.filter((b) => officialModels.has(b.model));
  const scopeProviders = [...new Set(scopedBuckets.map((b) => b.provider || "未标注"))].sort();
  let outOfWindow = 0;

  for (const bucket of scopedBuckets) {
    // turns.day 是本机日，为了盖住时区差会宽搜一两天，按 UTC 日把区间外的剔掉。
    if ((start && bucket.day < start) || (end && bucket.day > end)) { outOfWindow += 1; continue; }
    const key = bucket.day + "\u0000" + bucket.model;
    const priced = typeof costOf === "function"
      ? costOf(bucket.provider, bucket.model, {
          input: bucket.input,
          cacheRead: bucket.cacheRead,
          cacheWrite: 0,
          output: bucket.output,
          callCount: bucket.calls,
        })
      : null;
    const acc = estimate.get(key) || {
      day: bucket.day,
      modelId: bucket.model,
      usd: 0,
      missingPrice: false,
      providers: new Set(),
      input: 0,
      cacheRead: 0,
      output: 0,
      calls: 0,
    };
    acc.providers.add(bucket.provider || "未标注");
    acc.input += bucket.input;
    acc.cacheRead += bucket.cacheRead;
    acc.output += bucket.output;
    acc.calls += bucket.calls;
    if (priced && Number.isFinite(priced.cost)) acc.usd += priced.cost;
    else acc.missingPrice = true;
    estimate.set(key, acc);
  }

  const keys = new Set([...official.keys(), ...estimate.keys()]);
  const rows = [];
  for (const key of keys) {
    const off = official.get(key) || null;
    const est = estimate.get(key) || null;
    const day = (off?.day || est?.day) || "";
    const modelId = (off?.modelId || est?.modelId) || "";
    const officialUsd = off ? roundTo(off.usd, 6) : 0;
    let status;
    if (off && est && est.missingPrice) status = "missing_price";
    else if (off && est) status = "matched";
    else if (off) status = "official_only";
    else status = "estimate_only";

    const estimateUsd = est && !est.missingPrice ? roundTo(est.usd, 6) : null;
    // token 以官方为准：那才是真正被计费的数量。只有本地独有（没走这个渠道）时才用本地。
    const tokens = off
      ? { input: off.input, cacheRead: off.cacheRead, output: off.output, total: off.input + off.cacheRead + off.output }
      : { input: est.input, cacheRead: est.cacheRead, output: est.output, total: est.input + est.cacheRead + est.output };

    rows.push({
      day,
      modelId,
      officialUsd,
      estimateUsd,
      deltaUsd: estimateUsd == null ? null : roundTo(estimateUsd - officialUsd, 6),
      deltaPct: estimateUsd == null ? null : deltaPct(officialUsd, estimateUsd),
      tokens,
      status,
      providers: est ? [...est.providers] : [],
    });
  }
  rows.sort((a, b) => a.day.localeCompare(b.day) || b.officialUsd - a.officialUsd);

  const aggregate = (list) => {
    let officialUsd = 0;
    let estimateSum = 0;
    let missingPrice = 0;
    const tokens = { input: 0, cacheRead: 0, output: 0, total: 0 };
    for (const r of list) {
      officialUsd += r.officialUsd;
      if (r.status === "missing_price") missingPrice += 1;
      if (r.estimateUsd != null && r.status !== "estimate_only") estimateSum += r.estimateUsd;
      if (r.status === "estimate_only") missingPrice += 0;
      for (const k of ["input", "cacheRead", "output", "total"]) tokens[k] += r.tokens[k] || 0;
    }
    // 有任何一条缺价，合计估算就是「不完整」——宁可报 null，也不给一个偏小的数。
    const hasEstimateRows = list.some((r) => r.status === "matched" || r.status === "missing_price");
    const estimateUsd = missingPrice > 0 || !hasEstimateRows ? null : roundTo(estimateSum, 6);
    return {
      officialUsd: roundTo(officialUsd, 6),
      estimateUsd,
      deltaUsd: estimateUsd == null ? null : roundTo(estimateUsd - officialUsd, 6),
      deltaPct: estimateUsd == null ? null : deltaPct(officialUsd, estimateUsd),
      tokens,
      missingPriceRows: missingPrice,
    };
  };

  const byDay = new Map();
  const byModel = new Map();
  for (const row of rows) {
    // 只有「本地独有」的行不构成一天：那天没官方记录，也没匹配上调用的估算。
    if (row.status === "estimate_only") continue;
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day).push(row);
    if (!byModel.has(row.modelId)) byModel.set(row.modelId, []);
    byModel.get(row.modelId).push(row);
  }
  // 模型维度仍要把「只有本地」的模型列出来，否则用户看不到对不上号的那批。
  for (const row of rows) {
    if (row.status !== "estimate_only") continue;
    if (!byModel.has(row.modelId)) byModel.set(row.modelId, []);
    byModel.get(row.modelId).push(row);
  }

  const days = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, list]) => {
      const agg = aggregate(list.filter((r) => r.status !== "estimate_only"));
      return { day, ...agg, models: new Set(list.map((r) => r.modelId)).size };
    });

  const models = [...byModel.entries()]
    .sort((a, b) => {
      const sa = a[1].reduce((s, r) => s + r.officialUsd, 0);
      const sb = b[1].reduce((s, r) => s + r.officialUsd, 0);
      return sb - sa;
    })
    .map(([modelId, list]) => {
      const agg = aggregate(list.filter((r) => r.status !== "estimate_only"));
      const billedTokens = agg.tokens.total;
      // 官方实测单价：钱 ÷ token。只有官方总额，所以这是混合价，不是输入/输出分价。
      const impliedPerMUsd = billedTokens > 0 && agg.officialUsd > 0
        ? roundTo((agg.officialUsd / billedTokens) * 1e6, 4)
        : null;
      const ourBlendedPerMUsd = billedTokens > 0 && agg.estimateUsd != null && agg.estimateUsd > 0
        ? roundTo((agg.estimateUsd / billedTokens) * 1e6, 4)
        : null;
      const status = list.some((r) => r.status === "missing_price")
        ? "missing_price"
        : list.every((r) => r.status === "estimate_only")
          ? "estimate_only"
          : "matched";
      // 整体缩放建议：官方 ÷ 估算。它能回答「价目表整体偏低多少」，
      // 但无法分辨是输入价、缓存价还是输出价错了——别把它当成精确结论。
      const scaleSuggestion = agg.estimateUsd != null && agg.estimateUsd > 0 && agg.officialUsd > 0
        ? roundTo(agg.officialUsd / agg.estimateUsd, 3)
        : null;
      return { modelId, ...agg, impliedPerMUsd, ourBlendedPerMUsd, scaleSuggestion, status };
    });

  const officialOnly = rows.filter((r) => r.status === "official_only")
    .map((r) => ({ day: r.day, modelId: r.modelId, officialUsd: r.officialUsd, tokens: r.tokens }));
  const estimateOnly = rows.filter((r) => r.status === "estimate_only")
    .map((r) => ({
      day: r.day,
      modelId: r.modelId,
      providers: r.providers,
      // 本地独有也应该给出估算金额：既然我们估了这笔，就告诉用户大约多少钱。
      estimateUsd: r.estimateUsd,
      tokens: r.tokens,
    }));

  const totalsAgg = aggregate(rows.filter((r) => r.status !== "estimate_only"));
  const missingPriceModels = [...new Set(rows.filter((r) => r.status === "missing_price").map((r) => r.modelId))];
  const billedModels = models.filter((m) => m.status !== "estimate_only");
  // 覆盖率口径写死：分母是本区间真正被官方计过费的模型数，不是价目表总条数。
  const coveragePct = billedModels.length > 0
    ? roundTo(((billedModels.length - missingPriceModels.length) / billedModels.length) * 100, 1)
    : null;

  return {
    totals: {
      ...totalsAgg,
      missingPriceModels,
      matchedModels: models.filter((m) => m.status === "matched").length,
      billedModels: billedModels.length,
      coveragePct,
    },
    days,
    models,
    rows,
    unmatched: { officialOnly, estimateOnly },
    scope: {
      providers: scopeProviders,
      models: [...officialModels],
      // 这两个数字专门用来说明「为什么本地总用量那么高，却只对这么点」：
      // 其余渠道不对账，区间外的宽搜命中也要报出来，不藏。
      excludedBuckets: allBuckets.length - scopedBuckets.length,
      outOfWindowBuckets: outOfWindow,
    },
  };
}

export default { utcDayOf, shiftIsoDay, isIsoDay, dayCount, deltaPct, bucketTurns, reconcile };
