import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionSourceResolver } from "../lib/session-sources.mjs";
import { createSyncScheduler } from "../lib/sync-scheduler.mjs";
import { createLedgerEngine } from "../runtime/engine/ledger-engine.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function entry(sessionId, requestId, startedAt = "2026-10-06T10:00:00.000Z") {
  return {
    requestId,
    startedAt,
    status: "ok",
    attribution: { agentId: "agent-a", sessionId, kind: "session" },
    model: { provider: "deepseek", modelId: "deepseek-chat" },
    usage: { totalTokens: 10 },
  };
}

function fakeSdk(resolver) {
  const calls = [];
  return {
    calls,
    sessions: {
      async get(params) {
        calls.push(params);
        return resolver(params);
      },
    },
  };
}

test("resolver maps parent and sub requests by namespace and returns only safe session ids", async () => {
  const sdk = fakeSdk(async ({ sessionId }) => {
    return { session: { id: sessionId, namespace: sessionId === "chat" ? "chat" : "code", title: "secret title" } };
  });
  const client = { call: async () => ({ sessionIds: [] }) };
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet });

  const out = await resolver.resolve([
    entry("code-parent", "r1"),
    entry("code-parent", "r2"),
    entry("code-child", "r3"),
    entry("chat", "r4"),
  ]);

  assert.deepEqual(out.sessionNamespaces, { "code-parent": "code", "code-child": "code", chat: "chat" });
  assert.deepEqual(out.sourceResolution, { capability: "ready", failedSessionIds: [] });
  assert.equal(sdk.calls.length, 3, "同一父会话在同一轮只查询一次");
  for (const params of sdk.calls) {
    assert.deepEqual(Object.keys(params).sort(), ["scope", "sessionId"]);
    assert.equal(params.scope, "all");
  }
});

test("resolver never throws for denied, missing or null sessions and never guesses a namespace", async () => {
  const denied = Object.assign(new Error("permission denied"), { code: "PERMISSION_DENIED" });
  const sdk = fakeSdk(async ({ sessionId }) => {
    if (sessionId === "denied") throw denied;
    if (sessionId === "missing") return { session: null };
    return { session: { namespace: null } };
  });
  const resolver = createSessionSourceResolver({ sdk, client: { call: async () => ({ sessionIds: [] }) }, log: quiet });
  const out = await resolver.resolve([entry("denied", "a"), entry("missing", "b"), entry("null-ns", "c")]);
  assert.deepEqual(out.sessionNamespaces, {});
  assert.deepEqual(out.sourceResolution.failedSessionIds.sort(), ["denied", "missing", "null-ns"]);
  assert.equal(out.sourceResolution.capability, "ready");
});

test("resolver degrades to unavailable when the host exposes no session lookup", async () => {
  let candidates = 0;
  const resolver = createSessionSourceResolver({
    sdk: {},
    client: { call: async () => { candidates++; return { sessionIds: ["x"] }; } },
    log: quiet,
  });
  const out = await resolver.resolve([entry("x", "a")]);
  assert.deepEqual(out.sessionNamespaces, {});
  assert.equal(out.sourceResolution.capability, "unavailable");
  assert.equal(candidates, 0, "能力缺失时不再请求历史候选");
});

test("resolver caps a round at 8 lookups with at most 2 in flight and keeps a history slot", async () => {
  let active = 0;
  let maxActive = 0;
  const requested = [];
  const sdk = fakeSdk(async ({ sessionId }) => {
    requested.push(sessionId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
    return { session: { namespace: sessionId.startsWith("hist") ? "code" : "chat" } };
  });
  const client = { call: async () => ({ sessionIds: ["hist-1", "hist-2"] }) };
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet });

  const entries = [];
  for (let i = 0; i < 12; i++) entries.push(entry(`new-${i}`, `r${i}`, `2026-10-06T10:${String(i).padStart(2, "0")}:00.000Z`));
  const out = await resolver.resolve(entries);

  assert.equal(requested.length, 8);
  assert.equal(maxActive, 2, "全局在途查询不得超过 2");
  assert.equal(out.sessionNamespaces["hist-1"], "code", "必须为历史回填保留至少 1 个名额");
  assert.equal(requested.filter((id) => id.startsWith("new-")).length, 7, "新账本优先且最多 7 个");
});

test("resolver times out a slow lookup and keeps the slot until the underlying promise settles", async () => {
  let started = 0;
  let settleSlow = null;
  let active = 0;
  let maxActive = 0;
  const sdk = fakeSdk(async ({ sessionId }) => {
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (sessionId === "slow") {
      await new Promise((resolve) => { settleSlow = resolve; });
      active -= 1;
      return { session: { namespace: "code" } };
    }
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return { session: { namespace: "chat" } };
  });
  const resolver = createSessionSourceResolver({
    sdk,
    client: { call: async () => ({ sessionIds: [] }) },
    log: quiet,
    timeoutMs: 20,
    maxInFlight: 1,
  });

  const first = await resolver.resolve([entry("slow", "s1")]);
  assert.deepEqual(first.sessionNamespaces, {});
  assert.deepEqual(first.sourceResolution.failedSessionIds, ["slow"]);
  assert.equal(started, 1);

  // 超时的底层请求仍占名额：这一轮拿不到名额，不得启动新查询。
  const second = await resolver.resolve([entry("next-a", "n2")]);
  assert.deepEqual(second.sessionNamespaces, {});
  assert.equal(started, 1, "超时请求未真正结束前不释放名额");
  assert.equal(maxActive, 1);

  assert.equal(typeof settleSlow, "function");
  settleSlow();
  await new Promise((r) => setTimeout(r, 10));
  const third = await resolver.resolve([entry("next-b", "n3")]);
  assert.equal(third.sessionNamespaces["next-b"], "chat", "慢请求真正结束后名额释放，后续候选继续查询");
  assert.equal(started, 2);
  assert.equal(maxActive, 1);
});

test("failed sessions are not retried for five minutes", async () => {
  let clock = 1_000_000;
  let calls = 0;
  const sdk = fakeSdk(async () => {
    calls += 1;
    throw Object.assign(new Error("busy"), { code: "BUSY" });
  });
  const resolver = createSessionSourceResolver({
    sdk,
    client: { call: async () => ({ sessionIds: [] }) },
    log: quiet,
    now: () => clock,
  });

  await resolver.resolve([entry("a", "r1")]);
  assert.equal(calls, 1);
  clock += 4 * 60 * 1000;
  await resolver.resolve([entry("a", "r2")]);
  assert.equal(calls, 1, "5 分钟内不重试失败会话");
  clock += 61 * 1000;
  await resolver.resolve([entry("a", "r3")]);
  assert.equal(calls, 2, "超过 5 分钟后允许重试");
});

test("resolver falls back to the bus session:get and stops querying after dispose", async () => {
  const requests = [];
  const sdk = {
    bus: {
      async request(verb, params) {
        requests.push([verb, params]);
        return { session: { namespace: "code" } };
      },
    },
  };
  const resolver = createSessionSourceResolver({ sdk, client: { call: async () => [] }, log: quiet });
  const out = await resolver.resolve([entry("via-bus", "r1")]);
  assert.deepEqual(out.sessionNamespaces, { "via-bus": "code" });
  assert.deepEqual(requests[0][0], "session:get");
  assert.deepEqual(requests[0][1], { sessionId: "via-bus", scope: "all" });

  await resolver.dispose();
  const after = await resolver.resolve([entry("later", "r2")]);
  assert.deepEqual(after.sessionNamespaces, {});
  assert.equal(requests.length, 1);
});

test("scheduler passes classification to the engine and survives classification failure", async () => {
  const scanned = [];
  const shared = {
    agentNames: {},
    health: { set() {} },
    log: quiet,
    data: null,
    ready: false,
    scanMeta: null,
  };
  const client = {
    async scan(entries, options) {
      scanned.push(options);
      return { coverageLimitReached: false, usageQueryError: null, sourceAckSessionIds: ["code-1"] };
    },
    async readSnapshot() {
      return { sessions: {}, lastScan: "2026-10-06T10:00:00.000Z" };
    },
  };
  const sdk = { usage: { async list() { return { entries: [entry("code-1", "r1")] }; } } };
  const resolver = {
    calls: 0,
    acked: [],
    async resolve() {
      this.calls += 1;
      return { sessionNamespaces: { "code-1": "code" }, sourceResolution: { capability: "ready", failedSessionIds: [] } };
    },
    ack(ids) { this.acked.push(ids); },
    async dispose() {},
  };

  const scheduler = createSyncScheduler({ shared, client, sdk, interval: 60000, sourceResolver: resolver });
  await scheduler.performScan(false);
  assert.equal(resolver.calls, 1);
  assert.deepEqual(scanned.at(-1).sessionNamespaces, { "code-1": "code" });
  assert.equal(scanned.at(-1).sourceResolution.capability, "ready");
  assert.deepEqual(resolver.acked.at(-1), ["code-1"], "引擎接收后必须 ack 成功映射");

  resolver.resolve = async () => { throw new Error("classification exploded"); };
  await scheduler.performScan(false);
  assert.equal(scanned.length, 2, "分类失败不得中断用量扫描");
  assert.deepEqual(scanned.at(-1).sessionNamespaces, {});
});

function makeShared() {
  return { agentNames: {}, health: { set() {} }, log: quiet, data: null, ready: false, scanMeta: null };
}

function engineClient(engine, override = {}) {
  return {
    async call(method, payload) {
      if (method === "sessions.candidates") return engine.sessionCandidates(payload);
      throw new Error(`unexpected rpc ${method}`);
    },
    async scan(entries, options) { return engine.scan(entries, options); },
    async readSnapshot() { return engine.getData(); },
    ...override,
  };
}

test("resolver skips sessions the engine already knows or is cooling down", async () => {
  let queries = 0;
  const sdk = fakeSdk(async () => { queries += 1; return { session: { namespace: "code" } }; });
  const client = { call: async () => ({ sessionIds: [], known: { a: "chat" }, cooling: ["b"] }) };
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet });
  const out = await resolver.resolve([entry("a", "r1"), entry("b", "r2")]);
  assert.equal(queries, 0, "持久 known/冷却状态必须阻止重复查询");
  assert.deepEqual(out.sessionNamespaces, {});
});

test("persistent known and cooling state survive a resolver restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-code-persist-"));
  let engine = createLedgerEngine({ dataDir: dir, log: quiet });
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let client = engineClient(engine);
  const shared = makeShared();
  const entries = () => [entry("code-persist", "p1"), entry("failing-session", "p2")];
  let queries = [];
  const makeSdk = () => ({
    usage: { async list() { return { entries: entries() }; } },
    sessions: {
      async get({ sessionId }) {
        queries.push(sessionId);
        if (sessionId === "failing-session") throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" });
        return { session: { namespace: "code" } };
      },
    },
  });

  const first = createSessionSourceResolver({ sdk: makeSdk(), client, log: quiet });
  const scheduler1 = createSyncScheduler({ shared, client, sdk: makeSdk(), interval: 60000, sourceResolver: first });
  await scheduler1.performScan(false);
  assert.deepEqual(queries.sort(), ["code-persist", "failing-session"].sort());
  assert.ok(engine.getData().sessions["agent-a::code::2026-10-06"], "首次扫描后 Code 映射必须入库");
  await first.dispose();

  // 重启：成功映射不得重查，五分钟内失败会话不得重查。
  queries = [];
  const second = createSessionSourceResolver({ sdk: makeSdk(), client, log: quiet });
  const scheduler2 = createSyncScheduler({ shared, client, sdk: makeSdk(), interval: 60000, sourceResolver: second });
  await scheduler2.performScan(false);
  assert.deepEqual(queries, [], "重启后 known 与冷却状态必须从持久层恢复");
  await second.dispose();

  // 冷却到期（通过持久文件时间戳注入，并重启引擎读取）后允许重试。
  const sourceFile = path.join(dir, "session-sources.json");
  const parsed = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  parsed.failures["failing-session"] = Date.now() - 6 * 60 * 1000;
  fs.writeFileSync(sourceFile, JSON.stringify(parsed));
  engine.close();
  engine = createLedgerEngine({ dataDir: dir, log: quiet });
  client = engineClient(engine);
  queries = [];
  const third = createSessionSourceResolver({ sdk: makeSdk(), client, log: quiet });
  const scheduler3 = createSyncScheduler({ shared, client, sdk: makeSdk(), interval: 60000, sourceResolver: third });
  await scheduler3.performScan(false);
  assert.deepEqual(queries, ["failing-session"], "超过 5 分钟后只重试失败会话");
  await third.dispose();
});

test("a failed engine scan does not lose the learned mapping", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-code-retry-"));
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const entries = [entry("retry-code", "r1")];
  let queries = 0;
  const sdk = {
    usage: { async list() { return { entries }; } },
    sessions: { async get() { queries += 1; return { session: { namespace: "code" } }; } },
  };
  let failOnce = true;
  const realScan = engine.scan.bind(engine);
  const client = engineClient(engine, {
    async scan(scanEntries, options) {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error("后台扫描失败"), { code: "SCAN_FAILED" });
      }
      return realScan(scanEntries, options);
    },
  });
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet });
  const scheduler = createSyncScheduler({ shared: makeShared(), client, sdk, interval: 60000, sourceResolver: resolver });
  await assert.rejects(scheduler.performScan(false));
  assert.equal(queries, 1);
  assert.equal(engine.archiveCount(), 0, "首次扫描失败时未归档");

  await scheduler.performScan(false);
  const data = engine.getData();
  assert.ok(data.sessions["agent-a::code::2026-10-06"], "重试时必须重新交付上次未确认的映射");
  assert.equal(data.sourceClassification.status, "complete");
  assert.equal(queries, 1, "待提交映射不得重复查询官方会话");
});

test("history candidates skip ids already picked from the recent ledger", async () => {
  const requested = [];
  const sdk = fakeSdk(async ({ sessionId }) => {
    requested.push(sessionId);
    return { session: { namespace: "chat" } };
  });
  const history = ["new-0", "hist-old"];
  const resolver = createSessionSourceResolver({
    sdk,
    client: { call: async () => ({ sessionIds: history }) },
    log: quiet,
  });
  const entries = [];
  for (let i = 0; i < 8; i++) entries.push(entry(`new-${i}`, `r${i}`, `2026-10-06T10:${String(i).padStart(2, "0")}:00.000Z`));
  await resolver.resolve(entries);

  assert.equal(requested.length, 8);
  assert.ok(requested.includes("hist-old"), "历史名额不能被与 recent 重叠的候选吞掉");
  assert.equal(requested.filter((id) => id.startsWith("new-")).length, 7);
});

test("candidate window is bounded to 256 ids and advances past persistent known ids", async () => {
  const sdk = fakeSdk(async () => { throw new Error("known sessions must not be queried"); });
  const payloads = [];
  const client = {
    call: async (method, payload) => {
      payloads.push(payload);
      const known = {};
      for (const id of payload.recent || []) known[id] = "chat";
      return { sessionIds: [], known, cooling: [] };
    },
  };
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet });
  const entries = [];
  for (let i = 0; i < 300; i++) entries.push(entry(`s-${String(i).padStart(3, "0")}`, `r${i}`, "2026-10-06T10:00:00.000Z"));

  await resolver.resolve(entries);
  await resolver.resolve(entries);

  assert.equal(sdk.calls.length, 0, "持久 known 状态必须阻止重查");
  assert.equal(payloads[0].recent.length, 256, "候选窗口必须有界");
  assert.equal(payloads[1].recent.length, 44, "下一轮窗口必须越过已确认的 256 个会话继续推进");
  assert.ok(payloads[1].recent.every((id) => !payloads[0].recent.includes(id)));
});

test("a candidate-state RPC failure skips classification instead of bypassing persistent state", async () => {
  const sdk = fakeSdk(async () => { throw new Error("stale state must not be re-queried"); });
  const client = { call: async () => { throw Object.assign(new Error("rpc down"), { code: "BUSY" }); } };
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet });
  const out = await resolver.resolve([entry("a", "r1"), entry("b", "r2")]);
  assert.equal(sdk.calls.length, 0, "RPC 失败时不得把无状态当成全部未知");
  assert.deepEqual(out.sessionNamespaces, {});
});

test("long session ids keep the candidate RPC payload bounded", async () => {
  const sdk = fakeSdk(async () => ({ session: { namespace: "chat" } }));
  const payloads = [];
  const client = { call: async (method, payload) => { payloads.push(payload); return { sessionIds: [], known: {}, cooling: [] }; } };
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet });
  const entries = [];
  for (let i = 0; i < 10; i++) entries.push(entry(`${i}${"x".repeat(252)}`, `r${i}`, "2026-10-06T10:00:00.000Z"));
  await resolver.resolve(entries);

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].recent.length, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(payloads[0])) < 1024 * 1024, "候选 RPC 负载必须远低于 1 MiB");
});

test("pending mappings are capped at 256 entries and drain only after ack", async () => {
  const sdk = fakeSdk(async () => ({ session: { namespace: "code" } }));
  const client = { call: async () => ({ sessionIds: [], known: {}, cooling: [] }) };
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet });
  let entries = [];
  let lastDelivered = {};
  for (let round = 0; round < 33; round++) {
    entries = entries.concat(Array.from({ length: 8 }, (_, i) => entry(`p-${round}-${i}`, `req-${round}-${i}`, "2026-10-06T10:00:00.000Z")));
    const out = await resolver.resolve(entries);
    lastDelivered = out.sessionNamespaces;
    assert.ok(Object.keys(out.sessionNamespaces).length <= 256, "返回映射不得超过 256");
  }
  assert.equal(sdk.calls.length, 256, "待提交容量满后不得继续查询新会话");
  assert.equal(Object.keys(lastDelivered).length, 256);

  await resolver.ack(Object.keys(lastDelivered).slice(0, 8));
  const after = await resolver.resolve(entries);
  assert.equal(Object.keys(after.sessionNamespaces).length, 256, "ack 后腾出名额并保持上限");
  assert.equal(sdk.calls.length, 264);
});

test("readSnapshot failure keeps mappings pending instead of acking them", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-code-snapshot-"));
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const entries = [entry("snapshot-code", "r1")];
  let queries = 0;
  const sdk = {
    usage: { async list() { return { entries }; } },
    sessions: { async get() { queries += 1; return { session: { namespace: "code" } }; } },
  };
  let failSnapshot = true;
  const scanOptions = [];
  const client = engineClient(engine, {
    async scan(scanEntries, options) {
      scanOptions.push(options);
      return engine.scan(scanEntries, options);
    },
    async readSnapshot() {
      if (failSnapshot) {
        failSnapshot = false;
        throw new Error("snapshot failed");
      }
      return engine.getData();
    },
  });
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet });
  const scheduler = createSyncScheduler({ shared: makeShared(), client, sdk, interval: 60000, sourceResolver: resolver });

  await assert.rejects(scheduler.performScan(false));
  await scheduler.performScan(false);

  assert.equal(queries, 1, "未 ack 的映射不得重新查询官方会话");
  assert.deepEqual(scanOptions.at(-1).sessionNamespaces, { "snapshot-code": "code" }, "readSnapshot 失败后必须重新交付");
  assert.ok(engine.getData().sessions["agent-a::code::2026-10-06"]);
});

test("history still progresses when recent candidates exceed the 256-id window", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-code-history-"));
  const engine = createLedgerEngine({ dataDir: dir, log: quiet });
  t.after(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const entries = [];
  for (let i = 0; i < 300; i++) {
    entries.push(entry(`recent-${String(i).padStart(3, "0")}`, `r${i}`, "2026-10-06T11:00:00.000Z"));
  }
  entries.push(entry("hist-old", "hist", "2026-09-01T09:00:00.000Z"));
  await engine.scan(entries, {});

  const requested = [];
  const sdk = fakeSdk(async ({ sessionId }) => {
    requested.push(sessionId);
    return { session: { namespace: sessionId === "hist-old" ? "code" : "chat" } };
  });
  const resolver = createSessionSourceResolver({
    sdk,
    client: { call: async (method, payload) => engine.sessionCandidates(payload) },
    log: quiet,
  });
  await resolver.resolve(entries);
  assert.ok(requested.includes("hist-old"), "超过窗口的近期会话不得挤掉真正的历史");
});

test("engine cooling expires inside one resolver process instead of blocking forever", async () => {
  let clock = 1_000_000;
  let engineCooling = true;
  let queries = 0;
  const sdk = fakeSdk(async () => {
    queries += 1;
    return { session: { namespace: "code" } };
  });
  const client = {
    call: async (method, payload) => ({
      sessionIds: [],
      known: {},
      cooling: engineCooling && (payload.recent || []).includes("cool-session") ? ["cool-session"] : [],
    }),
  };
  const resolver = createSessionSourceResolver({ sdk, client, log: quiet, now: () => clock });
  const entries = [entry("cool-session", "r1")];

  await resolver.resolve(entries);
  assert.equal(queries, 0, "冷却中的会话首轮不得查询");

  clock += 4 * 60 * 1000;
  await resolver.resolve(entries);
  assert.equal(queries, 0, "5 分钟内仍不得查询");

  clock += 2 * 60 * 1000;
  engineCooling = false;
  const out = await resolver.resolve(entries);
  assert.equal(queries, 1, "同一个 resolver 进程内冷却到期后必须重新查询");
  assert.deepEqual(out.sessionNamespaces, { "cool-session": "code" });
});
