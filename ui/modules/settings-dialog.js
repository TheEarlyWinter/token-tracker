// ui/modules/settings-dialog.js — 设置面板控制

import { getThemeMode, setThemeMode, syncHanaTheme, syncThemeUI } from "./theme.js";

export function initSettingsDialog({ onThemeChange } = {}) {
  const btn = document.getElementById("st-btn");
  const panel = document.getElementById("set-panel");
  const shade = document.getElementById("set-shade");
  const close = document.getElementById("set-close");
  const save = document.getElementById("set-save");

  function openSet() {
    const isDark = document.body.getAttribute("data-theme") === "dark";
    syncThemeUI(isDark ? "dark" : "light", getThemeMode());
    if (shade) shade.style.display = "";
    if (panel) panel.style.display = "";
  }

  function closeSet() {
    if (shade) shade.style.display = "none";
    if (panel) panel.style.display = "none";
  }

  function saveSettings() {
    closeSet();
  }

  if (btn) btn.onclick = openSet;
  if (close) close.onclick = closeSet;
  if (shade) shade.onclick = closeSet;
  if (save) save.onclick = saveSettings;

  document.addEventListener("click", function (e) {
    const topt = e.target.closest(".set-theme-opt");
    if (topt) {
      setThemeMode(topt.dataset.v || "auto");
      const { theme, mode } = syncHanaTheme();
      if (typeof onThemeChange === "function") {
        onThemeChange(theme, mode);
      }
    }
  });

  return { openSet, closeSet };
}
