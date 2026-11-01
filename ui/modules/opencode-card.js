// ui/modules/opencode-card.js — OpenCode Go 订阅用量卡片
//
// 只展示官方端点给的百分比窗口（5 小时 / 本周 / 本月）与重置倒计时。
// 不按价格表倒推美元金额：端点没有美元字段，写上去就是编数字。
import { fmtReset } from "./subscription-quotas.js";

const WINDOW_LABELS = {
  rolling: "5 小时窗口",
  weekly: "本周窗口",
  monthly: "本月窗口",
};

// 与 subscription-quotas 的配色口径一致：越接近上限越提醒。
// 只用在进度条上；数字本身用卡片常规前景色，不跟着绿/橙/红跑。
function usedColor(p) {
  if (p >= 80) return "var(--red, #e11d48)";
  if (p >= 60) return "var(--orange, #d97706)";
  return "var(--green, #15803d)";
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtPct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return (value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)) + "%";
}

// 上游其中一种形状会直接给官方 used/limit（美元），有就写出来：这是官方数字，不是估算。
function fmtMoney(used, limit) {
  if (typeof used !== "number" || typeof limit !== "number") return "";
  const trim = (v) => (v >= 1 ? v.toFixed(2) : v.toFixed(4));
  return "$" + trim(used) + " / $" + trim(limit);
}

// 「没配过」与「配了但坏了」要分开：前者给填 Key 的入口，后者把真实原因写出来。
const NEVER_CONFIGURED = ["", "not_connected", "not_configured", "no_credentials"];

export function renderOpenCodeQuotaCard(container, quota, handlers = {}) {
  if (!container) return;

  const reason = quota?.reason || "";
  const notConfigured = !quota || (quota.connected === false && NEVER_CONFIGURED.includes(reason));

  if (notConfigured) {
    container.innerHTML = `
      <div class="sb-codex-card sb-og-card">
        <div class="sb-codex-hdr">
          <span class="sb-codex-title">OpenCode Go</span>
          <div class="sb-codex-badges"><span class="sb-codex-badge">未配置</span></div>
        </div>
        <div class="sb-codex-body">
          <div class="sb-codex-quiet">填入 oc_sk_ 开头的 API Key 才能读订阅用量。控制台 Cookie 在这里不管用。</div>
          <div class="sb-og-form">
            <input class="sb-og-input" type="password" id="og-key-input" placeholder="oc_sk_…" autocomplete="off" spellcheck="false" />
            <button type="button" class="sb-codex-topup" id="og-key-save">保存</button>
          </div>
          <div class="sb-og-msg" id="og-key-msg"></div>
        </div>
      </div>
    `;
    wireForm(container, handlers);
    return;
  }

  if (!quota.connected) {
    container.innerHTML = `
      <div class="sb-codex-card sb-og-card">
        <div class="sb-codex-hdr">
          <span class="sb-codex-title">OpenCode Go</span>
          <div class="sb-codex-badges"><span class="sb-codex-badge">—</span></div>
        </div>
        <div class="sb-codex-body">
          <div class="sb-codex-quiet">${esc(quota.message || "用量查询失败")}</div>
        </div>
      </div>
    `;
    return;
  }

  const windows = Array.isArray(quota.windows) ? quota.windows : [];
  let body = "";
  for (const win of windows) {
    const label = WINDOW_LABELS[win.level] || win.level;
    if (!win.known || typeof win.usedPercent !== "number") {
      body += `
        <div class="sb-codex-item">
          <div class="sb-codex-row">
            <span class="sb-codex-label">${esc(label)}</span>
            <span class="sb-codex-val">—</span>
          </div>
          <div class="sb-codex-hint">这个窗口本次没给数据</div>
        </div>
      `;
      continue;
    }
    const used = Math.min(100, Math.max(0, win.usedPercent));
    const color = usedColor(used);
    const resetHint = win.resetInSec === null || win.resetInSec === undefined
      ? ""
      : fmtReset(win.resetInSec);
    const money = fmtMoney(win.usedUsd, win.limitUsd);
    const hintParts = [];
    if (money) hintParts.push(money);
    hintParts.push(resetHint || "剩余 " + fmtPct(win.remainingPercent));
    body += `
      <div class="sb-codex-item">
        <div class="sb-codex-row">
          <span class="sb-codex-label">${esc(label)}</span>
          <span class="sb-codex-val">已用 ${fmtPct(used)}</span>
        </div>
        <div class="sb-codex-track">
          <div class="sb-codex-bar" style="width:${used}%;background:${color}"></div>
        </div>
        <div class="sb-codex-hint">${esc(hintParts.join(" · "))}</div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="sb-codex-card sb-og-card">
      <div class="sb-codex-hdr">
        <span class="sb-codex-title">OpenCode Go</span>
        <div class="sb-codex-badges"><span class="sb-codex-badge">官方</span></div>
      </div>
      <div class="sb-codex-body">${body}</div>
    </div>
  `;
}

function wireForm(container, handlers) {
  const input = container.querySelector("#og-key-input");
  const button = container.querySelector("#og-key-save");
  const msg = container.querySelector("#og-key-msg");
  if (!button) return;

  const setMsg = (text, ok) => {
    if (!msg) return;
    msg.textContent = text;
    msg.style.color = ok ? "var(--green, #15803d)" : "var(--red, #e11d48)";
  };

  const save = async () => {
    const key = input ? String(input.value || "").trim() : "";
    if (!key) {
      setMsg("先填 Key", false);
      return;
    }
    button.disabled = true;
    setMsg("正在验证…", true);
    try {
      const res = await handlers.onSaveKey?.(key);
      if (!res || res.ok === false) {
        setMsg(res?.message || "保存失败", false);
        return;
      }
      if (input) input.value = "";
      const quota = res.quota || res;
      if (quota && quota.connected === false) {
        setMsg(quota.message || "Key 已保存，但查不到用量", false);
      } else {
        setMsg("已保存", true);
      }
      await handlers.onRefresh?.(true);
    } catch (err) {
      setMsg(err?.message || "保存失败", false);
    } finally {
      button.disabled = false;
    }
  };

  button.addEventListener("click", save);
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e?.key === "Enter") save();
    });
  }
}
