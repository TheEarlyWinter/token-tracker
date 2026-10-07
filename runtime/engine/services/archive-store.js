// ── 独立历史归档（usage-archive.json → usage-archive.jsonl）──
//
// 背景：核心 usage-ledger 是 5000 条环形缓冲，满了会挤掉最旧记录；插件把每条账本记录按
// requestId 去重搬进归档，统计从归档构建，账本丢数据不影响历史。旧实现每并入一条新记录就把
// 整个归档 JSON.stringify 一遍再整文件覆盖写——历史越长写放大越夸张。
//
// 现在：历史只追加。主格式是追加式 JSONL（一行一条，键为 requestId），只写新增的那几行。
//   · 旧版单文件 usage-archive.json 首次打开时一次性迁移：整份历史写成 JSONL（tmp + rename
//     原子落地），随后把旧文件改名为 .imported 留底，不删除任何历史。
//   · 若日志已存在、旧单文件又重新出现（降级运行旧版本后再升级），先把其中日志尚无的条目
//     按 rid 并入日志，再改名留底；并入失败则保留原文件、不当作已完成迁移，下次重试。
//   · 已有 .imported / .imported-<ts> 备份一律不删除、不覆盖，改名冲突时改用带时间戳的新名。
//   · 迁移与日志读取都以 requestId 去重，重复的 key 后写覆盖先写；重启、重复扫描都不会重复归档。
//   · 进程中断最多在日志尾部留一行半截记录，读取时跳过；下次追加前会先把它封口，不污染后续记录。
//
// 记录行两种：
//   { rid, v }        一条归档条目（v 为紧凑短键对象，见 index.js entryToArchive）
//   { meta: 1, version, updatedAt }  元信息（最后一次为准）
import fs from "node:fs";
import path from "node:path";
import { appendJsonLines, readJsonLines, renameToBackup } from "./jsonl-log.js";

function readTextFile(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

const ARCHIVE_VERSION = 1;

const noop = () => {};
function asLog(log) {
  if (!log) return { info: noop, warn: noop, error: noop };
  if (typeof log === "function") return { info: log, warn: log, error: log };
  return log;
}

export function journalPathForArchive(jsonPath) {
  return jsonPath.replace(/\.json$/i, "") + ".jsonl";
}

export function openArchiveStore(jsonPath, log = null) {
  log = asLog(log);
  const journalPath = journalPathForArchive(jsonPath);
  const entries = Object.create(null); // rid -> 归档条目
  const written = new Set();           // 已落进日志的 rid
  let updatedAt = null;
  let persistedUpdatedAt = null;

  // 一次性迁移：日志还不存在但旧单文件在 → 生成日志（migrateLegacy 内会改名留底）。
  if (!fs.existsSync(journalPath) && fs.existsSync(jsonPath)) migrateLegacy();
  // 读日志（migrateLegacy 可能刚生成）。
  if (fs.existsSync(journalPath)) loadJournal();
  // 日志已存在、旧单文件又重新出现（如降级运行旧版本后再升级）：先把其中日志尚无的条目录入，
  // 再改名留底。合并失败则保留原文件、不当作已完成迁移，下次重试。
  if (fs.existsSync(journalPath) && fs.existsSync(jsonPath)) {
    if (mergeLegacyIntoJournal()) finishLegacyRename();
    else log.warn("[token-tracker] usage-archive.json 未能并入日志，保留原文件不当已完成迁移（下次重试）");
  }

  // 把旧单文件改名留底。已有 .imported / .imported-<ts> 备份绝不删除或覆盖，改用带时间戳的新名字。
  function finishLegacyRename() {
    try {
      const dest = renameToBackup(jsonPath, ".imported");
      log.info("[token-tracker] 旧 usage-archive.json 已改名留底：" + path.basename(dest));
    } catch (e) {
      log.warn("[token-tracker] archive 旧文件改名失败（原文件保留原位）：", e.message);
    }
  }

  // 把旧单文件里日志尚无的条目按 rid 追加进现有 JSONL。
  // 失败（解析不了 / 追加不了）返回 false，调用方据此保留旧文件、不当作已完成迁移。
  function mergeLegacyIntoJournal() {
    let legacy;
    try {
      legacy = JSON.parse(readTextFile(jsonPath));
    } catch (e) {
      log.warn("[token-tracker] archive 旧文件解析失败，保留原文件不迁移：", e.message);
      return false;
    }
    const src = legacy && legacy.entries && typeof legacy.entries === "object" ? legacy.entries : {};
    const fresh = [];
    for (const rid of Object.keys(src)) {
      if (rid in entries) continue; // 日志已收录，跳过
      fresh.push({ rid, v: src[rid] });
    }
    if (!fresh.length) return true;
    try {
      appendJsonLines(journalPath, fresh);
    } catch (e) {
      log.warn("[token-tracker] archive 旧文件并入日志失败，保留原文件：", e.message);
      return false;
    }
    for (const r of fresh) { entries[r.rid] = r.v; written.add(r.rid); }
    return true;
  }

  function migrateLegacy() {
    if (!fs.existsSync(jsonPath)) return;
    let legacy;
    try {
      legacy = JSON.parse(readTextFile(jsonPath));
    } catch (e) {
      // 损坏：留档待人工恢复，本次以空归档启动，下次扫描从账本重新播种。
      log.warn("[token-tracker] archive parse failed:", jsonPath, e.message);
      try { fs.renameSync(jsonPath, jsonPath + ".corrupt-" + Date.now()); } catch {}
      return;
    }
    const src = legacy && legacy.entries && typeof legacy.entries === "object" ? legacy.entries : {};
    const lines = [];
    for (const rid of Object.keys(src)) lines.push({ rid, v: src[rid] });
    if (legacy && legacy.updatedAt) lines.push({ meta: 1, version: legacy.version || ARCHIVE_VERSION, updatedAt: legacy.updatedAt });
    const dir = path.dirname(journalPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = journalPath + ".migrating";
    try {
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeSync(fd, lines.length ? lines.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");
        try { fs.fsyncSync(fd); } catch {}
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, journalPath); // 原子落地：要么没有日志，要么整份都在
    } catch (e) {
      log.warn("[token-tracker] archive 迁移失败（下次重试）：", e.message);
      try { fs.rmSync(tmp, { force: true }); } catch {}
      return;
    }
    finishLegacyRename();
    log.info("[token-tracker] usage-archive.json 已迁移为追加日志 " + path.basename(journalPath) + "：" + Object.keys(src).length + " 条");
  }

  function loadJournal() {
    let res;
    try { res = readJsonLines(journalPath); }
    catch (e) { if (e && e.code !== "ENOENT") log.warn("[token-tracker] archive journal read failed:", e.code || "", e.message); return; }
    for (const rec of res.records) {
      if (!rec) continue;
      if (rec.meta) { if (rec.updatedAt) { updatedAt = rec.updatedAt; persistedUpdatedAt = rec.updatedAt; } continue; }
      // 无效记录（rid 缺失或 v 为 null）不入账、也不占用 rid 槽位，
      // 否则会让该 rid 永远无法被后续 appendPending 追加。
      if (rec.rid == null || rec.v == null) continue;
      entries[rec.rid] = rec.v; // 同 rid 后写覆盖
      written.add(rec.rid);
    }
    if (res.skipped) log.warn("[token-tracker] archive journal 跳过 " + res.skipped + " 行损坏记录（中断写入残留，已忽略）");
  }

  // 把内存里还没落盘的条目标追加进日志；返回 { rows, bytes }。
  function appendPending() {
    const fresh = [];
    for (const rid of Object.keys(entries)) if (!written.has(rid)) fresh.push({ rid, v: entries[rid] });
    const lines = fresh.slice();
    if (updatedAt && updatedAt !== persistedUpdatedAt) lines.push({ meta: 1, version: ARCHIVE_VERSION, updatedAt });
    if (!lines.length) return { rows: 0, bytes: 0 };
    const bytes = appendJsonLines(journalPath, lines);
    for (const r of fresh) written.add(r.rid);
    persistedUpdatedAt = updatedAt;
    return { rows: fresh.length, bytes };
  }

  return {
    journalPath,
    entries,
    get updatedAt() { return updatedAt; },
    set updatedAt(v) { updatedAt = v; },
    appendPending,
    size: () => Object.keys(entries).length,
  };
}
