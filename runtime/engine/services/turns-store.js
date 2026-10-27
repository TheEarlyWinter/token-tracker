// runtime/engine/services/turns-store.js
// 轮次（Turn-level）细粒度用量存储层：基于 node:sqlite 的 DatabaseSync。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { formatAppDay } from "./platform.js";

const require = createRequire(import.meta.url);

export function loadSqliteDriver() {
  try {
    const mod = require("node:sqlite");
    return typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    return null;
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS turns (
     session_key TEXT NOT NULL, seq INTEGER NOT NULL,
     at TEXT NOT NULL, day TEXT NOT NULL,
     agent TEXT NOT NULL, type TEXT NOT NULL,
     provider TEXT NOT NULL, model TEXT NOT NULL,
     total INTEGER NOT NULL, input INTEGER, output INTEGER,
     cache_read INTEGER, calls INTEGER,
     request_id TEXT,
     PRIMARY KEY (session_key, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS turns_at ON turns(at)`,
  `CREATE INDEX IF NOT EXISTS turns_day ON turns(day)`,
  // 派生索引键版本：session_key 统一使用聚合桶键（agent::type::day）。
  `CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

// 后加的列：老库不会因为 CREATE TABLE IF NOT EXISTS 长出它们，得单独补。
// 只做 ADD COLUMN（SQLite 支持，不动已有行）；值由下一次全量 rebuild 填上。
const ADDED_COLUMNS = [{ name: "request_id", ddl: "ALTER TABLE turns ADD COLUMN request_id TEXT" }];

const INSERT_SQL =
  "INSERT INTO turns (session_key, seq, at, day, agent, type, provider, model, total, input, output, cache_read, calls, request_id) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const DELETE_SESSION_SQL = "DELETE FROM turns WHERE session_key = ?";

// 命中率排序表达式：口径 = 缓存读 / 输入总量（含缓存读），与 ui/hit-rate.js 同一式子。
// SQL 里调不到 JS，公式在这里抄一遍；test/hit-rate.test.js 拿同一批样本比对两边。
export const HIT_SORT_EXPR =
  "CASE WHEN (COALESCE(input, 0) + COALESCE(cache_read, 0)) > 0 THEN CAST(COALESCE(cache_read, 0) AS REAL) / (COALESCE(input, 0) + COALESCE(cache_read, 0)) ELSE NULL END";

const SORT_EXPR = {
  time: "at",
  tokens: "total",
  uncached: "COALESCE(input, 0)",
  hit: HIT_SORT_EXPR,
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const BACKFILL_CHUNK = 200;

function pushEq(where, params, col, v) {
  if (Array.isArray(v)) {
    if (!v.length) return;
    where.push(col + " IN (" + v.map(() => "?").join(",") + ")");
    for (const x of v) params.push(x);
    return;
  }
  if (typeof v === "string" && v !== "") {
    where.push(col + " = ?");
    params.push(v);
  }
}

function localDay(ts) {
  return formatAppDay(ts);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v) {
  return v == null ? null : num(v);
}

export function turnRowsFor(key, session) {
  const convs = Array.isArray(session?.conversations) ? session.conversations : [];
  if (!convs.length) return [];
  const agent = session?.agent == null ? "" : String(session.agent);
  const type = session?.type == null ? "" : String(session.type);
  const out = [];
  for (let i = 0; i < convs.length; i++) {
    const c = convs[i] || {};
    const at = c.time == null ? "" : String(c.time);
    out.push([
      key,
      i + 1,
      at,
      localDay(at),
      agent,
      type,
      c.provider == null ? "" : String(c.provider),
      c.model == null ? "" : String(c.model),
      num(c.totalTokens),
      numOrNull(c.inTokens ?? c.inputTokens ?? c.input),
      numOrNull(c.outTokens ?? c.outputTokens ?? c.output),
      numOrNull(c.cacheRead ?? c.cacheReadTokens),
      numOrNull(c.msgCount ?? c.calls ?? 1),
      c.requestId == null ? null : String(c.requestId),
    ]);
  }
  return out;
}

export function createSqliteTurnsStore({ DatabaseSync, file, log = () => {} }) {
  let db = null;

  function open() {
    if (db) return db;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new DatabaseSync(file);
    try { d.exec("PRAGMA busy_timeout = 5000"); } catch {}
    try { d.exec("PRAGMA journal_mode = WAL"); } catch {}
    try { d.exec("PRAGMA synchronous = NORMAL"); } catch {}
    for (const sql of SCHEMA) d.exec(sql);
    ensureColumns(d);
    db = d;
    return db;
  }

  // 老库补列：PRAGMA 里没有才 ALTER，重复启动不会报错。
  function ensureColumns(d) {
    let have = new Set();
    try {
      have = new Set(d.prepare("PRAGMA table_info(turns)").all().map((c) => String(c.name)));
    } catch (e) {
      log.warn?.("[token-tracker] turns 库结构读取失败：", e.message);
      return;
    }
    for (const col of ADDED_COLUMNS) {
      if (have.has(col.name)) continue;
      try {
        d.exec(col.ddl);
      } catch (e) {
        log.warn?.(`[token-tracker] turns 库补列 ${col.name} 失败：`, e.message);
      }
    }
  }

  function insertStatement(d) {
    return d.prepare(INSERT_SQL);
  }

  function replaceSession(key, session) {
    const d = open();
    d.exec("BEGIN");
    try {
      replaceSessionNoTx(d, key, session);
      d.exec("COMMIT");
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }

  function replaceSessionNoTx(d, key, session, ins = null) {
    d.prepare(DELETE_SESSION_SQL).run(key);
    const stmt = ins || insertStatement(d);
    for (const r of turnRowsFor(key, session)) stmt.run(...r);
  }

  function removeSession(key) {
    open().prepare(DELETE_SESSION_SQL).run(key);
  }

  function rebuild(data) {
    const sessions = data?.sessions || {};
    if (!Object.keys(sessions).length && !db && !fs.existsSync(file)) return 0;
    const d = open();
    let inserted = 0;
    d.exec("BEGIN");
    try {
      d.exec("DELETE FROM turns");
      const ins = insertStatement(d);
      for (const key of Object.keys(sessions)) {
        for (const r of turnRowsFor(key, sessions[key])) {
          ins.run(...r);
          inserted += 1;
        }
      }
      d.exec("COMMIT");
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
    }
    if (inserted > 200) {
      try {
        d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (e) {
        log.warn?.("[token-tracker] turns 库 WAL 回收失败：", e.message);
      }
    }
    return inserted;
  }

  function apply(data, changed) {
    const sessions = data?.sessions || {};
    if (changed?.all) return rebuild(data);
    const keys = Array.isArray(changed?.keys) ? changed.keys : [];
    if (!keys.length) return 0;
    const d = open();
    let n = 0;
    d.exec("BEGIN");
    try {
      const ins = insertStatement(d);
      for (const key of keys) {
        const s = sessions[key];
        if (s) {
          replaceSessionNoTx(d, key, s, ins);
          n += 1;
        } else {
          d.prepare(DELETE_SESSION_SQL).run(key);
          n += 1;
        }
      }
      d.exec("COMMIT");
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
    }
    return n;
  }

  function count() {
    if (!db && !fs.existsSync(file)) return 0;
    const row = open().prepare("SELECT COUNT(*) AS n FROM turns").get();
    return Number(row?.n) || 0;
  }

  async function backfill(data) {
    const d = open();
    const sessions = data?.sessions || {};
    const keys = Object.keys(sessions);
    let inserted = 0;
    for (let i = 0; i < keys.length; i += BACKFILL_CHUNK) {
      d.exec("BEGIN");
      try {
        const ins = insertStatement(d);
        const end = Math.min(i + BACKFILL_CHUNK, keys.length);
        for (let j = i; j < end; j++) {
          for (const r of turnRowsFor(keys[j], sessions[keys[j]])) {
            ins.run(...r);
            inserted += 1;
          }
        }
        d.exec("COMMIT");
      } catch (e) {
        try { d.exec("ROLLBACK"); } catch {}
        throw e;
      }
      await new Promise((r) => setImmediate(r));
    }
    return inserted;
  }

  function query(opts) {
    if (!db && !fs.existsSync(file)) return { rows: [], total: 0, sumTokens: 0 };
    const o = opts && typeof opts === "object" ? opts : {};
    const d = open();
    const where = [];
    const params = [];
    const eq = (col, v) => pushEq(where, params, col, v);
    if (typeof o.from === "string" && o.from !== "") { where.push("day >= ?"); params.push(o.from); }
    if (typeof o.to === "string" && o.to !== "") { where.push("day <= ?"); params.push(o.to); }
    eq("agent", o.agent);
    eq("model", o.model);
    eq("provider", o.provider);
    eq("type", o.type);
    const min = Number(o.minTokens);
    if (Number.isFinite(min) && min > 0) { where.push("total >= ?"); params.push(min); }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";

    const agg = d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS s FROM turns" + clause).get(...params);
    const total = Number(agg?.n) || 0;
    const sumTokens = Number(agg?.s) || 0;
    if (!total) return { rows: [], total: 0, sumTokens: 0 };

    const sortKey = Object.prototype.hasOwnProperty.call(SORT_EXPR, o.sortKey) ? o.sortKey : "time";
    const expr = SORT_EXPR[sortKey];
    const dir = o.order === "asc" ? "ASC" : "DESC";
    const orderBy = `(${expr} IS NULL) ASC, ${expr} ${dir}, at DESC, session_key ASC, seq ASC`;

    const lim = Number(o.limit);
    const limit = Number.isFinite(lim) && lim > 0 ? Math.min(Math.floor(lim), MAX_LIMIT) : DEFAULT_LIMIT;
    const offRaw = Number(o.offset);
    const offset = Number.isFinite(offRaw) && offRaw > 0 ? Math.floor(offRaw) : 0;

    const select =
      "SELECT session_key AS sessionKey, seq, at, day, agent, type, provider, model, total, input, output, cache_read AS cacheRead, calls, request_id AS requestId " +
      "FROM turns" + clause + " ORDER BY " + orderBy;

    const rows = o.all === true
      ? d.prepare(select).all(...params)
      : d.prepare(select + " LIMIT ? OFFSET ?").all(...params, limit, offset);

    return { rows: rows.map((r) => ({ ...r })), total, sumTokens };
  }

  function queryTurnSizes(opts) {
    if (!db && !fs.existsSync(file)) return [];
    const o = opts && typeof opts === "object" ? opts : {};
    const d = open();
    const where = [];
    const params = [];
    const eq = (col, v) => pushEq(where, params, col, v);
    if (typeof o.from === "string" && o.from !== "") { where.push("day >= ?"); params.push(o.from); }
    if (typeof o.to === "string" && o.to !== "") { where.push("day <= ?"); params.push(o.to); }
    eq("agent", o.agent);
    eq("model", o.model);
    eq("provider", o.provider);
    eq("type", o.type);
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    return d.prepare("SELECT model, total FROM turns" + clause).all(...params)
      .map((r) => ({ model: String(r.model ?? ""), totalTokens: Number(r.total) || 0 }));
  }

  function close() {
    try { db?.close(); } catch {}
    db = null;
  }

  function getMeta(key) {
    if (!db && !fs.existsSync(file)) return null;
    const row = open().prepare("SELECT value FROM store_meta WHERE key = ?").get(String(key));
    return row?.value ?? null;
  }

  function setMeta(key, value) {
    const d = open();
    if (value == null) {
      d.prepare("DELETE FROM store_meta WHERE key = ?").run(String(key));
    } else {
      d.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(key), String(value));
    }
  }

  return { open, replaceSession, removeSession, rebuild, apply, count, backfill, query, queryTurnSizes, getMeta, setMeta, close };
}

export function queryTurns(store, opts) {
  if (!store || typeof store.query !== "function") return { rows: [], total: 0, sumTokens: 0 };
  return store.query(opts);
}

export function queryTurnSizes(store, opts) {
  if (!store || typeof store.queryTurnSizes !== "function") return [];
  return store.queryTurnSizes(opts);
}

export function openTurnsStore({ file, log = () => {} } = {}) {
  const DatabaseSync = loadSqliteDriver();
  if (!DatabaseSync) return null;
  try {
    return createSqliteTurnsStore({ DatabaseSync, file, log });
  } catch (e) {
    log.warn?.("[token-tracker] turns 库打开失败：", e.message);
    return null;
  }
}

export default { createSqliteTurnsStore, queryTurns, queryTurnSizes, openTurnsStore, turnRowsFor };
