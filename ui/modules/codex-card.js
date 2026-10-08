function formatDuration(seconds) {
  if (typeof seconds !== "number" || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) {
    return `${h}h${m > 0 ? `${m}m` : ""}后重置`;
  }
  return `${m}m后重置`;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderCodexQuotaCard(container, quotaData) {
  if (!container) return;
  if (!quotaData || !quotaData.connected) {
    const msg = quotaData?.message || "未检测到 Codex 登录";
    container.innerHTML = `
      <div class="sb-codex-card sb-codex-dim">
        <div class="sb-codex-hdr">
          <span class="sb-codex-title">Codex 额度</span>
        </div>
        <div class="sb-codex-quiet">${esc(msg)}</div>
      </div>
    `;
    return;
  }

  const plan = quotaData.planLabel || quotaData.planType || "Codex";
  const credits = quotaData.resetCredits ?? 0;
  const primary = quotaData.primary;
  const secondary = quotaData.secondary;

  const priRem = primary?.remainingPercent != null ? Math.round(primary.remainingPercent) : null;
  const priReset = primary?.resetAfterSeconds ? formatDuration(primary.resetAfterSeconds) : "";
  const secRem = secondary?.remainingPercent != null ? Math.round(secondary.remainingPercent) : null;
  const secReset = secondary?.resetAfterSeconds ? formatDuration(secondary.resetAfterSeconds) : "";

  let primaryHtml = "";
  if (priRem !== null) {
    primaryHtml = `
      <div class="sb-codex-item">
        <div class="sb-codex-row">
          <span class="sb-codex-label">5h 窗口</span>
          <span class="sb-codex-val">${priRem}%</span>
        </div>
        <div class="sb-codex-track">
          <div class="sb-codex-bar" style="width:${Math.max(0, Math.min(100, priRem))}%"></div>
        </div>
        ${priReset ? `<div class="sb-codex-hint">${esc(priReset)}</div>` : ""}
      </div>
    `;
  }

  let secondaryHtml = "";
  if (secRem !== null) {
    secondaryHtml = `
      <div class="sb-codex-item">
        <div class="sb-codex-row">
          <span class="sb-codex-label">每周窗口</span>
          <span class="sb-codex-val">${secRem}%</span>
        </div>
        <div class="sb-codex-track">
          <div class="sb-codex-bar" style="width:${Math.max(0, Math.min(100, secRem))}%"></div>
        </div>
        ${secReset ? `<div class="sb-codex-hint">${esc(secReset)}</div>` : ""}
      </div>
    `;
  }

  container.innerHTML = `
    <div class="sb-codex-card">
      <div class="sb-codex-hdr">
        <span class="sb-codex-title">Codex 额度</span>
        <div class="sb-codex-badges">
          <span class="sb-codex-badge">${esc(plan)}</span>
          ${credits > 0 ? `<span class="sb-codex-credit">卡 ${credits}</span>` : ""}
        </div>
      </div>
      <div class="sb-codex-body">
        ${primaryHtml}
        ${secondaryHtml}
      </div>
    </div>
  `;
}
