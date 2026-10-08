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

export function initSettingsDialog({ onThemeChange, onSettingsSaved, fetchFn } = {}) {
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
