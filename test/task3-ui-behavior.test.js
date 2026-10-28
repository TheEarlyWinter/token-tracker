import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

import { createTurnsInspector } from "../ui/modules/turns-inspector.js";
import { createDeepSeekUsage } from "../ui/modules/deepseek-usage.js";
import { createLithosSpend } from "../ui/modules/lithos-spend.js";

const dashboardSource = fs.readFileSync(new URL("../ui/dashboard-app.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到生产函数 ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 未闭合`);
}

class MiniClassList {
  constructor(value = "") {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  contains(name) { return this.classes.has(name); }
  add(name) { this.classes.add(name); }
  remove(name) { this.classes.delete(name); }
  toggle(name, force) {
    if (force === true) this.add(name);
    else if (force === false) this.remove(name);
    else if (this.contains(name)) this.remove(name);
    else this.add(name);
  }
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = re.exec(raw))) attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  return attrs;
}

function parseInto(parent, html) {
  const tokenRe = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g;
  const stack = [parent];
  const voidTags = new Set(["input", "img", "br", "hr", "meta", "link"]);
  let match;
  while ((match = tokenRe.exec(String(html)))) {
    const raw = match[0];
    const tag = match[1];
    if (raw.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = new MiniElement(tag);
    const attrs = parseAttrs(match[2] || "");
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    stack.at(-1).appendChild(node);
    if (!voidTags.has(tag.toLowerCase()) && !raw.endsWith("/>") && !attrs.disabled) stack.push(node);
  }
}

class MiniElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this._className = "";
    this.classList = new MiniClassList();
    this._innerHTML = "";
    this._ownTextContent = "";
    this.value = "";
    this.disabled = false;
    this.onclick = null;
    this.onchange = null;
    this.listeners = new Map();
  }

  set className(value) {
    this._className = String(value || "");
    this.classList = new MiniClassList(this._className);
  }
  get className() { return this._className; }

  set innerHTML(value) {
    this._innerHTML = String(value ?? "");
    this.children = [];
    this._ownTextContent = this._innerHTML.replace(/<[^>]+>/g, " ");
    parseInto(this, this._innerHTML);
  }
  get innerHTML() { return this._innerHTML; }
  set textContent(value) { this._ownTextContent = String(value ?? ""); }
  get textContent() {
    if (this._innerHTML) return this._ownTextContent;
    return this._ownTextContent + this.children.map((child) => child.textContent).join("");
  }

  appendChild(child) {
    if (!child) return child;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }
  setAttribute(key, value) {
    const text = String(value ?? "");
    this.attributes[key] = text;
    if (key === "class") this.className = text;
    else if (key === "id") this.id = text;
    else if (key === "value") this.value = text;
    else if (key === "disabled") this.disabled = true;
    else if (key.startsWith("data-")) this.dataset[key.slice(5)] = text;
    else this[key] = text;
  }
  getAttribute(key) {
    if (key === "class") return this.className;
    if (key === "id") return this.id || null;
    if (key.startsWith("data-")) return this.dataset[key.slice(5)] ?? null;
    return this.attributes[key] ?? null;
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  dispatchEvent(event) {
    for (const handler of this.listeners.get(event.type) || []) handler(event);
  }
  click() {
    if (typeof this.onclick === "function") this.onclick({ target: this, currentTarget: this });
    this.dispatchEvent({ type: "click", target: this, currentTarget: this });
  }
  select() {}

  querySelectorAll(selector) {
    const result = [];
    const matches = (node) => {
      if (selector.startsWith("#")) return node.id === selector.slice(1);
      if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
      if (selector.startsWith("[data-") && selector.endsWith("]")) {
        return Object.prototype.hasOwnProperty.call(node.dataset, selector.slice(6, -1));
      }
      const classMatch = selector.match(/^([\w-]+)\.([\w-]+)$/);
      if (classMatch) return node.tagName.toLowerCase() === classMatch[1].toLowerCase() && node.classList.contains(classMatch[2]);
      return node.tagName.toLowerCase() === selector.toLowerCase();
    };
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child)) result.push(child);
        walk(child);
      }
    };
    walk(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function withDom(fn) {
  const original = globalThis.document;
  globalThis.document = {
    body: new MiniElement("body"),
    createElement: (tag) => new MiniElement(tag),
  };
  return Promise.resolve().then(fn).finally(() => {
    globalThis.document = original;
  });
}

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => String(body ?? "") };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function expectedRange(key, now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  if (key === "last") {
    return { from: dateKey(new Date(year, month - 1, 1)), to: dateKey(new Date(year, month, 0)) };
  }
  if (key === "q3") {
    return { from: dateKey(new Date(year, month - 2, 1)), to: dateKey(now) };
  }
  return { from: dateKey(new Date(year, month, 1)), to: dateKey(now) };
}

function dataFor(model, day, cost = 1) {
  return {
    connected: true,
    start: day,
    end: day,
    days: [{ day, cost, usd: cost, byModel: { [model]: { cost, tokens: 100, hitTokens: 50, missTokens: 25, outputTokens: 25, requests: 1 } } }],
    models: [{ model, cost, usd: cost, hitTokens: 50, missTokens: 25, outputTokens: 25, tokens: 100, requests: 1, days: 1, share: 1, hitRate: 2 / 3 }],
    balance: { connected: true, balanceDisplay: "¥1.00", tokenEstimation: 100 },
  };
}

function lithosData(model, day, usd = 1) {
  return {
    connected: true,
    start: day,
    end: day,
    totalUsd: usd,
    days: [{ day, usd, byModel: { [model]: usd } }],
    models: [{ modelId: model, usd, inputTokens: 100, cachedTokens: 50, outputTokens: 25, days: 1, share: 1 }],
    updatedAt: "2026-10-27T00:00:00Z",
  };
}

function runDashboardFunction(name, extra, expression) {
  const ctx = vm.createContext({ console, ...extra });
  vm.runInContext(`${extractFunction(dashboardSource, name)};${expression}`, ctx);
  return ctx;
}

test("昨天快捷范围会把两个日期输入都设为实际昨天", () => {
  const elements = { df: { value: "2026-10-27" }, dt: { value: "2026-10-27" } };
  class FixedDate extends Date {
    constructor(...args) { super(args.length ? args[0] : "2026-10-27T12:00:00+08:00"); }
  }
  runDashboardFunction(
    "syncDateInputs",
    {
      Date: FixedDate,
      R: "yesterday",
      D: null,
      $: (id) => elements[id],
      cnToday: () => "2026-10-27",
    },
    "syncDateInputs();",
  );
  assert.equal(elements.df.value, "2026-10-26");
  assert.equal(elements.dt.value, "2026-10-26");
});

test("新扫描代次刷新 turns 但不重置当前页，筛选变化才重置页", () => {
  const elements = {
    "turns-inspector-section": {},
    df: { value: "2026-10-27" },
    dt: { value: "2026-10-27" },
  };
  const reloads = [];
  let creates = 0;
  const ctx = runDashboardFunction(
    "renderTurnsInspectorSection",
    {
      D: { lastScan: "scan-1" },
      R: "today",
      _selAgent: "",
      _selProvider: "",
      _selModel: "",
      _selType: "",
      _turnsInspectorInstance: null,
      _lastTurnsFilterKey: null,
      $: (id) => elements[id],
      trackerFetch: () => {},
      getAppApiBase: () => "/api",
      createTurnsInspector: () => {
        creates += 1;
        return { reload: (resetPage) => reloads.push(resetPage) };
      },
    },
    "renderTurnsInspectorSection();",
  );
  assert.equal(creates, 1);
  ctx.D.lastScan = "scan-2";
  vm.runInContext("renderTurnsInspectorSection();", ctx);
  assert.deepEqual(reloads, [false]);
  ctx._selModel = "new-model";
  vm.runInContext("renderTurnsInspectorSection();", ctx);
  assert.deepEqual(reloads, [false, true]);
});

test("turns 丢弃过期列表响应、详情响应，并且关闭详情后旧响应不能重开", async () => withDom(async () => {
  const container = new MiniElement("div");
  const listRequests = [];
  let filter = "old";
  const rows = (name) => [
    { requestId: "r1", at: "2026-10-27T01:00:00Z", agent: "a", model: name, input: 1, output: 2, total: 3 },
    { requestId: "r2", at: "2026-10-27T02:00:00Z", agent: "a", model: `${name}-two`, input: 1, output: 2, total: 3 },
  ];
  const detailRequests = [];
  const inspector = createTurnsInspector({
    container,
    getFilters: () => ({ model: filter }),
    fetchFn: (url) => {
      if (url.startsWith("/turns?")) {
        return new Promise((resolve) => listRequests.push({ url, resolve }));
      }
      if (url.startsWith("/turn?")) {
        return new Promise((resolve) => detailRequests.push({ url, resolve }));
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(listRequests.length, 1);
  listRequests[0].resolve(response({ rows: rows("initial"), total: 2, sumTokens: 6, totalPages: 1 }));
  await flush();

  filter = "stale";
  inspector.reload(true);
  filter = "latest";
  inspector.reload(true);
  await flush();
  assert.equal(listRequests.length, 3);

  listRequests[1].resolve(response({ rows: rows("STALE-LIST"), total: 2, sumTokens: 6, totalPages: 1 }));
  await flush();
  assert.doesNotMatch(container.textContent, /STALE-LIST/);

  listRequests[2].resolve(response({ rows: rows("LATEST-LIST"), total: 2, sumTokens: 6, totalPages: 1 }));
  await flush();
  assert.match(container.textContent, /LATEST-LIST/);

  let row = container.querySelectorAll("tr.turns-row")[0];
  row.click();
  await flush();
  assert.equal(detailRequests.length, 1);
  row = container.querySelectorAll("tr.turns-row")[1];
  row.click();
  await flush();
  assert.equal(detailRequests.length, 2);

  detailRequests[0].resolve(response({ requestId: "r1", callCount: 1, calls: [{ requestId: "r1", model: "STALE-DETAIL", input: 1, output: 1 }], totals: { totalTokens: 2 } }));
  await flush();
  assert.doesNotMatch(container.textContent, /STALE-DETAIL/);

  detailRequests[1].resolve(response({ requestId: "r2", callCount: 1, calls: [{ requestId: "r2", model: "LATEST-DETAIL", input: 1, output: 1 }], totals: { totalTokens: 2 } }));
  await flush();
  assert.match(container.textContent, /LATEST-DETAIL/);

  row = container.querySelectorAll("tr.turns-row")[0];
  row.click();
  await flush();
  assert.equal(detailRequests.length, 3);
  row = container.querySelectorAll("tr.turns-row")[0];
  row.click();
  assert.equal(container.querySelector(".turns-detail"), null);
  detailRequests[2].resolve(response({ requestId: "r1", callCount: 1, calls: [{ requestId: "r1", model: "CLOSED-DETAIL", input: 1, output: 1 }], totals: { totalTokens: 2 } }));
  await flush();
  assert.equal(container.querySelector(".turns-detail"), null);
  assert.doesNotMatch(container.textContent, /CLOSED-DETAIL/);

  filter = "failed";
  inspector.reload(true);
  await flush();
  listRequests[3].resolve(response({ message: "最新筛选读取失败" }, { ok: false, status: 503 }));
  await flush();
  assert.match(container.textContent, /最新筛选读取失败/);
  assert.doesNotMatch(container.textContent, /LATEST-LIST/);
}));

test("DeepSeek 月份 chip 生成自然月区间，回调模式把区间交给全局日期状态", async () => withDom(async () => {
  const container = new MiniElement("div");
  const urls = [];
  const instance = createDeepSeekUsage({
    container,
    fetchFn: async (url) => {
      urls.push(url);
      return response({ connected: true, days: [], models: [], range: "month" });
    },
    getFilters: () => ({ from: "2026-10-27", to: "2026-10-27" }),
  });
  instance.ensure();
  await flush();

  for (const key of ["month", "last", "q3"]) {
    container.querySelector("[data-range]");
    const chip = container.querySelectorAll("[data-range]").find((node) => node.dataset.range === key);
    assert.ok(chip, `找不到 ${key} chip`);
    chip.click();
    await flush();
    const parsed = new URL(urls.at(-1), "https://test.local");
    const expected = expectedRange(key);
    assert.equal(parsed.searchParams.get("start"), expected.from);
    assert.equal(parsed.searchParams.get("end"), expected.to);
    assert.equal(parsed.searchParams.get("range"), null);
  }

  let selected = null;
  let callbackCalls = 0;
  const callbackContainer = new MiniElement("div");
  const callbackInstance = createDeepSeekUsage({
    container: callbackContainer,
    fetchFn: async () => response({ connected: true, days: [], models: [] }),
    getFilters: () => ({}),
    onSelectRange: (range) => { callbackCalls += 1; selected = range; },
  });
  callbackInstance.ensure();
  await flush();
  callbackContainer.querySelectorAll("[data-range]").find((node) => node.dataset.range === "last").click();
  await flush();
  assert.equal(callbackCalls, 1);
  assert.deepEqual(selected, { key: "last", ...expectedRange("last") });
}));

test("DeepSeek loading 中日期变化只合并成一次最新请求，最新错误明确覆盖旧数据", async () => withDom(async () => {
  const container = new MiniElement("div");
  const pending = [];
  const oldDay = "2026-10-01";
  let filters = { from: "2026-10-01", to: "2026-10-10" };
  const instance = createDeepSeekUsage({
    container,
    fetchFn: (url) => new Promise((resolve) => pending.push({ url, resolve })),
    getFilters: () => filters,
  });
  instance.ensure();
  await flush();
  assert.equal(pending.length, 1);
  filters = { from: "2026-10-20", to: "2026-10-27" };
  instance.reloadWithFilters();
  await flush();
  pending[0].resolve(response(dataFor("OLD-MODEL", oldDay, 5)));
  await flush();
  assert.equal(pending.length, 2, "日期变化必须排队一次最新重载");
  const latest = new URL(pending[1].url, "https://test.local");
  assert.equal(latest.searchParams.get("start"), "2026-10-20");
  assert.equal(latest.searchParams.get("end"), "2026-10-27");
  pending[1].resolve(response({ message: "最新 DeepSeek 区间失败" }, { ok: false, status: 502 }));
  await flush();
  assert.match(container.textContent, /最新 DeepSeek 区间失败/);
  assert.doesNotMatch(container.textContent, /OLD-MODEL/);
}));

test("Lithos loading 中日期变化只合并成一次最新请求，最新错误明确展示", async () => withDom(async () => {
  const container = new MiniElement("div");
  const pending = [];
  let filters = { from: "2026-10-01", to: "2026-10-10" };
  const instance = createLithosSpend({
    container,
    fetchFn: (url) => new Promise((resolve) => pending.push({ url, resolve })),
    getFilters: () => filters,
  });
  instance.ensure();
  await flush();
  assert.equal(pending.length, 2, "初次加载应同时取消费和余额");
  filters = { from: "2026-10-20", to: "2026-10-27" };
  instance.reloadWithFilters();
  pending[0].resolve(response(lithosData("OLD-LITHOS", "2026-10-01", 5)));
  pending[1].resolve(response({ connected: true, display: "$9.00" }));
  await flush();
  assert.equal(pending.length, 4, "日期变化必须合并成一次新的消费/余额请求");
  const latestSpend = new URL(pending[2].url, "https://test.local");
  assert.equal(latestSpend.searchParams.get("start"), "2026-10-20");
  assert.equal(latestSpend.searchParams.get("end"), "2026-10-27");
  pending[2].resolve(response({ message: "最新 Lithos 区间失败" }, { ok: false, status: 502 }));
  pending[3].resolve(response({ connected: true, display: "$9.00" }));
  await flush();
  assert.match(container.textContent, /最新 Lithos 区间失败/);
  assert.doesNotMatch(container.textContent, /OLD-LITHOS/);
}));

test("两账单的今日卡按真实今日取数，不把最后有记录日冒充今日", async () => withDom(async () => {
  const now = new Date();
  const today = dateKey(now);
  const oldDay = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2));

  const dsContainer = new MiniElement("div");
  const ds = createDeepSeekUsage({
    container: dsContainer,
    fetchFn: async () => response(dataFor("DS-OLD-DAY", oldDay, 5)),
    getFilters: () => ({}),
  });
  ds.ensure();
  await flush();
  assert.match(dsContainer.innerHTML, /今日<\/div><div class="ls-v">¥0\.00/);
  const todayLabel = `${now.getMonth() + 1}月${now.getDate()}日`;
  assert.match(dsContainer.innerHTML, new RegExp(`>${todayLabel}<\\/div>`));

  const lithosContainer = new MiniElement("div");
  const lithos = createLithosSpend({
    container: lithosContainer,
    fetchFn: async (url) => url.startsWith("/lithos-spend")
      ? response(lithosData("LITHOS-OLD-DAY", oldDay, 5))
      : response({ connected: true, display: "$9.00" }),
    getFilters: () => ({}),
  });
  lithos.ensure();
  await flush();
  assert.match(lithosContainer.innerHTML, /今日（UTC）<\/div><div class="ls-v">\$0\.00/);
  const utcDate = new Date(Date.now());
  const utcTodayLabel = `${utcDate.getUTCMonth() + 1}月${utcDate.getUTCDate()}日`;
  assert.match(lithosContainer.innerHTML, new RegExp(`>${utcTodayLabel}<\\/div>`));
}));

test("dashboard 的 DeepSeek chip 回调同步全局日期、清空快捷范围并触发主看板加载", () => {
  const elements = {
    "usage-view": { style: {} },
    "turns-view": { style: {} },
    "lithos-spend-section": { style: {} },
    "ds-usage-section": { style: {} },
    sa: { classList: { toggle() {} } },
    stype: { classList: { toggle() {} } },
    df: { value: "2026-10-27" },
    dt: { value: "2026-10-27" },
  };
  const tabs = [];
  let options = null;
  let loadCalls = 0;
  const ctx = runDashboardFunction(
    "setView",
    {
      window: {},
      document: { querySelectorAll: () => tabs },
      localStorage: { setItem() {} },
      $: (id) => elements[id],
      _activeView: "usage",
      _lithosSpend: null,
      _dsUsage: null,
      _selModel: "",
      _selAgent: "",
      _selProvider: "",
      _selType: "",
      trackerFetch: () => {},
      chartColors: () => ({}),
      getAppApiBase: () => "/api",
      createDeepSeekUsage: (opts) => {
        options = opts;
        return { ensure() {} };
      },
      createLithosSpend: () => ({ ensure() {} }),
      load: () => { loadCalls += 1; },
      updateFilterOpts: () => {},
    },
    "setView('ds-usage');",
  );
  assert.equal(typeof options.onSelectRange, "function");
  options.onSelectRange({ key: "last", from: "2026-09-01", to: "2026-09-30" });
  assert.equal(elements.df.value, "2026-09-01");
  assert.equal(elements.dt.value, "2026-09-30");
  assert.equal(ctx.R, "");
  assert.equal(loadCalls, 1);
});

test("turns 列表重载失败时不保留旧详情", async () => withDom(async () => {
  const container = new MiniElement("div");
  let listCalls = 0;
  let resolveDetail;
  let resolveReload;
  const inspector = createTurnsInspector({
    container,
    fetchFn: (url) => {
      if (url.startsWith("/turns?")) {
        listCalls += 1;
        if (listCalls === 1) return Promise.resolve(response({ rows: [{ requestId: "r1", at: "2026-10-27T01:00:00Z", model: "old", total: 1 }], total: 1, sumTokens: 1, totalPages: 1 }));
        return new Promise((resolve) => { resolveReload = resolve; });
      }
      if (url.startsWith("/turn?")) {
        return new Promise((resolve) => { resolveDetail = resolve; });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await flush();
  container.querySelector("tr.turns-row").click();
  await flush();
  resolveDetail(response({ requestId: "r1", callCount: 1, calls: [{ requestId: "r1", model: "OLD-DETAIL", input: 1, output: 1 }], totals: { totalTokens: 2 } }));
  await flush();
  assert.match(container.textContent, /OLD-DETAIL/);

  inspector.reload(false);
  await flush();
  assert.equal(container.querySelector(".turns-detail"), null);
  resolveReload(response({ message: "列表刷新失败" }, { ok: false, status: 503 }));
  await flush();
  assert.match(container.textContent, /列表刷新失败/);
}));
