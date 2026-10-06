import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import registerRoutes from "../routes/dashboard.js";

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
      let resHeaders = {};
      let resBody = null;

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
        html: (content, status = 200) => {
          resStatus = status;
          resBody = content;
          return { status: resStatus, body: resBody };
        },
      };
      const r = await handler(mockContext);
      return { status: resStatus, body: resBody || r };
    },
  };
}

test("后端路由安全性、敏感字段脱敏及拒权可解释测试", async () => {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-routes-"));

  // 预置包含私密凭据的 balance-apis.json
  const initialBalanceApis = {
    deepseek: {
      url: "https://api.deepseek.com/user/balance",
      apiKey: "sk-secret-real-api-key-1234567890",
      cookie: "session_cookie_secret=abcdefg",
      token: "secret-token-xyz",
      enabled: true,
    },
  };
  fs.writeFileSync(
    path.join(tmpDataDir, "balance-apis.json"),
    JSON.stringify(initialBalanceApis, null, 2)
  );

  const mockApp = createMockApp();
  const mockShared = {
    dataDir: tmpDataDir,
    ready: true,
    data: {
      lastScan: "2026-10-06T12:00:00.000Z",
      coverageLimitReached: true,
      sessions: {
        "alpha::desktop::2026-10-06": {
          agent: "agent-alpha",
          type: "desktop",
          dailyBreakdown: {
            "2026-10-06": { totalTokens: 500, models: { "deepseek-chat": { totalTokens: 500 } } },
          },
          models: { "deepseek-chat": { totalTokens: 500 } },
        },
      },
    },
    realtime: {},
  };

  const mockCtx = {
    pluginId: "token-tracker",
    _tokenCache: mockShared,
    bus: {
      request: async (verb, params) => {
        if (verb === "model:list") {
          return {
            models: [{ id: "deepseek-chat", modelId: "deepseek-chat", provider: "deepseek" }],
          };
        }
        if (verb === "agent:list") {
          return { agents: [{ id: "agent-alpha", name: "阿尔法" }] };
        }
        if (verb === "provider:credentials") {
          // 模拟拒权场景（未在设置中开启凭据读取）
          return { error: "forbidden: app/provider.credentials.read required" };
        }
        if (verb === "session:history") {
          return {
            messages: [{ role: "user", content: "你好" }, { role: "assistant", content: "您好！" }],
          };
        }
        return {};
      },
    },
  };

  registerRoutes(mockApp, mockCtx);

  // 1. 验证 GET /data 的脱敏与敏感数据白名单过滤
  const dataRes = await mockApp.dispatch("GET", "/data");
  assert.equal(dataRes.status, 200);
  const data = dataRes.body;

  // 校验：绝不能回传真实 apiKey、cookie、token！
  const deepseekConf = data._balanceApis?.deepseek;
  assert.ok(deepseekConf, "_balanceApis 必须存在");
  assert.equal(deepseekConf.configured, true);
  assert.equal(deepseekConf.hasApiKey, true);
  assert.equal(deepseekConf.apiKey, "••••••••", "私钥必须被掩码替换");
  assert.equal(deepseekConf.cookie, "••••••••", "Cookie 必须被掩码替换");
  assert.equal(deepseekConf.token, "••••••••", "Token 必须被掩码替换");

  // 校验：凭据拒权时必须有可解释说明，不可伪装为 0
  const dsBalance = data._balances?.find((b) => b.provider === "deepseek");
  assert.ok(dsBalance, "必须包含 deepseek 余额条目");
  assert.equal(dsBalance.type, "unauthorized", "必须标识为 unauthorized");
  assert.ok(dsBalance.display.includes("未获授权"), "必须明确展示未获授权");
  assert.ok(dsBalance.error, "必须包含错误信息");

  // 校验：覆盖限制标识
  assert.equal(data._coverageLimitReached, true);
  assert.ok(data._coverageNotice);

  // 2. 验证 POST /balance-apis 的掩码保护（防误清空）
  const updatePayload = {
    deepseek: {
      url: "https://api.deepseek.com/user/balance",
      apiKey: "••••••••", // 用户未更改密钥直接保存
      cookie: "••••••••",
      token: "••••••••",
      enabled: false,
    },
  };
  const saveRes = await mockApp.dispatch("POST", "/balance-apis", {}, updatePayload);
  assert.equal(saveRes.status, 200);

  // 读取底层文件，核实真实 apiKey 没有被 "••••••••" 覆盖成破坏性字符串
  const diskSaved = JSON.parse(fs.readFileSync(path.join(tmpDataDir, "balance-apis.json"), "utf-8"));
  assert.equal(diskSaved.deepseek.apiKey, "sk-secret-real-api-key-1234567890", "原有 apiKey 必须完好保留");
  assert.equal(diskSaved.deepseek.enabled, false, "非凭据字段应正常更新");

  // 3. 验证 /session/detail 按需下钻
  const sessRes = await mockApp.dispatch("GET", "/session/detail", { sessionId: "sess-1" });
  assert.equal(sessRes.status, 200);
  assert.equal(sessRes.body.messages.length, 2);

  // 清理临时目录
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});
