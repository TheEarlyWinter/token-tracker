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
  assert.equal(manifest.version, "6.3.0", "版本必须定为 6.3.0");
  assert.equal(manifest.minAppVersion, "0.978.0", "minAppVersion 必须为合法的 MAJOR.MINOR.PATCH");
  assert.equal(manifest.entry, "index.js", "entry 必须为 index.js");

  // 必须声明且仅声明 5 个必要权限
  const expectedCaps = [
    "app/usage.read",
    "app/provider.credentials.read",
    "app/agents.read",
    "app/sessions.read",
    "app/media.tasks.read",
  ];
  assert.deepEqual(
    [...manifest.capabilities].sort(),
    expectedCaps.sort(),
    "capabilities 必须精准对应最小必要权限列表"
  );

  // 整页卡声明
  assert.ok(Array.isArray(manifest.contributes?.cards), "contributes.cards 必须为数组");
  assert.equal(manifest.contributes.cards.length, 1);
  const card = manifest.contributes.cards[0];
  assert.equal(card.id, "token-tracker-dashboard");
  assert.equal(card.route, "/index.html", "route 必须以 / 开头");
  assert.equal(card.realization, "page", "realization 必须为 page");
  assert.equal(card.siteNavEntry, true, "siteNavEntry 必须为 true");
  assert.equal(card.closable, false, "closable 必须为 false");

  // 真实图片文件存在性
  assert.ok(fs.existsSync(path.join(rootDir, manifest.icon)), "顶层 icon 文件必须存在");
  assert.ok(fs.existsSync(path.join(rootDir, "ui", card.face.image)), "card face.image 必须存在于 ui/ 下");

  // Settings 校验（非 v1 configuration）
  assert.ok(manifest.contributes.settings, "必须使用 contributes.settings");
  assert.ok(!manifest.contributes.configuration, "禁止使用已废弃的 configuration 字段");
  assert.equal(typeof manifest.contributes.settings.schema?.properties?.scanInterval, "object");
});
