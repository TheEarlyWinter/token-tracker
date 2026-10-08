// ui/function-panel.js — 宿主功能面板 (Function Panel) Codex 额度与状态挂载模块
import { renderCodexQuotaCard } from "./modules/codex-card.js";
import { hana } from "./assets/sdk.js";

function getAppApiBase() {
  const p = window.location.pathname || "";
  if (p.indexOf("/api/apps/token-tracker/routes") >= 0) {
    return p.split("/routes")[0] + "/routes";
  }
  return "/api/apps/token-tracker/routes";
}

async function fetchCodexQuota(force = false) {
  const query = force ? "?refresh=1" : "";
  if (window.hana?.api?.fetch) {
    try {
      const res = await window.hana.api.fetch(`/codex-quota${query}`);
      return await res.json();
    } catch {}
  }
  const res = await fetch(`${getAppApiBase()}/codex-quota${query}`);
  return await res.json();
}

async function loadAndRender(force = false) {
  const slot = document.getElementById("codex-card-slot");
  const refreshBtn = document.getElementById("fp-refresh");
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const data = await fetchCodexQuota(force);
    renderCodexQuotaCard(slot, data);
  } catch (err) {
    renderCodexQuotaCard(slot, {
      connected: false,
      message: "额度加载失败，请重试",
    });
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

export async function initFunctionPanel() {
  try {
    const isAppSurface = window.location?.pathname?.startsWith("/api/apps/token-tracker/ui/");
    if (window.parent && window.parent !== window && (window.hana || isAppSurface)) {
      window.hana ||= hana;
      window.hana?.ready?.();
    }
  } catch {}

  const refreshBtn = document.getElementById("fp-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadAndRender(true));
  }

  await loadAndRender(false);
}

if (typeof window !== "undefined") {
  initFunctionPanel();
}
