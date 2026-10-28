import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGeminiQuotaController, renderGeminiCard } from "../ui/modules/gemini-card.js";
import { initSettingsDialog } from "../ui/modules/settings-dialog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeSection {
  constructor() {
    this.style = {};
    this.className = "gemini-pool-section";
  }
}

class FakeContainer {
  constructor() {
    this.style = {};
    this._innerHTML = "";
    this.section = new FakeSection();
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  closest(selector) {
    return selector === ".gemini-pool-section" ? this.section : null;
  }
}

function response(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  };
}

function dto(overrides = {}) {
  return {
    configured: true,
    connected: true,
    reason: null,
    updatedAt: 1793181600000,
    accounts: [
      {
        id: "account-summary-a",
        label: "safe@example.test",
        health: "healthy",
        quotaStatus: "ok",
        groups: [
          {
            id: "cloud-code",
            label: "Cloud Code",
            buckets: [
              { id: "daily", label: "Daily", remainingFraction: 0, resetTime: "2026-10-28T10:00:00.000Z" },
              { id: "sandbox", label: "Sandbox", remainingFraction: 0.5, resetTime: null },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
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

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("未配置时清空卡片并隐藏整个 Gemini 区块", () => {
  const container = new FakeContainer();
  container.innerHTML = "旧结果";
  container.section.style.display = "";

  renderGeminiCard(container, { configured: false, connected: false, accounts: [] });

  assert.equal(container.innerHTML, "");
  assert.equal(container.section.style.display, "none");
});

test("正常 DTO 按账号、分组和 bucket 展示，0%有效且不聚合账号百分比", () => {
  const container = new FakeContainer();
  renderGeminiCard(container, dto(), { now: Date.parse("2026-10-28T11:00:00.000Z") });

  assert.equal(container.section.style.display, "");
  assert.match(container.innerHTML, /Gemini 算力池/);
  assert.match(container.innerHTML, /Antigravity共享配额/);
  assert.match(container.innerHTML, /safe@example\.test/);
  assert.match(container.innerHTML, /Daily/);
  assert.match(container.innerHTML, /0%/);
  assert.match(container.innerHTML, /50%/);
  assert.match(container.innerHTML, /待刷新/);
  assert.match(container.innerHTML, /重置时间未知/);
  assert.doesNotMatch(container.innerHTML, /总池|平均|Gemini独享/);
});

test("所有外来 label 均 HTML 转义", () => {
  const container = new FakeContainer();
  renderGeminiCard(container, dto({
    accounts: [{
      id: "summary-id",
      label: '<img src=x onerror="alert(1)">',
      health: "healthy",
      quotaStatus: "ok",
      groups: [{
        id: "g",
        label: "<group>&\"",
        buckets: [{ id: "b", label: "<bucket>", remainingFraction: 0.25, resetTime: null }],
      }],
    }],
  }));

  assert.match(container.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(container.innerHTML, /&lt;group&gt;&amp;&quot;/);
  assert.match(container.innerHTML, /&lt;bucket&gt;/);
  assert.doesNotMatch(container.innerHTML, /<img|onerror="alert/);
});

test("账号 health 与 quotaStatus 分开展示，unavailable 账号仍展示有效额度", () => {
  const container = new FakeContainer();
  renderGeminiCard(container, dto({
    connected: false,
    accounts: [
      {
        id: "unavailable-summary",
        label: "脱敏账号",
        health: "unavailable",
        quotaStatus: "error",
        groups: [{ id: "g", label: "Production", buckets: [{ id: "b", label: "主配额", remainingFraction: 0.2, resetTime: "2026-10-29T00:00:00.000Z" }] }],
      },
      {
        id: "missing-project-summary",
        label: "另一个账号",
        health: "healthy",
        quotaStatus: "missing_project",
        groups: [],
      },
    ],
  }));

  assert.match(container.innerHTML, /账号不可用/);
  assert.match(container.innerHTML, /配额查询失败/);
  assert.match(container.innerHTML, /缺少项目/);
  assert.match(container.innerHTML, /20%/);
});

test("已配置但无账号或读取失败显示安全短句，不伪造 0%", () => {
  const empty = new FakeContainer();
  renderGeminiCard(empty, { configured: true, connected: true, reason: null, accounts: [] });
  assert.match(empty.innerHTML, /暂无可展示的 Antigravity 账号/);
  assert.doesNotMatch(empty.innerHTML, /0%/);

  const failed = new FakeContainer();
  renderGeminiCard(failed, { configured: true, connected: false, reason: "upstream_secret", accounts: [] });
  assert.match(failed.innerHTML, /暂时无法读取 Gemini 算力池/);
  assert.doesNotMatch(failed.innerHTML, /upstream_secret|0%/);
});

test("控制器对相同在途查询去重，且请求不带 force 参数", async () => {
  const container = new FakeContainer();
  const pending = deferred();
  const calls = [];
  const controller = createGeminiQuotaController({
    container,
    fetchFn: (url) => {
      calls.push(String(url));
      return pending.promise;
    },
  });

  const first = controller.load();
  const second = controller.load();
  assert.strictEqual(first, second);
  assert.deepEqual(calls, ["/gemini-quota"]);

  pending.resolve(response(dto()));
  await first;
  assert.match(container.innerHTML, /Gemini 算力池/);
});

test("新一轮配置读取获胜，旧响应不能覆盖新状态", async () => {
  const container = new FakeContainer();
  const requests = [];
  const controller = createGeminiQuotaController({
    container,
    fetchFn: (url) => {
      const gate = deferred();
      requests.push({ url, ...gate });
      return gate.promise;
    },
  });

  controller.load();
  const second = controller.reload();
  assert.equal(requests.length, 2);
  requests[1].resolve(response(dto({ accounts: [{ ...dto().accounts[0], label: "新配置账号" }] })));
  await second;
  requests[0].resolve(response(dto({ accounts: [{ ...dto().accounts[0], label: "旧配置账号" }] })));
  await flush();

  assert.match(container.innerHTML, /新配置账号/);
  assert.doesNotMatch(container.innerHTML, /旧配置账号/);
});

test("清空配置立即隐藏，迟到的旧成功响应不能复活卡片", async () => {
  const container = new FakeContainer();
  const gate = deferred();
  const controller = createGeminiQuotaController({ container, fetchFn: () => gate.promise });

  controller.load();
  controller.hide();
  assert.equal(container.section.style.display, "none");
  assert.equal(container.innerHTML, "");

  gate.resolve(response(dto()));
  await flush();
  assert.equal(container.section.style.display, "none");
  assert.equal(container.innerHTML, "");
});

test("首次请求失败保持未配置隐藏，不凭空出现错误卡", async () => {
  const container = new FakeContainer();
  const controller = createGeminiQuotaController({
    container,
    fetchFn: async () => { throw new Error("synthetic_network_failure"); },
  });

  await controller.load();
  assert.equal(container.section.style.display, "none");
  assert.equal(container.innerHTML, "");
});

test("请求失败仅在已确认 configured=true 后显示安全错误卡", async () => {
  const container = new FakeContainer();
  let calls = 0;
  const controller = createGeminiQuotaController({
    container,
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) return response(dto());
      return { ok: false, status: 502, json: async () => ({ error: "management-key-secret" }) };
    },
  });

  await controller.load();
  assert.equal(container.section.style.display, "");
  await controller.refresh();
  assert.match(container.innerHTML, /暂时无法读取 Gemini 算力池/);
  assert.doesNotMatch(container.innerHTML, /management-key-secret|502/);
});

test("clear 后 reload 失败仍保持隐藏，旧的 errorDto 不能复活卡片", async () => {
  const container = new FakeContainer();
  let calls = 0;
  const controller = createGeminiQuotaController({
    container,
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) return response(dto());
      throw new Error("synthetic_after_clear_failure");
    },
  });

  await controller.load();
  assert.equal(container.section.style.display, "");
  await controller.reload({ hide: true, configured: false });
  assert.equal(container.section.style.display, "none");
  assert.equal(container.innerHTML, "");
});

test("unauthorized 和 forbidden 使用固定管理鉴权受限文案", () => {
  for (const reason of ["unauthorized", "forbidden"]) {
    const container = new FakeContainer();
    renderGeminiCard(container, { configured: true, connected: false, reason, accounts: [] });
    assert.match(container.innerHTML, /管理鉴权受限，请检查密钥和远程管理，再重新保存配置/);
    assert.doesNotMatch(container.innerHTML, /unauthorized|forbidden|上游|原始/);
  }
});

test("missing_base_url 明确提示尚未配置网关地址", () => {
  const container = new FakeContainer();
  renderGeminiCard(container, { configured: true, connected: false, reason: "missing_base_url", accounts: [] });
  assert.equal(container.section.style.display, "");
  assert.match(container.innerHTML, /尚未配置网关地址，请在设置里填写 CPA 网关地址。/);
  assert.doesNotMatch(container.innerHTML, /missing_base_url|cpa\.example\.invalid/);
});

test("看板不再重复挂载 Gemini 卡，Function Panel 独立接入共享卡片、配置路由和独立 Gemini 请求", () => {
  const dashboard = fs.readFileSync(path.join(root, "ui", "dashboard-app.js"), "utf8");
  const panel = fs.readFileSync(path.join(root, "ui", "function-panel.js"), "utf8");
  const panelHtml = fs.readFileSync(path.join(root, "ui", "function-panel.html"), "utf8");
  const settings = fs.readFileSync(path.join(root, "ui", "modules", "settings-dialog.js"), "utf8");

  // 算力池只保留在最左侧功能面板一处：看板侧栏曾同时挂了一份，同数据同渲染，属于重复。
  assert.doesNotMatch(dashboard, /createGeminiQuotaController/);
  assert.doesNotMatch(dashboard, /gemini-card-slot/);
  assert.doesNotMatch(dashboard, /id="gemini-pool-section"/);
  assert.match(panel, /createGeminiQuotaController/);
  assert.match(panel, /gemini-card-slot/);
  assert.match(panel, /gemini-config-updated/);
  assert.match(panelHtml, /id="fp-gemini-section"/);
  assert.match(panelHtml, /id="gemini-card-slot"/);
  assert.match(settings, /gemini-quota\/config/);
  assert.match(settings, /set-gemini-key/);
  assert.match(settings, /set-gemini-base/);
  assert.match(settings, /网关地址/);
  assert.match(settings, /network\.allowedHosts/);
  assert.match(settings, /set-gemini-save/);
  assert.match(settings, /set-gemini-clear/);
  assert.match(settings, /managementKey/);
  assert.match(settings, /baseUrl/);
});

test("设置和面板不把管理密钥写入 localStorage、日志或任意 URL", () => {
  const panel = fs.readFileSync(path.join(root, "ui", "function-panel.js"), "utf8");
  const settings = fs.readFileSync(path.join(root, "ui", "modules", "settings-dialog.js"), "utf8");
  const combined = `${panel}\n${settings}`;

  assert.doesNotMatch(combined, /localStorage\.(setItem|getItem)\([^)]*managementKey/i);
  assert.doesNotMatch(combined, /console\.(log|debug|info|warn|error)\([^)]*managementKey/i);
  // 前端不得内置任何真实 CPA 主机（只允许 https://… 这类占位提示）
  assert.doesNotMatch(combined, /https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/i);
  assert.match(combined, /https:\/\/…/);
  assert.match(combined, /tt-gemini-config-tick/);
  assert.match(combined, /action:\s*["'](?:save|clear)["']/);
});

test("Gemini 样式使用现有 CSS tokens 并提供紧凑进度条", () => {
  const css = fs.readFileSync(path.join(root, "ui", "base.css"), "utf8");
  assert.match(css, /\.gemini-pool-card/);
  assert.match(css, /var\(--bg-card/);
  assert.match(css, /\.gemini-bucket-track/);
  assert.match(css, /\.gemini-bucket-fill/);
});

test("设置页保存和清空只提交固定动作，成功后清空输入并通知双端", async () => {
  const elements = {};
  function makeElement(id) {
    const element = {
      id,
      style: {},
      value: "",
      textContent: "",
      className: "",
      checked: true,
      disabled: false,
      onclick: null,
    };
    elements[id] = element;
    return element;
  }
  [
    "st-btn", "set-panel", "set-shade", "set-close", "set-save", "set-scan-interval",
    "set-high-usage", "set-show-codex", "set-show-deepseek", "set-msg",
    "set-gemini-key", "set-gemini-base", "set-gemini-save", "set-gemini-clear", "set-gemini-status",
  ].forEach(makeElement);

  const originalDocument = globalThis.document;
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  const originalLocalStorage = globalThis.localStorage;
  const configTicks = [];
  globalThis.BroadcastChannel = undefined;
  globalThis.localStorage = {
    setItem(key, value) {
      if (key === "tt-gemini-config-tick") configTicks.push(String(value));
    },
  };
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    body: { getAttribute: () => "light" },
    addEventListener: () => {},
  };

  const posted = [];
  const changed = [];
  let configState = { configured: false, baseUrl: "https://synthetic-cpa.invalid", baseUrlConfigured: false };
  try {
    const fetchFn = async (url, options) => {
      if (url === "/settings") return { ok: true, json: async () => ({ scanInterval: 60, highUsageThreshold: 30000 }) };
      if (url === "/gemini-quota/config" && !options) {
        return { ok: true, json: async () => configState };
      }
      if (url === "/gemini-quota/config" && options?.method === "POST") {
        const body = JSON.parse(options.body);
        posted.push(body);
        const baseUrl = body.baseUrl || "https://synthetic-cpa.invalid";
        return {
          ok: true,
          json: async () => ({
            configured: body.action === "save",
            baseUrl,
            baseUrlConfigured: body.action === "save",
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const dialog = initSettingsDialog({
      fetchFn,
      onGeminiConfigChanged: (action, data) => changed.push({ action, configured: data?.configured }),
    });

    await dialog.loadGeminiConfig();
    assert.equal(elements["set-gemini-status"].textContent, "未配置");
    assert.equal(elements["set-gemini-base"].value, "", "默认占位地址不回填到输入框");

    // 有密钥没地址：状态文案必须点明缺什么，而不是笼统的“未配置”
    configState = { configured: true, baseUrl: "https://synthetic-cpa.invalid", baseUrlConfigured: false };
    await dialog.loadGeminiConfig();
    assert.equal(elements["set-gemini-status"].textContent, "缺少网关地址");
    assert.equal(elements["set-gemini-base"].value, "");

    elements["set-gemini-key"].value = "synthetic-management-key";
    elements["set-gemini-base"].value = "https://synthetic-cpa.invalid/cpa";
    await elements["set-gemini-save"].onclick();
    assert.deepEqual(posted[0], {
      action: "save",
      managementKey: "synthetic-management-key",
      baseUrl: "https://synthetic-cpa.invalid/cpa",
    });
    assert.equal(elements["set-gemini-key"].value, "");
    assert.equal(elements["set-gemini-base"].value, "https://synthetic-cpa.invalid/cpa");
    assert.equal(elements["set-gemini-status"].textContent, "已配置 · synthetic-cpa.invalid");
    assert.deepEqual(changed, [{ action: "save", configured: true }]);

    await new Promise((resolve) => setTimeout(resolve, 2));
    elements["set-gemini-key"].value = "synthetic-management-key-2";
    await elements["set-gemini-save"].onclick();
    assert.deepEqual(posted[1], {
      action: "save",
      managementKey: "synthetic-management-key-2",
      baseUrl: "https://synthetic-cpa.invalid/cpa",
    });
    assert.deepEqual(changed, [
      { action: "save", configured: true },
      { action: "save", configured: true },
    ]);
    assert.equal(configTicks.length, 2);
    assert.notEqual(configTicks[0], configTicks[1], "连续保存不同 key 必须产生不同 storage tick");
    assert.match(configTicks[0], /^save:1:\d+$/);
    assert.match(configTicks[1], /^save:1:\d+$/);

    await elements["set-gemini-clear"].onclick();
    assert.deepEqual(posted[2], { action: "clear" });
    assert.equal(elements["set-gemini-key"].value, "");
    assert.deepEqual(changed, [
      { action: "save", configured: true },
      { action: "save", configured: true },
      { action: "clear", configured: false },
    ]);
    assert.equal(typeof dialog.saveSettings, "function");
  } finally {
    globalThis.document = originalDocument;
    globalThis.BroadcastChannel = originalBroadcastChannel;
    globalThis.localStorage = originalLocalStorage;
  }
});
