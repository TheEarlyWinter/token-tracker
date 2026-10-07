// runtime/engine/services/turns-store.js
// 轮次（Turn-level）细粒度用量存储层：基于 node:sqlite 的 DatabaseSync。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

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
     PRIMARY KEY (session_key, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS turns_at ON turns(at)`,
  `CREATE INDEX IF NOT EXISTS turns_day ON turns(day)`,
];

const INSERT_SQL =
  "INSERT INTO turns (session_key, seq, at, day, agent, type, provider, model, total, input, output, cache_read, calls) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
const DELETE_SESSION_SQL = "DELETE FROM turns WHERE session_key = ?";

const SORT_EXPR = {
  time: "at",
  tokens: "total",
  uncached: "MAX(COALESCE(input, 0) - COALESCE(cache_read, 0), 0)",
  hit: "CASE WHEN input IS NOT NULL AND input > 0 THEN CAST(cache_read AS REAL) / input ELSE NULL END",
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
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d.getTime())) return "unknown";
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
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
    db = d;
    return db;
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

  function backfillFromArchive(entries = {}) {
    const d = open();
    const list = Array.isArray(entries) ? entries : Object.values(entries || {});
    if (!list.length) return 0;
    let inserted = 0;
    d.exec("BEGIN");
    try {
      d.exec("DELETE FROM turns");
      const ins = insertStatement(d);
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r) continue;
        const at = r.startedAt || r.endedAt || "";
        ins.run(
          r.sessionId || r.requestId || `req-${i}`,
          i + 1,
          at,
          localDay(at),
          r.agentId || r.agent || "unknown",
          r.type || "desktop",
          r.provider || "",
          r.model || "unknown",
          num(r.totalTokens),
          numOrNull(r.inputTokens),
          numOrNull(r.outputTokens),
          numOrNull(r.cacheReadTokens),
          1
        );
        inserted++;
      }
      d.exec("COMMIT");
    } catch (e) {
      try { d.exec("ROLLBACK"); } catch {}
      throw e;
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
      "SELECT session_key AS sessionKey, seq, at, day, agent, type, provider, model, total, input, output, cache_read AS cacheRead, calls " +
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

  return { open, replaceSession, removeSession, rebuild, apply, count, backfill, backfillFromArchive, query, queryTurnSizes, close };
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
