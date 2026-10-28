import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createModelRouting } from "../ui/modules/model-routing.js";

class FakeControl {
  constructor(attrs = {}) {
    this.attrs = attrs;
    this.onclick = null;
    this.disabled = false;
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
}

class FakeContainer {
  constructor() {
    this._html = "";
    this.refreshButton = new FakeControl();
    this.retryButton = new FakeControl();
    this.previousButton = new FakeControl();
    this.nextButton = new FakeControl();
    this.statusButtons = [];
    this.renderCount = 0;
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(value) {
    this._html = String(value);
    this.renderCount += 1;
  }

  querySelector(selector) {
    if (selector === ".mr-refresh-btn") return this.refreshButton;
    if (selector === ".mr-retry-btn") return this.retryButton;
    if (selector === ".mr-prev-btn") {
      this.previousButton.disabled = /class="btn btn-sm mr-prev-btn" disabled/.test(this._html);
      return this.previousButton;
    }
    if (selector === ".mr-next-btn") {
      this.nextButton.disabled = /class="btn btn-sm mr-next-btn" disabled/.test(this._html);
      return this.nextButton;
    }
    if (selector === ".mr-clear-model") return new FakeControl();
    return null;
  }

  querySelectorAll(selector) {
    if (selector !== ".mr-status-btn") return [];
    this.statusButtons = ["all", "routed", "normal"].map((status) => new FakeControl({ "data-status": status }));
    return this.statusButtons;
  }
}

function response(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  };
}

function payload(label, { total = 1, routed = true, provider = "provider-a" } = {}) {
  const requestedModel = `requested-${label}`;
  const responseModel = routed ? `served-${label}` : requestedModel;
  return {
    ok: true,
    summary: {
      totalCalls: total,
      normalCount: total - (routed ? 1 : 0),
      routedCount: routed ? 1 : 0,
      totalRouted: routed ? 1 : 0,
      routeRate: total > 0 ? Number(((routed ? 1 : 0) / total * 100).toFixed(1)) : 0,
      totalTokens: 100,
      routedTokens: routed ? 100 : 0,
      topPairs: routed ? [{ provider, requestedModel, responseModel, count: 1, tokens: 100 }] : [],
    },
    routes: [{
      id: `route-${label}`,
      at: "2026-10-28T10:00:00.000Z",
      agent: "agent-a",
      provider,
      requestedModel,
      responseModel,
      isRouted: routed,
      tokens: { input: 10, output: 20, cacheRead: 70, total: 100 },
      sessionId: "synthetic-session",
    }],
    total,
  };
}

function pendingFetcher() {
  const calls = [];
  return {
    calls,
    fetchFn(url) {
      return new Promise((resolve, reject) => calls.push({ url, resolve, reject }));
    },
  };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function queryOf(url) {
  return new URL(url, "http://model-routing.test").searchParams;
}

function click(control) {
  assert.equal(typeof control.onclick, "function");
  if (!control.disabled) control.onclick();
}

test("latest request wins when an older success resolves after the new filter", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  let filters = { model: "old-filter" };
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => filters });

  instance.ensure();
  filters = { model: "new-filter" };
  instance.reloadWithFilters();
  assert.equal(pending.calls.length, 2);

  pending.calls[1].resolve(response(payload("new")));
  await flush();
  pending.calls[0].resolve(response(payload("old")));
  await flush();

  assert.match(container.innerHTML, /requested-new/);
  assert.doesNotMatch(container.innerHTML, /requested-old/);
});

test("stale failure and finally cannot hide the latest request loading state", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  let filters = { model: "old-filter" };
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => filters });

  instance.ensure();
  filters = { model: "new-filter" };
  instance.reloadWithFilters();
  assert.equal(pending.calls.length, 2);

  pending.calls[0].reject(new Error("stale failure"));
  await flush();
  assert.match(container.innerHTML, /正在加载路由数据/);
  assert.doesNotMatch(container.innerHTML, /stale failure/);

  pending.calls[1].resolve(response(payload("new")));
  await flush();
  assert.match(container.innerHTML, /requested-new/);
});

test("ensure reloads when returning with a newer filter and deduplicates identical in-flight intent", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  let filters = { model: "first" };
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => filters });

  instance.ensure();
  instance.ensure();
  assert.equal(pending.calls.length, 1);
  pending.calls[0].resolve(response(payload("first")));
  await flush();

  instance.ensure();
  assert.equal(pending.calls.length, 2, "同 key 再次进入页签也要取最新数据");
  pending.calls[1].resolve(response(payload("latest")));
  await flush();
  instance.reloadWithFilters();
  assert.equal(pending.calls.length, 2, "普通 render 重放不应额外请求");

  filters = { model: "second" };
  instance.ensure();
  instance.ensure();
  assert.equal(pending.calls.length, 3, "新筛选只允许一个在途请求");
  assert.equal(queryOf(pending.calls[2].url).get("offset"), "0");
});

test("page intent supersedes a pending refresh under the same filters", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => ({}) });

  instance.ensure();
  pending.calls[0].resolve(response(payload("page-one", { total: 51 })));
  await flush();

  instance.refresh();
  click(container.nextButton);
  assert.equal(pending.calls.length, 3, "翻页必须新建当前页请求，而不是复用刷新请求");
  assert.equal(queryOf(pending.calls[1].url).get("offset"), "0");
  assert.equal(queryOf(pending.calls[2].url).get("offset"), "50");

  pending.calls[2].resolve(response(payload("page-two", { total: 51 })));
  await flush();
  pending.calls[1].resolve(response(payload("page-one-refresh", { total: 51 })));
  await flush();
  assert.match(container.innerHTML, /requested-page-two/);
  assert.doesNotMatch(container.innerHTML, /requested-page-one-refresh/);
});

test("provider participates in URL, badge, filter identity, and page reset", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  let filters = { provider: "provider-a" };
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => filters });

  instance.ensure();
  assert.equal(queryOf(pending.calls[0].url).get("provider"), "provider-a");
  pending.calls[0].resolve(response(payload("provider-a", { provider: "provider-a", total: 51 })));
  await flush();
  click(container.nextButton);
  assert.equal(pending.calls.length, 2);
  pending.calls[1].resolve(response(payload("provider-a-page-2", { provider: "provider-a", total: 51 })));
  await flush();

  filters = { provider: "provider-b" };
  instance.ensure();
  assert.equal(pending.calls.length, 3);
  assert.equal(queryOf(pending.calls[2].url).get("provider"), "provider-b");
  assert.equal(queryOf(pending.calls[2].url).get("offset"), "0", "全局筛选变化必须回到第一页");
  pending.calls[2].resolve(response(payload("provider-b", { provider: "provider-b" })));
  await flush();
  assert.match(container.innerHTML, /供应商: provider-b/);
});

test("status changes reset the page and disabled paging controls do not request", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => ({}) });

  instance.ensure();
  pending.calls[0].resolve(response(payload("page-1", { total: 51 })));
  await flush();
  click(container.nextButton);
  assert.equal(pending.calls.length, 2);
  pending.calls[1].resolve(response(payload("page-2", { total: 51 })));
  await flush();

  const routedButton = container.statusButtons.find((button) => button.getAttribute("data-status") === "routed");
  click(routedButton);
  assert.equal(pending.calls.length, 3);
  assert.equal(queryOf(pending.calls[2].url).get("status"), "routed");
  assert.equal(queryOf(pending.calls[2].url).get("offset"), "0");
  pending.calls[2].resolve(response(payload("routed-first-page", { total: 1 })));
  await flush();

  assert.equal(container.nextButton.disabled, true);
  assert.equal(container.previousButton.disabled, true);
  click(container.nextButton);
  click(container.previousButton);
  assert.equal(pending.calls.length, 3);
});

test("refresh keeps the current page, then performs one correction request when total shrinks", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => ({}) });

  instance.ensure();
  pending.calls[0].resolve(response(payload("page-1", { total: 51 })));
  await flush();
  click(container.nextButton);
  assert.equal(pending.calls.length, 2);
  pending.calls[1].resolve(response(payload("page-2", { total: 51 })));
  await flush();

  instance.refresh();
  assert.equal(queryOf(pending.calls[2].url).get("offset"), "50", "刷新应先取当前页");
  pending.calls[2].resolve(response(payload("shrunk", { total: 1 })));
  await flush();

  assert.equal(pending.calls.length, 4, "总量缩小只补查一次第一页");
  assert.equal(queryOf(pending.calls[3].url).get("offset"), "0");
  pending.calls[3].resolve(response(payload("corrected", { total: 1 })));
  await flush();
  assert.match(container.innerHTML, /第 1 \/ 1 页/);
  assert.equal(pending.calls.length, 4);
});

test("normal refresh does not force a scan; explicit history scan does", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => ({}) });

  instance.ensure();
  assert.equal(queryOf(pending.calls[0].url).get("force"), null);
  pending.calls[0].resolve(response(payload("initial")));
  await flush();

  instance.refresh();
  assert.equal(queryOf(pending.calls[1].url).get("force"), null);
  assert.match(container.innerHTML, /正在加载/);
  assert.doesNotMatch(container.innerHTML, /正在重新扫描/);
  pending.calls[1].resolve(response(payload("normal-refresh")));
  await flush();

  click(container.refreshButton);
  assert.equal(queryOf(pending.calls[2].url).get("force"), "true");
});

test("strong history scan supersedes a weak in-flight request and weak refresh reuses strong", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => ({}) });

  instance.ensure();
  pending.calls[0].resolve(response(payload("initial")));
  await flush();
  instance.refresh();
  click(container.refreshButton);
  assert.equal(pending.calls.length, 3, "全面扫描历史必须覆盖普通在途查询");
  assert.equal(queryOf(pending.calls[1].url).get("force"), null);
  assert.equal(queryOf(pending.calls[2].url).get("force"), "true");
  pending.calls[2].resolve(response(payload("forced")));
  await flush();
  pending.calls[1].resolve(response(payload("weak")));
  await flush();
  assert.match(container.innerHTML, /requested-forced/);
  assert.doesNotMatch(container.innerHTML, /requested-weak/);

  click(container.refreshButton);
  assert.equal(queryOf(pending.calls[3].url).get("force"), "true");
  instance.refresh();
  assert.equal(pending.calls.length, 4, "普通刷新应复用更强的在途查询");
});

test("loaded data remains visible with an explicit retry error", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => ({}) });

  instance.ensure();
  pending.calls[0].resolve(response(payload("kept-data")));
  await flush();

  instance.refresh();
  pending.calls[1].reject(new Error("network unavailable"));
  await flush();

  assert.match(container.innerHTML, /加载失败/);
  assert.match(container.innerHTML, /network unavailable/);
  assert.match(container.innerHTML, /保留上次成功数据/);
  assert.match(container.innerHTML, /requested-kept-data/);
  assert.equal(typeof container.retryButton.onclick, "function");
});

test("routing explanation distinguishes returned identifiers and fallback inference", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => ({}) });

  instance.ensure();
  pending.calls[0].resolve(response(payload("copy", { routed: false })));
  await flush();

  assert.match(container.innerHTML, /上游返回的模型标识不同/);
  assert.match(container.innerHTML, /返回标识/);
  assert.doesNotMatch(container.innerHTML, /实际承载模型/);
  assert.match(container.innerHTML, /缺少 <code>responseModel<\/code>/);
  assert.match(container.innerHTML, /回退推定/);
  assert.match(container.innerHTML, /替身切流请求/, "保留 routed 三态产品标签");
  assert.doesNotMatch(container.innerHTML, /模型偷换|偷偷替换/);
});

test("top pairs announce the displayed count instead of implying a complete ranking", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn, getFilters: () => ({}) });

  instance.ensure();
  pending.calls[0].resolve(response(payload("top", { routed: true })));
  await flush();
  assert.match(container.innerHTML, /展示前 1 种模式/);
});

test("initial load retry is an ordinary query, not a history scan", async () => {
  const container = new FakeContainer();
  const pending = pendingFetcher();
  const instance = createModelRouting({ container, fetchFn: pending.fetchFn });
  instance.ensure();
  pending.calls[0].reject(new Error("synthetic initial failure"));
  await flush();
  assert.match(container.innerHTML, /class="[^"]*mr-retry-btn/);
  click(container.retryButton);
  assert.equal(pending.calls.length, 2);
  assert.equal(queryOf(pending.calls[1].url).has("force"), false);
  pending.calls[1].resolve(response(payload("retry")));
  await flush();
  assert.doesNotMatch(container.innerHTML, /synthetic initial failure/);
});

test("dashboard refreshes routing after data load, but ordinary render stays non-refreshing", () => {
  const source = fs.readFileSync(new URL("../ui/dashboard-app.js", import.meta.url), "utf8");
  assert.match(source, /createModelRouting\(\{[\s\S]*provider: _selProvider \|\| ""/);
  assert.match(source, /if \(_activeView === "model-routing" && _modelRouting\) \{\s*_modelRouting\.refresh\(\);\s*return;/);
  assert.match(source, /render\(\);\s*if \(_activeView === "model-routing" && _modelRouting\) \{\s*_modelRouting\.reloadWithFilters\(\{ refresh: true \}\);/);

  const renderStart = source.indexOf("function render()");
  const renderEnd = source.indexOf("let _agentAnalyticsInstance", renderStart);
  const renderSource = source.slice(renderStart, renderEnd);
  assert.match(renderSource, /_modelRouting\.reloadWithFilters\(\);/);
  assert.doesNotMatch(renderSource, /reloadWithFilters\(\{\s*refresh:\s*true/);
});
