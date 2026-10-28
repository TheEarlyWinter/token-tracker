import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerRoutes from "../server/dashboard.js";

const CPA_BASE_URL = "https://cpa.example.invalid";
const CREDENTIALS_URL = `${CPA_BASE_URL}/v8/management/credentials`;
const API_CALL_URL = `${CPA_BASE_URL}/v8/management/requests/api-call`;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gemini-quota-routes-"));
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

function createMockApp() {
  const routes = { GET: {}, POST: {} };
  return {
    routes,
    get(route, handler) { routes.GET[route] = handler; },
    post(route, handler) { routes.POST[route] = handler; },
    async dispatch(method, route, query = {}, body = null) {
      const handler = routes[method][route];
      assert.equal(typeof handler, "function", `${method} ${route} must be registered`);
      let result;
      const context = {
        req: {
          query: (key) => (key ? query[key] : query),
          json: async () => body,
        },
        json: (payload, status = 200) => {
          result = { status, body: payload };
          return result;
        },
      };
      await handler(context);
      return result;
    },
  };
}

test("Gemini 路由只实例化共享服务、注册双别名、代理合成 CPA 并隐藏管理密钥", async () => {
  const dataDir = tempDir();
  const calls = [];
  const app = createMockApp();
  const ctx = {
    dataDir,
    network: {
      async fetch(url, init) {
        calls.push({ url, init });
        if (url === CREDENTIALS_URL) {
          return response(200, {
            files: [{ provider: "antigravity", auth_index: 2, email: "route@example.com", project_id: "route-project" }],
          });
        }
        assert.equal(url, API_CALL_URL);
        return response(200, {
          status_code: 200,
          body: JSON.stringify({ groups: [{ displayName: "Daily", buckets: [{ displayName: "5h", remainingFraction: 0.5 }] }] }),
        });
      },
    },
    _tokenCache: {},
  };
  try {
    registerRoutes(app, ctx);
    assert.equal(typeof app.routes.GET["/gemini-quota"], "function");
    assert.equal(typeof app.routes.GET["/dashboard/gemini-quota"], "function");
    assert.equal(typeof app.routes.GET["/gemini-quota/config"], "function");
    assert.equal(typeof app.routes.POST["/gemini-quota/config"], "function");

    const before = await app.dispatch("GET", "/gemini-quota/config");
    assert.deepEqual(before.body, { configured: false, baseUrl: CPA_BASE_URL, baseUrlConfigured: false });
    const bad = await app.dispatch("POST", "/gemini-quota/config", {}, { action: "save", managementKey: "" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "INVALID_INPUT");
    const badBody = await app.dispatch("POST", "/gemini-quota/config", {}, null);
    assert.equal(badBody.status, 400);
    assert.equal(badBody.body.code, "INVALID_INPUT");

    const saved = await app.dispatch("POST", "/dashboard/gemini-quota/config", {}, {
      action: "save",
      managementKey: "route-management-secret",
      baseUrl: CPA_BASE_URL,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.baseUrl, CPA_BASE_URL);
    assert.equal(saved.body.baseUrlConfigured, true);
    assert.doesNotMatch(JSON.stringify(saved.body), /route-management-secret/);

    const quota = await app.dispatch("GET", "/gemini-quota");
    assert.equal(quota.status, 200);
    assert.equal(quota.body.configured, true);
    assert.equal(quota.body.accounts[0].quotaStatus, "ok");
    assert.doesNotMatch(JSON.stringify(quota.body), /route-management-secret|route-project|route@example\.com/);
    assert.equal(calls.filter((call) => call.url === CREDENTIALS_URL).length, 1);

    const config = await app.dispatch("GET", "/dashboard/gemini-quota/config");
    assert.deepEqual(config.body, { configured: true, baseUrl: CPA_BASE_URL, baseUrlConfigured: true });
    const cleared = await app.dispatch("POST", "/gemini-quota/config", {}, { action: "clear" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.configured, false);
    assert.equal(cleared.body.baseUrlConfigured, false);
    assert.doesNotMatch(JSON.stringify(cleared.body), /route-management-secret/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Gemini 配置路由透传 baseUrl：非法地址 400，未传时沿用已存地址，响应回带 baseUrl 与标记", async () => {
  const dataDir = tempDir();
  const app = createMockApp();
  const ctx = { dataDir, network: null, _tokenCache: {} };
  try {
    registerRoutes(app, ctx);

    const badBase = await app.dispatch("POST", "/gemini-quota/config", {}, {
      action: "save",
      managementKey: "route-key",
      baseUrl: "http://insecure.test",
    });
    assert.equal(badBase.status, 400);
    assert.equal(badBase.body.code, "INVALID_INPUT");
    assert.equal(fs.existsSync(path.join(dataDir, "gemini-cpa.json")), false);

    const saved = await app.dispatch("POST", "/gemini-quota/config", {}, {
      action: "save",
      managementKey: "route-key",
      baseUrl: "https://cpa.example.invalid/cpa/",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.baseUrl, "https://cpa.example.invalid/cpa");
    assert.equal(saved.body.baseUrlConfigured, true);

    // 只轮换密钥、不传 baseUrl：沿用磁盘上已有的地址
    const rotated = await app.dispatch("POST", "/gemini-quota/config", {}, {
      action: "save",
      managementKey: "route-key-2",
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.baseUrl, "https://cpa.example.invalid/cpa");
    assert.equal(rotated.body.baseUrlConfigured, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("manifest 与忽略规则只增加固定 CPA 主机和 gemini-cpa.json", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.network.allowedHosts.includes("cpa.example.invalid"));
  assert.equal(manifest.version, "7.3.0");
  const ignore = fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^gemini-cpa\.json$/m);
});
