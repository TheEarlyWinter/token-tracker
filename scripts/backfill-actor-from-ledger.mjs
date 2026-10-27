#!/usr/bin/env node
// 维护脚本：从宿主官方账本补写归档里的「执行者身份」。
//
// 为什么需要它：应用通过 `usage:list` 拿到的记录是宿主投影后的对象，投影里保留了
// attribution.childSessionId，但**丢掉了** attribution.childAgentId 与 source.actor，
// 所以子代理记录到手时只知道自己是谁派出去的，不知道是谁在跑。官方账本 SQLite 里两者都在。
// 这个脚本用宿主账本给归档补一次字段，只补不删：同 rid 追加一行，读取侧后写覆盖先写。
//
// 用法：
//   node scripts/backfill-actor-from-ledger.mjs [--data-dir <应用数据目录>] [--ledger <账本路径>] [--dry-run]
//
// 限制：宿主账本是 2 万条环形窗口，超出窗口的旧记录无法恢复，聚合时会单列为
// 「未标注执行者」。脚本可重复运行，已补齐的记录不会重复写。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function argOf(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const dataDir = argOf("--data-dir", path.join(os.homedir(), ".hanako", "app-data", "token-tracker"));
const ledgerPath = argOf("--ledger", path.join(os.homedir(), ".hanako", "usage-ledger.sqlite"));
const archivePath = path.join(dataDir, "usage-archive.jsonl");

if (!fs.existsSync(archivePath)) {
  console.error(`找不到归档：${archivePath}`);
  process.exit(1);
}
if (!fs.existsSync(ledgerPath)) {
  console.error(`找不到官方账本：${ledgerPath}`);
  process.exit(1);
}

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(ledgerPath, { readOnly: true });
const rows = db.prepare("SELECT entry_json FROM usage_entries").all();
db.close();

const actors = new Map();
for (const row of rows) {
  let entry;
  try { entry = JSON.parse(row.entry_json); } catch { continue; }
  if (entry?.source?.subsystem !== "subagent") continue;
  const actor = entry?.source?.actor?.agentId || entry?.attribution?.childAgentId || null;
  const parent = entry?.attribution?.agentId || null;
  if (!entry?.requestId || (!actor && !parent)) continue;
  actors.set(entry.requestId, { actorAgentId: actor, parentAgentId: parent });
}

const lines = fs.readFileSync(archivePath, "utf8").split("\n");
const latest = new Map();
for (const line of lines) {
  if (!line) continue;
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  if (!rec || rec.meta || rec.rid == null || !rec.v) continue;
  latest.set(rec.rid, rec.v);
}

const patches = [];
for (const [rid, record] of latest) {
  if (record.baseType !== "sub") continue;
  const info = actors.get(rid);
  if (!info) continue;
  if (record.actorAgentId && record.parentAgentId) continue;
  const next = { ...record };
  let changed = false;
  if (!next.actorAgentId && info.actorAgentId) { next.actorAgentId = info.actorAgentId; changed = true; }
  if (!next.parentAgentId && info.parentAgentId) { next.parentAgentId = info.parentAgentId; changed = true; }
  if (changed) patches.push({ rid, v: next });
}

const named = patches.filter((p) => p.v.actorAgentId).length;
console.log(`归档记录 ${latest.size} 条，账本窗口内可补 ${patches.length} 条（其中执行者明确 ${named} 条）`);
if (dryRun) {
  console.log("--dry-run：不写文件。");
  process.exit(0);
}
if (!patches.length) process.exit(0);

const payload = patches.map((p) => JSON.stringify(p)).join("\n") + "\n";
fs.appendFileSync(archivePath, payload);
console.log(`已追加 ${patches.length} 行补写记录到 ${archivePath}`);
