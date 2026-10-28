import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ModelRoutingStore, computeDateRange } from "../lib/model-routing.mjs";

test("computeDateRange 计算各区间日期", () => {
  const today = computeDateRange("today");
  assert.ok(today && today.from === today.to);

  const yesterday = computeDateRange("yesterday");
  assert.ok(yesterday && yesterday.from === yesterday.to);

  const d7 = computeDateRange("7d");
  assert.ok(d7 && d7.from <= d7.to);

  const all = computeDateRange("all");
  assert.strictEqual(all, null);

  const custom = computeDateRange("custom", "2026-05-01", "2026-05-10");
  assert.deepStrictEqual(custom, { from: "2026-05-01", to: "2026-05-10" });
});

test("ModelRoutingStore 写入与过滤测试", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-test-"));
  const store = new ModelRoutingStore({ dataDir: tmpDir });

  try {
    // 相同模型记录为直通（is_routed = 0）
    const same = store.recordRoute({
      id: "r1",
      at: "2026-10-27T08:00:00Z",
      requestedModel: "gemini-flash",
      responseModel: "gemini-flash",
      totalTokens: 100,
    });
    assert.strictEqual(same, true);

    // 不同模型记录为切流（is_routed = 1）
    const diff = store.recordRoute({
      id: "r2",
      at: "2026-10-27T10:00:00Z",
      day: "2026-10-27",
      agent: "hakimi",
      sessionId: "s1",
      provider: "gemini",
      requestedModel: "gemini-3.8-flash-high",
      responseModel: "gemini-3.8-flash-control",
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 200,
      totalTokens: 350,
    });
    assert.strictEqual(diff, true);

    // 重复 ID 幂等
    const dup = store.recordRoute({
      id: "r2",
      requestedModel: "gemini-3.8-flash-high",
      responseModel: "gemini-3.8-flash-control",
    });
    assert.strictEqual(dup, false);

    // 再加一条不同日期的切流记录
    store.recordRoute({
      id: "r3",
      at: "2026-10-26T10:00:00Z",
      day: "2026-10-26",
      agent: "luna",
      sessionId: "s2",
      provider: "gemini",
      requestedModel: "gemini-3.8-flash-high",
      responseModel: "gemini-3.8-flash-n",
      totalTokens: 500,
    });

    // 查询全部
    const qAll = store.queryRoutes({ range: "all" });
    assert.strictEqual(qAll.ok, true);
    assert.strictEqual(qAll.summary.totalCalls, 3);
    assert.strictEqual(qAll.summary.routedCount, 2);
    assert.strictEqual(qAll.summary.normalCount, 1);
    assert.strictEqual(qAll.summary.totalRouted, 2);
    assert.strictEqual(qAll.summary.totalTokens, 950);
    assert.strictEqual(qAll.summary.routedTokens, 850);
    assert.strictEqual(qAll.summary.routeRate, 66.7);
    assert.strictEqual(qAll.summary.topPairs.length, 2);

    // 状态过滤：仅切流
    const qRouted = store.queryRoutes({ status: "routed" });
    assert.strictEqual(qRouted.total, 2);
    assert.strictEqual(qRouted.routes.every((r) => r.isRouted), true);

    // 状态过滤：仅正常
    const qNormal = store.queryRoutes({ status: "normal" });
    assert.strictEqual(qNormal.total, 1);
    assert.strictEqual(qNormal.routes[0].isRouted, false);

    // 按 Agent 过滤
    const qAgent = store.queryRoutes({ agent: "hakimi" });
    assert.strictEqual(qAgent.summary.totalCalls, 1);
    assert.strictEqual(qAgent.summary.routedCount, 1);
    assert.strictEqual(qAgent.routes[0].responseModel, "gemini-3.8-flash-control");

    // 按日期过滤
    const qDay = store.queryRoutes({ from: "2026-10-27", to: "2026-10-27" });
    assert.strictEqual(qDay.summary.totalCalls, 2);
    assert.strictEqual(qDay.summary.routedCount, 1);
    assert.strictEqual(qDay.summary.normalCount, 1);
    assert.strictEqual(qDay.summary.totalRouted, 1);

    // recordMessage 辅助方法（正常直通消息）
    const normalMsg = store.recordMessage(
      { agentId: "hakimi", sessionId: "sess-msg-normal" },
      {
        role: "assistant",
        model: "gemini-3.8-flash-high",
        responseId: "resp_normal",
        timestamp: Date.now(),
        provider: "gemini",
        usage: { input: 10, output: 20, cacheRead: 30, totalTokens: 60 },
      }
    );
    assert.strictEqual(normalMsg, true);

    // recordMessage 辅助方法（切流消息）
    const fromMsg = store.recordMessage(
      { agentId: "hakimi", sessionId: "sess-msg" },
      {
        role: "assistant",
        model: "gemini-3.8-flash-high",
        responseModel: "gemini-3.8-flash-exp-a",
        responseId: "resp_123",
        timestamp: Date.now(),
        provider: "gemini",
        usage: { input: 10, output: 20, cacheRead: 30, totalTokens: 60 },
      }
    );
    assert.strictEqual(fromMsg, true);

    const qAfter = store.queryRoutes({ range: "all" });
    assert.strictEqual(qAfter.summary.totalCalls, 5);
    assert.strictEqual(qAfter.summary.routedCount, 3);
    assert.strictEqual(qAfter.summary.normalCount, 2);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ModelRoutingStore 会话历史扫描与增量 mtime 节流", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-scan-"));
  const fakeHanaHome = path.join(tmpDir, "hana_home");
  const agentSessionDir = path.join(fakeHanaHome, "agents", "test-agent", "sessions");
  fs.mkdirSync(agentSessionDir, { recursive: true });

  const sessionFile = path.join(agentSessionDir, "test-sess.jsonl");
  const lines = [
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "model-a",
        responseModel: "model-b",
        responseId: "scan_1",
        timestamp: 1790000000000,
        provider: "test-prov",
        usage: { totalTokens: 100 },
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "model-a",
        responseModel: "model-a", // 没变
        responseId: "scan_2",
      },
    }),
  ];
  fs.writeFileSync(sessionFile, lines.join("\n") + "\n", "utf8");

  const store = new ModelRoutingStore({ dataDir: tmpDir });
  try {
    const res1 = store.scanSessions(fakeHanaHome);
    assert.strictEqual(res1.scannedFiles, 1);
    assert.strictEqual(res1.newRoutes, 2);

    // 再次扫描，由于 mtime 未变化，直接跳过
    const res2 = store.scanSessions(fakeHanaHome);
    assert.strictEqual(res2.scannedFiles, 0);

    const q = store.queryRoutes({ range: "all" });
    assert.strictEqual(q.summary.totalCalls, 2);
    assert.strictEqual(q.summary.routedCount, 1);
    assert.strictEqual(q.summary.normalCount, 1);
    assert.strictEqual(q.summary.totalRouted, 1);
    assert.strictEqual(q.routes.length, 2);
    const qRouted = store.queryRoutes({ status: "routed" });
    assert.strictEqual(qRouted.total, 1);
    assert.strictEqual(qRouted.routes[0].requestedModel, "model-a");
    assert.strictEqual(qRouted.routes[0].responseModel, "model-b");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("createModelRouting 视图组件渲染与分页联动", async () => {
  const { createModelRouting } = await import("../ui/modules/model-routing.js");

  class MockElement {
    constructor() {
      this.innerHTML = "";
      this.listeners = new Map();
    }
    querySelector(sel) {
      return {
        onclick: null,
      };
    }
    querySelectorAll() {
      return [];
    }
  }

  const container = new MockElement();

  const mockPayload = {
    ok: true,
    summary: {
      totalRouted: 1,
      totalTokens: 1000,
      topPairs: [
        {
          provider: "gemini",
          requestedModel: "gemini-3.8-flash-high",
          responseModel: "gemini-3.8-flash-control",
          count: 1,
          tokens: 1000,
        },
      ],
    },
    routes: [
      {
        id: "r1",
        at: "2026-10-27T10:00:00Z",
        agent: "hakimi",
        provider: "gemini",
        requestedModel: "gemini-3.8-flash-high",
        responseModel: "gemini-3.8-flash-control",
        tokens: { input: 100, output: 50, cacheRead: 850, total: 1000 },
        sessionId: "sess_test",
      },
    ],
    total: 1,
  };

  const instance = createModelRouting({
    container,
    fetchFn: async () => ({
      ok: true,
      json: async () => mockPayload,
    }),
    getFilters: () => ({ agent: "hakimi" }),
  });

  instance.ensure();
  await new Promise((r) => setTimeout(r, 10));

  assert.match(container.innerHTML, /模型路由与切流检测/);
  assert.match(container.innerHTML, /总请求调用/);
  assert.match(container.innerHTML, /替身切流请求/);
  assert.match(container.innerHTML, /上游切流率/);
  assert.match(container.innerHTML, /mr-status-btn/);
  assert.match(container.innerHTML, /gemini-3.8-flash-high/);
  assert.match(container.innerHTML, /gemini-3.8-flash-control/);
  assert.match(container.innerHTML, /Top 替身重定向模式/);
});

test("页签接线：模型路由拥有独立 Tab 按钮与独立视图容器", () => {
  const dashboardSource = fs.readFileSync(new URL("../ui/dashboard-app.js", import.meta.url), "utf8");
  assert.match(dashboardSource, /data-view="model-routing"/);
  assert.match(dashboardSource, /id="model-routing-section"/);
  assert.match(dashboardSource, /createModelRouting/);
});
