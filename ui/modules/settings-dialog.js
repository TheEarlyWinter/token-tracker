// ui/modules/settings-dialog.js — 设置面板控制

import { getThemeMode, setThemeMode, syncHanaTheme, syncThemeUI } from "./theme.js";

let settingsBc = null;
function getSettingsBroadcastChannel() {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!settingsBc) {
    try {
      settingsBc = new BroadcastChannel("token-tracker-channel");
      if (typeof settingsBc.unref === "function") {
        settingsBc.unref();
      }
    } catch {}
  }
  return settingsBc;
}

export function initSettingsDialog({ onThemeChange, onSettingsSaved, onGeminiConfigChanged, fetchFn } = {}) {
  const btn = document.getElementById("st-btn");
  const panel = document.getElementById("set-panel");
  const shade = document.getElementById("set-shade");
  const close = document.getElementById("set-close");
  const save = document.getElementById("set-save");
  const scanInput = document.getElementById("set-scan-interval");
  const highInput = document.getElementById("set-high-usage");
  const codexToggle = document.getElementById("set-show-codex");
  const dsToggle = document.getElementById("set-show-deepseek");
  const msgEl = document.getElementById("set-msg");
  const lithosInput = document.getElementById("set-lithos-cookie");
  const lithosSave = document.getElementById("set-lithos-save");
  const lithosStatus = document.getElementById("set-lithos-status");
  const dsKeyInput = document.getElementById("set-ds-key");
  const dsSave = document.getElementById("set-ds-save");
  const dsStatus = document.getElementById("set-ds-status");
  const geminiKeyInput = document.getElementById("set-gemini-key");
  const geminiSave = document.getElementById("set-gemini-save");
  const geminiClear = document.getElementById("set-gemini-clear");
  const geminiStatus = document.getElementById("set-gemini-status");

  let currentSettings = { scanInterval: 60, highUsageThreshold: 30000, showCodexQuota: true, showDeepseekBalance: true };
  let inFlightPromise = null;

  function loadSettingsData() {
    if (typeof fetchFn !== "function") return Promise.resolve(currentSettings);
    if (inFlightPromise) return inFlightPromise;
    inFlightPromise = (async () => {
      try {
        const res = await fetchFn("/settings");
        if (res && res.ok) {
          let data = null;
          try {
            data = await res.json();
          } catch {
            data = null;
          }
          if (data && typeof data.scanInterval === "number") {
            currentSettings = data;
            if (scanInput) scanInput.value = String(data.scanInterval);
            if (highInput) highInput.value = String(data.highUsageThreshold ?? 30000);
            if (codexToggle) codexToggle.checked = data.showCodexQuota !== false;
            if (dsToggle) dsToggle.checked = data.showDeepseekBalance !== false;
          }
        }
      } catch {
        // 忽略拉取错误，保持界面当前输入值
      } finally {
        inFlightPromise = null;
      }
      return currentSettings;
    })();
    return inFlightPromise;
  }

  function setDsStatus(text, isError = false) {
    if (!dsStatus) return;
    dsStatus.textContent = text;
    dsStatus.style.color = isError ? "var(--orange)" : "var(--text-tertiary)";
  }

  function setGeminiStatus(text, isError = false) {
    if (!geminiStatus) return;
    geminiStatus.textContent = text;
    geminiStatus.style.color = isError ? "var(--orange)" : "var(--text-tertiary)";
  }

  async function loadGeminiConfig() {
    if (typeof fetchFn !== "function" || !geminiStatus) return;
    try {
      const res = await fetchFn("/gemini-quota/config");
      const data = await res.json();
      if (!res.ok || !data || typeof data.configured !== "boolean") throw new Error("config_status_unavailable");
      const baseUrl = typeof data.baseUrl === "string" ? data.baseUrl : "";
      setGeminiStatus(data.configured
        ? `已配置 · ${baseUrl || "指定 CPA 主机"}`
        : `未配置${baseUrl ? ` · ${baseUrl}` : ""}`);
    } catch {
      setGeminiStatus("安全状态暂不可用", true);
    }
  }

  async function submitGeminiConfig(action, managementKey = "") {
    if (typeof fetchFn !== "function") return;
    const buttons = [geminiSave, geminiClear].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    setGeminiStatus(action === "clear" ? "正在清空…" : "正在保存…");
    try {
      const payload = action === "clear" ? { action: "clear" } : { action: "save", managementKey };
      const res = await fetchFn("/gemini-quota/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok || !data || typeof data.configured !== "boolean") throw new Error("gemini_config_failed");
      if (geminiKeyInput) geminiKeyInput.value = "";
      const baseUrl = typeof data.baseUrl === "string" ? data.baseUrl : "";
      setGeminiStatus(data.configured
        ? `已配置 · ${baseUrl || "指定 CPA 主机"}`
        : `未配置${baseUrl ? ` · ${baseUrl}` : ""}`);
      const configured = data.configured === true;
      try {
        getSettingsBroadcastChannel()?.postMessage({ type: "tt-gemini-config-updated", action, configured });
      } catch {}
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem("tt-gemini-config-tick", `${action}:${configured ? "1" : "0"}:${Date.now()}`);
        }
      } catch {}
      try {
        if (typeof window !== "undefined" && window.parent) {
          window.parent.postMessage({ type: "tt-gemini-config-updated", action, configured }, "*");
        }
      } catch {}
      if (typeof onGeminiConfigChanged === "function") onGeminiConfigChanged(action, data);
    } catch {
      setGeminiStatus(action === "clear" ? "清空失败，请重试" : "保存失败，请重试", true);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  if (geminiSave) {
    geminiSave.onclick = async () => {
      const managementKey = geminiKeyInput?.value?.trim() || "";
      if (!managementKey) {
        setGeminiStatus("请输入管理密钥", true);
        return;
      }
      await submitGeminiConfig("save", managementKey);
    };
  }

  if (geminiClear) {
    geminiClear.onclick = async () => {
      await submitGeminiConfig("clear");
    };
  }

  // DeepSeek 余额卡消失最常见的原因：宿主里删掉了 DeepSeek 供应商，凭据跟着没了。
  // 所以这里允许单独填一把「只用来查余额」的 key，存在 balance-apis.json，不碰供应商配置。
  async function loadDsStatus() {
    if (typeof fetchFn !== "function") return;
    try {
      const res = await fetchFn("/deepseek-balance");
      const data = await res.json();
      if (data?.connected) setDsStatus(`已连接 · 余额 ${data.display || "—"}`);
      else if (data?.reason === "not_connected") setDsStatus("未配置密钥（宿主里没有 DeepSeek 供应商时会这样）");
      else setDsStatus(data?.message || "查询失败", true);
    } catch {
      setDsStatus("查询失败", true);
    }
  }

  if (dsSave) {
    dsSave.onclick = async () => {
      const apiKey = dsKeyInput?.value?.trim() || "";
      if (!apiKey) {
        setDsStatus("先填 API Key", true);
        return;
      }
      dsSave.disabled = true;
      setDsStatus("正在保存并查询…");
      try {
        const saveRes = await fetchFn("/balance-apis", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deepseek: { apiKey } }),
        });
        if (!saveRes.ok) {
          setDsStatus("保存失败（HTTP " + saveRes.status + "）", true);
          return;
        }
        const res = await fetchFn("/deepseek-balance?refresh=1");
        const data = await res.json();
        if (data?.connected) {
          setDsStatus(`已连接 · 余额 ${data.display || "—"}`);
          if (dsKeyInput) dsKeyInput.value = "";
        } else {
          setDsStatus(data?.message || "已保存，但查询失败", true);
        }
        try {
          getSettingsBroadcastChannel()?.postMessage({ type: "tt-quota-updated" });
        } catch {}
      } catch (e) {
        setDsStatus("保存失败：" + (e?.message || String(e)), true);
      } finally {
        dsSave.disabled = false;
      }
    };
  }

  function setLithosStatus(text, isError = false) {
    if (!lithosStatus) return;
    lithosStatus.textContent = text;
    lithosStatus.style.color = isError ? "var(--orange)" : "var(--text-tertiary)";
  }

  // Lithos 余额只能走控制台会话，所以设置页只管「粘 Cookie」这件事。
  // 打开面板时问一次现状：已连接就把余额写出来，别让用户猜它到底配没配。
  async function loadLithosStatus() {
    if (typeof fetchFn !== "function") return;
    try {
      const res = await fetchFn("/lithos-balance");
      const data = await res.json();
      if (data?.connected) setLithosStatus(`已连接 · 余额 ${data.display || "—"}`);
      else if (!data?.configured) setLithosStatus("未配置");
      else setLithosStatus(data?.message || "已配置，但这次查询失败", true);
    } catch {
      setLithosStatus("查询失败", true);
    }
  }

  if (lithosSave) {
    lithosSave.onclick = async () => {
      const cookie = lithosInput?.value?.trim() || "";
      if (!cookie) {
        setLithosStatus("先粘贴 Cookie 请求头", true);
        return;
      }
      lithosSave.disabled = true;
      setLithosStatus("正在保存并查询…");
      try {
        const res = await fetchFn("/lithos-balance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cookie }),
        });
        const data = await res.json();
        if (!res.ok || data?.ok === false) {
          setLithosStatus(data?.message || "保存失败", true);
        } else {
          const b = data.balance || {};
          if (b.connected) {
            setLithosStatus(`已连接 · 余额 ${b.display || "—"}`);
            if (lithosInput) lithosInput.value = "";
          } else {
            setLithosStatus(b.message || "已保存，但查询失败", true);
          }
          try {
            getSettingsBroadcastChannel()?.postMessage({ type: "tt-quota-updated" });
          } catch {}
        }
      } catch (e) {
        setLithosStatus("保存失败：" + (e?.message || String(e)), true);
      } finally {
        lithosSave.disabled = false;
      }
    };
  }

  function showMsg(text, isError = false) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = "set-feedback " + (isError ? "error" : "success");
    msgEl.style.display = "block";
    setTimeout(() => {
      if (msgEl) msgEl.style.display = "none";
    }, 2500);
  }

  function openSet() {
    const isDark = document.body?.getAttribute?.("data-theme") === "dark";
    syncThemeUI(isDark ? "dark" : "light", getThemeMode());
    if (shade) shade.style.display = "";
    if (panel) panel.style.display = "";
    loadLithosStatus();
    loadDsStatus();
    loadGeminiConfig();
    loadSettingsData();
  }

  function closeSet() {
    if (shade) shade.style.display = "none";
    if (panel) panel.style.display = "none";
    if (msgEl) msgEl.style.display = "none";
  }

  async function saveSettings() {
    const scanVal = parseInt(scanInput?.value, 10);
    const highVal = parseInt(highInput?.value, 10);
    const showCodexQuota = codexToggle ? Boolean(codexToggle.checked) : true;
    const showDeepseekBalance = dsToggle ? Boolean(dsToggle.checked) : true;

    if (isNaN(scanVal) || scanVal < 5) {
      showMsg("扫描间隔必须为 ≥ 5 的整数秒", true);
      return;
    }
    if (isNaN(highVal) || highVal < 0) {
      showMsg("高消耗阈值必须为 ≥ 0 的整数", true);
      return;
    }

    if (typeof fetchFn === "function" && save) {
      save.disabled = true;
      save.textContent = "保存中…";
      try {
        const res = await fetchFn("/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scanInterval: scanVal,
            highUsageThreshold: highVal,
            showCodexQuota,
            showDeepseekBalance,
          }),
        });
        let result = null;
        try {
          result = await res.json();
        } catch {
          result = null;
        }
        if (!res.ok || result?.error) {
          const detail = result?.error || (res?.status ? `保存失败 (${res.status}${res.statusText ? ` ${res.statusText}` : ""})` : "保存失败，响应异常");
          throw new Error(detail);
        }
        currentSettings = result.settings || {
          scanInterval: scanVal,
          highUsageThreshold: highVal,
          showCodexQuota,
          showDeepseekBalance,
        };
        showMsg("设置已保存并生效");

        // 广播跨上下文即时通知，驱动左侧功能面板等视图无需手动刷新即可即刻重绘
        try {
          const bc = getSettingsBroadcastChannel();
          if (bc) {
            bc.postMessage({ type: "tt-settings-updated", settings: currentSettings });
            // 注意：绝不能立刻 bc.close()，在 Chromium / Electron 内核中会导致尚未派发的广播被强行终止
          }
        } catch {}
        try {
          if (typeof localStorage !== "undefined") {
            // 双重保障触发：随机数+时间戳确保 storage 事件必触发，并存入最新配置数据供极速提取
            localStorage.setItem("tt-settings-tick", Date.now() + "_" + Math.random());
            localStorage.setItem("tt-settings-data", JSON.stringify(currentSettings));
          }
        } catch {}
        try {
          if (typeof window !== "undefined" && window.parent) {
            window.parent.postMessage({ type: "tt-settings-updated", settings: currentSettings }, "*");
          }
        } catch {}

        if (typeof onSettingsSaved === "function") {
          onSettingsSaved(currentSettings);
        }

        setTimeout(closeSet, 800);
      } catch (err) {
        showMsg(err.message, true);
      } finally {
        if (save) {
          save.disabled = false;
          save.textContent = "保存";
        }
      }
    } else {
      closeSet();
    }
  }

  if (btn) btn.onclick = openSet;
  if (close) close.onclick = closeSet;
  if (shade) shade.onclick = closeSet;
  if (save) save.onclick = saveSettings;

  document.addEventListener("click", function (e) {
    const topt = e.target.closest?.(".set-theme-opt");
    if (topt) {
      setThemeMode(topt.dataset.v || "auto");
      const { theme, mode } = syncHanaTheme();
      if (typeof onThemeChange === "function") {
        onThemeChange(theme, mode);
      }
    }
  });

  loadSettingsData();

  return { openSet, closeSet, loadSettingsData, saveSettings, getSettings: () => currentSettings };
}
