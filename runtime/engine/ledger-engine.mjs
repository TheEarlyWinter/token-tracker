import path from "node:path";
import { openArchiveStore } from "./services/archive-store.js";
import { createJsonJournalStore } from "./services/json-journal-store.js";
import { normalizeEntryForArchive } from "../../lib/ledger-normalization.mjs";
export { normalizeEntryForArchive } from "../../lib/ledger-normalization.mjs";

const CACHE_FILE = "token-cache.json";
const ARCHIVE_FILE = "usage-archive.json";
const CACHE_VERSION = 20;
const MAX_LEDGER_LIMIT = 20000;
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const hourFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false });
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
      totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0,
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
      totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0,
      cacheRead: 0, cacheWrite: 0, assistantCount: 0, models: {}, providerTotals: {},
    };
  }
  const hourly = bucket.hourlyBreakdown[day][hour];
  hourly.totalTokens += total;
  if (hourly[type] !== undefined) hourly[type] += total;
  hourly.cacheRead += cacheRead;
  hourly.cacheWrite += cacheWrite;
  hourly.assistantCount++;
  if (!hourly.models[model]) {
    hourly.models[model] = { totalTokens: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0 };
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
      hourly.providerTotals[providerKey] = { totalTokens: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0 };
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
    this.cacheStore = createJsonJournalStore({ file: this.cachePath, log: this.log });
    const cached = this.cacheStore.load();
    const meta = cached || this.cacheStore.readMeta() || {};
    this.data = { ...meta, sessions: cached?.sessions || {} };
    this.ready = !!cached;
    this.revision = 0;
    this.dirtyBuckets = new Set();
    this.bucketIndex = new Map();
    for (const record of Object.values(this.archiveStore.entries)) this.indexRecord(record);
  }

  indexRecord(record) {
    const bucket = bucketFor(record);
    let records = this.bucketIndex.get(bucket.key);
    if (!records) this.bucketIndex.set(bucket.key, records = []);
    records.push(record);
    return bucket.key;
  }

  archiveUsage(raw) {
    if (!raw || raw.status !== "ok" || !raw.usage || typeof raw.requestId !== "string" || !raw.requestId) {
      return { accepted: false, reason: "invalid_entry" };
    }
    if (this.archiveStore.entries[raw.requestId]) return { accepted: false, reason: "duplicate" };
    const record = normalizeEntryForArchive(raw);
    const key = this.indexRecord(record);
    this.archiveStore.entries[raw.requestId] = record;
    this.dirtyBuckets.add(key);
    this.archiveStore.updatedAt = new Date().toISOString();
    const persisted = this.archiveStore.appendPending();
    return { accepted: true, rows: persisted.rows, archiveCount: this.archiveStore.size() };
  }

  async scan(entries, options = {}) {
    if (!Array.isArray(entries)) entries = [];
    const force = options.force === true;
    const previous = this.data;
    const cache = { ...previous, version: CACHE_VERSION, sessions: previous.sessions || {} };
    if (options.agentNames && Object.keys(options.agentNames).length) {
      cache.agentNames = { ...(options.agentNames || {}), ...(cache.agentNames || {}) };
    }

    let newArchivedCount = 0;
    for (const raw of entries) {
      if (!raw || typeof raw.requestId !== "string" || !raw.requestId || raw.status !== "ok" || !raw.usage) continue;
      if (this.archiveStore.entries[raw.requestId]) continue;
      const record = normalizeEntryForArchive(raw);
      this.archiveStore.entries[raw.requestId] = record;
      this.dirtyBuckets.add(this.indexRecord(record));
      newArchivedCount++;
    }
    if (newArchivedCount > 0 || !this.archiveStore.updatedAt) this.archiveStore.updatedAt = new Date().toISOString();
    // Always flush pending rows; this also retries an append interrupted by a prior disk error.
    const archiveWrite = this.archiveStore.appendPending();

    const fullRebuild = force || !previous?.sessions || previous.version !== CACHE_VERSION;
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
    cache.prediction = computePrediction(cache, buildDailyGlobal(cache));

    const persistence = this.cacheStore.save(cache, [...dirty], fullRebuild);
    this.cacheStore.saveMeta(cache);
    this.data = cache;
    this.ready = true;
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
  close() { try { this.cacheStore.close(); } catch {} }
}

export function createLedgerEngine(options) {
  return new LedgerEngine(options);
}
