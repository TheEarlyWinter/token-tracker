import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomInt, randomUUID } from "node:crypto";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_RPC_BYTES = 1024 * 1024;
const MAX_BATCH_BYTES = 700 * 1024;

export function chunkLedgerEntries(entries, maxBytes = MAX_BATCH_BYTES) {
  const chunks = [];
  let chunk = [];
  let bytes = 2; // []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const text = JSON.stringify(entry);
    if (typeof text !== "string") continue;
    const entryBytes = Buffer.byteLength(text) + (chunk.length ? 1 : 0);
    if (entryBytes + 128 > MAX_RPC_BYTES) throw Object.assign(new Error("账本记录超过 RPC 大小限制"), { code: "REQUEST_TOO_LARGE" });
    if (chunk.length && bytes + entryBytes > maxBytes) {
      chunks.push(chunk);
      chunk = [];
      bytes = 2;
    }
    chunk.push(entry);
    bytes += Buffer.byteLength(text) + (chunk.length > 1 ? 1 : 0);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export class LocalClient {
  constructor({ ctx, dataDir = ctx?.dataDir, log = () => {}, startTimeoutMs = 30000, scanTimeoutMs = 5 * 60 * 1000 } = {}) {
    this.ctx = ctx;
    this.dataDir = dataDir;
    this.log = log;
    this.startTimeoutMs = startTimeoutMs;
    this.scanTimeoutMs = scanTimeoutMs;
    this.secret = randomBytes(32).toString("hex");
    this.runtimeId = null;
    this.starting = null;
    this.configFile = null;
    this.disposed = false;
    this.operationQueue = Promise.resolve();
  }

  start() {
    if (this.disposed) return Promise.reject(Object.assign(new Error("Token Tracker 已停止"), { code: "APP_STOPPED" }));
    if (this.runtimeId) return Promise.resolve(this.runtimeId);
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    const runtime = this.ctx?.runtime;
    if (!runtime?.start || !runtime?.get || !runtime?.fetch || !runtime?.stop || typeof this.dataDir !== "string") {
      throw Object.assign(new Error("宿主未提供受管运行时；请授予 app/runtime.execute 权限"), { code: "RUNTIME_UNAVAILABLE" });
    }
    await fs.mkdir(this.dataDir, { recursive: true });
    this.configFile = path.join(this.dataDir, `token-tracker-runtime-${randomUUID()}.json`);
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError = null;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.disposed) throw new Error("Token Tracker 已停止");
        const port = randomInt(40000, 60000);
        const config = { port, secret: this.secret, dataDir: this.dataDir };
        await fs.writeFile(this.configFile, JSON.stringify(config), { mode: 0o600 });
        try {
          const started = await runtime.start({
            runtime: "node",
            profile: "scoped",
            // Linux scoped/bwrap cannot expose a loopback-only managed service.
            // External networking is explicitly declared and permission-gated.
            network: "external",
            entry: "runtime/service.mjs",
            args: [this.configFile],
            service: { port, readyMarker: "TOKEN_TRACKER_READY" },
          });
          this.runtimeId = started?.runtimeId || null;
          if (!this.runtimeId) throw Object.assign(new Error("宿主没有返回运行时 ID"), { code: "RUNTIME_START_FAILED" });
          while (Date.now() <= deadline) {
            if (this.disposed) throw new Error("Token Tracker 已停止");
            const info = await runtime.get(this.runtimeId);
            if (!info || ["failed", "exited", "stopped"].includes(info.state)) {
              throw Object.assign(new Error("后台引擎启动失败"), { code: "RUNTIME_START_FAILED" });
            }
            if (info.state === "ready" && info.service?.state === "ready") {
              const status = await this._requestRuntime("status", {});
              if (status?.ready) return this.runtimeId;
              if (status?.error) throw Object.assign(new Error(status.error.message || "后台引擎初始化失败"), { code: status.error.code || "ENGINE_INIT_FAILED" });
            }
            await pause(100);
          }
          throw Object.assign(new Error("后台引擎启动超时"), { code: "RUNTIME_START_TIMEOUT" });
        } catch (error) {
          lastError = error;
          if (this.runtimeId) await runtime.stop(this.runtimeId).catch(() => {});
          this.runtimeId = null;
          if (attempt < 2 && Date.now() <= deadline && error?.code === "RUNTIME_SERVICE_BIND_FAILED") continue;
          throw error;
        } finally {
          await fs.rm(this.configFile, { force: true }).catch(() => {});
        }
      }
      throw lastError || new Error("后台引擎启动失败");
    } catch (error) {
      if (this.runtimeId) await runtime.stop(this.runtimeId).catch(() => {});
      this.runtimeId = null;
      await fs.rm(this.configFile, { force: true }).catch(() => {});
      throw error;
    }
  }

  _enqueue(work) {
    const next = this.operationQueue.then(work, work);
    this.operationQueue = next.catch(() => {});
    return next;
  }

  call(method, payload = {}) {
    return this._enqueue(async () => {
      await this.start();
      return this._requestRuntime(method, payload);
    });
  }

  async _requestRuntime(method, payload = {}) {
    if (this.disposed) throw Object.assign(new Error("Token Tracker 已停止"), { code: "APP_STOPPED" });
    if (!this.runtimeId) throw Object.assign(new Error("后台引擎尚未启动"), { code: "RUNTIME_NOT_READY" });
    const body = JSON.stringify({ method, payload });
    if (Buffer.byteLength(body) > MAX_RPC_BYTES) throw Object.assign(new Error("RPC 请求超过 1 MiB 限制"), { code: "REQUEST_TOO_LARGE" });
    const response = await this.ctx.runtime.fetch(this.runtimeId, "/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.secret}` },
      body,
      timeoutMs: 30000,
    });
    let result;
    try { result = await response.json(); }
    catch { throw Object.assign(new Error("后台引擎返回了无效响应"), { code: "INVALID_RESPONSE" }); }
    if (!response.ok || result?.error) {
      const error = result?.error || {};
      throw Object.assign(new Error(error.message || "后台引擎请求失败"), { code: error.code || "ENGINE_ERROR", status: response.status });
    }
    return result?.value;
  }

  scan(entries, options = {}) {
    return this._enqueue(() => this._scan(entries, options));
  }

  async _scan(entries, options) {
    await this.start();
    const scanId = randomUUID();
    await this._requestRuntime("scan.begin", {
      scanId,
      force: options.force === true,
      agentNames: options.agentNames || {},
      coverageLimitReached: options.coverageLimitReached === true,
      usageQueryError: options.usageQueryError || null,
    });
    for (const batch of chunkLedgerEntries(entries)) {
      await this._requestRuntime("scan.append", { scanId, entries: batch });
    }
    const started = await this._requestRuntime("scan.commit", { scanId });
    const deadline = Date.now() + this.scanTimeoutMs;
    while (Date.now() <= deadline) {
      const state = await this._requestRuntime("scan.status", { jobId: started.jobId });
      if (state?.state === "complete") return state.result;
      if (state?.state === "failed") throw Object.assign(new Error(state.error?.message || "后台扫描失败"), { code: state.error?.code || "SCAN_FAILED" });
      await pause(100);
    }
    throw Object.assign(new Error("后台扫描超时；扫描进程仍由宿主管理"), { code: "SCAN_TIMEOUT" });
  }

  archiveUsage(entry) {
    return this._enqueue(async () => {
      await this.start();
      return this._requestRuntime("archive.append", { entry });
    });
  }

  readSnapshot() {
    return this._enqueue(async () => {
      await this.start();
      const data = { sessions: {} };
      let cursor = 0;
      let revision = null;
      let first = true;
      do {
        const page = await this._requestRuntime("cache.page", { cursor, maxBytes: 640 * 1024 });
        if (revision !== null && page.revision !== revision) throw Object.assign(new Error("后台缓存在分页读取期间发生变化"), { code: "CACHE_CHANGED" });
        revision = page.revision;
        if (first) {
          Object.assign(data, page.meta || {});
          first = false;
        }
        Object.assign(data.sessions, page.sessions || {});
        cursor = page.nextCursor;
      } while (cursor !== null);
      return data;
    });
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      if (this.starting) await this.starting.catch(() => {});
      const runtimeId = this.runtimeId;
      try {
        if (runtimeId) await this.ctx.runtime.stop(runtimeId);
      } finally {
        this.runtimeId = null;
        if (this.configFile) await fs.rm(this.configFile, { force: true });
        await this.operationQueue.catch(() => {});
      }
    })();
    return this.disposePromise;
  }
}
