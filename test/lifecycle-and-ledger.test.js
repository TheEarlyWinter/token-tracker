import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import appModule from "../index.js";

test("App V2 生命周期与账本拉取/归一化/归档持久化测试", async () => {
  // 创建临时隔离工作目录（充当 sdk.dataDir）
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-test-"));

  const recordedBusRequests = [];
  const mockSubscribers = new Set();

  const mockLedgerEntries = [
    {
      requestId: "req-1",
      startedAt: "2026-10-06T10:00:00.000Z",
      status: "ok",
      source: { subsystem: "session", operation: "chat" },
      attribution: { agentId: "agent-alpha", sessionId: "sess-1", kind: "session" },
      model: { provider: "deepseek", modelId: "deepseek-chat" },
      usage: {
        input: { totalTokens: 1000, uncachedTokens: 800 },
        output: { totalTokens: 200, reasoningTokens: 50 },
        cache: { readTokens: 200, writeTokens: 0, hitRatio: 0.2 },
        totalTokens: 1200,
        costTotal: 0.002,
      },
    },
    {
      // 无效请求：status 不是 ok，不应计入有效消费
      requestId: "req-error",
      startedAt: "2026-10-06T10:05:00.000Z",
      status: "error",
      source: { subsystem: "session" },
      attribution: { agentId: "agent-alpha", sessionId: "sess-1", kind: "session" },
      model: { provider: "deepseek", modelId: "deepseek-chat" },
      usage: null,
    },
    {
      // 异常请求：usage 为 null，不可当作有效 0 请求
      requestId: "req-missing-usage",
      startedAt: "2026-10-06T10:06:00.000Z",
      status: "usage_missing",
      source: { subsystem: "session" },
      attribution: { agentId: "agent-alpha", sessionId: "sess-1", kind: "session" },
      model: { provider: "deepseek", modelId: "deepseek-chat" },
      usage: null,
    },
  ];

  const mockCtx = {
    dataDir: tmpDataDir,
    config: {
      get: async (key) => (key === "scanInterval" ? 30 : null),
    },
    bus: {
      request: async (verb, params) => {
        recordedBusRequests.push({ verb, params });
        if (verb === "usage:list") {
          assert.equal(params?.limit, 20000, "usage:list 必须且仅传合法数字 limit: 20000");
          assert.equal(params?.cursor, undefined, "禁止传递非法的 cursor 参数");
          return { entries: mockLedgerEntries, nextCursor: null };
        }
        if (verb === "agent:list") {
          assert.equal(params?.scope, "all", "agent:list 必须带 scope: 'all'");
          return {
            agents: [{ id: "agent-alpha", name: "阿尔法助理" }],
          };
        }
        return {};
      },
      subscribe: (fn) => {
        mockSubscribers.add(fn);
        return () => mockSubscribers.delete(fn);
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  // 1. 装载 App
  await appModule.apply(mockCtx);

  const shared = mockCtx._tokenCache;
  assert.ok(shared, "宿主 context 上必须成功挂载 _tokenCache");

  // 等待首次异步扫描完成
  await shared.scan(true);

  // 2. 校验持久化文件
  const archivePath = path.join(tmpDataDir, "usage-archive.json");
  const cachePath = path.join(tmpDataDir, "token-cache.json");
  assert.ok(fs.existsSync(archivePath), "usage-archive.json 必须落盘");
  assert.ok(fs.existsSync(cachePath), "token-cache.json 必须落盘");

  const archive = JSON.parse(fs.readFileSync(archivePath, "utf-8"));
  // 只有 1 条有效请求 req-1 落入归档，过滤掉了 error 和 usage_missing
  assert.equal(Object.keys(archive.entries).length, 1);
  const archivedEntry = archive.entries["req-1"];
  assert.equal(archivedEntry.inputUncachedTokens, 800, "必须优先记录 inputUncachedTokens");
  assert.equal(archivedEntry.inputTokens, 1000);
  assert.equal(archivedEntry.totalTokens, 1200);

  // 3. 校验聚合数据
  const cacheData = shared.data;
  assert.ok(cacheData.sessions);
  const sessionKey = Object.keys(cacheData.sessions)[0];
  const session = cacheData.sessions[sessionKey];
  assert.equal(session.agent, "agent-alpha");
  assert.equal(session.totalTokens, 1200);
  assert.equal(session.assistantCount, 1);
  assert.equal(cacheData.agentNames["agent-alpha"], "阿尔法助理");

  // 4. 模拟 agent:list 失败场景，验证不误标删除与映射保留
  mockCtx.bus.request = async (verb, params) => {
    if (verb === "usage:list") return { entries: mockLedgerEntries };
    if (verb === "agent:list") throw new Error("Permission denied or service busy");
    return {};
  };
  await shared.scan(false);
  assert.equal(shared.data.agentNames["agent-alpha"], "阿尔法助理", "agent:list 失败必须保留已有名称映射");

  // 5. 校验幂等 dispose
  assert.equal(typeof shared.dispose, "function");
  shared.dispose();
  shared.dispose(); // 重复调用不报错

  // 清理临时目录
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});
