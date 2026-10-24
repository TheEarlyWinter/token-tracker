// runtime/engine/services/session-sources.js
// 父会话 namespace 映射的持久层：只保存 { sessionId: namespace } 与失败时间戳，
// 不保存 session:get 返回的标题、正文、路径等任何其他字段。
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./jsonl-log.js";

const FILE_VERSION = 1;
const MAX_ID_LENGTH = 256;
const MAX_NAMESPACE_LENGTH = 64;
const FAILURE_RETRY_MS = 5 * 60 * 1000;

const noop = () => {};
function asLog(log) {
  if (!log) return { info: noop, warn: noop, error: noop };
  if (typeof log === "function") return { info: log, warn: log, error: log };
  return log;
}

function safeId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null;
  if (trimmed === "__proto__" || trimmed === "constructor" || trimmed === "prototype") return null;
  return trimmed;
}

function safeNamespace(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_NAMESPACE_LENGTH) return null;
  return trimmed;
}

export function openSessionSourceStore({ file, log = null } = {}) {
  log = asLog(log);
  const sources = new Map();
  const failures = new Map();
  let capability = null;
  let updatedAt = null;
  let dirty = false;

  function load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if (e && e.code !== "ENOENT") {
        log.warn("[token-tracker] session source cache 解析失败，改用空映射：", e.code || "", e.message);
        try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
      }
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    for (const [id, ns] of Object.entries(parsed.sources || {})) {
      const key = safeId(id);
      const value = safeNamespace(ns);
      if (key && value) sources.set(key, value);
    }
    for (const [id, ts] of Object.entries(parsed.failures || {})) {
      const key = safeId(id);
      const time = Number(ts);
      if (key && Number.isFinite(time)) failures.set(key, time);
    }
    if (typeof parsed.capability === "string") capability = parsed.capability;
    if (typeof parsed.updatedAt === "string") updatedAt = parsed.updatedAt;
  }

  load();

  function has(sessionId) {
    const key = safeId(sessionId);
    return !!key && sources.has(key);
  }

  function get(sessionId) {
    const key = safeId(sessionId);
    return (key && sources.get(key)) || null;
  }

  function set(sessionId, namespace) {
    const key = safeId(sessionId);
    const value = safeNamespace(namespace);
    if (!key || !value) return false;
    if (sources.get(key) === value) {
      failures.delete(key);
      return false;
    }
    sources.set(key, value);
    failures.delete(key);
    dirty = true;
    return true;
  }

  function fail(sessionId, timestamp = Date.now()) {
    const key = safeId(sessionId);
    if (!key || sources.has(key)) return false;
    const time = Number.isFinite(timestamp) ? timestamp : Date.now();
    failures.set(key, time);
    dirty = true;
    return true;
  }

  function failedRecently(sessionId, now = Date.now()) {
    const key = safeId(sessionId);
    if (!key) return false;
    const ts = failures.get(key);
    if (ts === undefined) return false;
    if (now - ts >= FAILURE_RETRY_MS) {
      failures.delete(key);
      dirty = true;
      return false;
    }
    return true;
  }

  function setCapability(value) {
    const next = value === "unavailable" ? "unavailable" : value === "ready" ? "ready" : null;
    if (next === capability) return;
    capability = next;
    dirty = true;
  }

  function save() {
    if (!dirty) return 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    updatedAt = new Date().toISOString();
    const payload = {
      version: FILE_VERSION,
      updatedAt,
      capability,
      sources: Object.fromEntries(sources),
      failures: Object.fromEntries(failures),
    };
    const text = JSON.stringify(payload);
    writeFileAtomic(file, text);
    dirty = false;
    return Buffer.byteLength(text);
  }

  return {
    file,
    has,
    get,
    set,
    fail,
    failedRecently,
    setCapability,
    get capability() { return capability; },
    get pending() { return dirty; },
    save,
    size: () => sources.size,
  };
}

export default { openSessionSourceStore };
