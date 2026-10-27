// ui/hit-rate.js
// 缓存命中率：全应用只有这一种算法。
//
// 口径：命中率 = 缓存读 / 输入总量，其中输入总量**含**缓存读（也就是明细行里
// 「输入」那一列），**不含输出**。命中率回答的是「这次读进去的上下文里有多少是
// 白拿的」，输出跟这件事没关系。
//
// 为什么放在 ui/ 而不是 lib/：
//   浏览器（明细行、KPI 卡）与主进程（summary.cacheHitRate）都要算同一个数，
//   而卡片 iframe 只加载得到 ui/ 这一层，所以纯函数放这里，两边各 import 同一份。
//
// 为什么索引层没有 import 这份：
//   turns 的排序表达式是 SQL（SORT_EXPR.hit），SQL 里没法调 JS。公式在那边抄了
//   一遍，test/hit-rate.test.js 用同一批样本同时跑 SQL 与这份实现比对，防止漂移。
//
// 三种返回形态各有用途，不合并：
//   hitRate            → 0~1 或 null（分母无效）
//   hitRatePercent     → 一位小数百分比，分母无效给 0（KPI 那一格历来显示 0.0%，不改界面契约）
//   hitRatePercentText → 同上但给字符串（历史上面板那几个字段就是字符串）

/**
 * @param {number} cacheRead 缓存读 tokens
 * @param {number} inputInclusive 输入总量（含缓存读）
 * @returns {number|null} 0~1；分母无效时返回 null（「没有口径」比「0%」诚实）
 */
export function hitRate(cacheRead, inputInclusive) {
  const read = Number(cacheRead);
  const input = Number(inputInclusive);
  if (!Number.isFinite(input) || input <= 0) return null;
  if (!Number.isFinite(read) || read <= 0) return 0;
  return Math.min(1, read / input);
}

/** 界面直接用的百分比数值（保留一位小数）。分母无效给 0。 */
export function hitRatePercent(cacheRead, inputInclusive) {
  const r = hitRate(cacheRead, inputInclusive);
  return r === null ? 0 : +(r * 100).toFixed(1);
}

/** 同上，字符串形态。 */
export function hitRatePercentText(cacheRead, inputInclusive) {
  const r = hitRate(cacheRead, inputInclusive);
  return (r === null ? 0 : r * 100).toFixed(1);
}

/** 明细行用：分母无效时给「—」，不把「没数据」写成 0%。 */
export function hitRateLabel(cacheRead, inputInclusive) {
  const r = hitRate(cacheRead, inputInclusive);
  return r === null ? "—" : (r * 100).toFixed(1) + "%";
}

export default { hitRate, hitRatePercent, hitRatePercentText, hitRateLabel };
