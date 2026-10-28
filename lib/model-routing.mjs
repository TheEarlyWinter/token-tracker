// lib/model-routing.mjs — 模型路由与上游切流检测存储与服务
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { deriveHanaHome } from "./local-client.mjs";
import { appTimeZone, formatAppDay } from "../runtime/engine/services/platform.js";

const require = createRequire(import.meta.url);
const STORAGE_ERROR_CODE = "MODEL_ROUTING_STORAGE_UNAVAILABLE";
const INVALID_QUERY_CODE = "MODEL_ROUTING_INVALID_QUERY";
const SCHEMA_VERSION = 1;
const SESSION_HEADER_READ_BYTES = 64 * 1024;
const LEGACY_RANDOM_ID_RE = /^mr_\d+_[a-z0-9]+$/;
const ALLOWED_RANGES = new Set(["all", "today", "yesterday", "7d", "30d", "week", "month", "last_month", "year", "custom"]);
const ALLOWED_STATUS = new Set(["all", "routed", "normal"]);
const dayFormatters = new Map();

function loadSqliteDriver() {
  try {
    const mod = require("node:sqlite");
    return typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    return null;
  }
}

function formatterFor(timeZone) {
  const key = timeZone || appTimeZone;
  let formatter = dayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: key });
    dayFormatters.set(key, formatter);
  }
  return formatter;
}

function formatDay(value, timeZone = appTimeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  if (timeZone === appTimeZone) return formatAppDay(date);
  return formatterFor(timeZone).format(date);
}

function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function shiftDay(day, delta) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function monthStart(day, delta = 0) {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 10);
}

function monthEnd(day, delta = 0) {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + delta + 1);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

function weekStart(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  return date.toISOString().slice(0, 10);
}

export function computeDateRange(range = "all", from, to, timeZone = appTimeZone, now = new Date()) {
  const selected = range || "all";
  const today = formatDay(now, timeZone);
  if (today === "unknown") return null;

  if (selected === "today") return { from: today, to: today };
  if (selected === "yesterday") {
    const yesterday = shiftDay(today, -1);
    return { from: yesterday, to: yesterday };
  }
  if (selected === "7d") return { from: shiftDay(today, -6), to: today };
  if (selected === "30d") return { from: shiftDay(today, -29), to: today };
  if (selected === "week") return { from: weekStart(today), to: today };
  if (selected === "month") return { from: monthStart(today), to: today };
  if (selected === "last_month") return { from: monthStart(today, -1), to: monthEnd(today, -1) };
  if (selected === "year") return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (selected === "custom" && from && to) {
    return { from: String(from).slice(0, 10), to: String(to).slice(0, 10) };
  }
  if (from && to) return { from: String(from).slice(0, 10), to: String(to).slice(0, 10) };
  return null;
}

function storageError(cause) {
  const error = new Error("模型路由存储不可用");
  error.code = STORAGE_ERROR_CODE;
  error.cause = cause;
  return error;
}

function invalidQuery(message) {
  const error = new Error(message || "模型路由查询参数无效");
  error.code = INVALID_QUERY_CODE;
  return error;
}

function text(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const result = value.trim();
  return result || fallback;
}

function modelId(value) {
  if (typeof value === "string") return text(value);
  if (!value || typeof value !== "object") return "";
  return text(value.modelId || value.id || value.model);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function numberValue(value) {
  return numberOrNull(value) ?? 0;
}

function normalizeAt(value) {
  const date = value === undefined || value === null ? new Date() : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizeUsage(rawUsage) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const inputRaw = usage.input;
  const outputRaw = usage.output;
  const cacheRaw = usage.cache;
  const cacheRead = numberValue(
    usage.cacheRead ?? usage.readCache ?? cacheRaw?.readTokens ?? cacheRaw?.cacheRead,
  );
  const cacheWrite = numberValue(
    usage.cacheWrite ?? usage.writeCache ?? cacheRaw?.writeTokens ?? cacheRaw?.cacheWrite,
  );

  let input = null;
  let inputTotal = null;
  if (inputRaw && typeof inputRaw === "object") {
    input = numberOrNull(inputRaw.uncachedTokens ?? inputRaw.uncached ?? inputRaw.inputTokens);
    inputTotal = numberOrNull(inputRaw.totalTokens ?? inputRaw.total);
    if (input === null && inputTotal !== null) {
      input = inputTotal >= cacheRead ? inputTotal - cacheRead : inputTotal;
    }
  } else {
    input = numberOrNull(inputRaw ?? usage.inputTokens ?? usage.input_tokens);
  }

  let output;
  if (outputRaw && typeof outputRaw === "object") {
    output = numberOrNull(outputRaw.totalTokens ?? outputRaw.total ?? outputRaw.outputTokens);
  } else {
    output = numberOrNull(outputRaw ?? usage.outputTokens ?? usage.output_tokens);
  }
  output ??= 0;
  input ??= 0;

  const reportedTotal = numberOrNull(usage.totalTokens ?? usage.total_tokens);
  const total = reportedTotal !== null
    ? reportedTotal
    : inputTotal !== null
      ? inputTotal + output
      : input + cacheRead + output + cacheWrite;

  return { input, output, cacheRead, cacheWrite, total };
}

function sessionHeaderIdFromObject(value) {
  if (!value || typeof value !== "object") return null;
  const typeName = text(value.type || value.kind).toLowerCase();
  const looksLikeHeader = typeName === "session" || typeName === "session_header" || typeName === "header";
  if (!looksLikeHeader) return null;
  return text(
    value.sessionId
      || value.session_id
      || value.id
      || value.session?.sessionId
      || value.session?.id
      || value.payload?.sessionId
      || value.payload?.id,
  ) || null;
}

function readSessionHeaderId(filePath, cache = null) {
  if (typeof filePath !== "string" || !filePath) return null;
  if (cache?.has(filePath)) return cache.get(filePath);
  let sessionId = null;
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(SESSION_HEADER_READ_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const textContent = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "");
    for (const line of textContent.split(/\r?\n/).slice(0, 16)) {
      if (!line.trim()) continue;
      try {
        sessionId = sessionHeaderIdFromObject(JSON.parse(line));
        if (sessionId) break;
      } catch {}
    }
  } catch {}
  finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  cache?.set(filePath, sessionId);
  return sessionId;
}

function readFileRange(filePath, start, end) {
  const length = Math.max(0, end - start);
  if (!length) return Buffer.alloc(0);
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function listJsonlFiles(root) {
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch { return []; }
  if (!rootStat.isDirectory()) return [];

  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(filePath);
      else if (entry.isDirectory()) walk(filePath);
    }
  };
  walk(root);
  return files;
}

function completeJsonlBytes(buffer) {
  if (!buffer.length || buffer[buffer.length - 1] === 0x0a) return buffer.length;
  const lastNewline = buffer.lastIndexOf(0x0a);
  const tail = buffer.subarray(lastNewline + 1).toString("utf8");
  try {
    JSON.parse(tail);
    return buffer.length;
  } catch {
    return lastNewline >= 0 ? lastNewline + 1 : 0;
  }
}

function agentFromSession(session) {
  const direct = text(session?.agentId || session?.agent);
  if (direct) return direct;
  const sessionPath = text(session?.sessionPath);
  const match = /[\\/]agents[\\/]([^\\/]+)[\\/]/.exec(sessionPath);
  return text(match?.[1], "unknown");
}

function compositeModelFilter(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1) return null;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function modelMatches(route, value) {
  if (!value) return true;
  if (route.requestedModel === value || route.responseModel === value) return true;
  const compound = compositeModelFilter(value);
  return !!compound
    && route.provider === compound.provider
    && (route.requestedModel === compound.model || route.responseModel === compound.model);
}

function queryInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  let number;
  if (typeof value === "number") {
    number = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    number = Number(value.trim());
  } else {
    throw invalidQuery("分页参数无效");
  }
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw invalidQuery("分页参数无效");
  }
  return number;
}

function intersectDateRanges(left, right) {
  if (!left) return right;
  if (!right) return left;
  return {
    from: left.from > right.from ? left.from : right.from,
    to: left.to < right.to ? left.to : right.to,
  };
}

function stableMessageId({ message, entryId, agent, sessionId, sessionPath, at, provider, requestedModel, responseModel }) {
  const responseId = text(message?.responseId || message?.requestId || message?.messageId || message?.id);
  if (message?.responseId !== undefined && message?.responseId !== null && text(String(message.responseId))) {
    return `${String(message.responseId)}_${message.timestamp ?? ""}`;
  }
  if (responseId && (message?.requestId || message?.messageId || message?.id)) {
    return `${responseId}_${message.timestamp ?? ""}`;
  }
  const hasTimestamp = message?.timestamp !== undefined
    && message?.timestamp !== null
    && Number.isFinite(new Date(message.timestamp).getTime());
  const stableFields = {
    version: 1,
    agent,
    sessionId: sessionPath ? "" : sessionId || "",
    sessionPath: sessionPath || "",
    entryId: !hasTimestamp ? text(entryId) : "",
    at: hasTimestamp ? at : "",
    provider,
    requestedModel,
    responseModel,
    content: !hasTimestamp ? message?.content || "" : "",
    role: message?.role || "",
    stopReason: message?.stopReason || "",
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(stableFields)).digest("hex").slice(0, 32);
  return `mr_${digest}`;
}

function cleanRecord({
  id,
  at,
  agent,
  sessionId,
  provider,
  requestedModel,
  responseModel,
  isRouted = null,
  inputTokens = 0,
  outputTokens = 0,
  cacheRead = 0,
  cacheWrite = 0,
  totalTokens = 0,
}, timeZone) {
  const cleanRequested = modelId(requestedModel);
  if (!cleanRequested) return null;
  const cleanResponse = modelId(responseModel) || cleanRequested;
  const cleanAt = normalizeAt(at);
  const cleanId = text(id) || `mr_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  const cleanAgent = text(agent, "unknown");
  const cleanProvider = text(provider, "unknown");
  const cleanSessionId = text(sessionId) || null;
  const routed = isRouted === null || isRouted === undefined
    ? (cleanRequested !== cleanResponse ? 1 : 0)
    : (isRouted ? 1 : 0);
  return {
    id: cleanId,
    at: cleanAt,
    day: formatDay(cleanAt, timeZone),
    agent: cleanAgent,
    sessionId: cleanSessionId,
    provider: cleanProvider,
    requestedModel: cleanRequested,
    responseModel: cleanResponse,
    isRouted: routed,
    inputTokens: numberValue(inputTokens),
    outputTokens: numberValue(outputTokens),
    cacheRead: numberValue(cacheRead),
    cacheWrite: numberValue(cacheWrite),
    totalTokens: numberValue(totalTokens),
  };
}

function recordKeyParams(route) {
  return [route.agent, route.sessionId, route.at, route.provider, route.requestedModel, route.responseModel];
}

function sqliteChanges(result) {
  return Number(result?.changes) || 0;
}

export class ModelRoutingStore {
  constructor({ dataDir, log = () => {}, appTimeZone: configuredTimeZone = appTimeZone } = {}) {
    this.dataDir = dataDir;
    this.appTimeZone = configuredTimeZone || appTimeZone;
    this.log = typeof log === "function" ? log : () => {};
    this.db = null;
    this.insertStmt = null;
    this.memoryRecords = [];
    this.scanCursors = new Map();
    this.sessionIds = new Map();
    this.sessionHeaderIds = new Map();
    this.storageError = null;
    this.closed = false;
    this.storageMode = "memory";
    this.init();
  }

  init() {
    const Driver = loadSqliteDriver();
    if (!this.dataDir || !Driver) return;

    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const dbPath = path.join(this.dataDir, "model-routing.sqlite");
      this.db = new Driver(dbPath);
      this.migrate();
      this.insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO model_routes (
          id, at, day, agent, session_id, provider, requested_model, response_model,
          is_routed, input_tokens, output_tokens, cache_read, cache_write, total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.storageMode = "sqlite";
    } catch (error) {
      this.log("warn", "[model-routing] SQLite 初始化失败:", error?.message || error);
      try { this.db?.close(); } catch {}
      this.db = null;
      this.insertStmt = null;
      this.storageMode = "unavailable";
      this.storageError = storageError(error);
    }
  }

  migrate() {
    const db = this.db;
    let transaction = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_routes (
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          day TEXT NOT NULL,
          agent TEXT NOT NULL,
          session_id TEXT,
          provider TEXT NOT NULL,
          requested_model TEXT NOT NULL,
          response_model TEXT NOT NULL,
          is_routed INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read INTEGER DEFAULT 0,
          cache_write INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0
        );
      `);

      const columns = new Set(this.db.prepare("PRAGMA table_info(model_routes);").all().map((column) => String(column.name)));
      if (!columns.has("is_routed")) {
        db.exec("ALTER TABLE model_routes ADD COLUMN is_routed INTEGER DEFAULT 0");
      }
      if (!columns.has("cache_write")) {
        db.exec("ALTER TABLE model_routes ADD COLUMN cache_write INTEGER DEFAULT 0");
      }

      db.exec("CREATE INDEX IF NOT EXISTS idx_mr_day ON model_routes(day)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_mr_agent ON model_routes(agent)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_mr_at ON model_routes(at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_mr_routed ON model_routes(is_routed)");

      const versionRow = db.prepare("PRAGMA user_version").get() || {};
      const version = Number(versionRow.user_version) || 0;
      if (version < SCHEMA_VERSION) {
        const rows = db.prepare("SELECT id, at, requested_model, response_model FROM model_routes").all();
        const updateDay = db.prepare("UPDATE model_routes SET day = ? WHERE id = ?");
        for (const row of rows) {
          const day = formatDay(row.at, this.appTimeZone);
          if (day !== "unknown") updateDay.run(day, row.id);
        }
        db.exec("UPDATE model_routes SET is_routed = 1 WHERE is_routed = 0 AND requested_model != response_model");
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
      db.exec("COMMIT");
      transaction = false;
    } catch (error) {
      if (transaction) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      throw error;
    }
  }

  ensureStorage() {
    if (this.closed) throw storageError(new Error("store closed"));
    if (this.storageError) throw this.storageError;
  }

  normalizeRoute(input) {
    return cleanRecord(input || {}, this.appTimeZone);
  }

  insertRecord(route) {
    this.ensureStorage();
    if (this.db) {
      const result = this.insertStmt.run(
        route.id, route.at, route.day, route.agent, route.sessionId, route.provider,
        route.requestedModel, route.responseModel, route.isRouted,
        route.inputTokens, route.outputTokens, route.cacheRead, route.cacheWrite, route.totalTokens,
      );
      return sqliteChanges(result) > 0;
    }
    if (this.memoryRecords.some((record) => record.id === route.id)) return false;
    this.memoryRecords.push({ ...route });
    return true;
  }

  findLegacyCandidates(route, sessionIds = [route.sessionId]) {
    const uniqueSessionIds = [];
    for (const value of Array.isArray(sessionIds) ? sessionIds : [sessionIds]) {
      const normalized = value === null || value === undefined ? null : (text(value) || null);
      if (!uniqueSessionIds.some((item) => item === normalized)) uniqueSessionIds.push(normalized);
    }
    if (this.db) {
      const candidates = [];
      for (const sessionId of uniqueSessionIds) {
        const sessionWhere = sessionId === null ? "session_id IS NULL" : "session_id = ?";
        const rows = sessionId === null
          ? this.db.prepare(`
              SELECT id FROM model_routes
              WHERE ${sessionWhere} AND agent = ? AND at = ? AND provider = ?
                AND requested_model = ? AND response_model = ?
            `).all(route.agent, route.at, route.provider, route.requestedModel, route.responseModel)
          : this.db.prepare(`
              SELECT id FROM model_routes
              WHERE ${sessionWhere} AND agent = ? AND at = ? AND provider = ?
                AND requested_model = ? AND response_model = ?
            `).all(sessionId, route.agent, route.at, route.provider, route.requestedModel, route.responseModel);
        candidates.push(...rows);
      }
      return candidates.filter((candidate) => LEGACY_RANDOM_ID_RE.test(String(candidate.id)));
    }
    return this.memoryRecords
      .filter((record) => uniqueSessionIds.includes(record.sessionId)
        && record.agent === route.agent
        && record.at === route.at
        && record.provider === route.provider
        && record.requestedModel === route.requestedModel
        && record.responseModel === route.responseModel
        && LEGACY_RANDOM_ID_RE.test(String(record.id)))
      .map((record) => ({ id: record.id }));
  }

  hasId(id) {
    if (this.db) return !!this.db.prepare("SELECT 1 AS present FROM model_routes WHERE id = ? LIMIT 1").get(id);
    return this.memoryRecords.some((record) => record.id === id);
  }

  updateLegacyId(route, oldId) {
    if (this.db) {
      const result = this.db.prepare(`
        UPDATE model_routes SET
          id = ?, at = ?, day = ?, agent = ?, session_id = ?, provider = ?,
          requested_model = ?, response_model = ?, is_routed = ?, input_tokens = ?,
          output_tokens = ?, cache_read = ?, cache_write = ?, total_tokens = ?
        WHERE id = ?
      `).run(
        route.id, route.at, route.day, route.agent, route.sessionId, route.provider,
        route.requestedModel, route.responseModel, route.isRouted, route.inputTokens,
        route.outputTokens, route.cacheRead, route.cacheWrite, route.totalTokens, oldId,
      );
      return sqliteChanges(result) > 0;
    }
    const record = this.memoryRecords.find((item) => item.id === oldId);
    if (!record) return false;
    Object.assign(record, route);
    return true;
  }

  reconcileLegacy(route, sessionIds = [route.sessionId]) {
    if (this.hasId(route.id)) return true;
    const candidates = this.findLegacyCandidates(route, sessionIds);
    if (candidates.length === 1 && candidates[0].id !== route.id) {
      return this.updateLegacyId(route, candidates[0].id);
    }
    if (candidates.length > 1) {
      this.log("warn", "[model-routing] 无法精确重用重复的旧无响应记录，保留原行:", route.agent, route.sessionId || "");
    }
    return false;
  }

  recordRoute(input) {
    const route = this.normalizeRoute(input);
    if (!route) return false;
    return this.insertRecord(route);
  }

  recordMessage(session, message, entryId = null) {
    if (!message || message.role !== "assistant") return false;
    const requestedModel = modelId(message.model);
    if (!requestedModel) return false;

    const sessionPath = text(session?.sessionPath);
    const headerSessionId = readSessionHeaderId(sessionPath, this.sessionHeaderIds);
    const basenameSessionId = sessionPath ? path.basename(sessionPath, path.extname(sessionPath)) : null;
    const externalSessionId = text(session?.sessionId) || null;
    const sessionId = headerSessionId || externalSessionId || null;
    const agent = agentFromSession(session);
    const responseModel = modelId(message.responseModel) || requestedModel;
    const provider = text(message.provider || message.model?.provider || message.responseProvider, "unknown");
    const at = normalizeAt(message.timestamp);
    const usage = normalizeUsage(message.usage);
    const id = stableMessageId({
      message,
      entryId,
      agent,
      sessionId,
      sessionPath,
      at,
      provider,
      requestedModel,
      responseModel,
    });
    const route = this.normalizeRoute({
      id,
      at,
      agent,
      sessionId,
      provider,
      requestedModel,
      responseModel,
      isRouted: requestedModel !== responseModel ? 1 : 0,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.total,
    });
    if (!route) return false;
    this.ensureStorage();
    if (this.reconcileLegacy(route, [sessionId, externalSessionId, basenameSessionId])) return false;
    return this.insertRecord(route);
  }

  beginScanTransaction() {
    if (this.db) {
      this.db.exec("BEGIN IMMEDIATE");
      return { sqlite: true };
    }
    return {
      sqlite: false,
      records: this.memoryRecords.map((record) => ({ ...record })),
    };
  }

  commitScanTransaction(transaction) {
    if (transaction?.sqlite) this.db.exec("COMMIT");
  }

  rollbackScanTransaction(transaction) {
    if (transaction?.sqlite) {
      try { this.db.exec("ROLLBACK"); } catch {}
    } else if (transaction?.records) {
      this.memoryRecords.splice(0, this.memoryRecords.length, ...transaction.records.map((record) => ({ ...record })));
    }
  }

  scanSessions(homeDir = null) {
    this.ensureStorage();
    const targetHome = homeDir || deriveHanaHome(this.dataDir);
    if (!targetHome || typeof targetHome !== "string") return { scannedFiles: 0, newRoutes: 0 };
    let homeStat;
    try { homeStat = fs.lstatSync(targetHome); } catch { return { scannedFiles: 0, newRoutes: 0 }; }
    if (!homeStat.isDirectory()) return { scannedFiles: 0, newRoutes: 0 };
    const agentsDir = path.join(targetHome, "agents");
    let agentsStat;
    try { agentsStat = fs.lstatSync(agentsDir); } catch { return { scannedFiles: 0, newRoutes: 0 }; }
    if (!agentsStat.isDirectory()) return { scannedFiles: 0, newRoutes: 0 };

    let scannedFiles = 0;
    let newRoutes = 0;
    const agents = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const agent of agents) {
      const agentDir = path.join(agentsDir, agent);
      for (const rootName of ["sessions", "subagent-sessions"]) {
        const sessionFiles = listJsonlFiles(path.join(agentDir, rootName));
        for (const filePath of sessionFiles) {
          const stat = fs.statSync(filePath);
          const previous = this.scanCursors.get(filePath);
          if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;

          scannedFiles++;
          let offset = previous?.offset || 0;
          const rewritten = stat.size < offset || (previous && stat.size === previous.size && stat.mtimeMs !== previous.mtimeMs);
          if (rewritten) {
            offset = 0;
            this.sessionIds.delete(filePath);
            this.sessionHeaderIds.delete(filePath);
          }
          const unread = readFileRange(filePath, offset, stat.size);
          const completeBytes = completeJsonlBytes(unread);
          const completeText = unread.subarray(0, completeBytes).toString("utf8");
          const lines = completeText.split("\n");
          if (lines.at(-1) === "") lines.pop();
          const hadHeaderCache = this.sessionHeaderIds.has(filePath);
          let headerId = hadHeaderCache ? this.sessionHeaderIds.get(filePath) : null;
          const parsedObjects = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const object = JSON.parse(line);
              parsedObjects.push(object);
              const discovered = sessionHeaderIdFromObject(object);
              if (discovered) headerId = discovered;
            } catch {
              this.log("warn", "[model-routing] 跳过无法解析的会话行:", filePath);
            }
          }
          if (headerId) this.sessionHeaderIds.set(filePath, headerId);
          else if (!hadHeaderCache && completeBytes > 0) this.sessionHeaderIds.set(filePath, null);
          let sessionId = headerId || this.sessionIds.get(filePath) || path.basename(filePath, path.extname(filePath));
          const transaction = this.beginScanTransaction();
          try {
            for (const object of parsedObjects) {
              const objectHeaderId = sessionHeaderIdFromObject(object);
              if (objectHeaderId) sessionId = objectHeaderId;
              const message = object?.message;
              if (!message || message.role !== "assistant" || !modelId(message.model)) continue;
              const entryId = message.timestamp === undefined || message.timestamp === null ? object?.id : null;
              if (this.recordMessage({ agentId: agent, sessionId, sessionPath: filePath }, message, entryId)) newRoutes++;
            }
            this.commitScanTransaction(transaction);
            this.sessionIds.set(filePath, sessionId);
            this.scanCursors.set(filePath, {
              offset: offset + completeBytes,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            });
          } catch (error) {
            this.rollbackScanTransaction(transaction);
            throw error;
          }
        }
      }
    }
    return { scannedFiles, newRoutes };
  }

  queryRoutes({
    range = "all",
    from = null,
    to = null,
    agent = "",
    model = "",
    provider = "",
    status = "all",
    limit = 100,
    offset = 0,
    force = false,
    refresh = false,
  } = {}, scanHome = null) {
    this.ensureStorage();
    const selectedRange = range === undefined || range === null || range === "" ? "all" : range;
    const selectedStatus = status === undefined || status === null || status === "" ? "all" : status;
    if (!ALLOWED_RANGES.has(selectedRange)) throw invalidQuery("不支持的时间范围");
    if (!ALLOWED_STATUS.has(selectedStatus)) throw invalidQuery("不支持的状态筛选");

    const explicitFrom = from === undefined || from === null || from === "" ? null : from;
    const explicitTo = to === undefined || to === null || to === "" ? null : to;
    if ((explicitFrom === null) !== (explicitTo === null)) throw invalidQuery("日期参数无效");
    if (selectedRange === "custom" && explicitFrom === null) throw invalidQuery("日期参数无效");
    if (explicitFrom !== null
      && (typeof explicitFrom !== "string" || typeof explicitTo !== "string"
        || !validDay(explicitFrom) || !validDay(explicitTo) || explicitFrom > explicitTo)) {
      throw invalidQuery("日期参数无效");
    }

    const explicitRange = explicitFrom === null ? null : { from: explicitFrom, to: explicitTo };
    const rangeDate = selectedRange === "all" || selectedRange === "custom"
      ? null
      : computeDateRange(selectedRange, null, null, this.appTimeZone);
    const dateRange = intersectDateRanges(rangeDate, explicitRange);
    const safeLimit = queryInteger(limit, 100, 1, 500);
    const safeOffset = queryInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const cleanAgent = text(agent);
    const cleanModel = text(model);
    const cleanProvider = text(provider);
    const forceScan = force === true || force === "true" || refresh === true || refresh === "true";
    if (forceScan) this.scanSessions(scanHome);

    if (this.db) {
      const baseWhere = [];
      const baseParams = [];
      if (dateRange) {
        baseWhere.push("day >= ? AND day <= ?");
        baseParams.push(dateRange.from, dateRange.to);
      }
      if (cleanAgent) {
        baseWhere.push("agent = ?");
        baseParams.push(cleanAgent);
      }
      if (cleanProvider) {
        baseWhere.push("provider = ?");
        baseParams.push(cleanProvider);
      }
      if (cleanModel) {
        const compound = compositeModelFilter(cleanModel);
        if (compound) {
          baseWhere.push("(requested_model = ? OR response_model = ? OR (provider = ? AND (requested_model = ? OR response_model = ?)))");
          baseParams.push(cleanModel, cleanModel, compound.provider, compound.model, compound.model);
        } else {
          baseWhere.push("(requested_model = ? OR response_model = ?)");
          baseParams.push(cleanModel, cleanModel);
        }
      }
      const baseClause = baseWhere.length ? `WHERE ${baseWhere.join(" AND ")}` : "";
      const summary = this.db.prepare(`
        SELECT count(*) AS total_calls,
               coalesce(sum(CASE WHEN is_routed = 1 THEN 1 ELSE 0 END), 0) AS routed_count,
               coalesce(sum(CASE WHEN is_routed = 0 THEN 1 ELSE 0 END), 0) AS normal_count,
               coalesce(sum(total_tokens), 0) AS total_tokens,
               coalesce(sum(CASE WHEN is_routed = 1 THEN total_tokens ELSE 0 END), 0) AS routed_tokens
        FROM model_routes ${baseClause}
      `).get(...baseParams) || {};
      const topPairs = this.db.prepare(`
        SELECT provider, requested_model AS requestedModel, response_model AS responseModel,
               count(*) AS count, coalesce(sum(total_tokens), 0) AS tokens
        FROM model_routes
        ${baseClause ? `${baseClause} AND is_routed = 1` : "WHERE is_routed = 1"}
        GROUP BY provider, requested_model, response_model
        ORDER BY count DESC, provider ASC, requested_model ASC, response_model ASC
        LIMIT 10
      `).all(...baseParams);

      const listWhere = [...baseWhere];
      const listParams = [...baseParams];
      if (selectedStatus === "routed") {
        listWhere.push("is_routed = 1");
      } else if (selectedStatus === "normal") {
        listWhere.push("is_routed = 0");
      }
      const listClause = listWhere.length ? `WHERE ${listWhere.join(" AND ")}` : "";
      const count = this.db.prepare(`SELECT count(*) AS count FROM model_routes ${listClause}`).get(...listParams) || {};
      const rows = this.db.prepare(`
        SELECT id, at, day, agent, session_id AS sessionId, provider,
               requested_model AS requestedModel, response_model AS responseModel,
               is_routed AS isRouted, input_tokens AS inputTokens,
               output_tokens AS outputTokens, cache_read AS cacheRead,
               total_tokens AS totalTokens
        FROM model_routes ${listClause}
        ORDER BY at DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(...listParams, safeLimit, safeOffset);
      return this.result({
        totalCalls: Number(summary.total_calls) || 0,
        routedCount: Number(summary.routed_count) || 0,
        normalCount: Number(summary.normal_count) || 0,
        totalTokens: Number(summary.total_tokens) || 0,
        routedTokens: Number(summary.routed_tokens) || 0,
        topPairs,
        rows,
        total: Number(count.count) || 0,
        limit: safeLimit,
        offset: safeOffset,
      });
    }

    let baseFiltered = this.memoryRecords.slice();
    if (dateRange) {
      baseFiltered = baseFiltered.filter((record) => record.day >= dateRange.from && record.day <= dateRange.to);
    }
    if (cleanAgent) baseFiltered = baseFiltered.filter((record) => record.agent === cleanAgent);
    if (cleanProvider) baseFiltered = baseFiltered.filter((record) => record.provider === cleanProvider);
    if (cleanModel) baseFiltered = baseFiltered.filter((record) => modelMatches(record, cleanModel));

    let routedCount = 0;
    let normalCount = 0;
    let totalTokens = 0;
    let routedTokens = 0;
    const pairMap = new Map();
    for (const record of baseFiltered) {
      totalTokens += record.totalTokens;
      if (record.isRouted) {
        routedCount++;
        routedTokens += record.totalTokens;
        const key = `${record.provider}\u0000${record.requestedModel}\u0000${record.responseModel}`;
        const pair = pairMap.get(key) || {
          provider: record.provider,
          requestedModel: record.requestedModel,
          responseModel: record.responseModel,
          count: 0,
          tokens: 0,
        };
        pair.count++;
        pair.tokens += record.totalTokens;
        pairMap.set(key, pair);
      } else {
        normalCount++;
      }
    }
    let listFiltered = baseFiltered;
    if (selectedStatus === "routed") listFiltered = baseFiltered.filter((record) => record.isRouted);
    if (selectedStatus === "normal") listFiltered = baseFiltered.filter((record) => !record.isRouted);
    listFiltered.sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id));
    const topPairs = [...pairMap.values()]
      .sort((left, right) => right.count - left.count
        || left.provider.localeCompare(right.provider)
        || left.requestedModel.localeCompare(right.requestedModel)
        || left.responseModel.localeCompare(right.responseModel))
      .slice(0, 10);
    return this.result({
      totalCalls: baseFiltered.length,
      routedCount,
      normalCount,
      totalTokens,
      routedTokens,
      topPairs,
      rows: listFiltered.slice(safeOffset, safeOffset + safeLimit),
      total: listFiltered.length,
      limit: safeLimit,
      offset: safeOffset,
    });
  }

  result({ totalCalls, routedCount, normalCount, totalTokens, routedTokens, topPairs, rows, total, limit, offset }) {
    return {
      ok: true,
      summary: {
        totalCalls,
        routedCount,
        normalCount,
        totalRouted: routedCount,
        routeRate: totalCalls > 0 ? Number(((routedCount / totalCalls) * 100).toFixed(1)) : 0,
        totalTokens,
        routedTokens,
        topPairs: topPairs.map((pair) => ({
          provider: pair.provider,
          requestedModel: pair.requestedModel,
          responseModel: pair.responseModel,
          count: Number(pair.count) || 0,
          tokens: Number(pair.tokens) || 0,
        })),
      },
      routes: rows.map((row) => ({
        id: row.id,
        at: row.at,
        day: row.day,
        agent: row.agent,
        sessionId: row.sessionId,
        provider: row.provider,
        requestedModel: row.requestedModel,
        responseModel: row.responseModel,
        isRouted: row.isRouted === 1 || row.isRouted === true,
        tokens: {
          input: Number(row.inputTokens) || 0,
          output: Number(row.outputTokens) || 0,
          cacheRead: Number(row.cacheRead) || 0,
          total: Number(row.totalTokens) || 0,
        },
      })),
      total,
      limit,
      offset,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db?.close(); } catch {}
    this.db = null;
    this.insertStmt = null;
  }
}
