import fs from "node:fs";
import path from "node:path";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderDashboardHtml({
  version = "6.5.2",
  theme = null,
  basePath = "",
  standalone = false,
} = {}) {
  const prefix = basePath ? (basePath.endsWith("/") ? basePath : `${basePath}/`) : "./";
  const themeAttr = theme ? ` data-hana-theme="${esc(theme)}"` : "";
  const statusHtml = standalone
    ? `<div id="app">正在加载 Token 用量看板…</div>`
    : `<div id="app"><p role="status">正在加载 Token 用量看板…</p></div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Token 用量</title>
  <link rel="stylesheet" href="${prefix}base.css">
  <link rel="stylesheet" href="${prefix}theme.css">
  <script src="${prefix}vendor/chart.umd.min.js"></script>
  <script src="${prefix}model-filter-options.js"></script>
</head>
<body${themeAttr} data-surface="page" data-ui-version="${esc(version)}">
  ${statusHtml}
  <script type="module" src="${prefix}bootstrap.js"></script>
</body>
</html>
`;
}

export function syncDashboardEntries(rootDir, version) {
  const uiDir = path.join(rootDir, "ui");
  const htmlContent = renderDashboardHtml({ version, basePath: "./", standalone: false });
  fs.writeFileSync(path.join(uiDir, "index.html"), htmlContent, "utf8");
  fs.writeFileSync(path.join(uiDir, `dashboard-v${version}.html`), htmlContent, "utf8");
}
