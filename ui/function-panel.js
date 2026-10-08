// ui/function-panel.js — 宿主功能面板 (Function Panel) Codex 额度与 DeepSeek 余额挂载模块
import { renderCodexQuotaCard } from "./modules/codex-card.js";
import { renderDeepSeekCard } from "./modules/deepseek-card.js";
import { hana } from "./assets/sdk.js";

function getAppApiBase() {
  const p = window.location.pathname || "";
  if (p.indexOf("/api/apps/token-tracker/routes") >= 0) {
    return p.split("/routes")[0] + "/routes";
  }
  return "/api/apps/token-tracker/routes";
}

async function fetchSettings() {
  if (window.hana?.api?.fetch) {
    try {
      const res = await window.hana.api.fetch(`/settings`);
      return await res.json();
    } catch {}
  }
  try {
    const res = await fetch(`${getAppApiBase()}/settings`);
    return await res.json();
  } catch {}
  return { showCodexQuota: true, showDeepseekBalance: true };
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

async function fetchDeepSeekBalance(force = false) {
  const query = force ? "?refresh=1" : "";
  if (window.hana?.api?.fetch) {
    try {
      const res = await window.hana.api.fetch(`/deepseek-balance${query}`);
      return await res.json();
    } catch {}
  }
  const res = await fetch(`${getAppApiBase()}/deepseek-balance${query}`);
  return await res.json();
}

export async function loadAndRender(force = false) {
  const codexSection = document.getElementById("fp-codex-section");
  const dsSection = document.getElementById("fp-deepseek-section");
  const emptyNotice = document.getElementById("fp-empty-notice");
  const codexSlot = document.getElementById("codex-card-slot");
  const dsSlot = document.getElementById("deepseek-card-slot");
  const refreshBtn = document.getElementById("fp-refresh");
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const settings = await fetchSettings();
    const showCodex = settings?.showCodexQuota !== false;
    const showDeepseek = settings?.showDeepseekBalance !== false;

    if (codexSection) {
      codexSection.style.display = showCodex ? "" : "none";
    }
    if (dsSection && !showDeepseek) {
      dsSection.style.display = "none";
    }
    if (emptyNotice) {
      emptyNotice.style.display = (!showCodex && !showDeepseek) ? "" : "none";
    }

    const tasks = [];
    if (showCodex) {
      tasks.push(
        fetchCodexQuota(force)
          .then(data => ({ type: "codex", data }))
          .catch(err => ({ type: "codex", err }))
      );
    }
    if (showDeepseek) {
      tasks.push(
        fetchDeepSeekBalance(force)
          .then(data => ({ type: "deepseek", data }))
          .catch(err => ({ type: "deepseek", err }))
      );
    }

    const results = await Promise.all(tasks);
    for (const res of results) {
      if (res.type === "codex") {
        if (res.data) renderCodexQuotaCard(codexSlot, res.data);
        else renderCodexQuotaCard(codexSlot, { connected: false, message: "额度加载失败，请重试" });
      } else if (res.type === "deepseek") {
        if (res.data) renderDeepSeekCard(dsSlot, res.data);
        else renderDeepSeekCard(dsSlot, { connected: false, message: "余额加载失败" });
      }
    }

    const hasVisibleSection = (codexSection && codexSection.style.display !== "none") ||
                              (dsSection && dsSection.style.display !== "none");
    if (emptyNotice) {
      if (!hasVisibleSection) {
        emptyNotice.style.display = "";
        const noticeText = (!showCodex && !showDeepseek)
          ? "已在设置中关闭功能面板卡片"
          : "暂无可展示的卡片（可前往设置开启或配置）";
        const quietEl = emptyNotice.querySelector(".sb-codex-quiet");
        if (quietEl) quietEl.textContent = noticeText;
      } else {
        emptyNotice.style.display = "none";
      }
    }
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

  // 跨上下文监听设置即时保存与额度更新通知，立即重新渲染，无需用户手动点击刷新
  try {
    const bc = new BroadcastChannel("token-tracker-channel");
    bc.onmessage = (event) => {
      if (event.data?.type === "tt-settings-updated" || event.data?.type === "tt-quota-updated") {
        loadAndRender(false);
      }
    };
  } catch {}

  try {
    window.addEventListener("storage", (e) => {
      if (e.key === "tt-settings-tick" || e.key === "tt-quota-tick") {
        loadAndRender(false);
      }
    });
  } catch {}

  try {
    window.addEventListener("message", (e) => {
      if (e.data?.type === "tt-settings-updated" || e.data?.type === "tt-quota-updated") {
        loadAndRender(false);
      }
    });
  } catch {}

  // 自动化刷新机制：
  // 1. 每 60 秒定时自动静默拉取（与服务端 60s 内存防刷缓存对齐）
  setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    loadAndRender(false);
  }, 60_000);

  // 2. 页面可见性恢复（从后台切回前台）自动静默刷新
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        loadAndRender(false);
      }
    });
  }

  // 3. 窗口重新获得焦点时自动静默刷新
  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => {
      loadAndRender(false);
    });
  }

  await loadAndRender(false);
}

if (typeof window !== "undefined") {
  initFunctionPanel();
}
