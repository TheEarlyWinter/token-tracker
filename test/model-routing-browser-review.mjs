// 独立浏览器验收：只启动新的 headless Chrome profile，不连接 Hana，不读取真实数据。
// 运行：node test/model-routing-browser-review.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelRoutingPath = join(root, "ui", "modules", "model-routing.js");
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  if (pathname === "/" || pathname === "/model-routing-browser-review.html") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><meta charset=\"utf-8\"><title>Model routing browser review</title><div id=\"app\"></div>");
    return;
  }
  if (pathname === "/ui/modules/model-routing.js") {
    try {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.end(await readFile(modelRoutingPath));
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

// 故意不批量清理 profile；每次只创建一个隔离 profile，finally 只关闭本次 Chrome 和服务器。
const profile = await mkdtemp(join(tmpdir(), "token-tracker-model-routing-review-"));
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
      timeout = setTimeout(() => reject(new Error("model-routing browser review timed out")), 30000);
    }),
  ]);
  for (const item of report) {
    if (item.ok) console.log(`PASS ${item.name}`);
    else console.error(`FAIL ${item.name}: ${item.error}`);
  }
  const failed = report.filter((item) => !item.ok);
  if (failed.length) throw new Error(`${failed.length} browser acceptance case(s) failed`);
  console.log(`PASS: ${report.length} model-routing browser cases`);
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
  const loaded = new Promise((resolveLoaded) => {
    const listener = (message) => {
      if (message.sessionId === sessionId && message.method === "Page.loadEventFired") {
        events.delete(listener);
        resolveLoaded();
      }
    };
    events.add(listener);
  });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/model-routing-browser-review.html` });
  await loaded;

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };

  return evaluate(`(async () => {
    const { createModelRouting } = await import("/ui/modules/model-routing.js?browser-review=" + Date.now());
    const results = [];

    function expect(condition, message) {
      if (!condition) throw new Error(message);
    }

    function response(body) {
      return { ok: true, status: 200, statusText: "OK", json: async () => body };
    }

    function route(label, routed = true) {
      const requestedModel = "requested-" + label;
      return {
        id: "route-" + label,
        at: "2026-10-28T10:00:00.000Z",
        agent: "synthetic-agent",
        provider: "synthetic-provider",
        requestedModel,
        responseModel: routed ? "served-" + label : requestedModel,
        isRouted: routed,
        tokens: { input: 10, output: 20, cacheRead: 70, total: 100 },
        sessionId: "synthetic-session",
      };
    }

    function payload(label, options = {}) {
      const total = options.total ?? 1;
      const summaryTotal = options.summaryTotal ?? total;
      const routedCount = options.summaryRouted ?? (options.routed === false ? 0 : 1);
      const normalCount = options.summaryNormal ?? Math.max(0, summaryTotal - routedCount);
      const routes = options.routes ?? [route(label, options.routed !== false)];
      return {
        ok: true,
        summary: {
          totalCalls: summaryTotal,
          normalCount,
          routedCount,
          totalRouted: routedCount,
          routeRate: summaryTotal ? Number(((routedCount / summaryTotal) * 100).toFixed(1)) : 0,
          totalTokens: summaryTotal * 100,
          routedTokens: routedCount * 100,
          topPairs: routedCount ? [{ provider: "synthetic-provider", requestedModel: "requested-" + label, responseModel: "served-" + label, count: routedCount, tokens: routedCount * 100 }] : [],
        },
        routes,
        total,
      };
    }

    function view(filters = {}) {
      const container = document.createElement("div");
      container.className = "model-routing-review-container";
      document.body.append(container);
      const calls = [];
      let currentFilters = { ...filters };
      const fetchFn = (url) => new Promise((resolveFetch, rejectFetch) => {
        calls.push({ url: String(url), resolve: resolveFetch, reject: rejectFetch });
      });
      const instance = createModelRouting({
        container,
        fetchFn,
        getFilters: () => currentFilters,
      });
      return {
        container,
        calls,
        instance,
        setFilters(next) { currentFilters = { ...next }; },
        remove() { container.remove(); },
      };
    }

    async function flush() {
      await Promise.resolve();
      await new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
      await Promise.resolve();
    }

    async function callsAt(api, count, label) {
      const deadline = Date.now() + 1500;
      while (api.calls.length < count && Date.now() < deadline) await flush();
      expect(api.calls.length >= count, label + ": expected " + count + " fetch call(s), got " + api.calls.length);
    }

    function query(api, index) {
      return new URL(api.calls[index].url, location.href).searchParams;
    }

    async function runCase(name, fn) {
      try {
        await fn();
        results.push({ name, ok: true });
      } catch (error) {
        results.push({ name, ok: false, error: error?.stack || String(error) });
      }
    }

    await runCase("状态按钮保持 summary 分母，分页边界使用真实 disabled", async () => {
      const api = view();
      try {
        api.instance.ensure();
        await callsAt(api, 1, "initial all");
        expect(query(api, 0).get("status") === null, "all must omit status parameter");
        api.calls[0].resolve(response(payload("all-page-1", { total: 51, summaryTotal: 51, summaryRouted: 2, summaryNormal: 49 })));
        await flush();
        expect(api.container.querySelector(".mr-prev-btn").disabled === true, "first page previous must be disabled");
        expect(api.container.querySelector(".mr-next-btn").disabled === false, "first page next must be enabled");
        api.container.querySelector(".mr-next-btn").click();
        await callsAt(api, 2, "next page");
        expect(query(api, 1).get("offset") === "50", "next page must request offset 50");
        api.calls[1].resolve(response(payload("all-page-2", { total: 51, summaryTotal: 51, summaryRouted: 2, summaryNormal: 49 })));
        await flush();
        expect(api.container.querySelector(".mr-next-btn").disabled === true, "last page next must be disabled");
        const beforeDisabledClick = api.calls.length;
        api.container.querySelector(".mr-next-btn").click();
        await flush();
        expect(api.calls.length === beforeDisabledClick, "disabled next must not request");
        api.container.querySelector(".mr-prev-btn").click();
        await callsAt(api, 3, "previous page");
        expect(query(api, 2).get("offset") === "0", "previous page must return to offset 0");
        api.calls[2].resolve(response(payload("all-page-1-again", { total: 51, summaryTotal: 51, summaryRouted: 2, summaryNormal: 49 })));
        await flush();

        for (const status of ["routed", "normal", "all"]) {
          const button = api.container.querySelector('[data-status="' + status + '"]');
          expect(button, "missing status button " + status);
          const expectedCalls = api.calls.length + 1;
          button.click();
          await callsAt(api, expectedCalls, status + " status");
          const index = api.calls.length - 1;
          const requestedStatus = query(api, index).get("status");
          expect(status === "all" ? requestedStatus === null : requestedStatus === status, status + " URL status mismatch");
          api.calls[index].resolve(response(payload(status, { total: status === "all" ? 51 : 2, summaryTotal: 51, summaryRouted: 2, summaryNormal: 49 })));
          await flush();
          expect(api.container.querySelector('[data-status="' + status + '"]').classList.contains("active"), status + " button must be active");
          const totalValue = api.container.querySelectorAll(".ls-card .ls-v")[0].textContent.trim();
          expect(totalValue === "51", status + " must keep summary denominator 51, got " + totalValue);
        }
      } finally {
        api.remove();
      }
    });

    await runCase("模型与供应商筛选进入 URL，旧慢请求不能覆盖新结果", async () => {
      const api = view({ model: "old-model", provider: "old-provider" });
      try {
        api.instance.ensure();
        await callsAt(api, 1, "old filter");
        api.setFilters({ model: "new-model", provider: "new-provider" });
        api.instance.reloadWithFilters();
        await callsAt(api, 2, "new filter");
        expect(query(api, 1).get("model") === "new-model", "new model filter missing from URL");
        expect(query(api, 1).get("provider") === "new-provider", "new provider filter missing from URL");
        api.calls[1].resolve(response(payload("new-result")));
        await flush();
        api.calls[0].resolve(response(payload("old-result")));
        await flush();
        expect(api.container.textContent.includes("requested-new-result"), "new response not rendered");
        expect(!api.container.textContent.includes("requested-old-result"), "stale response overwrote new result");
      } finally {
        api.remove();
      }
    });

    await runCase("已加载数据的错误可见，重试后恢复", async () => {
      const api = view();
      try {
        api.instance.ensure();
        await callsAt(api, 1, "initial load");
        api.calls[0].resolve(response(payload("kept-data")));
        await flush();
        api.container.querySelector(".mr-refresh-btn").click();
        await callsAt(api, 2, "refresh error");
        api.calls[1].reject(new Error("synthetic network failure"));
        await flush();
        expect(api.container.querySelector(".mr-error"), "loaded-data error banner is missing");
        expect(api.container.textContent.includes("synthetic network failure"), "error text is missing");
        expect(api.container.textContent.includes("requested-kept-data"), "last successful data was not retained");
        const retry = api.container.querySelector(".mr-retry-btn");
        expect(retry, "retry button is missing");
        retry.click();
        await callsAt(api, 3, "retry");
        api.calls[2].resolve(response(payload("recovered-data")));
        await flush();
        expect(!api.container.querySelector(".mr-error"), "error banner remains after retry success");
        expect(api.container.textContent.includes("requested-recovered-data"), "retry result not rendered");
      } finally {
        api.remove();
      }
    });

    await runCase("同筛选 ensure 会重新读取新增数据", async () => {
      const api = view({ model: "same-model", provider: "same-provider" });
      try {
        api.instance.ensure();
        await callsAt(api, 1, "first ensure");
        api.calls[0].resolve(response(payload("before-new-data")));
        await flush();
        api.instance.ensure();
        await callsAt(api, 2, "same-key ensure refresh");
        expect(query(api, 1).get("model") === "same-model", "same-key refresh lost model filter");
        expect(query(api, 1).get("provider") === "same-provider", "same-key refresh lost provider filter");
        api.calls[1].resolve(response(payload("after-new-data")));
        await flush();
        expect(api.container.textContent.includes("requested-after-new-data"), "same-key ensure did not render new data");
      } finally {
        api.remove();
      }
    });

    await runCase("全面扫描不会被普通在途请求吞掉，旧弱结果不能覆盖强结果", async () => {
      const api = view();
      try {
        api.instance.ensure();
        await callsAt(api, 1, "initial load");
        api.calls[0].resolve(response(payload("initial")));
        await flush();
        api.instance.refresh();
        await callsAt(api, 2, "weak refresh");
        api.container.querySelector(".mr-refresh-btn").click();
        await callsAt(api, 3, "force refresh");
        expect(query(api, 1).get("force") === null, "weak refresh must not force scan");
        expect(query(api, 2).get("force") === "true", "history scan must include force=true");
        api.calls[2].resolve(response(payload("forced-result")));
        await flush();
        api.calls[1].resolve(response(payload("weak-result")));
        await flush();
        expect(api.container.textContent.includes("requested-forced-result"), "forced result not rendered");
        expect(!api.container.textContent.includes("requested-weak-result"), "weak result overwrote forced result");
      } finally {
        api.remove();
      }
    });

    return results;
  })()`);
}
