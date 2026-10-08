import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import registerRoutes from "../server/dashboard.js";
import { initSettingsDialog } from "../ui/modules/settings-dialog.js";
import { loadAndRender } from "../ui/function-panel.js";

function createMockApp() {
  const routes = { GET: {}, POST: {} };
  return {
    routes,
    get: (p, handler) => { routes.GET[p] = handler; },
    post: (p, handler) => { routes.POST[p] = handler; },
    async dispatch(method, urlPath, query = {}, body = null) {
      const handler = routes[method]?.[urlPath];
      if (!handler) return { status: 404, body: { error: "not found" } };
      let resStatus = 200;
      let resBody = null;
      let resHeaders = {};

      const mockContext = {
        req: {
          query: (k) => (k ? query[k] : query),
          json: async () => body,
        },
        json: (data, status = 200) => {
          resStatus = status;
          resBody = data;
          return { status: resStatus, body: resBody };
        },
        text: (data, status = 200, headers = {}) => {
          resStatus = status;
          resBody = data;
          resHeaders = headers;
          return { status: resStatus, body: resBody, headers: resHeaders };
        },
      };
      const r = await handler(mockContext);
      return { status: resStatus, body: resBody || r };
    },
  };
}

test("hardening: server dashboard turnsStore is reused as singleton and cached on _tokenCache", async () => {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "turns-reuse-"));
  try {
    const app = createMockApp();
    const mockCache = {
      ready: true,
      data: { sessions: {} },
    };
    const ctx = {
      dataDir: tmpDataDir,
      _tokenCache: mockCache,
    };

    registerRoutes(app, ctx);

    // 第一次调用 /turns，应创建并挂载 turnsStore
    const res1 = await app.dispatch("GET", "/turns", { page: "1", pageSize: "10" });
    assert.equal(res1.status, 200);
    assert.ok(mockCache.turnsStore, "turnsStore 必须已挂载到 _tokenCache 上进行复用");

    const firstStore = mockCache.turnsStore;

    // 第二次调用 /turns/csv，应直接复用同一个 turnsStore 实例
    const res2 = await app.dispatch("GET", "/turns/csv");
    assert.equal(res2.status, 200);
    assert.strictEqual(mockCache.turnsStore, firstStore, "多次请求必须复用单例 turnsStore 实例");

    // 调用关闭确保测试不残留连接
    if (mockCache.turnsStore?.close) {
      mockCache.turnsStore.close();
    }
  } finally {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
});

test("hardening: server dashboard /data utilizes ctx.network.fetch without crashing when offline", async () => {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-network-"));
  try {
    const app = createMockApp();
    let networkFetchCalled = false;
    const mockCache = {
      ready: true,
      data: { sessions: {} },
    };
    const ctx = {
      dataDir: tmpDataDir,
      _tokenCache: mockCache,
      network: {
        fetch: async (url) => {
          networkFetchCalled = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              result: "success",
              rates: { CNY: 7.25 },
            }),
          };
        },
      },
    };

    registerRoutes(app, ctx);

    const res = await app.dispatch("GET", "/data");
    assert.equal(res.status, 200);
    assert.equal(networkFetchCalled, true, "应当优先通过 ctx.network.fetch 获取汇率");
    assert.equal(res.body._fxRate, 7.25);
  } finally {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  }
});

test("hardening: settings-dialog protects against non-JSON 502/HTML responses gracefully", async () => {
  const elements = {};
  function makeEl(id) {
    const el = {
      id,
      style: {},
      value: "",
      textContent: "",
      className: "",
      onclick: null,
      dataset: {},
      disabled: false,
    };
    elements[id] = el;
    return el;
  }

  makeEl("st-btn");
  makeEl("set-panel");
  makeEl("set-shade");
  makeEl("set-close");
  makeEl("set-save");
  makeEl("set-scan-interval");
  makeEl("set-high-usage");
  makeEl("set-show-codex");
  makeEl("set-show-deepseek");
  makeEl("set-msg");

  const originalDoc = globalThis.document;
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    body: { getAttribute: () => "light" },
    addEventListener: () => {},
  };

  try {
    elements["set-scan-interval"].value = "60";
    elements["set-high-usage"].value = "30000";

    // 模拟前置网关返回 502 Bad Gateway HTML
    const fetchFn = async () => ({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new SyntaxError("Unexpected token '<', <html>... is not valid JSON");
      },
    });

    const dialog = initSettingsDialog({ fetchFn });
    await dialog.saveSettings();

    // 验证错误信息被优雅捕获并展示，未抛出未捕获的 SyntaxError
    assert.match(elements["set-msg"].textContent, /502 Bad Gateway/);
    assert.equal(elements["set-msg"].className.includes("error"), true);
    assert.equal(elements["set-save"].disabled, false);
  } finally {
    globalThis.document = originalDoc;
  }
});

test("hardening: function-panel shows empty notice when Codex is disabled and DeepSeek is unconnected", async () => {
  const originalDoc = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;

  try {
    const elements = {};
    function makeEl(id) {
      const el = {
        id,
        style: {},
        innerHTML: "",
        textContent: "",
        querySelector: (sel) => {
          if (sel === ".sb-codex-quiet") {
            const quiet = { textContent: "" };
            el._quiet = quiet;
            return quiet;
          }
          return null;
        },
        closest: () => el,
        parentElement: null,
      };
      elements[id] = el;
      return el;
    }

    const codexSec = makeEl("fp-codex-section");
    const dsSec = makeEl("fp-deepseek-section");
    const emptyNotice = makeEl("fp-empty-notice");
    const codexSlot = makeEl("codex-card-slot");
    const dsSlot = makeEl("deepseek-card-slot");
    dsSlot.closest = (sel) => (sel === ".fp-section" ? dsSec : dsSlot);
    codexSlot.closest = (sel) => (sel === ".fp-section" ? codexSec : codexSlot);
    const refreshBtn = makeEl("fp-refresh");

    globalThis.document = {
      getElementById: (id) => elements[id] || null,
    };

    globalThis.window = {
      location: { pathname: "/test" },
      hana: null,
    };

    // 模拟接口响应：Codex 关闭，DeepSeek 开启但未连接（无凭据）
    globalThis.fetch = async (url) => {
      if (url.includes("/settings")) {
        return {
          ok: true,
          json: async () => ({ showCodexQuota: false, showDeepseekBalance: true }),
        };
      }
      if (url.includes("/deepseek-balance")) {
        return {
          ok: true,
          json: async () => ({ connected: false, reason: "no_credentials" }),
        };
      }
      return { ok: false };
    };

    await loadAndRender(false);

    // 验证当两个卡片均不可见时，空状态提示能够兜底展示，消除全白界面
    assert.equal(codexSec.style.display, "none", "Codex 分区应当隐藏");
    assert.equal(dsSec.style.display, "none", "DeepSeek 分区应当隐藏");
    assert.equal(emptyNotice.style.display, "", "空状态提示必须可见展示");
    assert.match(emptyNotice._quiet?.textContent || "", /暂无可展示的卡片/);
  } finally {
    globalThis.document = originalDoc;
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});
