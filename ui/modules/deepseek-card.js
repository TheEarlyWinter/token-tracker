import { bindTopup } from "../external-link.js";

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderDeepSeekCard(container, balanceData) {
  if (!container) return;
  const parentSection = container.closest ? container.closest(".fp-section") : container.parentElement;

  // 真正该藏只有一种情况：从来没配过（宿主没有 DeepSeek 供应商，也没单独填 key）。
  // 以前只要 connected 为假就藏，于是「有 key 但失效」「余额接口抽风」都变成卡片突然消失，
  // 看上去像功能坏了。现在除「未配置」以外都把真实原因写出来。
  const reason = balanceData?.reason || "";
  // 这几种都是「从来没配过」，与「配了但坏了」是两回事：
  //   not_connected / not_configured 是现在的服务返回，no_credentials 是历史字段名，一并认。
  const NEVER_CONFIGURED = ["", "not_connected", "not_configured", "no_credentials"];
  const notConfigured = !balanceData || (balanceData.connected === false && NEVER_CONFIGURED.includes(reason));
  if (notConfigured) {
    container.innerHTML = "";
    if (parentSection) parentSection.style.display = "none";
    return;
  }

  if (parentSection) parentSection.style.display = "";

  if (!balanceData.connected) {
    container.innerHTML = `
      <div class="sb-codex-card">
        <div class="sb-codex-hdr">
          <span class="sb-codex-title">DeepSeek 余额</span>
          <div class="sb-codex-badges"><span class="sb-codex-badge">—</span></div>
        </div>
        <div class="sb-codex-body">
          <div class="sb-codex-item">
            <div class="sb-codex-quiet">${esc(balanceData.message || "余额查询失败")}</div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const currency = balanceData.currency || "CNY";
  const display = balanceData.display || "¥0.00";
  const granted = balanceData.granted ?? 0;
  const symbol = balanceData.symbol || (currency === "USD" ? "$" : "¥");
  const grantedBal = balanceData.grantedBalance || "0.00";

  container.innerHTML = `
    <div class="sb-codex-card">
      <div class="sb-codex-hdr">
        <span class="sb-codex-title">DeepSeek 余额</span>
        <div class="sb-codex-badges">
          <span class="sb-codex-badge">${esc(currency)}</span>
          <button type="button" class="sb-codex-topup" data-topup="deepseek" title="在 DeepSeek 控制台充值">充值 ↗</button>
        </div>
      </div>
      <div class="sb-codex-body">
        <div class="sb-codex-item">
          <div class="sb-codex-row">
            <span class="sb-codex-label">账户余额</span>
            <span class="sb-codex-val">${esc(display)}</span>
          </div>
          ${granted > 0 ? `<div class="sb-codex-hint">含赠送 ${symbol}${esc(grantedBal)}</div>` : ""}
        </div>
      </div>
    </div>
  `;
  bindTopup(container);
}
