import { timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SCAN_ENTRIES = 20000;
const SAFE_MESSAGES = new Map([
  ["BUSY", "后台引擎正在处理其他任务"],
  ["NOT_READY", "后台引擎尚未就绪"],
  ["INVALID_PAYLOAD", "RPC 参数无效"],
  ["UNKNOWN_METHOD", "不支持的 RPC 方法"],
  ["UNAUTHORIZED", "未授权的 RPC 请求"],
  ["REQUEST_TOO_LARGE", "RPC 请求超过大小限制"],
  ["RECORD_TOO_LARGE", "单条缓存记录超过传输限制"],
  ["NOT_FOUND", "RPC 任务不存在"],
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createRpcDispatcher({ getEngine, getInitError = () => null } = {}) {
  let pending = null;
  let job = null;

  return async function dispatch(method, payload = {}) {
    if (method === "status") {
      const initError = getInitError();
      if (initError) return { ready: false, error: { code: initError.code || "ENGINE_INIT_FAILED", message: "后台引擎初始化失败" } };
      const engine = getEngine();
      return engine ? { ...engine.status(), dataReady: engine.ready, ready: true } : { ready: false, state: "starting" };
    }

    const engine = getEngine();
    if (!engine) throw Object.assign(new Error("engine not ready"), { code: "NOT_READY" });
    if (!isObject(payload)) throw Object.assign(new Error("payload must be an object"), { code: "INVALID_PAYLOAD" });

    if (method === "scan.begin") {
      if (pending || job?.state === "running") throw Object.assign(new Error("scan already active"), { code: "BUSY" });
      if (typeof payload.scanId !== "string" || payload.scanId.length < 1 || payload.scanId.length > 128) throw Object.assign(new Error("invalid scan id"), { code: "INVALID_PAYLOAD" });
      if (payload.agentNames !== undefined && !isObject(payload.agentNames)) throw Object.assign(new Error("invalid agent names"), { code: "INVALID_PAYLOAD" });
      const agentNames = {};
      for (const [id, name] of Object.entries(payload.agentNames || {}).slice(0, 10000)) {
        if (typeof id === "string" && id && typeof name === "string") agentNames[id.slice(0, 256)] = name.slice(0, 256);
      }
      pending = {
        scanId: payload.scanId,
        entries: [],
        force: payload.force === true,
        agentNames,
        coverageLimitReached: payload.coverageLimitReached === true,
        usageQueryError: typeof payload.usageQueryError === "string" ? payload.usageQueryError.slice(0, 500) : null,
      };
      return { accepted: true, scanId: pending.scanId };
    }

    if (method === "scan.append") {
      if (!pending || payload.scanId !== pending.scanId || !Array.isArray(payload.entries)) throw Object.assign(new Error("invalid scan batch"), { code: "INVALID_PAYLOAD" });
      if (pending.entries.length + payload.entries.length > MAX_SCAN_ENTRIES) throw Object.assign(new Error("too many ledger entries"), { code: "INVALID_PAYLOAD" });
      for (const entry of payload.entries) if (isObject(entry)) pending.entries.push(entry);
      return { accepted: true, received: pending.entries.length };
    }

    if (method === "scan.commit") {
      if (!pending || payload.scanId !== pending.scanId) throw Object.assign(new Error("scan id mismatch"), { code: "INVALID_PAYLOAD" });
      const batch = pending;
      pending = null;
      const jobId = batch.scanId;
      job = { jobId, state: "running", result: null, error: null };
      Promise.resolve()
        .then(() => engine.scan(batch.entries, batch))
        .then(result => { job = { jobId, state: "complete", result, error: null }; })
        .catch(error => {
          job = { jobId, state: "failed", result: null, error: { code: error?.code || "SCAN_FAILED", message: "后台扫描失败" } };
        });
      return { jobId, state: "running" };
    }

    if (method === "scan.status") {
      if (!job || payload.jobId !== job.jobId) throw Object.assign(new Error("unknown scan job"), { code: "NOT_FOUND" });
      return { ...job };
    }

    if (method === "archive.append") {
      if (!isObject(payload.entry)) throw Object.assign(new Error("invalid usage entry"), { code: "INVALID_PAYLOAD" });
      return engine.archiveUsage(payload.entry);
    }

    if (method === "cache.page") {
      return engine.page(payload);
    }

    throw Object.assign(new Error("unknown method"), { code: "UNKNOWN_METHOD" });
  };
}

export function createHttpRpcHandler({ secret, dispatch, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  const expected = Buffer.from(`Bearer ${secret || ""}`);
  return async function handle(req, res) {
    const reply = (body, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/rpc") {
      reply({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      return;
    }
    const supplied = Buffer.from(req.headers.authorization || "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply({ error: { code: "UNAUTHORIZED", message: SAFE_MESSAGES.get("UNAUTHORIZED") } }, 401);
      return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          reply({ error: { code: "REQUEST_TOO_LARGE", message: SAFE_MESSAGES.get("REQUEST_TOO_LARGE") } }, 413);
          req.resume();
          return;
        }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reply({ error: { code: "INVALID_JSON", message: "Invalid JSON" } }, 400); return; }
      if (!isObject(input) || typeof input.method !== "string") {
        reply({ error: { code: "INVALID_PAYLOAD", message: SAFE_MESSAGES.get("INVALID_PAYLOAD") } }, 400);
        return;
      }
      const value = await dispatch(input.method, input.payload ?? {});
      reply({ value });
    } catch (error) {
      const code = error?.code || "ENGINE_ERROR";
      const status = code === "UNKNOWN_METHOD" || code === "NOT_FOUND" ? 404 : code === "INVALID_PAYLOAD" ? 400 : 503;
      reply({ error: { code, message: SAFE_MESSAGES.get(code) || "后台引擎操作失败" } }, status);
    }
  };
}
