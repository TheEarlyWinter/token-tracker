// ── 无 node:sqlite 时的缓存落盘：追加式 JSON 日志 ──
//
// 与 services/cache-store.js 的 SQLite 存储同形（load / save / saveMeta / rowCount / close），
// 供 createPersistScheduler 无差别调用。区别只是介质：
//   · token-cache.json      —— 基线快照（整份缓存，sessions 之外的字段见 meta sidecar）
//   · token-cache.json.journal —— 追加式 JSONL，一行一条会话的 upsert/delete
//   · token-cache.json.meta    —— 非 sessions 字段（version/lastScan/agentNames/persist…），原子写
//
// 为什么：旧退路每次 flush 都把整份缓存 JSON.stringify 再整文件替换，几千字节的变化被放大成
// 上万倍。改成按行追加后，一次落盘只跟「这一轮真的变过的会话数」成正比。
//
// 一致性要点：
//   · 读取 = 基线快照 + 顺序重放日志，同 key 后写覆盖先写；会话被删除用 { del:1 } 记录。
//   · 崩溃恢复 = 日志尾部半截行读取时跳过、追加前封口；基线/ meta 一律 tmp + fsync + rename。
//   · 合并（compact）= 把当前内存态写成新基线（先 meta、再基线、最后清日志）；顺序保证任一时刻
//     中断，重放日志都幂等，不丢数据。日志达到阈值时在启动或落盘后自动合并。
//
// 旧 token-cache.json（单文件整份缓存）无需改写即可作为基线被读取，首次落盘起转入追加模式。
import fs from "node:fs";
import path from "node:path";
import { appendJsonLines, readJsonLines, writeFileAtomic } from "./jsonl-log.js";

function readTextFile(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

const DEFAULT_COMPACT_RECORDS = 2000;
const DEFAULT_COMPACT_BYTES = 8 * 1024 * 1024;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const noop = () => {};
function asLog(log) {
  if (!log) return { info: noop, warn: noop, error: noop };
  if (typeof log === "function") return { info: log, warn: log, error: log };
  return log;
}

export function createJsonJournalStore({
  file,
  log = null,
  compactRecords = DEFAULT_COMPACT_RECORDS,
  compactBytes = DEFAULT_COMPACT_BYTES,
} = {}) {
  log = asLog(log);
  const journalFile = file + ".journal";
  const metaFile = file + ".meta";
  const rows = new Map(); // key -> { mtime, size }，上次落盘时这一行的状态
  let lastData = null;
  let journalRecords = 0;
  let journalBytes = 0;

  function readMetaFile() {
    try {
      const o = JSON.parse(readTextFile(metaFile));
      return o && typeof o === "object" ? o : null;
    } catch { return null; }
  }

  // 即使 load() 因为会话为空返回 null（避免把空缓存误判成有效），meta 仍可从这里读回，
  // 不静默丢失。返回合并后的非 sessions 字段；没有任何字段时返回 null。
  function readMeta() {
    const out = {};
    try {
      const base = JSON.parse(readTextFile(file));
      if (base && typeof base === "object") for (const k of Object.keys(base)) if (k !== "sessions") out[k] = base[k];
    } catch {}
    const meta = readMetaFile();
    if (meta) Object.assign(out, meta);
    return Object.keys(out).length ? out : null;
  }

  function splitRest(data) {
    const rest = {};
    for (const k of Object.keys(data || {})) if (k !== "sessions") rest[k] = data[k];
    return rest;
  }

  function load() {
    let base = null;
    try {
      base = JSON.parse(readTextFile(file));
    } catch (e) {
      if (e && e.code !== "ENOENT") log.warn("[token-tracker] cache read failed:", e.code || "", e.message);
      base = null;
    }
    const sessions = {};
    let rest = {};
    if (base && typeof base === "object") {
      if (base.sessions && typeof base.sessions === "object") {
        for (const k of Object.keys(base.sessions)) {
          const rec = base.sessions[k];
          sessions[k] = rec;
          rows.set(k, { mtime: num(rec && rec.mtime), size: num(rec && rec.size) });
        }
      }
      for (const k of Object.keys(base)) if (k !== "sessions") rest[k] = base[k];
    }
    const meta = readMetaFile();
    if (meta) rest = { ...rest, ...meta };

    let jres = { records: [], skipped: 0, bytes: 0 };
    try { jres = readJsonLines(journalFile); }
    catch (e) { if (e && e.code !== "ENOENT") log.warn("[token-tracker] cache journal read failed:", e.code || "", e.message); }
    for (const rec of jres.records) {
      if (rec.k == null) continue;
      if (rec.del) { delete sessions[rec.k]; rows.delete(rec.k); }
      else if (rec.v != null) { sessions[rec.k] = rec.v; rows.set(rec.k, { mtime: num(rec.m), size: num(rec.s) }); }
    }
    if (jres.skipped) log.warn("[token-tracker] cache journal 跳过 " + jres.skipped + " 行损坏记录（中断写入残留，已忽略）");
    journalRecords = jres.records.length;
    journalBytes = jres.bytes;

    if (!Object.keys(sessions).length) return null; // 空库：当作没有缓存，让调用方走全量
    const data = { ...rest, sessions };
    lastData = data;
    // 启动时日志过大 → 合并一次，收窄后续重放成本。
    if (journalRecords >= compactRecords || journalBytes >= compactBytes) compact(data);
    return data;
  }

  // forced：调用方明确知道变了、但 mtime/size 看不出来的键。
  // all：整库重写（首次导入、全量重扫）。
  function save(data, forced, all) {
    const sessions = (data && data.sessions) || {};
    const touched = new Set(forced || []);
    const writeAll = !!(all || rows.size === 0);
    const why = { forced: touched.size, stale: 0, gone: 0 };
    if (writeAll) {
      const before = touched.size;
      for (const k of Object.keys(sessions)) touched.add(k);
      why.stale = touched.size - before;
    } else {
      for (const k of Object.keys(sessions)) {
        const prev = rows.get(k);
        const cur = sessions[k];
        if (!prev || prev.mtime !== num(cur && cur.mtime) || prev.size !== num(cur && cur.size)) { touched.add(k); why.stale += 1; }
      }
    }
    // 已经不在缓存里的行要删掉（账本按天分键，旧的那天会被移除）
    for (const k of rows.keys()) if (!(k in sessions)) { touched.add(k); why.gone += 1; }

    const lines = [];
    for (const k of touched) {
      const rec = sessions[k];
      if (!rec) lines.push({ k, del: 1 });
      else lines.push({ k, m: num(rec.mtime), s: num(rec.size), v: rec });
    }
    let bytes = 0;
    if (lines.length) {
      bytes = appendJsonLines(journalFile, lines);
      journalRecords += lines.length;
      journalBytes += bytes;
      for (const k of touched) {
        const rec = sessions[k];
        if (!rec) rows.delete(k);
        else rows.set(k, { mtime: num(rec.mtime), size: num(rec.size) });
      }
    }
    lastData = data;
    const result = { rows: lines.length, bytes, scope: writeAll ? "全量" : "增量", why };
    // 定期合并：日志攒到阈值就把当前态压成新基线并清空日志。
    if (journalRecords >= compactRecords || journalBytes >= compactBytes) compact(data);
    return result;
  }

  // 非 sessions 字段单独原子写（调度器要先把这一轮真实计数更新完再写它）。
  function saveMeta(data) {
    const text = JSON.stringify(splitRest(data));
    writeFileAtomic(metaFile, text);
    return Buffer.byteLength(text);
  }

  // 把当前内存态写成新基线：meta → 基线 → 清日志。任一步中断都可安全重放。
  function compact(data) {
    const d = data && typeof data === "object" ? data : lastData;
    if (!d) return false;
    try {
      const sessions = d.sessions || {};
      writeFileAtomic(metaFile, JSON.stringify(splitRest(d)));
      writeFileAtomic(file, JSON.stringify({ version: d.version, sessions }));
      try { fs.rmSync(journalFile, { force: true }); }
      catch (e) {
        log.warn("[token-tracker] cache journal 清理失败，保留日志计数以便重试：", e.code || "", e.message);
        return false;
      }
      if (fs.existsSync(journalFile)) {
        log.warn("[token-tracker] cache journal 仍存在，保留日志计数以便重试");
        return false;
      }
      journalRecords = 0;
      journalBytes = 0;
      rows.clear();
      for (const k of Object.keys(sessions)) rows.set(k, { mtime: num(sessions[k] && sessions[k].mtime), size: num(sessions[k] && sessions[k].size) });
      lastData = d;
      return true;
    } catch (e) {
      log.warn("[token-tracker] cache compact failed:", e.code || "", e.message);
      return false;
    }
  }

  return {
    kind: "json-journal",
    file,
    journalFile,
    metaFile,
    load,
    save,
    saveMeta,
    readMeta,
    compact,
    close() {},
    rowCount: () => rows.size,
  };
}
