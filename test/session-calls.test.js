// 「点得开」：从明细一行回归档捞这一轮会话的逐次调用。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionCalls } from "../runtime/engine/services/session-calls.js";
import registerRoutes from "../server/dashboard.js";

function rec(requestId, sessionId, startedAt, extra = {}) {
  return {
    rid: requestId,
    v: {
      requestId,
      sessionId,
      startedAt,
      endedAt: startedAt,
      durationMs: 0,
      status: extra.status || "ok",
      agentId: extra.agentId || "hanako",
      provider: extra.provider || "deepseek",
      model: extra.model || "deepseek-ai/DeepSeek-V4.1-Flash",
      type: "desktop",
      inputTokens: extra.input ?? 100,
      inputUncachedTokens: extra.input ?? 100,
      outputTokens: extra.output ?? 50,
      cacheReadTokens: extra.cacheRead ?? 900,
      cacheWriteTokens: 0,
      totalTokens: (extra.input ?? 100) + (extra.cacheRead ?? 900) + (extra.output ?? 50),
    },
  };
}

function writeArchive(dir, records) {
  const file = path.join(dir, "usage-archive.jsonl");
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return file;
}

test("按 sessionId 捞出逐次调用：排序、失败标记、间隔与合计", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-calls-"));
  const file = writeArchive(dir, [
    rec("r2", "sess_a", "2026-10-27T10:00:05.000Z", { input: 20, output: 10 }),
    rec("r1", "sess_a", "2026-10-27T10:00:00.000Z"),
    // 同一会话里失败的一次：进列表、计失败数，但 token 照记
    rec("r3", "sess_a", "2026-10-27T10:00:07.000Z", { status: "error", input: 0, output: 0, cacheRead: 0 }),
    // 别的会话，不能被混进来
    rec("r9", "sess_b", "2026-10-27T10:00:01.000Z"),
  ]);

  const res = readSessionCalls({ file, requestId: "r2" });
  assert.equal(res.ok, true);
  assert.equal(res.sessionId, "sess_a");
  assert.equal(res.found, true);
  assert.deepEqual(res.calls.map((c) => c.requestId), ["r1", "r2", "r3"], "按开始时间升序");
  assert.equal(res.calls[1].failed, false);
  assert.equal(res.calls[2].failed, true);
  assert.equal(res.totals.calls, 3);
  assert.equal(res.totals.failedCalls, 1);
  // 间隔是「本次开始 − 上次开始」，只在这两个区间内给值
  assert.equal(res.calls[0].gapMs, null);
  assert.equal(res.calls[1].gapMs, 5000);
  // input 是未命中，inputTotal 才含命中
  assert.equal(res.calls[1].input, 20);
  assert.equal(res.calls[1].cacheRead, 900);
  assert.equal(res.calls[1].inputTotal, 920);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("归档里没有这条请求时如实报找不到", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-calls-"));
  const file = writeArchive(dir, [rec("r1", "sess_a", "2026-10-27T10:00:00.000Z")]);
  const res = readSessionCalls({ file, requestId: "nope" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "TURN_NOT_FOUND");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("没有归档文件、没有参数都给明确错误码", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-calls-"));
  const missing = readSessionCalls({ file: path.join(dir, "not-there.jsonl"), requestId: "x" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "NO_ARCHIVE");

  const noArg = readSessionCalls({ file: writeArchive(dir, []) });
  assert.equal(noArg.ok, false);
  assert.equal(noArg.code, "MISSING_ARG");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("记录没带 sessionId 时只回这一条，并说明拿不到上下文", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-calls-"));
  const solo = rec("r1", null, "2026-10-27T10:00:00.000Z");
  const file = writeArchive(dir, [solo]);
  const res = readSessionCalls({ file, requestId: "r1" });
  assert.equal(res.ok, true);
  assert.equal(res.sessionKnown, false);
  assert.equal(res.callCount, 1);
  assert.equal(res.calls.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("路由 /turn 带上单次费用与合计，找不到请求给 404", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-calls-route-"));
  writeArchive(dir, [rec("r1", "sess_a", "2026-10-27T10:00:00.000Z")]);
  // 价格表：输出 1 元/M、输入 0.5 元/M、缓存读 0.05 元/M
  fs.writeFileSync(
    path.join(dir, "price-table.json"),
    JSON.stringify({ "deepseek/deepseek-ai/DeepSeek-V4.1-Flash": { defaultPrice: { unit: "token", inputPerM: 0.5, inputCachePerM: 0.05, outputPerM: 1, cacheWritePerM: 0 } } }),
    "utf8"
  );

  const routes = {};
  const mockApp = { get: (p, fn) => { routes["GET " + p] = fn; }, post: () => {} };
  registerRoutes(mockApp, { _tokenCache: { ready: true, dataDir: dir, data: { sessions: {} } }, dataDir: dir, bus: { request: async () => ({}) } });

  const ok = await routes["GET /turn"]({
    req: { query: (k) => (k === "requestId" ? "r1" : "") },
    json: (body, status = 200) => ({ body, status }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.calls.length, 1);
  // 100 输入 × 0.5/M + 900 缓存读 × 0.05/M + 50 输出 × 1/M
  const expected = (100 * 0.5 + 900 * 0.05 + 50 * 1) / 1e6;
  assert.ok(Math.abs(ok.body.calls[0].cost - expected) < 1e-12, `费用应为 ${expected}，实际 ${ok.body.calls[0].cost}`);
  assert.ok(Math.abs(ok.body.totalCost - expected) < 1e-12);

  const miss = await routes["GET /turn"]({
    req: { query: (k) => (k === "requestId" ? "nope" : "") },
    json: (body, status = 200) => ({ body, status }),
  });
  assert.equal(miss.status, 404);
  assert.equal(miss.body.code, "TURN_NOT_FOUND");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("明细行把 requestId 交给详情接口，而不是自己拼详情", async () => {
  const src = fs.readFileSync(new URL("../ui/modules/turns-inspector.js", import.meta.url), "utf8");
  assert.match(src, /data-request-id/, "每一行要带 requestId，点开才知道问哪一条");
  assert.match(src, /\/turn\?requestId=/, "详情来自 /turn，不从行上的汇总字段拼");
  assert.match(src, /turns-detail/, "要有详情区块的样式钩子");
  // 口径：行内命中率必须走共享实现，不许再各写一份式子
  assert.match(src, /hitRateLabel/, "命中率用 ui/hit-rate.js 的实现");
  assert.doesNotMatch(src, /r\s*\/\s*\(\s*r\s*\+\s*u\s*\)/, "不要留裸公式");
});

test("会话很长时以点的那条为中心开窗，不是从最早开始截", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-calls-window-"));
  const records = [];
  for (let i = 0; i < 500; i++) {
    const sec = String(i % 60).padStart(2, "0");
    const min = String(Math.floor(i / 60)).padStart(2, "0");
    records.push(rec(`r${i}`, "sess_long", `2026-10-27T10:${min}:${sec}.000Z`));
  }
  const file = writeArchive(dir, records);

  const res = readSessionCalls({ file, requestId: "r499" });
  assert.equal(res.ok, true);
  assert.equal(res.callCount, 500);
  assert.equal(res.truncated, true);
  assert.equal(res.calls.length, 400);
  assert.ok(res.windowStart > 0, "窗口要往后挪，不能从第 1 条开始");
  assert.ok(res.calls.some((c) => c.requestId === "r499"), "点的那一条必须在窗口里");
  assert.equal(res.calls[res.calls.length - 1].requestId, "r499");
  // 合计按整个会话算，不按窗口
  assert.equal(res.totals.calls, 500);

  fs.rmSync(dir, { recursive: true, force: true });
});
