import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("Function Panel 静态模板与组件结构完整性", () => {
  const panelHtmlPath = path.join(rootDir, "ui", "function-panel.html");
  assert.ok(fs.existsSync(panelHtmlPath), "function-panel.html 文件必须存在");

  const html = fs.readFileSync(panelHtmlPath, "utf-8");
  assert.ok(html.includes('data-surface="function-panel"'), "包含 function-panel surface 标记");
  assert.ok(html.includes('href="./base.css"'), "引入基础极简样式 base.css");
  assert.ok(html.includes('href="./theme.css"'), "引入主题样式 theme.css");
  assert.ok(html.includes('id="fp-codex-section"'), "包含 fp-codex-section 分区");
  assert.ok(html.includes('id="fp-deepseek-section"'), "包含 fp-deepseek-section 分区");
  assert.ok(html.includes('id="fp-empty-notice"'), "包含 fp-empty-notice 空状态提示");
  assert.ok(html.includes('id="codex-card-slot"'), "包含 codex-card-slot 容器");
  assert.ok(html.includes('id="deepseek-card-slot"'), "包含 deepseek-card-slot 容器");
  assert.ok(html.includes('id="fp-refresh"'), "包含刷新按钮 fp-refresh");
  assert.ok(html.includes('src="./function-panel.js"'), "引入模块化逻辑 function-panel.js");

  const panelJsPath = path.join(rootDir, "ui", "function-panel.js");
  assert.ok(fs.existsSync(panelJsPath), "function-panel.js 文件必须存在");
  const js = fs.readFileSync(panelJsPath, "utf-8");
  assert.ok(js.includes("/settings"), "支持请求 settings 配置");
  assert.ok(js.includes("renderCodexQuotaCard"), "正确复用 Codex 卡片渲染函数");
  assert.ok(js.includes("/codex-quota"), "请求 codex-quota 路由");
  assert.ok(js.includes("renderDeepSeekCard"), "正确引入 DeepSeek 卡片渲染函数");
  assert.ok(js.includes("/deepseek-balance"), "请求 deepseek-balance 路由");
});
