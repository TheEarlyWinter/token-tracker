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

  // 未连接或未配置时，静默折叠隐藏，不产生视觉占位与噪音
  if (!balanceData || !balanceData.connected) {
    container.innerHTML = "";
    if (parentSection) parentSection.style.display = "none";
    return;
  }

  if (parentSection) parentSection.style.display = "";

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
}
