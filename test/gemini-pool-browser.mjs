// 独立浏览器验收：新 headless Chrome profile、纯合成 DTO 和假 fetch。
// 不连接 Hana、CPA、真实账号、管理密钥或模型 API。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = join(root, "ui");
const modulePath = join(uiRoot, "modules", "gemini-card.js");
let geminiPendingRequests = 0;
const geminiGate = new Promise(() => {});

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  if (pathname === "/" || pathname === "/gemini-pool-browser.html") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><meta charset=\"utf-8\"><title>Gemini pool review</title>");
    return;
  }
  if (pathname === "/review-state") {
    sendJson(res, { geminiPending: geminiPendingRequests > 0 });
    return;
  }
  if (pathname.startsWith("/api/apps/token-tracker/routes/")) {
    const route = pathname.slice("/api/apps/token-tracker/routes".length);
    if (route === "/settings") {
      sendJson(res, { showCodexQuota: true, showDeepseekBalance: true });
      return;
    }
    if (route === "/codex-quota") {
      sendJson(res, { connected: true, planLabel: "Synthetic", primary: { remainingPercent: 80 }, resetCredits: 0 });
      return;
    }
    if (route === "/deepseek-balance") {
      sendJson(res, { connected: true, display: "$1.00", currency: "USD" });
      return;
    }
    if (route === "/lithos-balance") {
      sendJson(res, { connected: true, display: "$2.00", currency: "USD" });
      return;
    }
    if (route === "/gemini-quota") {
      geminiPendingRequests += 1;
      await geminiGate;
      sendJson(res, { configured: false, connected: false, accounts: [] });
      return;
    }
    sendJson(res, { error: "synthetic_not_found" }, 404);
    return;
  }
  if (pathname.startsWith("/ui/")) {
    const filePath = join(uiRoot, pathname.slice("/ui/".length));
    try {
      const contentType = pathname.endsWith(".html")
        ? "text/html; charset=utf-8"
        : pathname.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
      res.setHeader("content-type", contentType);
      res.end(await readFile(filePath));
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  res.writeHead(404).end();
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});

const profile = await mkdtemp(join(tmpdir(), "token-tracker-gemini-pool-review-"));
const chrome = spawn(process.env.CHROME_BIN || "/usr/bin/google-chrome", [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let ws;
let timeout;
try {
  const report = await Promise.race([
    runBrowser(),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Gemini pool browser review timed out")), 30000);
    }),
  ]);
  for (const item of report) {
    if (item.ok) console.log(`PASS ${item.name}`);
    else console.error(`FAIL ${item.name}: ${item.error}`);
  }
  const failed = report.filter((item) => !item.ok);
  if (failed.length) throw new Error(`${failed.length} Gemini browser acceptance case(s) failed`);
  console.log(`PASS: ${report.length} Gemini browser cases`);
} finally {
  clearTimeout(timeout);
  ws?.close();
  chrome.kill("SIGTERM");
  server.closeAllConnections?.();
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function runBrowser() {
  const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
    let stderr = "";
    chrome.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolveEndpoint(match[1]);
    });
    chrome.once("error", rejectEndpoint);
    chrome.once("exit", (code) => rejectEndpoint(new Error(`Chrome exited before readiness: ${code}`)));
  });

  ws = new WebSocket(endpoint);
  await once(ws, "open");
  let nextId = 0;
  const pending = new Map();
  const events = new Set();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of events) listener(message);
  };
  const call = (method, params = {}, sessionId) => new Promise((resolveCall, rejectCall) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveCall, reject: rejectCall });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => call(method, params, sessionId);
  await send("Page.enable");
  const waitForLoad = () => new Promise((resolveLoaded) => {
    const listener = (message) => {
      if (message.sessionId === sessionId && message.method === "Page.loadEventFired") {
        events.delete(listener);
        resolveLoaded();
      }
    };
    events.add(listener);
  });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/gemini-pool-browser.html` });
  await waitForLoad();

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };

  const rendererReport = await evaluate(`(async () => {
    const { createGeminiQuotaController, renderGeminiCard } = await import("/ui/modules/gemini-card.js?browser-review=" + Date.now());
    const results = [];
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    const flush = async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); await Promise.resolve(); };
    const makeSlot = () => {
      const section = document.createElement("section");
      section.className = "gemini-pool-section";
      const slot = document.createElement("div");
      section.append(slot);
      document.body.append(section);
      return { section, slot };
    };
    const normalDto = (label = "synthetic-account") => ({
      configured: true,
      connected: true,
      reason: null,
      updatedAt: 1793181600000,
      accounts: [{
        id: "summary-account",
        label,
        health: "healthy",
        quotaStatus: "ok",
        groups: [{
          id: "cloud-code",
          label: "Cloud Code",
          buckets: [
            { id: "daily", label: "Daily", remainingFraction: 0, resetTime: "2026-10-30T00:00:00.000Z" },
            { id: "sandbox", label: "Sandbox", remainingFraction: 0.75, resetTime: null },
          ],
        }],
      }],
    });
    const runCase = async (name, fn) => {
      try { await fn(); results.push({ name, ok: true }); }
      catch (error) { results.push({ name, ok: false, error: error?.stack || String(error) }); }
    };

    await runCase("未配置隐藏且清空卡片", async () => {
      const { section, slot } = makeSlot();
      renderGeminiCard(slot, { configured: false, connected: false, accounts: [] });
      expect(section.style.display === "none", "未配置区块未隐藏");
      expect(slot.innerHTML === "", "未配置仍有占位内容");
      section.remove();
    });

    await runCase("正常分组保留 0 值并标注共享配额", async () => {
      const { section, slot } = makeSlot();
      renderGeminiCard(slot, normalDto(), { now: Date.parse("2026-10-28T12:00:00Z") });
      expect(section.style.display !== "none", "正常卡片被隐藏");
      expect(slot.textContent.includes("Antigravity共享配额"), "缺少共享配额说明");
      expect(slot.textContent.includes("0%"), "0% 被错误当成缺失");
      expect(slot.textContent.includes("75%"), "正常百分比缺失");
      expect(!slot.textContent.includes("总池") && !slot.textContent.includes("平均"), "错误生成总池聚合");
      section.remove();
    });

    await runCase("缺项目与部分失败分开显示", async () => {
      const { section, slot } = makeSlot();
      renderGeminiCard(slot, {
        configured: true,
        connected: false,
        accounts: [
          { id: "unavailable-summary", label: "unavailable-account", health: "unavailable", quotaStatus: "error", groups: [{ id: "g", label: "Production", buckets: [{ id: "b", label: "Remaining", remainingFraction: 0.2, resetTime: "2026-10-29T00:00:00Z" }] }] },
          { id: "missing-summary", label: "missing-project-account", health: "healthy", quotaStatus: "missing_project", groups: [] },
        ],
      });
      expect(slot.textContent.includes("账号不可用"), "health 状态丢失");
      expect(slot.textContent.includes("配额查询失败"), "quota error 状态丢失");
      expect(slot.textContent.includes("缺少项目"), "missing project 状态丢失");
      expect(slot.textContent.includes("20%"), "unavailable 账号的已有额度被隐藏");
      section.remove();
    });

    await runCase("过期 reset 显示待刷新", async () => {
      const { section, slot } = makeSlot();
      const data = normalDto();
      data.accounts[0].groups[0].buckets[0].resetTime = "2026-10-27T00:00:00Z";
      renderGeminiCard(slot, data, { now: Date.parse("2026-10-28T00:00:00Z") });
      expect(slot.textContent.includes("待刷新"), "过期时间未显示待刷新");
      expect(!slot.textContent.includes("已恢复"), "过期时间被伪造为已恢复");
      section.remove();
    });

    await runCase("清空配置竞态不被旧响应复活", async () => {
      const { section, slot } = makeSlot();
      const requests = [];
      const controller = createGeminiQuotaController({
        container: slot,
        fetchFn: () => new Promise(resolve => requests.push(resolve)),
      });
      controller.load();
      controller.reload({ hide: true });
      expect(requests.length === 2, "配置重载未创建新请求");
      requests[1]({ ok: true, json: async () => ({ configured: false, connected: false, accounts: [] }) });
      await flush();
      requests[0]({ ok: true, json: async () => normalDto("stale-account") });
      await flush();
      expect(section.style.display === "none", "旧响应复活了已清空卡片");
      expect(!slot.textContent.includes("stale-account"), "旧账号结果泄露到当前状态");
      controller.dispose();
      section.remove();
    });

    return results;
  })()`);

  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/ui/function-panel.html` });
  await waitForLoad();
  const panelReport = await evaluate(`(async () => {
    const deadline = Date.now() + 4000;
    while ((!document.querySelector("#codex-card-slot .sb-codex-title") || !document.querySelector("#deepseek-card-slot .sb-codex-title") || !document.querySelector("#lithos-card-slot .sb-codex-title")) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const state = await fetch("/review-state").then(response => response.json());
    if (!document.querySelector("#codex-card-slot .sb-codex-title")) throw new Error("Codex card did not render while Gemini was pending");
    if (!document.querySelector("#deepseek-card-slot .sb-codex-title")) throw new Error("DeepSeek card did not render while Gemini was pending");
    if (!document.querySelector("#lithos-card-slot .sb-codex-title")) throw new Error("Lithos card did not render while Gemini was pending");
    if (!state.geminiPending) throw new Error("Gemini request was not held pending");
    return [{ name: "Gemini pending 不阻塞 Codex/DeepSeek/Lithos 旧卡", ok: true }];
  })()`);
  return [...rendererReport, ...panelReport];
}
