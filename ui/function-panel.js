// ui/function-panel.js — 宿主功能面板 (Function Panel) Codex 额度与 DeepSeek 余额挂载模块
import { renderCodexQuotaCard } from "./modules/codex-card.js";
import { renderDeepSeekCard } from "./modules/deepseek-card.js";
import { renderLithosCard } from "./modules/lithos-card.js";
import { hana } from "./assets/sdk.js";

// 常驻顶层 BroadcastChannel 引用，防止局部变量被垃圾回收 (GC) 导致监听器失效
let panelBc = null;
const RESET_MODAL_WAIT_MS = 400;
function getPanelBroadcastChannel() {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!panelBc) {
    try {
      panelBc = new BroadcastChannel("token-tracker-channel");
      if (typeof panelBc.unref === "function") {
        panelBc.unref();
      }
    } catch {}
  }
  return panelBc;
}

function getAppApiBase() {
  const p = window.location.pathname || "";
  if (p.indexOf("/api/apps/token-tracker/routes") >= 0) {
    return p.split("/routes")[0] + "/routes";
  }
  return "/api/apps/token-tracker/routes";
}

async function fetchSettings() {
  const query = `?_t=${Date.now()}`;
  if (window.hana?.api?.fetch) {
    try {
      const res = await window.hana.api.fetch(`/settings${query}`);
      return await res.json();
    } catch {}
  }
  try {
    const res = await fetch(`${getAppApiBase()}/settings${query}`);
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

export async function fetchResetCredits(force = false) {
  const query = force ? "?refresh=1" : "";
  if (window.hana?.api?.fetch) {
    try {
      const res = await window.hana.api.fetch(`/codex-reset-credits${query}`);
      return await res.json();
    } catch {}
  }
  try {
    const res = await fetch(`${getAppApiBase()}/codex-reset-credits${query}`);
    return await res.json();
  } catch {
    return { connected: false, message: "网络请求失败", credits: [] };
  }
}

export async function consumeResetCredit(creditId) {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creditId }),
  };
  if (window.hana?.api?.fetch) {
    try {
      const res = await window.hana.api.fetch("/codex-reset-credits/consume", init);
      return await res.json();
    } catch (e) {
      return { ok: false, message: e.message || "请求失败" };
    }
  }
  try {
    const res = await fetch(`${getAppApiBase()}/codex-reset-credits/consume`, init);
    return await res.json();
  } catch (e) {
    return { ok: false, message: e.message || "请求失败" };
  }
}

async function fetchLithosBalance(force = false) {
  const query = force ? "?refresh=1" : "";
  if (window.hana?.api?.fetch) {
    try {
      const res = await window.hana.api.fetch(`/lithos-balance${query}`);
      return await res.json();
    } catch {}
  }
  const res = await fetch(`${getAppApiBase()}/lithos-balance${query}`);
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

export async function loadAndRender(force = false, directSettings = null) {
  const codexSection = document.getElementById("fp-codex-section");
  const dsSection = document.getElementById("fp-deepseek-section");
  const emptyNotice = document.getElementById("fp-empty-notice");
  const codexSlot = document.getElementById("codex-card-slot");
  const dsSlot = document.getElementById("deepseek-card-slot");
  const lithosSection = document.getElementById("fp-lithos-section");
  const lithosSlot = document.getElementById("lithos-card-slot");
  const refreshBtn = document.getElementById("fp-refresh");
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    // 若外部传入了即时设置对象（如广播通知或本地存储缓存），优先直接使用，不等网络回包即完成毫秒级 UI 切换
    const settings = directSettings || await fetchSettings();
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
    // LithosAI 卡自己决定显不显示（没配 Cookie 就整块隐藏），不走设置开关。
    tasks.push(
      fetchLithosBalance(force)
        .then(data => ({ type: "lithos", data }))
        .catch(err => ({ type: "lithos", err }))
    );
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
        if (res.data) {
          renderCodexQuotaCard(codexSlot, res.data, {
            onFetchResetCredits: fetchResetCredits,
            onConsumeResetCredit: consumeResetCredit,
            onRefresh: (f) => loadAndRender(f),
            onOpenResetModal: async () => {
              const bc = getPanelBroadcastChannel();
              if (!bc) return false;
              const requestId = `reset-modal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

              return new Promise((resolve) => {
                let settled = false;
                let ackTimer = null;
                const expiresAt = Date.now() + RESET_MODAL_WAIT_MS;
                const cleanup = () => {
                  if (ackTimer) {
                    clearTimeout(ackTimer);
                    ackTimer = null;
                  }
                  try { bc.removeEventListener("message", onMsg); } catch {}
                };
                const finish = (handled) => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  resolve(handled);
                };
                const onMsg = (e) => {
                  if (e.data?.type !== "reset-credits-modal-ack" || e.data?.requestId !== requestId) return;
                  const ackExpiresAt = e.data?.expiresAt;
                  if (Number.isFinite(ackExpiresAt) && ackExpiresAt <= Date.now()) return;
                  finish(true);
                };

                try {
                  bc.addEventListener("message", onMsg);
                  ackTimer = setTimeout(() => finish(false), RESET_MODAL_WAIT_MS);
                  bc.postMessage({ type: "open-reset-credits-modal", requestId, expiresAt });
                } catch {
                  finish(false);
                }
              });
            },
          });
        } else {
          renderCodexQuotaCard(codexSlot, { connected: false, message: "额度加载失败，请重试" });
        }
      } else if (res.type === "deepseek") {
        if (res.data) renderDeepSeekCard(dsSlot, res.data);
        else renderDeepSeekCard(dsSlot, { connected: false, message: "余额加载失败" });
      } else if (res.type === "lithos") {
        // 没数据也算「没配」：卡按 not_configured 处理，自己隐藏
        if (res.data) renderLithosCard(lithosSlot, res.data);
        else renderLithosCard(lithosSlot, { reason: "not_configured" });
      }
    }

    const hasVisibleSection = (codexSection && codexSection.style.display !== "none") ||
                              (dsSection && dsSection.style.display !== "none") ||
                              (lithosSection && lithosSection.style.display !== "none");
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
    const bc = getPanelBroadcastChannel();
    if (bc) {
      bc.onmessage = (event) => {
        if (event.data?.type === "tt-settings-updated") {
          loadAndRender(false, event.data?.settings || null);
        } else if (event.data?.type === "tt-quota-updated") {
          loadAndRender(false);
        }
      };
    }
  } catch {}

  try {
    window.addEventListener("storage", (e) => {
      if (e.key === "tt-settings-tick") {
        let cachedSettings = null;
        try {
          const raw = localStorage.getItem("tt-settings-data");
          if (raw) cachedSettings = JSON.parse(raw);
        } catch {}
        loadAndRender(false, cachedSettings);
      } else if (e.key === "tt-quota-tick") {
        loadAndRender(false);
      }
    });
  } catch {}

  try {
    window.addEventListener("message", (e) => {
      if (e.data?.type === "tt-settings-updated") {
        loadAndRender(false, e.data?.settings || null);
      } else if (e.data?.type === "tt-quota-updated") {
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
