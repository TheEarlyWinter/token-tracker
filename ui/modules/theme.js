// ui/modules/theme.js — 主题与深浅色模式管理
export const THEME_STORAGE_KEY = "tt-theme";

export const ICON_SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
export const ICON_MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

export function getThemeMode() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || "auto";
  } catch (e) {
    return "auto";
  }
}

export function setThemeMode(mode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch (e) {}
}

export function syncThemeUI(theme, mode) {
  const btn = document.getElementById("th-btn");
  if (btn) {
    const isDark = theme === "dark";
    btn.title = isDark ? "切换浅色模式" : "切换深色模式";
    btn.innerHTML = isDark ? ICON_SUN : ICON_MOON;
  }
  const options = document.querySelectorAll(".set-theme-opt");
  for (let i = 0; i < options.length; i++) {
    options[i].classList.toggle("on", options[i].dataset.v === mode);
  }
}

export function syncHanaTheme({ onThemeChange } = {}) {
  const mode = getThemeMode();
  let theme;
  if (mode === "light") {
    theme = "light";
  } else if (mode === "dark") {
    theme = "dark";
  } else {
    const hostTheme = document.body.getAttribute("data-hana-theme") || "warm-paper";
    if (hostTheme === "midnight") {
      theme = "dark";
    } else if (hostTheme === "warm-paper") {
      theme = "light";
    } else if (hostTheme === "inherit" || hostTheme === "system") {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      theme = "light";
    }
  }
  document.body.setAttribute("data-theme", theme);
  syncThemeUI(theme, mode);
  if (typeof onThemeChange === "function") {
    onThemeChange(theme, mode);
  }
  return { theme, mode };
}

export function toggleTheme({ onThemeChange } = {}) {
  const current = document.body.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const target = current === "dark" ? "light" : "dark";
  setThemeMode(target);
  return syncHanaTheme({ onThemeChange });
}
