import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

import registerRoutes from "../server/dashboard.js";
import { ModelRoutingStore, computeDateRange } from "../lib/model-routing.mjs";

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  DatabaseSync = require("node:sqlite").DatabaseSync;
} catch {}

function tempDir(prefix = "model-routing-review-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createSessionHome({ agent = "agent-a", file = "session-file.jsonl", headerId = "real-session" } = {}) {
  const root = tempDir("model-routing-home-");
  const sessionDir = path.join(root, "agents", agent, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  return {
    root,
    filePath: path.join(sessionDir, file),
    header: { type: "session", id: headerId },
  };
}

function writeSession(filePath, header, messages, { trailingNewline = true } = {}) {
  const lines = [header, ...messages].map((line) => JSON.stringify(line));
  fs.writeFileSync(filePath, lines.join("\n") + (trailingNewline ? "\n" : ""), "utf8");
}

function assistantMessage(overrides = {}) {
  return {
    role: "assistant",
    model: "model-a",
    responseModel: "model-b",
    timestamp: Date.parse("2026-10-27T17:00:00.000Z"),
    provider: "provider-a",
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 },
    ...overrides,
  };
}

function closeAndRemove(store, ...dirs) {
  try { store?.close(); } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sqliteTest(name, fn) {
  test(name, { skip: !DatabaseSync }, fn);
}

function createRouteApp(store, dataDir = tempDir("model-routing-api-"), hanaHome = null) {
  const routes = {};
  const app = {
    get(route, handler) { routes[`GET ${route}`] = handler; },
    post(route, handler) { routes[`POST ${route}`] = handler; },
  };
  const ctx = {
    dataDir,
    _tokenCache: {
      dataDir,
      client: { hanaHome },
      modelRoutingStore: store,
    },
    bus: { request: async () => ({}) },
  };
  registerRoutes(app, ctx);
  return { routes, dataDir };
}

async function dispatch(handler, query = {}) {
  let result;
  const context = {
    req: { query: (key) => (key ? query[key] : query) },
    json: (body, status = 200) => {
      result = { status, body };
      return result;
    },
  };
  const returned = await handler(context);
  return result || returned;
}

test("应用时区按日历计算，UTC 17:00 不再落到前一天", () => {
  const now = new Date("2024-01-01T17:00:00.000Z");
  assert.deepEqual(
    computeDateRange("today", null, null, "Asia/Shanghai", now),
    { from: "2024-01-02", to: "2024-01-02" },
  );
  assert.deepEqual(
    computeDateRange("yesterday", null, null, "Asia/Shanghai", now),
    { from: "2024-01-01", to: "2024-01-01" },
  );
});

sqliteTest("新 dataDir 会先建目录，SQLite 重开仍保留记录", () => {
  const root = tempDir();
  const dataDir = path.join(root, "nested", "app-data");
  const first = new ModelRoutingStore({ dataDir });
  try {
    assert.ok(fs.existsSync(path.join(dataDir, "model-routing.sqlite")));
    assert.equal(first.recordRoute({
      id: "persistent-1",
      at: "2026-10-28T01:00:00.000Z",
      agent: "agent-a",
      provider: "provider-a",
      requestedModel: "model-a",
      responseModel: "model-a",
      totalTokens: 12,
    }), true);
  } finally {
    first.close();
  }

  const second = new ModelRoutingStore({ dataDir });
  try {
    assert.equal(second.queryRoutes({ range: "all" }).summary.totalCalls, 1);
  } finally {
    closeAndRemove(second, root);
  }
});

sqliteTest("旧表迁移补列，并只按应用时区修正一次 day", () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "model-routing.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE model_routes (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      day TEXT NOT NULL,
      agent TEXT NOT NULL,
      session_id TEXT,
      provider TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      response_model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0
    );
  `);
  legacy.prepare(`
    INSERT INTO model_routes
      (id, at, day, agent, session_id, provider, requested_model, response_model,
       input_tokens, output_tokens, cache_read, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-1", "2026-10-27T17:00:00.000Z", "2026-10-27", "agent-a", "session-a",
    "provider-a", "target", "served", 10, 20, 30, 60,
  );
  legacy.close();

  const store = new ModelRoutingStore({ dataDir });
  try {
    const version = store.db.prepare("PRAGMA user_version").get().user_version;
    assert.equal(Number(version), 1);
    const fixed = store.queryRoutes({ range: "custom", from: "2026-10-28", to: "2026-10-28" });
    assert.equal(fixed.summary.totalCalls, 1);
    assert.equal(fixed.summary.routedCount, 1);
    assert.equal(fixed.routes[0].day, "2026-10-28");
  } finally {
    closeAndRemove(store, root);
  }
});

sqliteTest("损坏旧表缺少真正必填列时标记存储不可用，不补默认列伪装可用", () => {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const legacy = new DatabaseSync(path.join(dataDir, "model-routing.sqlite"));
  legacy.exec(`
    CREATE TABLE model_routes (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      day TEXT NOT NULL,
      agent TEXT NOT NULL,
      session_id TEXT,
      provider TEXT NOT NULL
    );
  `);
  legacy.close();
  const store = new ModelRoutingStore({ dataDir });
  try {
    assert.throws(
      () => store.queryRoutes({ range: "all" }),
      (error) => error?.code === "MODEL_ROUTING_STORAGE_UNAVAILABLE",
    );
  } finally {
    closeAndRemove(store, root);
  }
});

test("实时消息与历史扫描共享无 responseId 的稳定身份，并读取 JSONL header 会话 ID", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ headerId: "header-session-42" });
  const message = assistantMessage({ responseId: undefined });
  writeSession(home.filePath, home.header, [{ type: "message", message }]);
  const store = new ModelRoutingStore({ dataDir });
  try {
    const session = { agentId: "agent-a", sessionId: "hook-session-id", sessionPath: home.filePath };
    assert.equal(store.recordMessage(session, message), true);
    assert.equal(store.recordMessage(session, message), false);

    const scan = store.scanSessions(home.root);
    assert.equal(scan.newRoutes, 0);

    const result = store.queryRoutes({ range: "custom", from: "2026-10-28", to: "2026-10-28" });
    assert.equal(result.summary.totalCalls, 1);
    assert.equal(result.routes[0].sessionId, "header-session-42");
    assert.equal(result.routes[0].id.includes("undefined"), false);
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("不同合法 responseId 的相同调用各保留一行", () => {
  const dataDir = tempDir();
  const store = new ModelRoutingStore({ dataDir });
  try {
    const session = { agentId: "agent-a", sessionId: "same-session" };
    const at = Date.parse("2026-10-28T01:00:00.000Z");
    const first = assistantMessage({ responseId: "distinct-a", timestamp: at });
    const second = assistantMessage({ responseId: "distinct-b", timestamp: at });
    assert.equal(store.recordMessage(session, first), true);
    assert.equal(store.recordMessage(session, second), true);
    const result = store.queryRoutes({ range: "all" });
    assert.equal(result.summary.totalCalls, 2);
    assert.deepEqual(result.routes.map((route) => route.id).sort(), [
      `distinct-a_${at}`,
      `distinct-b_${at}`,
    ].sort());
  } finally {
    closeAndRemove(store, dataDir);
  }
});

test("旧 basename 会话行可被 canonical header 精确复用，且无 agentId 仍对齐", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ file: "old-file.jsonl", headerId: "canonical-header" });
  const message = assistantMessage({ responseId: "canonical-response", timestamp: Date.parse("2026-10-28T01:00:00.000Z") });
  writeSession(home.filePath, home.header, [{ type: "message", message }]);
  const store = new ModelRoutingStore({ dataDir });
  try {
    assert.equal(store.recordRoute({
      id: "mr_1730000000000_abcdef",
      at: new Date(message.timestamp).toISOString(),
      agent: "agent-a",
      sessionId: "old-file",
      provider: "provider-a",
      requestedModel: "model-a",
      responseModel: "model-b",
      totalTokens: 100,
    }), true);
    assert.equal(store.recordMessage({ sessionPath: home.filePath }, message), false);
    assert.equal(store.scanSessions(home.root).newRoutes, 0);
    const result = store.queryRoutes({ range: "all" });
    assert.equal(result.summary.totalCalls, 1);
    assert.equal(result.routes[0].sessionId, "canonical-header");
    assert.equal(result.routes[0].agent, "agent-a");
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("session header 读取有界且按 sessionPath 缓存无 header 结果", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ file: "large-session.jsonl", headerId: "large-header" });
  fs.writeFileSync(home.filePath, `${JSON.stringify(home.header)}\n${"x".repeat(131 * 1024)}\n`, "utf8");
  const store = new ModelRoutingStore({ dataDir });
  const originalReadFileSync = fs.readFileSync;
  const originalReadSync = fs.readSync;
  let fullReads = 0;
  let readCalls = 0;
  let readBytes = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]) === home.filePath) fullReads++;
    return originalReadFileSync(...args);
  };
  fs.readSync = (...args) => {
    readCalls++;
    readBytes += Number(args[3]) || 0;
    return originalReadSync(...args);
  };
  try {
    const message = assistantMessage({ responseId: "cached-header", timestamp: Date.parse("2026-10-28T01:00:00.000Z") });
    for (let i = 0; i < 10; i++) store.recordMessage({ sessionPath: home.filePath }, message);
    assert.equal(fullReads, 0);
    assert.equal(readCalls, 1);
    assert.ok(readBytes > 0 && readBytes <= 64 * 1024);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.readSync = originalReadSync;
    closeAndRemove(store, dataDir, home.root);
  }
});

test("扫描只读取从追加游标到文件末尾的字节", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ file: "append-read.jsonl" });
  const first = assistantMessage({ responseId: "append-a", timestamp: Date.parse("2026-10-28T01:00:00.000Z") });
  writeSession(home.filePath, home.header, [{ type: "message", message: first }]);
  const initialSize = fs.statSync(home.filePath).size;
  const store = new ModelRoutingStore({ dataDir });
  const originalReadFileSync = fs.readFileSync;
  const originalReadSync = fs.readSync;
  const reads = [];
  let fullReads = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]) === home.filePath) fullReads++;
    return originalReadFileSync(...args);
  };
  fs.readSync = (...args) => {
    reads.push({ length: Number(args[3]), position: args[4] });
    return originalReadSync(...args);
  };
  try {
    assert.equal(store.scanSessions(home.root).newRoutes, 1);
    const second = assistantMessage({ responseId: "append-b", timestamp: Date.parse("2026-10-28T02:00:00.000Z") });
    const appended = JSON.stringify({ type: "message", message: second }) + "\n";
    fs.appendFileSync(home.filePath, appended, "utf8");
    assert.equal(store.scanSessions(home.root).newRoutes, 1);
    assert.equal(fullReads, 0);
    assert.deepEqual(reads, [
      { length: initialSize, position: 0 },
      { length: Buffer.byteLength(appended), position: initialSize },
    ]);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.readSync = originalReadSync;
    closeAndRemove(store, dataDir, home.root);
  }
});

test("无 JSONL header 时也用共同文件路径保持无 responseId 身份稳定", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ file: "no-header.jsonl" });
  const message = assistantMessage({ responseId: undefined, timestamp: Date.parse("2026-10-28T01:00:00.000Z") });
  writeSession(home.filePath, { type: "metadata", id: "not-a-session-header" }, [{ type: "message", message }]);
  const store = new ModelRoutingStore({ dataDir });
  try {
    const hookSession = { agentId: "agent-a", sessionId: "hook-session-id", sessionPath: home.filePath };
    assert.equal(store.recordMessage(hookSession, message), true);
    assert.equal(store.scanSessions(home.root).newRoutes, 0);
    assert.equal(store.queryRoutes({ range: "all" }).summary.totalCalls, 1);
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("缺少时间戳时只用外层 entry.id 补稳定身份", async () => {
  const dataDir = tempDir();
  const home = createSessionHome({ headerId: "outer-id-session", file: "outer-id.jsonl" });
  const message = assistantMessage({ responseId: undefined });
  delete message.timestamp;
  writeSession(home.filePath, home.header, [{ id: "outer-entry-42", type: "message", message }]);
  const store = new ModelRoutingStore({ dataDir });
  try {
    const session = { agentId: "agent-a", sessionId: "hook-session", sessionPath: home.filePath };
    assert.equal(store.recordMessage(session, message, "outer-entry-42"), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.scanSessions(home.root).newRoutes, 0);
    assert.equal(store.queryRoutes({ range: "all" }).summary.totalCalls, 1);
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("内存扫描事务失败时回滚旧随机行的 ID 更新", () => {
  const home = createSessionHome({ headerId: "memory-session", file: "memory.jsonl" });
  const first = assistantMessage({ responseId: undefined, timestamp: Date.parse("2026-10-28T01:00:00.000Z") });
  const second = assistantMessage({ responseId: "memory-second", timestamp: Date.parse("2026-10-28T02:00:00.000Z") });
  writeSession(home.filePath, home.header, [
    { type: "message", message: first },
    { type: "message", message: second },
  ]);
  const store = new ModelRoutingStore();
  try {
    assert.equal(store.recordRoute({
      id: "mr_1730000000000_abcdef",
      at: new Date(first.timestamp).toISOString(),
      agent: "agent-a",
      sessionId: "memory-session",
      provider: "provider-a",
      requestedModel: "model-a",
      responseModel: "model-b",
      totalTokens: 100,
    }), true);
    const originalInsertRecord = store.insertRecord.bind(store);
    store.insertRecord = () => { throw new Error("synthetic memory write failure"); };
    assert.throws(() => store.scanSessions(home.root), /synthetic memory write failure/);
    assert.equal(store.queryRoutes({ range: "all" }).routes[0].id, "mr_1730000000000_abcdef");
    store.insertRecord = originalInsertRecord;
    assert.equal(store.scanSessions(home.root).newRoutes, 1);
    const result = store.queryRoutes({ range: "all" });
    assert.equal(result.total, 2);
    assert.ok(result.routes.every((route) => route.id !== "mr_1730000000000_abcdef"));
  } finally {
    closeAndRemove(store, home.root);
  }
});

test("扁平与结构化 usage 归一化不丢 cacheWrite，也不重复计算 cacheRead", () => {
  const dataDir = tempDir();
  const store = new ModelRoutingStore({ dataDir });
  try {
    assert.equal(store.recordMessage(
      { agentId: "agent-a", sessionId: "flat" },
      assistantMessage({ responseId: "flat-1" }),
    ), true);
    assert.equal(store.recordMessage(
      { agentId: "agent-a", sessionId: "structured" },
      assistantMessage({
        responseId: "structured-1",
        timestamp: Date.parse("2026-10-28T01:00:00.000Z"),
        model: "model-structured",
        responseModel: "model-structured",
        usage: {
          input: { totalTokens: 100 },
          output: { totalTokens: 20 },
          cache: { readTokens: 80, writeTokens: 5 },
        },
      }),
    ), true);

    const result = store.queryRoutes({ range: "all" });
    const flat = result.routes.find((route) => route.id.startsWith("flat-1_"));
    const structured = result.routes.find((route) => route.id.startsWith("structured-1_"));
    assert.ok(flat);
    assert.ok(structured);
    assert.deepEqual(flat.tokens, { input: 10, output: 20, cacheRead: 30, total: 100 });
    // 与 normalizeEntryForArchive 一致：结构化 input.totalTokens 已含缓存，总量仅加 output。
    assert.deepEqual(structured.tokens, { input: 20, output: 20, cacheRead: 80, total: 120 });
  } finally {
    closeAndRemove(store, dataDir);
  }
});

test("provider 精确过滤、含斜杠模型保持裸 ID，并兼容 provider/model 查询", () => {
  const dataDir = tempDir();
  const store = new ModelRoutingStore({ dataDir });
  try {
    for (const record of [
      {
        id: "a-route", at: "2026-10-28T10:00:00.000Z", provider: "provider-a",
        requestedModel: "family/model/v1", responseModel: "served-a", totalTokens: 1,
      },
      {
        id: "z-route", at: "2026-10-28T10:00:00.000Z", provider: "provider-a",
        requestedModel: "other-model", responseModel: "served-z", totalTokens: 2,
      },
      {
        id: "raw-slash-route", at: "2026-10-28T09:00:00.000Z", provider: "provider-b",
        requestedModel: "provider-a/family/model/v1", responseModel: "served-b", totalTokens: 3,
      },
      {
        id: "similar-provider-route", at: "2026-10-28T08:00:00.000Z", provider: "provider-ab",
        requestedModel: "family/model/v1", responseModel: "served-ab", totalTokens: 4,
      },
    ]) {
      assert.equal(store.recordRoute(record), true);
    }

    const provider = store.queryRoutes({ range: "all", provider: "provider-a" });
    assert.equal(provider.total, 2);
    assert.ok(provider.routes.every((route) => route.provider === "provider-a"));

    const rawModel = store.queryRoutes({ range: "all", model: "family/model/v1" });
    assert.equal(rawModel.total, 2);
    assert.ok(rawModel.routes.some((route) => route.id === "a-route"));
    assert.ok(rawModel.routes.some((route) => route.id === "similar-provider-route"));

    const compound = store.queryRoutes({ range: "all", model: "provider-a/family/model/v1" });
    assert.equal(compound.total, 2);
    assert.ok(compound.routes.some((route) => route.id === "a-route"));
    assert.ok(compound.routes.some((route) => route.id === "raw-slash-route"));

    const all = store.queryRoutes({ range: "all" });
    assert.deepEqual(all.routes.slice(0, 2).map((route) => route.id), ["z-route", "a-route"]);
  } finally {
    closeAndRemove(store, dataDir);
  }
});

test("扫描使用追加字节游标，完整无 LF 尾行和写失败都可重试", () => {
  const dataDir = tempDir();
  const home = createSessionHome();
  const first = assistantMessage({ responseId: "scan-1", timestamp: Date.parse("2026-10-28T01:00:00.000Z") });
  writeSession(home.filePath, home.header, [{ type: "message", message: first }], { trailingNewline: false });
  const store = new ModelRoutingStore({ dataDir });
  try {
    assert.equal(store.scanSessions(home.root).newRoutes, 1);

    fs.appendFileSync(home.filePath, "\n", "utf8");
    assert.equal(store.scanSessions(home.root).newRoutes, 0);

    const second = assistantMessage({ responseId: "scan-2", timestamp: Date.parse("2026-10-28T02:00:00.000Z") });
    fs.appendFileSync(home.filePath, JSON.stringify({ type: "message", message: second }) + "\n", "utf8");
    assert.equal(store.scanSessions(home.root).newRoutes, 1);
    assert.equal(store.scanSessions(home.root).scannedFiles, 0);

    const retryHome = createSessionHome({ file: "retry.jsonl", headerId: "retry-session" });
    const retryMessage = assistantMessage({ responseId: "retry-1" });
    writeSession(retryHome.filePath, retryHome.header, [{ type: "message", message: retryMessage }]);
    const originalInsertRecord = store.insertRecord.bind(store);
    store.insertRecord = () => { throw new Error("synthetic write failure"); };
    assert.throws(() => store.scanSessions(retryHome.root), /synthetic write failure/);
    store.insertRecord = originalInsertRecord;
    assert.equal(store.scanSessions(retryHome.root).newRoutes, 1);
    fs.rmSync(retryHome.root, { recursive: true, force: true });

    assert.equal(store.queryRoutes({ range: "all" }).summary.totalCalls, 3);
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("旧无响应 ID 记录可精确重用并更新 ID，不删行或自动合并", () => {
  const dataDir = tempDir();
  const store = new ModelRoutingStore({ dataDir });
  try {
    const message = assistantMessage({ responseId: undefined });
    const at = new Date(message.timestamp).toISOString();
    assert.equal(store.recordRoute({
      id: "mr_1730000000000_abcdef",
      at,
      day: "2026-10-28",
      agent: "agent-a",
      sessionId: "stable-session",
      provider: "provider-a",
      requestedModel: "model-a",
      responseModel: "model-b",
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 30,
      totalTokens: 100,
    }), true);

    const inserted = store.recordMessage(
      { agentId: "agent-a", sessionId: "stable-session" },
      message,
    );
    assert.equal(inserted, false);
    const result = store.queryRoutes({ range: "all" });
    assert.equal(result.total, 1);
    assert.notEqual(result.routes[0].id, "mr_1730000000000_abcdef");
  } finally {
    closeAndRemove(store, dataDir);
  }
});

sqliteTest("指定 dataDir 无法打开时不伪装内存库", () => {
  const root = tempDir();
  const dataPath = path.join(root, "not-a-directory");
  fs.writeFileSync(dataPath, "synthetic file", "utf8");
  const store = new ModelRoutingStore({ dataDir: dataPath });
  try {
    assert.throws(
      () => store.queryRoutes({ range: "all" }),
      (error) => error?.code === "MODEL_ROUTING_STORAGE_UNAVAILABLE",
    );
    assert.throws(
      () => store.recordRoute({ id: "no-memory", requestedModel: "model-a" }),
      (error) => error?.code === "MODEL_ROUTING_STORAGE_UNAVAILABLE",
    );
  } finally {
    closeAndRemove(store, root);
  }
});

test("queryRoutes 统一校验范围、日期交集和有限分页值", () => {
  const store = new ModelRoutingStore();
  try {
    const range = computeDateRange("7d");
    const nextDay = new Date(`${range.from}T12:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const next = nextDay.toISOString().slice(0, 10);
    store.recordRoute({ id: "query-day-1", at: `${range.from}T12:00:00.000Z`, requestedModel: "m", responseModel: "m" });
    store.recordRoute({ id: "query-day-2", at: `${next}T12:00:00.000Z`, requestedModel: "m", responseModel: "m" });

    const intersected = store.queryRoutes({ range: "7d", from: range.from, to: range.from, limit: "1", offset: "0" });
    assert.equal(intersected.summary.totalCalls, 1);
    assert.equal(intersected.limit, 1);
    assert.equal(intersected.offset, 0);

    for (const query of [
      { range: "not-a-range" },
      { status: "pending" },
      { range: "custom", from: "2026-10-01" },
      { range: "custom", from: "2026-10-32", to: "2026-10-33" },
      { range: "custom", from: "2026-10-02", to: "2026-10-01" },
      { limit: "1.5" },
      { limit: "0" },
      { limit: "501" },
      { limit: "Infinity" },
      { offset: "-1" },
      { offset: "1.5" },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      assert.throws(
        () => store.queryRoutes(query),
        (error) => error?.code === "MODEL_ROUTING_INVALID_QUERY",
        JSON.stringify(query),
      );
    }
  } finally {
    store.close();
  }
});

test("模型路由 API 只在边界校验一次，并隐藏存储内部错误", async () => {
  const calls = [];
  const store = {
    queryRoutes(options) {
      calls.push(options);
      if (options.range === "not-a-range" || options.status === "pending"
        || options.range === "custom" || options.limit === "1.5" || options.offset === "-1") {
        throw Object.assign(new Error("invalid"), { code: "MODEL_ROUTING_INVALID_QUERY" });
      }
      return { ok: true, summary: {}, routes: [], total: 0, limit: options.limit, offset: options.offset };
    },
  };
  const api = createRouteApp(store);
  try {
    const invalidRange = await dispatch(api.routes["GET /model-routing"], { range: "not-a-range" });
    assert.equal(invalidRange.status, 400);
    assert.equal(calls.length, 1);

    const invalidDate = await dispatch(api.routes["GET /model-routing"], {
      range: "custom", from: "2026-10-29", to: "2026-10-28",
    });
    assert.equal(invalidDate.status, 400);
    assert.equal(calls.length, 2);

    const invalidPage = await dispatch(api.routes["GET /model-routing"], { limit: "1.5", offset: "-1" });
    assert.equal(invalidPage.status, 400);
    assert.equal(calls.length, 3);

    const invalidStatus = await dispatch(api.routes["GET /model-routing"], { status: "pending" });
    assert.equal(invalidStatus.status, 400);
    assert.equal(calls.length, 4);

    const valid = await dispatch(api.routes["GET /model-routing"], {
      range: "all", agent: "agent-a", provider: "provider-a", model: "family/model/v1",
      status: "routed", limit: "10", offset: "2",
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(calls[4], {
      range: "all", agent: "agent-a", provider: "provider-a",
      model: "family/model/v1", status: "routed", limit: "10", offset: "2",
    });

    const unavailable = createRouteApp({
      queryRoutes() {
        throw Object.assign(new Error("/secret/private/model-routing.sqlite"), {
          code: "MODEL_ROUTING_STORAGE_UNAVAILABLE",
        });
      },
    });
    const unavailableResult = await dispatch(unavailable.routes["GET /model-routing"], { range: "all" });
    assert.equal(unavailableResult.status, 503);
    assert.equal(unavailableResult.body.code, "STORAGE_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(unavailableResult.body), /private|sqlite/);

    const broken = createRouteApp({ queryRoutes() { throw new Error("/secret/private/model-routing.sqlite"); } });
    const brokenResult = await dispatch(broken.routes["GET /model-routing"], { range: "all" });
    assert.equal(brokenResult.status, 500);
    assert.equal(brokenResult.body.code, "MODEL_ROUTING_ERROR");
    assert.doesNotMatch(JSON.stringify(brokenResult.body), /private|sqlite/);

    const missing = createRouteApp(null);
    const missingResult = await dispatch(missing.routes["GET /model-routing"], { range: "all" });
    assert.equal(missingResult.status, 503);
  } finally {
    fs.rmSync(api.dataDir, { recursive: true, force: true });
  }
});

test("历史扫描覆盖普通 sessions 与可递归的 subagent-sessions，但不跟随 symlink 或扫描其他目录", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ agent: "owner-a", file: "ordinary.jsonl", headerId: "ordinary-session" });
  const ordinary = assistantMessage({ responseId: "ordinary-history" });
  writeSession(home.filePath, home.header, [{ type: "message", message: ordinary }]);

  const subagentRoot = path.join(home.root, "agents", "owner-a", "subagent-sessions");
  const directDir = path.join(subagentRoot, "direct");
  fs.mkdirSync(directDir, { recursive: true });
  const childPath = path.join(directDir, "child.jsonl");
  const child = assistantMessage({ responseId: "child-history", timestamp: Date.parse("2026-10-27T18:00:00.000Z") });
  writeSession(childPath, { type: "session", id: "child-session" }, [{ type: "message", message: child }]);

  const outsideRoot = tempDir("model-routing-outside-");
  const outsidePath = path.join(outsideRoot, "outside.jsonl");
  writeSession(outsidePath, { type: "session", id: "outside-session" }, [
    { type: "message", message: assistantMessage({ responseId: "symlink-history" }) },
  ]);
  fs.symlinkSync(outsidePath, path.join(subagentRoot, "linked.jsonl"));
  const linkedAgentRoot = path.join(outsideRoot, "linked-agent");
  const linkedAgentSessions = path.join(linkedAgentRoot, "sessions");
  fs.mkdirSync(linkedAgentSessions, { recursive: true });
  writeSession(path.join(linkedAgentSessions, "linked-agent.jsonl"), { type: "session", id: "linked-agent-session" }, [
    { type: "message", message: assistantMessage({ responseId: "linked-agent-history" }) },
  ]);
  fs.symlinkSync(linkedAgentRoot, path.join(home.root, "agents", "linked-owner"), "dir");
  const otherPath = path.join(home.root, "other", "sessions", "ignored.jsonl");
  fs.mkdirSync(path.dirname(otherPath), { recursive: true });
  writeSession(otherPath, { type: "session", id: "ignored-session" }, [
    { type: "message", message: assistantMessage({ responseId: "ignored-history" }) },
  ]);

  const store = new ModelRoutingStore({ dataDir });
  try {
    assert.equal(store.recordMessage({ sessionPath: childPath }, child), true);
    const scan = store.scanSessions(home.root);
    assert.equal(scan.scannedFiles, 2);
    assert.equal(scan.newRoutes, 1);
    const result = store.queryRoutes({ range: "all" });
    assert.equal(result.total, 2);
    assert.deepEqual(result.routes.map((route) => route.id).sort(), [
      `${child.responseId}_${child.timestamp}`,
      `${ordinary.responseId}_${ordinary.timestamp}`,
    ].sort());
    const linkedHome = path.join(outsideRoot, "linked-home");
    fs.symlinkSync(home.root, linkedHome, "dir");
    assert.deepEqual(store.scanSessions(linkedHome), { scannedFiles: 0, newRoutes: 0 });
  } finally {
    closeAndRemove(store, dataDir, home.root, outsideRoot);
  }
});

test("legacy reconcile 同时接受 canonical、basename 与原始外部 sessionId，但未知外部 ID 不跨 session 合并", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ file: "external-alias.jsonl", headerId: "canonical-session" });
  const knownMessage = assistantMessage({ responseId: "known-external", timestamp: Date.parse("2026-10-28T01:00:00.000Z") });
  writeSession(home.filePath, home.header, [{ type: "message", message: knownMessage }]);
  const store = new ModelRoutingStore({ dataDir });
  try {
    assert.equal(store.recordRoute({
      id: "mr_1730000000000_abcdef",
      at: new Date(knownMessage.timestamp).toISOString(),
      agent: "agent-a",
      sessionId: "external-session-id",
      provider: "provider-a",
      requestedModel: "model-a",
      responseModel: "model-b",
      totalTokens: 100,
    }), true);
    assert.equal(store.recordMessage({
      agentId: "agent-a", sessionId: "external-session-id", sessionPath: home.filePath,
    }, knownMessage), false);

    const unknownMessage = assistantMessage({ responseId: "unknown-external", timestamp: Date.parse("2026-10-28T02:00:00.000Z") });
    assert.equal(store.recordRoute({
      id: "mr_1730000000001_abcdef",
      at: new Date(unknownMessage.timestamp).toISOString(),
      agent: "agent-a",
      sessionId: "unrelated-session",
      provider: "provider-a",
      requestedModel: "model-a",
      responseModel: "model-b",
      totalTokens: 100,
    }), true);
    assert.equal(store.recordMessage({
      agentId: "agent-a", sessionId: "unknown-external-id", sessionPath: home.filePath,
    }, unknownMessage), true);

    const result = store.queryRoutes({ range: "all" });
    assert.equal(result.total, 3);
    assert.ok(result.routes.some((route) => route.id === "mr_1730000000001_abcdef" && route.sessionId === "unrelated-session"));
    assert.ok(result.routes.some((route) => route.id === `${unknownMessage.responseId}_${unknownMessage.timestamp}`
      && route.sessionId === "canonical-session"));
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("扫描录入完整的无 LF JSONL 最后一行并推进到文件末尾", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ file: "complete-no-lf.jsonl" });
  const message = assistantMessage({ responseId: "complete-no-lf" });
  writeSession(home.filePath, home.header, [{ type: "message", message }], { trailingNewline: false });
  const store = new ModelRoutingStore({ dataDir });
  try {
    assert.equal(store.scanSessions(home.root).newRoutes, 1);
    assert.equal(store.scanCursors.get(home.filePath).offset, fs.statSync(home.filePath).size);
    assert.equal(store.queryRoutes({ range: "all" }).total, 1);
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("扫描保留不完整无 LF 尾行，补齐后只录入一次", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ file: "partial-no-lf.jsonl" });
  const message = assistantMessage({ responseId: "partial-no-lf" });
  const headerText = `${JSON.stringify(home.header)}\n`;
  const messageText = JSON.stringify({ type: "message", message });
  fs.writeFileSync(home.filePath, headerText + messageText.slice(0, -1), "utf8");
  const store = new ModelRoutingStore({ dataDir });
  try {
    assert.equal(store.scanSessions(home.root).newRoutes, 0);
    assert.equal(store.scanCursors.get(home.filePath).offset, Buffer.byteLength(headerText));
    fs.appendFileSync(home.filePath, "}", "utf8");
    assert.equal(store.scanSessions(home.root).newRoutes, 1);
    assert.equal(store.scanCursors.get(home.filePath).offset, fs.statSync(home.filePath).size);
    assert.equal(store.scanSessions(home.root).scannedFiles, 0);
    assert.equal(store.queryRoutes({ range: "all" }).total, 1);
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("已处理的无 LF 尾行后追加 LF 与新记录时不重计旧记录", () => {
  const dataDir = tempDir();
  const home = createSessionHome({ file: "append-after-no-lf.jsonl" });
  const first = assistantMessage({ responseId: "no-lf-first" });
  writeSession(home.filePath, home.header, [{ type: "message", message: first }], { trailingNewline: false });
  const store = new ModelRoutingStore({ dataDir });
  try {
    assert.equal(store.scanSessions(home.root).newRoutes, 1);
    const firstOffset = fs.statSync(home.filePath).size;
    const second = assistantMessage({ responseId: "no-lf-second", timestamp: Date.parse("2026-10-28T02:00:00.000Z") });
    fs.appendFileSync(home.filePath, `\n${JSON.stringify({ type: "message", message: second })}`, "utf8");
    assert.equal(store.scanSessions(home.root).newRoutes, 1);
    assert.equal(store.scanCursors.get(home.filePath).offset, fs.statSync(home.filePath).size);
    assert.ok(store.scanCursors.get(home.filePath).offset > firstOffset);
    assert.equal(store.queryRoutes({ range: "all" }).total, 2);
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("强制模型历史扫描先完成 queryRoutes 校验，只有合法 force 才扫描可信 hanaHome", async () => {
  const dataDir = tempDir();
  const home = createSessionHome({ file: "force-scan.jsonl", headerId: "force-session" });
  const message = assistantMessage({ responseId: "force-scan-row" });
  writeSession(home.filePath, home.header, [{ type: "message", message }]);
  const store = new ModelRoutingStore({ dataDir });
  const originalScan = store.scanSessions.bind(store);
  const originalQuery = store.queryRoutes.bind(store);
  let scanCalls = 0;
  const queryArgs = [];
  store.scanSessions = (scanHome) => {
    scanCalls++;
    return originalScan(scanHome);
  };
  store.queryRoutes = (...args) => {
    queryArgs.push(args);
    return originalQuery(...args);
  };
  const api = createRouteApp(store, dataDir, home.root);
  try {
    for (const query of [
      { force: "true", range: "all", status: "pending" },
      { force: "true", range: "custom", from: "2026-10-29", to: "2026-10-28" },
      { force: "true", range: "all", limit: "0" },
    ]) {
      const response = await dispatch(api.routes["GET /model-routing"], query);
      assert.equal(response.status, 400);
      assert.equal(scanCalls, 0);
    }
    const response = await dispatch(api.routes["GET /model-routing"], {
      force: "true", range: "all", scanHome: path.join(dataDir, "untrusted-http-path"),
    });
    assert.equal(response.status, 200);
    assert.equal(scanCalls, 1);
    assert.equal(queryArgs.at(-1).length, 2);
    const refreshOnly = await dispatch(api.routes["GET /model-routing"], { refresh: "true", range: "all" });
    assert.equal(refreshOnly.status, 200);
    assert.equal(scanCalls, 2, "HTTP refresh=true 保留原有强扫别名；它不是 UI 内部的 refresh 选项");
    assert.equal(queryArgs.at(-1).length, 2);
    const normal = await dispatch(api.routes["GET /model-routing"], { range: "all" });
    assert.equal(normal.status, 200);
    assert.equal(queryArgs.at(-1).length, 1);
    assert.equal(response.body.summary.totalCalls, 1);
    assert.equal(response.body.total, 1);
  } finally {
    closeAndRemove(store, dataDir, home.root);
  }
});

test("启动路径只保留等待刷新后的调度器 afterScan 模型历史扫描", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.equal((source.match(/modelRoutingStore\.scanSessions/g) || []).length, 1);
  assert.match(source, /afterScan:\s*async\s*\(\)\s*=>[\s\S]*await refreshAgentNames\(shared\)[\s\S]*modelRoutingStore\.scanSessions/);
  assert.match(source, /model routing history scan failed:\s*\$\{safeCode\(error\)\}/);
});
