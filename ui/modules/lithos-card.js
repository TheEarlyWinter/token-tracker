// ui/modules/lithos-card.js — LithosAI 预付余额微卡
import { bindTopup } from "../external-link.js";
//
// 显示规则：
//   · 没配置 Cookie → 整块隐藏，不留空位（跟 DeepSeek 卡一样，不制造噪音）
//   · 会话过期 / 连不上 → 卡片留着，写清楚原因与怎么修（这是要用户动手的事，不能藏）
//   · 有余额 → 余额 + 是否有卡 / 是否被 hold
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderLithosCard(container, data) {
  if (!container) return;
  const parentSection = container.closest ? container.closest(".fp-section") : container.parentElement;

  // 未配置就是没这件事：整块隐藏
  if (!data || data.reason === "not_configured") {
    container.innerHTML = "";
    if (parentSection) parentSection.style.display = "none";
    return;
  }

  if (parentSection) parentSection.style.display = "";

  if (!data.connected) {
    const hint = data.reason === "session_expired"
      ? "在控制台重新登录，再到设置里粘一次 Cookie"
      : "";
    container.innerHTML = `
      <div class="sb-codex-card">
        <div class="sb-codex-hdr">
          <span class="sb-codex-title">LithosAI 余额</span>
          <div class="sb-codex-badges"><span class="sb-codex-badge">USD</span></div>
        </div>
        <div class="sb-codex-body">
          <div class="sb-codex-item">
            <div class="sb-codex-quiet">${esc(data.message || "查询失败")}</div>
            ${hint ? `<div class="sb-codex-hint">${esc(hint)}</div>` : ""}
          </div>
        </div>
      </div>
    `;
    return;
  }

  // 只给会影响使用的状态挂标签。
  // 「未绑卡」不放：它是支付方式的状态，不是当下的问题，平时挂着只是噪音。
  const badges = [];
  if (data.onHold) badges.push('<span class="sb-codex-badge">已冻结</span>');

  container.innerHTML = `
    <div class="sb-codex-card">
      <div class="sb-codex-hdr">
        <span class="sb-codex-title">LithosAI 余额</span>
        <div class="sb-codex-badges">
          ${badges.join("")}
          <span class="sb-codex-badge">${esc(data.currency || "USD")}</span>
          <button type="button" class="sb-codex-topup" data-topup="lithos" title="在 LithosAI 控制台充值">充值 ↗</button>
        </div>
      </div>
      <div class="sb-codex-body">
        <div class="sb-codex-item">
          <div class="sb-codex-row">
            <span class="sb-codex-label">预付余额</span>
            <span class="sb-codex-val">${esc(data.display || "—")}</span>
          </div>
          ${data.organization?.name ? `<div class="sb-codex-hint">${esc(data.organization.name)}</div>` : ""}
        </div>
      </div>
    </div>
  `;
  bindTopup(container);
}

export default { renderLithosCard };
