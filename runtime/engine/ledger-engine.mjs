import fs from "node:fs";
import path from "node:path";
import { openArchiveStore } from "./services/archive-store.js";
import { createJsonJournalStore } from "./services/json-journal-store.js";
import { openTurnsStore } from "./services/turns-store.js";
import { openSessionSourceStore } from "./services/session-sources.js";
import { normalizeEntryForArchive } from "../../lib/ledger-normalization.mjs";
export { normalizeEntryForArchive } from "../../lib/ledger-normalization.mjs";

const CACHE_FILE = "token-cache.json";
const ARCHIVE_FILE = "usage-archive.json";
const SESSION_SOURCES_FILE = "session-sources.json";
const MAX_CANDIDATES = 64;
const MAX_SOURCE_ENTRIES = 256;
// turns 派生索引键版本：session_key 必须等于聚合缓存桶键。
const TURNS_INDEX_KEY = "bucket-v1";
const MAX_PENDING_SOURCES = 256;
const MAX_NAMESPACE_LENGTH = 64;
const CACHE_VERSION = 20;
const MAX_LEDGER_LIMIT = 20000;

const appTimeZone = process.env.TOKEN_TRACKER_FORCE_TZ || "Asia/Shanghai";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: appTimeZone });
const hourFmt = new Intl.DateTimeFormat("en-CA", { timeZone: appTimeZone, hour: "2-digit", hour12: false });
const noop = () => {};

function asLog(log) {
  if (!log) return { info: noop, warn: noop, error: noop };
  if (typeof log === "function") return { info: log, warn: log, error: log };
  return log;
}

function bucketFor(record) {
  const value = record.startedAt || record.endedAt || "";
  const parsed = value ? new Date(value) : new Date();
  const date = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  const day = dayFmt.format(date);
  return { key: `${record.agentId || "unknown"}::${record.type || "desktop"}::${day}`, day, hour: String(hourFmt.format(date)).padStart(2, "0") };
}

function createSession(day) {
  return {
    agent: "unknown", type: "desktop", channelName: null,
    filePath: "usage-ledger.sqlite", mtime: 0, size: 0, fileName: "usage-ledger.sqlite",
    firstTime: null, lastTime: null, msgCount: 0, assistantCount: 0,
    input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0, cost: 0, models: {}, providers: {}, conversations: [], mediaGen: {},
    dailyBreakdown: {}, hourlyBreakdown: {}, title: day,
  };
}

function emptyTypeTotals() {
  return { totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0, code: 0 };
}

function addRecordToBucket(bucket, record, day, hour) {
  const provider = record.provider || "";
  const model = record.model || "unknown";
  const type = record.type || "desktop";
  const ts = record.startedAt || record.endedAt || "";
  const input = record.inputTokens || 0;
  const inputUncached = record.inputUncachedTokens ?? input;
  const output = record.outputTokens || 0;
  const cacheRead = record.cacheReadTokens || 0;
  const cacheWrite = record.cacheWriteTokens || 0;
  const total = record.totalTokens || (input + output + cacheRead);
  const cost = record.costTotal || 0;

  if (!bucket.firstTime) bucket.firstTime = ts;
  if (!bucket.lastTime || ts > bucket.lastTime) bucket.lastTime = ts;
  bucket.msgCount++;
  bucket.assistantCount++;
  bucket.input += input;
  bucket.inputUncached += inputUncached;
  bucket.output += output;
  bucket.cacheRead += cacheRead;
  bucket.cacheWrite += cacheWrite;
  bucket.totalTokens += total;
  bucket.cost += cost;

  if (!bucket.conversations) bucket.conversations = [];
  bucket.conversations.push({
    time: ts,
    provider,
    model,
    totalTokens: total,
    inTokens: input,
    outTokens: output,
    cacheRead,
    msgCount: 1,
  });

  if (!bucket.models[model]) bucket.models[model] = { input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 };
  const modelStats = bucket.models[model];
  modelStats.input += input;
  modelStats.inputUncached += inputUncached;
  modelStats.output += output;
  modelStats.cacheRead += cacheRead;
  modelStats.cacheWrite += cacheWrite;
  modelStats.count++;

  if (provider) {
    const providerKey = `${provider}/${model}`;
    if (!bucket.providers[providerKey]) bucket.providers[providerKey] = { provider, model, totalTokens: 0, count: 0, input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const stats = bucket.providers[providerKey];
    stats.totalTokens += total;
    stats.count++;
    stats.input += input;
    stats.inputUncached += inputUncached;
    stats.output += output;
    stats.cacheRead += cacheRead;
    stats.cacheWrite += cacheWrite;
  }

  if (!bucket.dailyBreakdown[day]) {
    bucket.dailyBreakdown[day] = {
      ...emptyTypeTotals(),
      input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0,
      models: {}, providerTotals: {},
    };
  }
  const daily = bucket.dailyBreakdown[day];
  daily.totalTokens += total;
  if (daily[type] !== undefined) daily[type] += total;
  else daily[type] = total;
  daily.input += input;
  daily.inputUncached += inputUncached;
  daily.output += output;
  daily.cacheRead += cacheRead;
  daily.cacheWrite += cacheWrite;
  daily.assistantCount++;
  if (!daily.models[model]) daily.models[model] = { input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, assistantCount: 0 };
  const dailyModel = daily.models[model];
  dailyModel.input += input;
  dailyModel.inputUncached += inputUncached;
  dailyModel.output += output;
  dailyModel.cacheRead += cacheRead;
  dailyModel.cacheWrite += cacheWrite;
  dailyModel.totalTokens += total;
  dailyModel.assistantCount++;
  if (provider) {
    const providerKey = `${provider}/${model}`;
    if (!daily.providerTotals[providerKey]) daily.providerTotals[providerKey] = { totalTokens: 0, input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0 };
    const stats = daily.providerTotals[providerKey];
    stats.totalTokens += total;
    stats.input += input;
    stats.inputUncached += inputUncached;
    stats.output += output;
    stats.cacheRead += cacheRead;
    stats.cacheWrite += cacheWrite;
    stats.assistantCount++;
  }

  if (!bucket.hourlyBreakdown[day]) bucket.hourlyBreakdown[day] = {};
  if (!bucket.hourlyBreakdown[day][hour]) {
    bucket.hourlyBreakdown[day][hour] = {
      ...emptyTypeTotals(),
      cacheRead: 0, cacheWrite: 0, assistantCount: 0, models: {}, providerTotals: {},
    };
  }
  const hourly = bucket.hourlyBreakdown[day][hour];
  hourly.totalTokens += total;
  if (hourly[type] !== undefined) hourly[type] += total;
  else hourly[type] = total;
  hourly.cacheRead += cacheRead;
  hourly.cacheWrite += cacheWrite;
  hourly.assistantCount++;
  if (!hourly.models[model]) {
    hourly.models[model] = { ...emptyTypeTotals(), cacheRead: 0, cacheWrite: 0, assistantCount: 0 };
  }
  const hourlyModel = hourly.models[model];
  hourlyModel.totalTokens += total;
  hourlyModel.cacheRead += cacheRead;
  hourlyModel.cacheWrite += cacheWrite;
  hourlyModel.assistantCount++;
  if (hourlyModel[type] !== undefined) hourlyModel[type] += total;
  if (provider) {
    const providerKey = `${provider}/${model}`;
    if (!hourly.providerTotals[providerKey]) {
      hourly.providerTotals[providerKey] = { ...emptyTypeTotals(), cacheRead: 0, cacheWrite: 0, assistantCount: 0 };
    }
    const stats = hourly.providerTotals[providerKey];
    stats.totalTokens += total;
    stats.cacheRead += cacheRead;
    stats.cacheWrite += cacheWrite;
    stats.assistantCount++;
    if (stats[type] !== undefined) stats[type] += total;
  }
}

function aggregateBucket(key, records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const parts = key.split("::");
  const day = parts[parts.length - 1] || "";
  const bucket = createSession(day);
  bucket.agent = parts[0] || "unknown";
  bucket.type = parts[1] || "desktop";
  for (const record of records) {
    const when = bucketFor(record);
    addRecordToBucket(bucket, record, when.day, when.hour);
  }
  return bucket.agent === "unknown" ? null : bucket;
}

function buildDailyGlobal(cache) {
  const dailyGlobal = {};
  for (const session of Object.values(cache.sessions || {})) {
    for (const [day, values] of Object.entries(session.dailyBreakdown || {})) {
      dailyGlobal[day] = (dailyGlobal[day] || 0) + (values.totalTokens || 0);
    }
  }
  return dailyGlobal;
}

function computePrediction(cache, dailyGlobal) {
  const days = Object.keys(dailyGlobal).sort();
  if (days.length < 2) return null;
  const values = days.map(day => dailyGlobal[day]);
  const dailyAvg = Math.round(values.slice(-7).reduce((sum, value) => sum + value, 0) / Math.min(7, values.length));
  const today = dayFmt.format(new Date());
  const hourTotals = new Array(24).fill(0);
  let histDays = 0;
  for (const session of Object.values(cache.sessions || {})) {
    for (const [day, hours] of Object.entries(session.hourlyBreakdown || {})) {
      if (day === today) continue;
      let hasData = false;
      for (const [hour, data] of Object.entries(hours)) {
        const index = Number.parseInt(hour, 10);
        if (Number.isInteger(index) && index >= 0 && index < 24) hourTotals[index] += data.totalTokens || 0;
        hasData = true;
      }
      if (hasData) histDays++;
    }
  }
  const histTotal = hourTotals.reduce((sum, value) => sum + value, 0);
  let cumulativePct = null;
  if (histDays >= 3 && histTotal > 0) {
    cumulativePct = new Array(24);
    let running = 0;
    for (let hour = 0; hour < 24; hour++) {
      running += hourTotals[hour] / histTotal;
      cumulativePct[hour] = running;
    }
  }
  const monthPrefix = today.slice(0, 7);
  let monthToDate = 0;
  for (const [day, total] of Object.entries(dailyGlobal)) if (day.startsWith(monthPrefix)) monthToDate += total;
  const now = new Date();
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeftInMonth = Math.max(0, lastDayOfMonth - now.getDate());
  return { dailyAvg, cumulativePct, monthToDate, daysLeftInMonth, projectedMonthEnd: Math.round(monthToDate + dailyAvg * daysLeftInMonth) };
}

export class LedgerEngine {
  constructor({ dataDir, log = null } = {}) {
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new TypeError("dataDir must be an absolute path");
    this.dataDir = dataDir;
    this.log = asLog(log);
    this.cachePath = path.join(dataDir, CACHE_FILE);
    this.archiveStore = openArchiveStore(path.join(dataDir, ARCHIVE_FILE), this.log);
    this.sourceStore = openSessionSourceStore({ file: path.join(dataDir, SESSION_SOURCES_FILE), log: this.log });
    this.cacheStore = createJsonJournalStore({ file: this.cachePath, log: this.log });
    this.turnsStore = openTurnsStore({ file: path.join(dataDir, "cache.sqlite"), log: this.log });
    const cached = this.cacheStore.load();
    const meta = cached || this.cacheStore.readMeta() || {};
    this.data = { ...meta, sessions: cached?.sessions || {} };
    this.ready = !!cached;
    this.revision = 0;
    this.dirtyBuckets = new Set();
    this.bucketIndex = new Map();
    this.recordKeys = new Map();
    for (const [rid, record] of Object.entries(this.archiveStore.entries)) {
      this.applyStoredType(rid, record);
      this.indexRecord(record);
    }
    this.turnsIndexReady = false;
    this.turnsNeedsRebuild = true;
    this.checkTurnsReadiness();
    // 上次写盘停在聚合与代次元数据之间：必须从原始归档重算，不能相信可能半更新的聚合缓存。
    if (this.data.aggregateWritePending === true) {
      this.needsFullRebuild = true;
      this.turnsIndexReady = false;
      this.turnsNeedsRebuild = true;
    }
    this.data.turnsIndexReady = this.turnsIndexReady;
    // 归档是唯一请求记录源：缓存/索引一旦落后于归档（写盘窗口中断），下一轮必须全量重建。
    this.needsFullRebuild = this.needsFullRebuild === true || this.archiveCoverageMismatch();
  }

  validSessionId(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 256) return null;
    if (trimmed === "__proto__" || trimmed === "constructor" || trimmed === "prototype") return null;
    return trimmed;
  }

  // 持久写入屏障：在任何 source/归档/聚合变更前先将 pending 写卡，避免 journal 变而代次未变。
  beginAggregateWrite() {
    if (this.data.aggregateWritePending === true) return;
    const pending = { ...this.data, aggregateWritePending: true, turnsIndexReady: false };
    this.cacheStore.saveMeta(pending);
    this.data = pending;
  }

  // 仅在聚合、代次与 SQLite 都处理完后才清屏障；最后写失败则保留 pending 供下次恢复。
  finalizeAggregateWrite(cache) {
    cache.aggregateWritePending = false;
    cache.turnsIndexReady = this.turnsIndexReady === true;
    try {
      this.cacheStore.saveMeta(cache);
      return true;
    } catch (error) {
      this.log.warn?.("[token-tracker] cache barrier clear failed: " + error.message);
      cache.aggregateWritePending = true;
      cache.turnsIndexReady = false;
      this.turnsIndexReady = false;
      this.turnsNeedsRebuild = true;
      try { this.cacheStore.saveMeta(cache); } catch {}
      return false;
    }
  }

  // 数据代次核对：cache.turnsGeneration 与 SQLite data_generation 必须一致，且键标记与内容存在。
  checkTurnsReadiness() {
    this.turnsIndexReady = false;
    this.turnsNeedsRebuild = true;
    if (!this.turnsStore) return;
    const hasSessions = Object.keys(this.data.sessions || {}).length > 0;
    try {
      if (!hasSessions && !fs.existsSync(path.join(this.dataDir, "cache.sqlite"))) {
        this.turnsIndexReady = true;
        this.turnsNeedsRebuild = false;
        return;
      }
      const marker = this.turnsStore.getMeta("index_key");
      const rawGeneration = this.turnsStore.getMeta("data_generation");
      const cacheGeneration = Number(this.data.turnsGeneration) || 0;
      const rows = this.turnsStore.count();
      // 无聚合会话但留着旧 SQLite：即为陈旧派生行，必须重建清空。
      if (!hasSessions && rows > 0) return;
      if (hasSessions && rows === 0) return;
      if (marker !== TURNS_INDEX_KEY) return;
      // 旧版本只写过键标记、没有内容代次：不能当作已就绪。
      if (rawGeneration === null || rawGeneration === undefined) return;
      const diskGeneration = Number(rawGeneration);
      if (!Number.isFinite(diskGeneration) || diskGeneration !== cacheGeneration) return;
      this.turnsIndexReady = true;
      this.turnsNeedsRebuild = false;
    } catch (error) {
      this.log.warn?.("[token-tracker] turns index readiness check failed: " + error.message);
    }
  }

  // 只有内容事务与代次写入都成功后才能就绪；否则同进程下一轮强制全量重建。
  applyTurns(cache, { fullRebuild, dirty }) {
    if (!this.turnsStore) {
      this.turnsIndexReady = false;
      cache.turnsIndexReady = false;
      return;
    }
    const full = fullRebuild || this.turnsNeedsRebuild || !this.turnsIndexReady;
    let contentOk = false;
    try {
      if (full) this.turnsStore.rebuild(cache);
      else this.turnsStore.apply(cache, { keys: [...dirty] });
      contentOk = true;
    } catch (error) {
      this.log.warn?.("[token-tracker] turnsStore " + (full ? "rebuild" : "apply") + " failed: " + error.message);
    }
    if (!contentOk) {
      this.turnsIndexReady = false;
      this.turnsNeedsRebuild = true;
      cache.turnsIndexReady = false;
    } else {
      try {
        this.turnsStore.setMeta("index_key", TURNS_INDEX_KEY);
        this.turnsStore.setMeta("data_generation", String(cache.turnsGeneration));
        this.turnsIndexReady = true;
        this.turnsNeedsRebuild = false;
        cache.turnsIndexReady = true;
      } catch (error) {
        this.log.warn?.("[token-tracker] turns index marker failed: " + error.message);
        this.turnsIndexReady = false;
        this.turnsNeedsRebuild = true;
        cache.turnsIndexReady = false;
      }
    }
    try {
      this.cacheStore.saveMeta(cache);
    } catch (error) {
      this.log.warn?.("[token-tracker] cache meta save failed: " + error.message);
    }
  }

  // 缓存/索引是否落后于归档：桶键集合或每桶请求数不一致即需全量重建。
  archiveCoverageMismatch() {
    const sessions = this.data.sessions || {};
    for (const [key, records] of this.bucketIndex) {
      if ((key.split("::")[0] || "") === "unknown") continue;
      const session = sessions[key];
      if (!session) return true;
      if ((Number(session.msgCount) || 0) !== records.length) return true;
    }
    for (const key of Object.keys(sessions)) {
      if (this.bucketIndex.has(key)) continue;
      if ((key.split("::")[0] || "") === "unknown") continue;
      return true;
    }
    return false;
  }

  // 归档记录的目标类型：已确认 namespace=code 时归 code，否则保留归档时的 baseType。
  resolveRecordType(record) {
    const baseType = record.baseType || (record.type === "code" ? "desktop" : record.type) || "desktop";
    if (!record.baseType) record.baseType = baseType;
    const namespace = record.sessionId ? this.sourceStore.get(record.sessionId) : null;
    return namespace === "code" ? "code" : baseType;
  }

  applyStoredType(rid, record) {
    if (!record) return false;
    const next = this.resolveRecordType(record);
    if (next === record.type) return false;
    record.type = next;
    return true;
  }

  indexRecord(record) {
    const bucket = bucketFor(record);
    let records = this.bucketIndex.get(bucket.key);
    if (!records) this.bucketIndex.set(bucket.key, records = []);
    records.push(record);
    if (record.requestId) this.recordKeys.set(record.requestId, bucket.key);
    return bucket.key;
  }

  // 映射变化后，把受影响会话所属的旧桶和新桶都重算；其余桶不动。
  applyClassification(sessionIds) {
    const changed = new Set();
    if (!sessionIds || !sessionIds.size) return changed;
    for (const [rid, record] of Object.entries(this.archiveStore.entries)) {
      if (!record) continue;
      const canonical = this.validSessionId(record.sessionId);
      if (!canonical || !sessionIds.has(canonical)) continue;
      const before = record.type;
      const next = this.resolveRecordType(record);
      if (next === before) continue;
      const oldKey = this.recordKeys.get(rid);
      if (oldKey) {
        const records = this.bucketIndex.get(oldKey);
        if (records) {
          const index = records.indexOf(record);
          if (index >= 0) records.splice(index, 1);
        }
        changed.add(oldKey);
      }
      record.type = next;
      const newKey = bucketFor(record).key;
      let records = this.bucketIndex.get(newKey);
      if (!records) this.bucketIndex.set(newKey, records = []);
      records.push(record);
      this.recordKeys.set(rid, newKey);
      changed.add(newKey);
    }
    return changed;
  }

  // 返回本 payload 中已真正持久化的会话 ID（sourceAckSessionIds）；保存失败或仍待写时为空。
  applySourceResolution(options = {}) {
    const changed = new Set();
    const accepted = [];
    const namespaces = options.sessionNamespaces;
    if (namespaces && typeof namespaces === "object") {
      let count = 0;
      for (const [rawId, rawNamespace] of Object.entries(namespaces)) {
        if (count >= MAX_SOURCE_ENTRIES) break;
        count++;
        const sessionId = this.validSessionId(rawId);
        const namespace = typeof rawNamespace === "string" ? rawNamespace.trim() : "";
        if (!sessionId || !namespace || namespace.length > MAX_NAMESPACE_LENGTH) continue;
        if (this.sourceStore.set(sessionId, namespace)) changed.add(sessionId);
        if (this.sourceStore.has(sessionId)) accepted.push(sessionId);
      }
    }
    const resolution = options.sourceResolution;
    if (resolution && typeof resolution === "object") {
      this.sourceStore.setCapability(resolution.capability);
      const failed = Array.isArray(resolution.failedSessionIds) ? resolution.failedSessionIds.slice(0, MAX_SOURCE_ENTRIES) : [];
      for (const sessionId of failed) this.sourceStore.fail(sessionId);
    }
    let persisted = true;
    try {
      this.sourceStore.save();
    } catch (error) {
      // 映射持久化失败只降级来源完整性：账本归档与聚合继续，dirty 保留供下轮重试。
      persisted = false;
      this.log.warn?.("[token-tracker] session source cache save failed: " + (error?.code || error?.message || "UNKNOWN"));
    }
    const ackIds = !persisted || this.sourceStore.pending ? [] : accepted.slice(0, MAX_PENDING_SOURCES);
    return { changed, ackIds };
  }

  unresolvedSessionIds() {
    const unresolved = new Set();
    for (const record of Object.values(this.archiveStore.entries)) {
      const sessionId = this.validSessionId(record?.sessionId);
      if (!sessionId) continue;
      if (this.sourceStore.has(sessionId)) continue;
      unresolved.add(sessionId);
    }
    return [...unresolved];
  }

  // 无合法父会话 ID 的请求数：仍计入总量与原类别，但完整性不能宣称 complete。
  unresolvedRecordCount() {
    let count = 0;
    for (const record of Object.values(this.archiveStore.entries)) {
      if (!this.validSessionId(record?.sessionId)) count++;
    }
    return count;
  }

  sessionCandidates({ limit, recent } = {}) {
    const raw = Number(limit);
    const max = limit === undefined || !Number.isFinite(raw)
      ? 24
      : Math.min(Math.max(1, Math.floor(raw)), MAX_CANDIDATES);
    const now = Date.now();
    const known = {};
    const cooling = [];
    const recentIds = new Set();
    for (const value of Array.isArray(recent) ? recent.slice(0, MAX_SOURCE_ENTRIES) : []) {
      const sessionId = this.validSessionId(value);
      if (!sessionId) continue;
      recentIds.add(sessionId);
      if (Object.prototype.hasOwnProperty.call(known, sessionId) || cooling.includes(sessionId)) continue;
      if (this.sourceStore.has(sessionId)) {
        known[sessionId] = this.sourceStore.get(sessionId);
      } else if (this.sourceStore.failedRecently(sessionId, now)) {
        cooling.push(sessionId);
      }
    }
    const totals = new Map();
    for (const record of Object.values(this.archiveStore.entries)) {
      const sessionId = this.validSessionId(record?.sessionId);
      if (!sessionId) continue;
      if (recentIds.has(sessionId)) continue;
      if (this.sourceStore.has(sessionId)) continue;
      if (this.sourceStore.failedRecently(sessionId, now)) continue;
      const ts = record.startedAt || record.endedAt || "";
      const previous = totals.get(sessionId);
      if (previous === undefined || ts < previous) totals.set(sessionId, ts);
    }
    // 历史优先最老且不在冷却中的会话，避免新会话持续到来时饥饿；recent 已在排序/截断前排除。
    const sessionIds = [...totals.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, max)
      .map(([sessionId]) => sessionId);
    return { sessionIds, known, cooling };
  }

  archiveUsage(raw) {
    if (!raw || raw.status !== "ok" || !raw.usage || typeof raw.requestId !== "string" || !raw.requestId) {
      return { accepted: false, reason: "invalid_entry" };
    }
    if (this.archiveStore.entries[raw.requestId]) return { accepted: false, reason: "duplicate" };
    const record = normalizeEntryForArchive(raw, { namespace: this.sourceStore.get(raw.attribution?.sessionId) });
    const key = this.indexRecord(record);
    this.archiveStore.entries[raw.requestId] = record;
    this.dirtyBuckets.add(key);
    this.archiveStore.updatedAt = new Date().toISOString();
    const persisted = this.archiveStore.appendPending();
    return { accepted: true, rows: persisted.rows, archiveCount: this.archiveStore.size() };
  }

  async scan(entries, options = {}) {
    if (!Array.isArray(entries)) entries = [];
    // 屏障必须先落盘：失败则本轮不修改任何持久数据。
    this.beginAggregateWrite();
    const force = options.force === true;
    const { changed: changedSessions, ackIds } = this.applySourceResolution(options);
    const reclassified = this.applyClassification(changedSessions);
    for (const key of reclassified) this.dirtyBuckets.add(key);
    const previous = this.data;
    const cache = {
      ...previous,
      version: CACHE_VERSION,
      sessions: previous.sessions || {},
      aggregateWritePending: true,
      turnsIndexReady: false,
    };
    if (options.agentNames && Object.keys(options.agentNames).length) {
      cache.agentNames = { ...(options.agentNames || {}), ...(cache.agentNames || {}) };
    }

    let newArchivedCount = 0;
    for (const raw of entries) {
      if (!raw || typeof raw.requestId !== "string" || !raw.requestId || raw.status !== "ok" || !raw.usage) continue;
      if (this.archiveStore.entries[raw.requestId]) continue;
      const record = normalizeEntryForArchive(raw, { namespace: this.sourceStore.get(raw.attribution?.sessionId) });
      this.archiveStore.entries[raw.requestId] = record;
      this.dirtyBuckets.add(this.indexRecord(record));
      newArchivedCount++;
    }
    if (newArchivedCount > 0 || !this.archiveStore.updatedAt) this.archiveStore.updatedAt = new Date().toISOString();
    // Always flush pending rows; this also retries an append interrupted by a prior disk error.
    const archiveWrite = this.archiveStore.appendPending();

    const fullRebuild = force || this.needsFullRebuild || !previous?.sessions || previous.version !== CACHE_VERSION;
    const dirty = new Set(this.dirtyBuckets);
    if (fullRebuild) {
      for (const key of this.bucketIndex.keys()) dirty.add(key);
      for (const key of Object.keys(previous.sessions || {})) dirty.add(key);
    }
    const sessions = fullRebuild ? {} : { ...(previous.sessions || {}) };
    for (const key of dirty) {
      const record = aggregateBucket(key, this.bucketIndex.get(key) || []);
      if (record) sessions[key] = record;
      else delete sessions[key];
    }
    cache.sessions = sessions;
    cache.lastScan = new Date().toISOString();
    cache.coverageLimitReached = options.coverageLimitReached ?? (entries.length >= MAX_LEDGER_LIMIT);
    cache.usageQueryError = options.usageQueryError || null;
    const unresolved = this.unresolvedSessionIds();
    const unresolvedRecords = this.unresolvedRecordCount();
    const capability = this.sourceStore.capability;
    const incomplete = unresolved.length > 0 || unresolvedRecords > 0 || this.sourceStore.pending;
    cache.sourceClassification = {
      status: incomplete ? (capability === "unavailable" ? "unavailable" : "partial") : "complete",
      unresolvedSessionCount: unresolved.length,
      unresolvedRecordCount: unresolvedRecords,
    };
    cache.prediction = computePrediction(cache, buildDailyGlobal(cache));

    // 代次：只有真正会改变派生内容的扫描才推进；先落缓存，再写 SQLite（失败时两代不等）。
    const turnsDirty = fullRebuild || dirty.size > 0;
    const previousGeneration = Number(previous?.turnsGeneration) || 0;
    cache.turnsGeneration = turnsDirty ? previousGeneration + 1 : previousGeneration;
    cache.turnsIndexReady = !turnsDirty && this.turnsIndexReady;

    const persistence = this.cacheStore.save(cache, [...dirty], fullRebuild);
    this.cacheStore.saveMeta(cache);
    this.applyTurns(cache, { fullRebuild, dirty });
    const committed = this.finalizeAggregateWrite(cache);
    this.data = cache;
    this.ready = true;
    if (committed) this.needsFullRebuild = false;
    this.dirtyBuckets.clear();
    this.revision++;
    this.log.info?.(`[token-tracker] ledger scan: ${entries.length} window entries, ${newArchivedCount} newly archived, ${this.archiveStore.size()} total history.`);
    return {
      ready: this.ready,
      revision: this.revision,
      lastScan: cache.lastScan,
      newArchivedCount,
      archiveCount: this.archiveStore.size(),
      archiveRowsWritten: archiveWrite.rows,
      cacheWrites: persistence.rows,
      cacheScope: persistence.scope,
      coverageLimitReached: cache.coverageLimitReached,
      usageQueryError: cache.usageQueryError,
      sourceClassification: cache.sourceClassification,
      sourceAckSessionIds: ackIds,
    };
  }

  status() {
    return { ready: this.ready, revision: this.revision, lastScan: this.data.lastScan || null, archiveCount: this.archiveStore.size(), sessionCount: Object.keys(this.data.sessions || {}).length };
  }

  page({ cursor = 0, maxBytes = 640 * 1024 } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 16 * 1024 || maxBytes > 800 * 1024) throw Object.assign(new Error("invalid page size"), { code: "INVALID_PAYLOAD" });
    const keys = Object.keys(this.data.sessions || {}).sort();
    const start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
    if (start > keys.length) throw Object.assign(new Error("invalid cache cursor"), { code: "INVALID_PAYLOAD" });
    const meta = {};
    for (const [key, value] of Object.entries(this.data)) if (key !== "sessions") meta[key] = value;
    const sessions = {};
    let bytes = Buffer.byteLength(JSON.stringify({ meta, sessions, revision: this.revision }));
    let index = start;
    while (index < keys.length) {
      const key = keys[index];
      const record = this.data.sessions[key];
      const rowBytes = Buffer.byteLength(JSON.stringify({ [key]: record }));
      if (Object.keys(sessions).length && bytes + rowBytes > maxBytes) break;
      if (!Object.keys(sessions).length && bytes + rowBytes > 900 * 1024) {
        throw Object.assign(new Error("cache record exceeds RPC page limit"), { code: "RECORD_TOO_LARGE" });
      }
      sessions[key] = record;
      bytes += rowBytes;
      index++;
      if (bytes >= maxBytes) break;
    }
    return { meta: start === 0 ? meta : null, sessions, revision: this.revision, nextCursor: index < keys.length ? index : null };
  }

  getData() { return this.data; }
  archiveCount() { return this.archiveStore.size(); }
  close() {
    try { this.turnsStore?.close?.(); } catch {}
    try { this.cacheStore.close(); } catch {}
  }
}

export function createLedgerEngine(options) {
  return new LedgerEngine(options);
}
