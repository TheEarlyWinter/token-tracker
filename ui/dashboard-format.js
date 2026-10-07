// ui/dashboard-format.js — Token 用量看板格式化与换算纯函数库

export function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatToken(n) {
  if (!n || n === 0) return "0";
  if (n >= 1e8) return (n / 1e8).toFixed(1) + "亿";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
}

export function formatAxisToken(n) {
  if (!n || n === 0) return "0";
  if (n >= 1e8) return (n / 1e8).toFixed(1) + "亿";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
}

export function formatCny(v, fxRate) {
  if (!(v > 0) || !fxRate) return "";
  return "¥" + (fxRate * v).toFixed(2);
}

export function formatDual(v, fxRate, dispCur = "CNY") {
  const amount = Number.isFinite(v) ? Math.max(0, v) : 0;
  if (dispCur === "CNY" && fxRate > 0) {
    return "¥" + (amount * fxRate).toFixed(amount * fxRate >= 1 ? 2 : 4);
  }
  return "$" + (amount === 0 ? "0" : amount.toFixed(amount >= 1 ? 2 : 4));
}

export function convertToUsd(v, cur, fxRate) {
  if (cur === "CNY" && !(fxRate > 0)) return null;
  if (!(v > 0)) return 0;
  return cur === "CNY" ? v / fxRate : v;
}

export function formatDualByCurrency(v, cur, fxRate, dispCur = "CNY") {
  if (cur !== "CNY") return formatDual(v, fxRate, dispCur);
  if (dispCur === "CNY" || !(fxRate > 0)) {
    return "¥" + (v >= 1 ? v.toFixed(2) : v.toFixed(4));
  }
  return formatDual(v / fxRate, fxRate, dispCur);
}

export function formatLocalTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN") : "未知";
}
