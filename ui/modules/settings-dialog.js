// ui/modules/settings-dialog.js — 设置面板控制

import { getThemeMode, setThemeMode, syncHanaTheme, syncThemeUI } from "./theme.js";

export function initSettingsDialog({ onThemeChange, fetchFn } = {}) {
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
          const data = await res.json();
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
        const result = await res.json();
        if (!res.ok || result.error) {
          throw new Error(result.error || "保存失败");
        }
        currentSettings = result.settings || {
          scanInterval: scanVal,
          highUsageThreshold: highVal,
          showCodexQuota,
          showDeepseekBalance,
        };
        showMsg("设置已保存并生效");
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
