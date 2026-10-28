import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { renderCodexQuotaCard } from "../ui/modules/codex-card.js";
import { showResetCreditsModal } from "../ui/modules/reset-credits-modal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = Object.create(null);
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.listeners = new Map();
    this.onclick = null;
    this.style = {};
    this._innerHTML = "";
    this._textContent = "";
    this.className = "";
    this.id = "";
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes[name] = text;
    if (name === "id") this.id = text;
    if (name === "class") this.className = text;
  }

  getAttribute(name) {
    if (Object.prototype.hasOwnProperty.call(this.attributes, name)) {
      return this.attributes[name];
    }
    return null;
  }

  appendChild(child) {
    if (child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === "function") {
      child.parentNode.removeChild(child);
    } else if (child.parentNode === this) {
      this.removeChild(child);
    }
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    child.parentNode = null;
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === "function") {
      child.parentNode.removeChild(child);
    } else if (child.parentNode === this) {
      this.removeChild(child);
    }
    const index = this.children.indexOf(reference);
    child.parentElement = this;
    child.parentNode = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(type, handlers.filter((item) => item !== handler));
  }

  dispatchEvent(event = {}) {
    const nextEvent = {
      ...event,
      type: event.type || "click",
      target: event.target || this,
      currentTarget: this,
    };
    const results = [];
    if (typeof this.onclick === "function") results.push(this.onclick(nextEvent));
    for (const handler of this.listeners.get(nextEvent.type) || []) {
      results.push(handler(nextEvent));
    }
    if (results.length === 0) return undefined;
    if (results.length === 1) return results[0];
    return Promise.all(results);
  }

  click() {
    return this.dispatchEvent({ type: "click" });
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  set innerHTML(value) {
    for (const child of this.children) {
      child.parentElement = null;
      child.parentNode = null;
    }
    this._innerHTML = String(value);
    this._textContent = "";
    this.children = [];
    parseMarkupInto(this, this._innerHTML);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    for (const child of this.children) {
      child.parentElement = null;
      child.parentNode = null;
    }
    this.children = [];
  }

  get textContent() {
    return this._textContent;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function matchesSelector(element, selector) {
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  const dataAct = selector.match(/^\[data-act=['"]([^'"]+)['"]\]$/);
  if (dataAct) return element.getAttribute("data-act") === dataAct[1];
  return false;
}

function parseMarkupInto(parent, html) {
  const tokens = /<!--[^]*?-->|<\/?[a-zA-Z][^>]*>/g;
  const stack = [parent];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const match of html.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const tagMatch = token.match(/^<([a-zA-Z][^\s/>]*)/);
    if (!tagMatch) continue;
    const element = new FakeElement(tagMatch[1]);
    const attrText = token.slice(tagMatch[0].length, token.length - 1);
    const attrs = /([:\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
    for (const attr of attrText.matchAll(attrs)) {
      let value = attr[2] || "";
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      element.setAttribute(attr[1], value);
    }
    stack.at(-1).appendChild(element);
    const selfClosing = /\/\s*>$/.test(token) || voidTags.has(element.tagName.toLowerCase());
    if (!selfClosing) stack.push(element);
  }
}

function makeResponse(data, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => data };
}

// 大弹窗直接使用真实模块，只替换浏览器的 createElement，不引入 DOM 运行时依赖。
globalThis.document = {
  body: new FakeElement("body"),
  createElement: (tagName) => new FakeElement(tagName),
};

function findAction(root, action, creditId) {
  return root.querySelectorAll(`[data-act='${action}']`).find((button) => button.getAttribute("data-credit-id") === creditId) || null;
}

function availableCredits() {
  return [
    { id: "credit-a", title: "卡 A", status: "available" },
    { id: "credit-b", title: "卡 B", status: "available" },
  ];
}

function withLongTimersCaptured(callback) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (handler, delay, ...args) => {
    if (delay >= 800) return { unref() {} };
    return originalSetTimeout(handler, delay, ...args);
  };
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      globalThis.setTimeout = originalSetTimeout;
    });
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openSmallModal({ onConsumeResetCredit, onOpenResetModal } = {}) {
  const container = new FakeElement("div");
  let fetchCount = 0;
  renderCodexQuotaCard(container, {
    connected: true,
    planLabel: "Plus",
    resetCredits: 2,
  }, {
    onFetchResetCredits: async () => {
      fetchCount++;
      return { connected: true, credits: availableCredits() };
    },
    onConsumeResetCredit,
    onOpenResetModal,
  });
  const toggle = container.querySelector("#sb-codex-credit-toggle");
  assert.ok(toggle);
  await toggle.click();
  assert.equal(fetchCount, 1);
  return {
    container,
    modal: container.querySelector("#sb-codex-reset-modal"),
    content: container.querySelector("#sb-codex-reset-content"),
  };
}

test("小卡等待 ACK 期间重绘仍复用同一个弹窗节点", async () => {
  const container = new FakeElement("div");
  const openGate = deferred();
  let fetchCount = 0;
  const handlers = {
    onOpenResetModal: () => openGate.promise,
    onFetchResetCredits: async () => {
      fetchCount++;
      return { connected: true, credits: availableCredits() };
    },
  };

  renderCodexQuotaCard(container, { connected: true, planLabel: "Plus", resetCredits: 2 }, handlers);
  const firstModal = container.querySelector("#sb-codex-reset-modal");
  const opening = container.querySelector("#sb-codex-credit-toggle").click();
  await flush();

  renderCodexQuotaCard(container, { connected: true, planLabel: "Plus", resetCredits: 2 }, handlers);
  const currentModal = container.querySelector("#sb-codex-reset-modal");
  openGate.resolve(false);
  await opening;

  assert.strictEqual(currentModal, firstModal, "重绘不得替换弹窗节点");
  assert.equal(currentModal.parentNode, container);
  assert.equal(currentModal.style.display, "flex", "首次点击应直接打开当前弹窗");
  assert.equal(fetchCount, 1, "首次点击只加载一次列表");
});

test("列表请求进行中重绘仍保持已打开弹窗并填充当前节点", async () => {
  const container = new FakeElement("div");
  const listGate = deferred();
  let fetchCount = 0;
  const handlers = {
    onOpenResetModal: async () => false,
    onFetchResetCredits: () => {
      fetchCount++;
      return listGate.promise;
    },
  };

  renderCodexQuotaCard(container, { connected: true, planLabel: "Plus", resetCredits: 2 }, handlers);
  const opening = container.querySelector("#sb-codex-credit-toggle").click();
  await flush();
  const modal = container.querySelector("#sb-codex-reset-modal");
  assert.equal(modal.style.display, "flex");

  renderCodexQuotaCard(container, { connected: true, planLabel: "Plus", resetCredits: 2 }, handlers);
  assert.strictEqual(container.querySelector("#sb-codex-reset-modal"), modal);
  assert.equal(modal.style.display, "flex");

  listGate.resolve({ connected: true, credits: availableCredits() });
  await opening;
  assert.equal(fetchCount, 1);
  assert.ok(modal.querySelector("[data-act='prepare']"), "迟到列表响应应填入仍在 DOM 中的弹窗");
});

test("重复重绘只保留一个弹窗且不累积遮罩关闭监听", () => {
  const container = new FakeElement("div");
  const handlers = { onOpenResetModal: async () => false };
  renderCodexQuotaCard(container, { connected: true, planLabel: "Plus", resetCredits: 2 }, handlers);
  const modal = container.querySelector("#sb-codex-reset-modal");
  renderCodexQuotaCard(container, { connected: true, planLabel: "Plus", resetCredits: 2 }, handlers);
  renderCodexQuotaCard(container, { connected: true, planLabel: "Plus", resetCredits: 2 }, handlers);

  assert.equal(container.querySelectorAll("#sb-codex-reset-modal").length, 1);
  assert.equal(modal.listeners.get("click")?.length || 0, 0, "遮罩关闭不应累积 addEventListener");
  assert.equal(typeof modal.onclick, "function");
});

test("connected 刷新保持 header 和 toggle 节点，并替换为最新 handlers", async () => {
  const container = new FakeElement("div");
  let oldOpen = 0;
  let newOpen = 0;
  let oldFetch = 0;
  let newFetch = 0;
  const oldHandlers = {
    onOpenResetModal: async () => {
      oldOpen++;
      return true;
    },
    onFetchResetCredits: async () => {
      oldFetch++;
      return { connected: true, credits: availableCredits() };
    },
  };
  const newHandlers = {
    onOpenResetModal: async () => {
      newOpen++;
      return false;
    },
    onFetchResetCredits: async () => {
      newFetch++;
      return { connected: true, credits: [] };
    },
  };

  renderCodexQuotaCard(container, {
    connected: true,
    planLabel: "Plus",
    resetCredits: 2,
    creditsBalance: "$1.00",
    primary: { remainingPercent: 80 },
  }, oldHandlers);
  const header = container.querySelector(".sb-codex-hdr");
  const toggle = container.querySelector("#sb-codex-credit-toggle");

  renderCodexQuotaCard(container, {
    connected: true,
    planLabel: "Pro",
    resetCredits: 3,
    creditsBalance: "$2.00",
    primary: { remainingPercent: 70 },
  }, newHandlers);

  assert.strictEqual(container.querySelector(".sb-codex-hdr"), header, "connected 刷新不得替换 header");
  assert.strictEqual(container.querySelector("#sb-codex-credit-toggle"), toggle, "connected 刷新不得替换 toggle");
  assert.equal(toggle.textContent, "卡 3 ▾");
  assert.equal(container.querySelector(".sb-codex-bal-badge").textContent, "$2.00");
  assert.ok(container.querySelector(".sb-codex-body").innerHTML.includes("70%"));

  await toggle.click();
  assert.equal(oldOpen, 0, "旧 handler 不得继续响应");
  assert.equal(oldFetch, 0);
  assert.equal(newOpen, 1, "新 handler 应响应一次");
  assert.equal(newFetch, 1, "一次点击只查询一次列表");
});

test("connected 刷新支持卡数与余额 0→2→0，旧节点和文本不残留", () => {
  const container = new FakeElement("div");
  const handlers = { onOpenResetModal: async () => false };

  renderCodexQuotaCard(container, {
    connected: true,
    planLabel: "Plus",
    resetCredits: 0,
    creditsBalance: null,
  }, handlers);
  assert.equal(container.querySelector("#sb-codex-credit-toggle"), null);
  assert.equal(container.querySelector(".sb-codex-bal-badge"), null);

  renderCodexQuotaCard(container, {
    connected: true,
    planLabel: "Plus",
    resetCredits: 2,
    creditsBalance: "$5.00",
  }, handlers);
  const toggle = container.querySelector("#sb-codex-credit-toggle");
  const balance = container.querySelector(".sb-codex-bal-badge");
  assert.ok(toggle);
  assert.ok(balance);
  assert.equal(toggle.textContent, "卡 2 ▾");
  assert.equal(balance.textContent, "$5.00");

  renderCodexQuotaCard(container, {
    connected: true,
    planLabel: "Plus",
    resetCredits: 0,
    creditsBalance: null,
  }, handlers);
  assert.equal(container.querySelector("#sb-codex-credit-toggle"), null, "卡数归零应移除按钮");
  assert.equal(container.querySelector(".sb-codex-bal-badge"), null, "余额清空应移除 badge");
  assert.equal(toggle.parentNode, null, "旧按钮不得残留在 DOM");
  assert.equal(balance.parentNode, null, "旧余额 badge 不得残留在 DOM");
});

class MockBroadcastChannel {
  static instances = [];
  static onPost = null;
  static failPost = false;

  constructor(name) {
    this.name = name;
    this.listeners = new Map();
    this.messages = [];
    MockBroadcastChannel.instances.push(this);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(type, handlers.filter((item) => item !== handler));
  }

  postMessage(data) {
    if (MockBroadcastChannel.failPost) throw new Error("channel closed");
    this.messages.push(data);
    if (MockBroadcastChannel.onPost) MockBroadcastChannel.onPost(this, data);
  }

  emit(data) {
    for (const handler of this.listeners.get("message") || []) handler({ data });
  }

  listenerCount(type = "message") {
    return (this.listeners.get(type) || []).length;
  }

  static reset() {
    MockBroadcastChannel.instances = [];
    MockBroadcastChannel.onPost = null;
    MockBroadcastChannel.failPost = false;
  }
}

function loadFunctionPanelHarness() {
  const sourcePath = path.join(rootDir, "ui", "function-panel.js");
  let source = fs.readFileSync(sourcePath, "utf8");
  source = source.replace(/^import[^\n]*\n/gm, "");
  source = source.replace(/^export\s+/gm, "");
  const bootstrapSentinel = 'if (typeof window !== "undefined") {';
  const bootstrapStart = source.lastIndexOf(bootstrapSentinel);
  assert.ok(bootstrapStart >= 0, "function-panel bootstrap sentinel must remain at the end");
  const bootstrapClose = source.indexOf("\n}", bootstrapStart);
  assert.ok(bootstrapClose > bootstrapStart, "function-panel bootstrap block must have a closing brace");
  source = source.slice(0, bootstrapStart) + source.slice(bootstrapClose + 2);
  source += "\nthis.__panelExports = { loadAndRender };\n";

  const elements = new Map();
  for (const id of [
    "fp-codex-section",
    "fp-deepseek-section",
    "fp-empty-notice",
    "codex-card-slot",
    "deepseek-card-slot",
    "fp-lithos-section",
    "lithos-card-slot",
    "fp-refresh",
  ]) {
    const element = new FakeElement("div");
    element.id = id;
    element.setAttribute("id", id);
    elements.set(id, element);
  }

  const rendered = [];
  const fetchImpl = async (endpoint) => {
    if (endpoint.startsWith("/codex-quota")) {
      return makeResponse({ connected: true, resetCredits: 2 });
    }
    if (endpoint.startsWith("/lithos-balance")) {
      return makeResponse({ reason: "not_configured" });
    }
    if (endpoint.startsWith("/deepseek-balance")) {
      return makeResponse({ connected: false });
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };

  const context = {
    console,
    BroadcastChannel: MockBroadcastChannel,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Math,
    Date,
    window: {
      location: { pathname: "/api/apps/token-tracker/ui/function-panel.html" },
      hana: { api: { fetch: fetchImpl } },
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
    },
    fetch: fetchImpl,
    renderCodexQuotaCard: (container, data, handlers) => rendered.push({ container, data, handlers }),
    renderDeepSeekCard: () => {},
    renderLithosCard: () => {},
  };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return {
    async load() {
      await context.__panelExports.loadAndRender(false, {
        showCodexQuota: true,
        showDeepseekBalance: false,
      });
      return rendered.at(-1)?.handlers;
    },
  };
}

function loadQuotaHarness({ initialD = { _subscriptionQuotas: [{ id: "old" }] }, fetchImpl = null } = {}) {
  const sourcePath = path.join(rootDir, "ui", "dashboard-app.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const start = source.indexOf("var quotaBc = null;");
  const end = source.indexOf("var quotaTimer=", start);
  assert.ok(start >= 0 && end > start, "dashboard quota block must be present");
  const quotaSource = source.slice(start, end) + "\nthis.__quotaExports = { getQuotaBroadcastChannel, refreshQuota };\n";

  const requests = [];
  const rendered = { header: 0, body: 0 };
  const dateElements = {
    df: { value: "" },
    dt: { value: "" },
  };
  const context = {
    console,
    BroadcastChannel: MockBroadcastChannel,
    document: { body: new FakeElement("body"), hidden: false },
    window: { location: { search: "" } },
    D: initialD,
    _closed: false,
    R: "today",
    $: (id) => dateElements[id] || null,
    renderHdrQuota: () => { rendered.header++; },
    renderSubscriptionQuotas: () => { rendered.body++; },
    localStorage: {
      setItem() {},
    },
    trackerFetch: (endpoint, options) => {
      requests.push({ endpoint, options });
      if (fetchImpl) return fetchImpl(endpoint, options);
      return Promise.resolve(makeResponse({ _subscriptionQuotas: [{ id: "new" }] }));
    },
    showResetCreditsModal: (options) => {
      context.modalOptions = options;
    },
  };
  vm.runInNewContext(quotaSource, context, { filename: sourcePath });
  return {
    context,
    requests,
    rendered,
    getChannel: () => context.__quotaExports.getQuotaBroadcastChannel(),
    refreshQuota: () => context.__quotaExports.refreshQuota(),
  };
}

test("Function Panel ACK 只接受同 requestId，及时 ACK 会结束等待并清理监听", async () => {
  MockBroadcastChannel.reset();
  const panel = loadFunctionPanelHarness();
  const handlers = await panel.load();
  assert.equal(typeof handlers.onOpenResetModal, "function");

  MockBroadcastChannel.onPost = (channel, message) => {
    if (message.type !== "open-reset-credits-modal") return;
    channel.emit({ type: "reset-credits-modal-ack", requestId: "another-request" });
    setTimeout(() => {
      channel.emit({
        type: "reset-credits-modal-ack",
        requestId: message.requestId,
        expiresAt: message.expiresAt,
      });
    }, 100);
  };

  const result = await Promise.race([
    handlers.onOpenResetModal(),
    new Promise((resolve) => setTimeout(() => resolve("timed-out-test"), 200)),
  ]);
  assert.equal(result, true, "匹配 ACK 应让打开请求完成，而不是永久 pending");

  const channel = MockBroadcastChannel.instances[0];
  assert.ok(channel);
  assert.equal(channel.listenerCount(), 0, "ACK 完成后必须移除临时监听");
  assert.equal(channel.messages.length, 1);
  assert.equal(typeof channel.messages[0].requestId, "string");
  assert.ok(channel.messages[0].requestId.length > 0);
  assert.equal(Number.isFinite(channel.messages[0].expiresAt), true);
});

test("Function Panel ACK 超时和发送失败都返回 false 并清理监听", async () => {
  MockBroadcastChannel.reset();
  const panel = loadFunctionPanelHarness();
  const handlers = await panel.load();

  const timeoutResult = await handlers.onOpenResetModal();
  assert.equal(timeoutResult, false);
  assert.equal(MockBroadcastChannel.instances[0].listenerCount(), 0);

  MockBroadcastChannel.reset();
  MockBroadcastChannel.failPost = true;
  const failedPanel = loadFunctionPanelHarness();
  const failedHandlers = await failedPanel.load();
  const sendResult = await failedHandlers.onOpenResetModal();
  assert.equal(sendResult, false);
  assert.equal(MockBroadcastChannel.instances[0].listenerCount(), 0);
});

test("小卡列表交替操作后每张卡只允许一次二次确认核销，并保留本地降级", async () => {
  let consumeCount = 0;
  let consumedIds = [];
  const opened = await openSmallModal({
    onOpenResetModal: async () => false,
    onConsumeResetCredit: async (creditId) => {
      consumeCount++;
      consumedIds.push(creditId);
      return { ok: true, message: "成功" };
    },
  });

  assert.equal(opened.modal.style.display, "flex", "无大看板 ACK 时应打开小卡本地弹窗");
  const prepareA = findAction(opened.content, "prepare", "credit-a");
  assert.ok(prepareA);
  assert.equal(consumeCount, 0, "点击使用此卡只能进入二次确认，不得直接核销");
  await prepareA.click();
  assert.ok(findAction(opened.content, "confirm", "credit-a"));
  assert.ok(findAction(opened.content, "cancel", "credit-a"));

  const cancelA = findAction(opened.content, "cancel", "credit-a");
  await cancelA.click();
  assert.ok(findAction(opened.content, "prepare", "credit-a"), "取消后应恢复使用按钮");

  await findAction(opened.content, "prepare", "credit-a").click();
  await findAction(opened.content, "prepare", "credit-b").click();
  const confirmA = findAction(opened.content, "confirm", "credit-a");
  assert.ok(confirmA);
  await withLongTimersCaptured(() => confirmA.click());

  assert.equal(consumeCount, 1, "交替操作其他卡后，确认同一张卡仍只能调用一次核销");
  assert.deepEqual(consumedIds, ["credit-a"]);
});

test("小卡核销失败后恢复可重试按钮，不调用真实服务", async () => {
  let consumeCount = 0;
  const opened = await openSmallModal({
    onConsumeResetCredit: async () => {
      consumeCount++;
      return { ok: false, message: "假网络失败" };
    },
  });

  await findAction(opened.content, "prepare", "credit-a").click();
  await findAction(opened.content, "confirm", "credit-a").click();
  assert.equal(consumeCount, 1);
  assert.ok(findAction(opened.content, "prepare", "credit-a"), "失败后应恢复使用按钮以便重试");
  assert.ok(opened.content.querySelector("#sb-reset-feedback-slot").innerHTML.includes("假网络失败"));
});

test("大看板列表取消与交替确认只能核销一次，成功后通知刷新", async () => {
  const container = new FakeElement("div");
  let consumeCount = 0;
  let refreshCount = 0;
  const modal = showResetCreditsModal({
    container,
    fetchFn: async (endpoint) => {
      if (endpoint.includes("/consume")) {
        consumeCount++;
        return makeResponse({ ok: true, message: "成功" });
      }
      return makeResponse({ connected: true, credits: availableCredits() });
    },
    onRefresh: () => { refreshCount++; },
  });
  await flush();

  const content = container.querySelector("#sb-modal-body-content");
  assert.ok(content);
  await findAction(content, "prepare", "credit-a").click();
  await findAction(content, "cancel", "credit-a").click();
  assert.ok(findAction(content, "prepare", "credit-a"));

  await findAction(content, "prepare", "credit-a").click();
  await findAction(content, "prepare", "credit-b").click();
  await withLongTimersCaptured(() => findAction(content, "confirm", "credit-a").click());

  assert.equal(consumeCount, 1, "大看板交替操作后也不能重复核销");
  assert.equal(refreshCount, 1, "成功核销后应通知看板刷新");
  modal.close();
});

test("大看板核销失败后恢复按钮并保留失败反馈", async () => {
  const container = new FakeElement("div");
  let consumeCount = 0;
  showResetCreditsModal({
    container,
    fetchFn: async (endpoint) => {
      if (endpoint.includes("/consume")) {
        consumeCount++;
        return makeResponse({ ok: false, message: "假网络失败" }, false);
      }
      return makeResponse({ connected: true, credits: availableCredits() });
    },
  });
  await flush();
  const content = container.querySelector("#sb-modal-body-content");
  await findAction(content, "prepare", "credit-a").click();
  await findAction(content, "confirm", "credit-a").click();
  assert.equal(consumeCount, 1);
  assert.ok(findAction(content, "prepare", "credit-a"));
  assert.ok(content.querySelector("#sb-modal-feedback-slot").innerHTML.includes("假网络失败"));
});

test("大看板隐藏页、关闭页和过期请求都不 ACK 也不开弹窗", () => {
  for (const setup of [
    { hidden: true, closed: false, expiresAt: Date.now() + 400 },
    { hidden: false, closed: true, expiresAt: Date.now() + 400 },
    { hidden: false, closed: false, expiresAt: Date.now() - 1 },
  ]) {
    MockBroadcastChannel.reset();
    const quota = loadQuotaHarness();
    quota.context.document.hidden = setup.hidden;
    quota.context._closed = setup.closed;
    const channel = quota.getChannel();
    channel.emit({
      type: "open-reset-credits-modal",
      requestId: "req-ignored",
      expiresAt: setup.expiresAt,
    });
    assert.equal(channel.messages.length, 0);
    assert.equal(quota.context.modalOptions, undefined);
  }
});

test("大看板 ACK 回传 requestId，成功后等待独立 Codex 刷新完成再广播", async () => {
  MockBroadcastChannel.reset();
  const refresh = deferred();
  const quota = loadQuotaHarness({
    fetchImpl: () => refresh.promise,
  });
  const channel = quota.getChannel();
  channel.emit({ type: "open-reset-credits-modal", requestId: "req-dashboard-1", expiresAt: Date.now() + 400 });
  assert.ok(quota.context.modalOptions);
  assert.equal(channel.messages[0].type, "reset-credits-modal-ack");
  assert.equal(channel.messages[0].requestId, "req-dashboard-1");

  channel.messages = [];
  const refreshPromise = quota.context.modalOptions.onRefresh();
  await flush();
  assert.equal(quota.requests.length, 1);
  assert.equal(quota.requests[0].endpoint, "/codex-quota?refresh=1");
  assert.equal(quota.requests[0].options.cache, "no-store");
  assert.equal(channel.messages.length, 0, "独立刷新未结束前不能广播");

  const codexQuota = { connected: true, primary: { remainingPercent: 88 } };
  refresh.resolve(makeResponse(codexQuota));
  await refreshPromise;
  assert.deepEqual(quota.context.D.codexQuota, codexQuota);
  assert.equal(channel.messages.length, 1);
  assert.equal(channel.messages[0].type, "tt-quota-updated");
});

test("大看板刷新失败也等待请求结束后广播，D 未就绪仍请求独立路由且不抛拒绝", async () => {
  MockBroadcastChannel.reset();
  const refresh = deferred();
  const quota = loadQuotaHarness({ initialD: null, fetchImpl: () => refresh.promise });
  const channel = quota.getChannel();
  channel.emit({ type: "open-reset-credits-modal", requestId: "req-dashboard-2", expiresAt: Date.now() + 400 });
  assert.ok(quota.context.modalOptions);

  channel.messages = [];
  const refreshPromise = quota.context.modalOptions.onRefresh();
  await flush();
  assert.equal(quota.requests.length, 1);
  assert.equal(quota.requests[0].endpoint, "/codex-quota?refresh=1");
  assert.equal(quota.requests[0].options.cache, "no-store");
  assert.equal(channel.messages.length, 0);

  refresh.reject(new Error("假网络失败"));
  await assert.doesNotReject(() => refreshPromise);
  assert.equal(channel.messages.length, 1);
  assert.equal(channel.messages[0].type, "tt-quota-updated");
});
