import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("Manifest V2 合规性与权限最小化校验", () => {
  const manifestPath = path.join(rootDir, "manifest.json");
  assert.ok(fs.existsSync(manifestPath), "manifest.json 必须存在");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  assert.equal(manifest.manifestVersion, 2, "manifestVersion 必须为 2");
  assert.equal(manifest.id, "token-tracker", "id 必须为 token-tracker");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "正式版本必须是三段数字");
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  assert.equal(packageJson.version, manifest.version, "package.json 与 manifest 版本必须一致");
  assert.equal(manifest.minAppVersion, "0.1050.9", "输入状态位需要宿主 0.1050.9 或更新版本");
  assert.equal(manifest.entry, "index.js", "entry 必须为 index.js");

  // 必须声明且仅声明最小必要权限（含受管子进程执行）
  const expectedCaps = [
    "app/usage.read",
    "app/runtime.execute",
    "app/runtime.network",
    "app/input.status",
    "app/ui.clipboard-write",
    "app/hooks.provider-before-request",
    "app/hooks.observe",
    "app/hooks.messages-post-assistant",
    "app/provider.credentials.read",
    "app/agents.read",
    "app/sessions.read",
    "app/media.tasks.read",
    "app/resources.write",
  ];
  assert.deepEqual(
    [...manifest.capabilities].sort(),
    expectedCaps.sort(),
    "capabilities 必须精准对应最小必要权限列表"
  );

  const inputStatus = manifest.contributes?.ui?.inputStatus;
  assert.equal(inputStatus?.length, 1, "必须声明输入栏状态位胶囊");
  assert.equal(inputStatus[0].id, "session-cache");
  assert.match(inputStatus[0].title, /首响/);
  assert.doesNotMatch(inputStatus[0].text, /[\u{1F300}-\u{1FAFF}]/u, "纯白极简状态文案不使用彩色 Emoji");

  // 整页卡声明
  assert.ok(Array.isArray(manifest.contributes?.cards), "contributes.cards 必须为数组");
  assert.equal(manifest.contributes.cards.length, 1);
  const card = manifest.contributes.cards[0];
  assert.equal(card.id, "token-tracker-dashboard");
  assert.equal(card.route, `/dashboard-v${manifest.version}.html`, "主卡使用当前版本入口，避免继续定位旧页面");
  const cardHtml = fs.readFileSync(path.join(rootDir, 'ui', card.route), 'utf8');
  assert.equal(cardHtml, fs.readFileSync(path.join(rootDir, 'ui/index.html'), 'utf8'), "兼容入口与主卡入口使用相同启动流程");
  assert.ok(cardHtml.includes(`data-ui-version="${manifest.version}"`));
  assert.equal(card.realization, "page", "realization 必须为 page");
  assert.equal(card.siteNavEntry, true, "siteNavEntry 必须为 true");
  assert.equal(card.fpFullPanel, true, "fpFullPanel 必须为 true");
  assert.equal(card.closable, false, "closable 必须为 false");

  // 功能面板 functionPanel 校验
  assert.ok(card.functionPanel, "主卡必须声明专属 functionPanel 替换默认空状态");
  assert.equal(card.functionPanel.id, "token-tracker-sidepanel", "functionPanel.id 匹配契约");
  assert.equal(card.functionPanel.route, "/function-panel.html", "functionPanel.route 必须为 /function-panel.html");
  assert.ok(fs.existsSync(path.join(rootDir, "ui", card.functionPanel.route)), "functionPanel.route 页面必须存在");

  // 真实图片文件存在性
  assert.ok(fs.existsSync(path.join(rootDir, manifest.icon)), "顶层 icon 文件必须存在");
  assert.ok(fs.existsSync(path.join(rootDir, "ui", card.face.image)), "card face.image 必须存在于 ui/ 下");

  // 网络声明校验
  assert.deepEqual(
    [...(manifest.network?.allowedHosts || [])].sort(),
    ["api.deepseek.com", "chatgpt.com", "open.er-api.com"].sort(),
    "network.allowedHosts 必须包含 chatgpt.com、api.deepseek.com 与 open.er-api.com"
  );
  assert.deepEqual(manifest.network?.methods, ["GET"], "network.methods 仅需 GET");

  // Settings 校验（迁移至插件内部自管，不在宿主全局设置中注入）
  assert.equal(manifest.contributes.settings, undefined, "插件内部自管设置，不向宿主注入全局 settings 表单");
  assert.ok(!manifest.contributes.configuration, "禁止使用已废弃的 configuration 字段");
});
