import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import vm from "node:vm";
import { trackerStatus } from "../lib/runtime-health.mjs";
import { applyDashboardOptions } from "../lib/dashboard-options.mjs";
import { renderDashboardHtml } from "../lib/dashboard-page.mjs";
import { openTurnsStore, queryTurns, queryTurnSizes } from "../runtime/engine/services/turns-store.js";
import { saveTurnsExport } from "../lib/turns-export.mjs";
import { loadSettings, saveSettings } from "../lib/settings-store.mjs";
import { buildDetailsCSV } from "../runtime/engine/services/details-csv.js";
import { buildVisualAnalytics } from "../runtime/engine/services/visual-analytics.js";
import { CodexQuotaService } from "../lib/codex-quota.mjs";
import { DeepSeekBalanceService } from "../lib/deepseek-balance.mjs";
const UI_VERSION = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).version;

// OpenCode Go 官方定价表（opencode.ai/docs/go 校验）
const DEFAULT_PRICE_TABLE = {
  "opencode-go/deepseek-v4-flash": {
    currency: "USD",
    monthlyAllowance: 60,
    defaultPrice: { unit: "token", inputPerM: 0.14, inputCachePerM: 0.0028, outputPerM: 0.28, cacheWritePerM: 0 }
  },
  "opencode-go/deepseek-v4-pro": {
    currency: "USD",
    monthlyAllowance: 15,
    defaultPrice: { unit: "token", inputPerM: 0.435, inputCachePerM: 0.003625, outputPerM: 0.87, cacheWritePerM: 0 }
  },
  "opencode-go/gpt-5.6-luna": {
    currency: "USD",
    monthlyAllowance: 15,
    defaultPrice: { unit: "token", inputPerM: 0.2, inputCachePerM: 0.02, outputPerM: 1.2, cacheWritePerM: 0.25 },
    contextTiers: [
      { maxContext: 272000, price: { unit: "token", inputPerM: 0.4, inputCachePerM: 0.04, outputPerM: 1.8, cacheWritePerM: 0.5 } }
    ]
  },
  "opencode-go/grok-4.5": { currency: "USD", monthlyAllowance: 15, defaultPrice: { unit: "token", inputPerM: 2, inputCachePerM: 0.3, outputPerM: 6, cacheWritePerM: 0 } },
  "opencode-go/glm-5.2": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 1.4, inputCachePerM: 0.26, outputPerM: 4.4, cacheWritePerM: 0 } },
  "opencode-go/glm-5.1": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 1.4, inputCachePerM: 0.26, outputPerM: 4.4, cacheWritePerM: 0 } },
  "opencode-go/kimi-k3": { currency: "USD", monthlyAllowance: 15, defaultPrice: { unit: "token", inputPerM: 3, inputCachePerM: 0.3, outputPerM: 15, cacheWritePerM: 0 } },
  "opencode-go/kimi-k2.7-code": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.95, inputCachePerM: 0.19, outputPerM: 4, cacheWritePerM: 0 } },
  "opencode-go/kimi-k2.6": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.95, inputCachePerM: 0.16, outputPerM: 4, cacheWritePerM: 0 } },
  "opencode-go/mimo-v2.5": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.14, inputCachePerM: 0.0028, outputPerM: 0.28, cacheWritePerM: 0 } },
  "opencode-go/mimo-v2.5-pro": { currency: "USD", monthlyAllowance: 15, defaultPrice: { unit: "token", inputPerM: 0.435, inputCachePerM: 0.003625, outputPerM: 0.87, cacheWritePerM: 0 } },
  "opencode-go/minimax-m3": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.3, inputCachePerM: 0.06, outputPerM: 1.2, cacheWritePerM: 0 } },
  "opencode-go/minimax-m2.7": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.3, inputCachePerM: 0.06, outputPerM: 1.2, cacheWritePerM: 0.375 } },
  "opencode-go/minimax-m2.5": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.3, inputCachePerM: 0.06, outputPerM: 1.2, cacheWritePerM: 0.375 } },
  "opencode-go/qwen3.7-max": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 2.5, inputCachePerM: 0.5, outputPerM: 7.5, cacheWritePerM: 3.125 } },
  "opencode-go/qwen3.7-plus": {
    currency: "USD",
    monthlyAllowance: 60,
    defaultPrice: { unit: "token", inputPerM: 0.4, inputCachePerM: 0.04, outputPerM: 1.6, cacheWritePerM: 0.5 },
    contextTiers: [
      { maxContext: 256000, price: { unit: "token", inputPerM: 1.2, inputCachePerM: 0.12, outputPerM: 4.8, cacheWritePerM: 1.5 } }
    ]
  },
  "opencode-go/qwen3.6-plus": {
    currency: "USD",
    monthlyAllowance: 60,
    defaultPrice: { unit: "token", inputPerM: 0.5, inputCachePerM: 0.05, outputPerM: 3, cacheWritePerM: 0.625 },
    contextTiers: [
      { maxContext: 256000, price: { unit: "token", inputPerM: 2, inputCachePerM: 0.2, outputPerM: 6, cacheWritePerM: 2.5 } }
    ]
  },
  "opencode-go/hy3": { currency: "USD", monthlyAllowance: 60, defaultPrice: { unit: "token", inputPerM: 0.14, inputCachePerM: 0.035, outputPerM: 0.58, cacheWritePerM: 0 } }
};

// 计费档位选取
function pickPrice(price, mv, hour) {
  if (!price) return null;
  if (price.defaultPrice === undefined) return price;
  let ap = price.defaultPrice;
  if (price.contextTiers && price.contextTiers.length) {
    const perCall = ((mv.input || 0) + (mv.cacheRead || 0)) / Math.max(1, mv.callCount || mv.assistantCount || 1);
    let matched = null, matchedMax = -1;
    for (const t of price.contextTiers) {
      if (t.maxContext == null) { matched = t.price; matchedMax = Infinity; continue; }
      if (perCall > t.maxContext && t.maxContext >= matchedMax) { matched = t.price; matchedMax = t.maxContext; }
    }
    if (matched) ap = { ...ap, ...matched };
  }
  if (price.slots && price.slots.length > 0) {
    const cur = hour !== undefined ? hour * 60 + 30 : (new Date().getHours() * 60 + 30);
    for (const s of price.slots) {
      const f = (s.from || "00:00").split(":").map(Number);
      const t = (s.to || "24:00").split(":").map(Number);
      const fs = f[0] * 60 + (f[1] || 0), ts = t[0] * 60 + (t[1] || 0);
      let match = false;
      if (fs <= ts) { if (cur >= fs && cur < ts) match = true; }
      else { if (cur >= fs || cur < ts) match = true; }
      if (match) { ap = s; break; }
    }
  }
  return ap;
}

function calcCost(price, mv, hour) {
  if (!price) return 0;
  if (price.defaultPrice !== undefined) {
    const ap = pickPrice(price, mv, hour);
    const unit = ap.unit || "token";
    if (unit === "per_call") return (mv.callCount || mv.assistantCount || 0) * (ap.pricePerCall || 0);
    if (unit === "per_char") { const chars = (mv.output || 0) + (mv.input || 0); return chars * (ap.pricePer10K || 0) / 10000; }
    return (mv.input || 0) * (ap.inputPerM || 0) / 1e6 + (mv.cacheRead || 0) * (ap.inputCachePerM || 0) / 1e6 + (mv.cacheWrite || 0) * (ap.cacheWritePerM || 0) / 1e6 + (mv.output || 0) * (ap.outputPerM || 0) / 1e6;
  }
  if (price.slots && price.slots.length > 0) {
    const cur = hour !== undefined ? hour * 60 + 30 : (new Date().getHours() * 60 + 30);
    let slot = null;
    for (const s of price.slots) {
      const f = (s.from || "00:00").split(":").map(Number);
      const t = (s.to || "24:00").split(":").map(Number);
      const fs = f[0] * 60 + (f[1] || 0), ts = t[0] * 60 + (t[1] || 0);
      if (fs <= ts) { if (cur >= fs && cur < ts) { slot = s; break; } }
      else { if (cur >= fs || cur < ts) { slot = s; break; } }
    }
    if (slot) return calcCost(slot, mv);
    return 0;
  }
  const unit = price.unit || "token";
  if (unit === "per_call") return (mv.callCount || mv.assistantCount || 0) * (price.pricePerCall || 0);
  if (unit === "per_char") { const chars = (mv.output || 0) + (mv.input || 0); return chars * (price.pricePer10K || 0) / 10000; }
  return (mv.input || 0) * (price.inputPerM || 0) / 1e6 + (mv.cacheRead || 0) * (price.inputCachePerM || 0) / 1e6 + (mv.cacheWrite || 0) * (price.cacheWritePerM || 0) / 1e6 + (mv.output || 0) * (price.outputPerM || 0) / 1e6;
}

// 缓存汇率
let cachedRate = null;
let lastFetchTime = 0;
let inFlightFx = null;
const CACHE_DURATION = 6 * 60 * 60 * 1000;

const appTimeZone = (typeof process !== "undefined" && process?.env?.TOKEN_TRACKER_FORCE_TZ) || "Asia/Shanghai";

async function fetchFxRate(ctx) {
  const now = Date.now();
  if (cachedRate && (now - lastFetchTime < CACHE_DURATION)) {
    return cachedRate;
  }
  if (inFlightFx) {
    if (cachedRate) return cachedRate;
    return Promise.race([
      inFlightFx,
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
  }

  const triggerFetch = async () => {
    try {
      let data = null;
      if (ctx?.network?.fetch) {
        const resp = await ctx.network.fetch("https://open.er-api.com/v6/latest/USD", {
          method: "GET",
          headers: { Accept: "application/json" },
          timeoutMs: 3000,
        });
        if (resp && resp.ok) {
          data = await resp.json();
        }
      } else if (typeof globalThis.fetch === "function") {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = setTimeout(() => controller?.abort(), 3000);
        try {
          const resp = await globalThis.fetch("https://open.er-api.com/v6/latest/USD", {
            signal: controller?.signal,
          });
          if (resp && resp.ok) {
            data = await resp.json();
          }
        } finally {
          clearTimeout(timer);
        }
      } else {
        data = await new Promise((resolve) => {
          https.get("https://open.er-api.com/v6/latest/USD", { timeout: 3000 }, (res) => {
            let body = "";
            res.on("data", (chunk) => body += chunk);
            res.on("end", () => {
              try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
          }).on("error", () => resolve(null))
            .on("timeout", function() { this.destroy(); resolve(null); });
        });
      }
      if (data && data.result === "success" && data.rates && data.rates.CNY) {
        cachedRate = data.rates.CNY;
        lastFetchTime = Date.now();
      }
    } catch {
      // 保持降级
    } finally {
      inFlightFx = null;
    }
    return cachedRate;
  };

  inFlightFx = triggerFetch();
  if (cachedRate) {
    return cachedRate;
  }
  return Promise.race([
    inFlightFx,
    new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);
}

// ── 安全凭据脱敏函数（白名单过滤，不暴露任何私钥/Cookie/路径）──
function sanitizeBalanceApisForClient(balApis) {
  const safe = {};
  for (const [provId, conf] of Object.entries(balApis || {})) {
    if (!conf || typeof conf !== "object") continue;
    safe[provId] = {
      enabled: conf.enabled !== false,
      url: conf.url || "",
      workspaceId: conf.workspaceId || "",
      responseType: conf.responseType || "",
      configured: !!(conf.token || conf.cookie || conf.apiKey || conf.ak || conf.sk),
      hasToken: !!conf.token,
      hasCookie: !!conf.cookie,
      hasApiKey: !!conf.apiKey,
      token: conf.token ? "••••••••" : "",
      cookie: conf.cookie ? "••••••••" : "",
      apiKey: conf.apiKey ? "••••••••" : "",
      ak: conf.ak ? "••••••••" : "",
      sk: conf.sk ? "••••••••" : "",
    };
  }
  return safe;
}

export default function (app, ctx) {
  let sharedTurnsStore = null;
  const getTurnsStore = () => {
    if (ctx._tokenCache?.turnsStore) return ctx._tokenCache.turnsStore;
    if (sharedTurnsStore) return sharedTurnsStore;
    if (ctx.dataDir) {
      sharedTurnsStore = openTurnsStore({ file: path.join(ctx.dataDir, "cache.sqlite") });
      if (sharedTurnsStore && ctx._tokenCache) {
        ctx._tokenCache.turnsStore = sharedTurnsStore;
      }
      return sharedTurnsStore;
    }
    return null;
  };

  const codexQuotaService = new CodexQuotaService({
    bus: ctx.bus,
    network: ctx.network,
    fetchFn: globalThis.fetch,
    ttlMs: 60_000,
  });

  const deepseekBalanceService = new DeepSeekBalanceService({
    bus: ctx.bus,
    network: ctx.network,
    fetchFn: globalThis.fetch,
    ttlMs: 60_000,
    dataDir: ctx.dataDir,
  });

  // 数据接口处理器
  const handleData = async (c) => {
    try {
      const cache = ctx._tokenCache;
      if (!cache?.ready || !cache.data) {
        return c.json({ error: "数据未就绪", code: "NOT_READY", _status: trackerStatus(cache) }, 503);
      }

      const range = c.req.query("range") || "all";
      const agent = c.req.query("agent") || "";
      const model = c.req.query("model") || "";
      const type = c.req.query("type") || "";
      const from = c.req.query("from") || "";
      const to = c.req.query("to") || "";
      const provider = c.req.query("provider") || "";

      const fxRate = await fetchFxRate(ctx);
      const result = build(cache.data, range, { agent, model, type, provider, from, to }, fxRate);

      // Agent 名称与状态
      const activeAgentIds = new Set();
      try {
        const ar = typeof ctx.agents?.list === "function"
          ? await ctx.agents.list({ scope: "all" })
          : await ctx.bus.request("agent:list", { scope: "all" });
        if (ar?.agents && Array.isArray(ar.agents)) {
          const names = {};
          for (const a of ar.agents) {
            names[a.id] = a.name || a.id;
            activeAgentIds.add(a.id);
          }
          result.agentNames = { ...result.agentNames, ...names };
        }
      } catch (e) {
        // 保留现有 Agent 映射，不误标删除
      }
      for (const a of result.agents || []) {
        if (activeAgentIds.size > 0 && !activeAgentIds.has(a.id)) {
          a.deleted = true;
        }
      }

      // 获取当前活跃 Providers (通过官方公开 bus: model:list)
      const providers = [];
      let providerStateKnown = false;
      try {
        const modelRes = typeof ctx.models?.listAvailable === "function"
          ? await ctx.models.listAvailable()
          : await ctx.bus.request("model:list");
        if (modelRes?.models && Array.isArray(modelRes.models)) {
          providerStateKnown = true;
          for (const m of modelRes.models) {
            const pId = m.provider || (m.id && m.id.split("/")[0]) || "unknown";
            const mId = m.modelId || m.id || "unknown";
            let pItem = providers.find(p => p.id === pId);
            if (!pItem) {
              pItem = { id: pId, models: [] };
              providers.push(pItem);
            }
            if (!pItem.models.includes(mId)) pItem.models.push(mId);
          }
        }
      } catch (e) {}

      result._providerConfig = providers;
      result._providerStateKnown = providerStateKnown;

      applyDashboardOptions(result, providers, providerStateKnown);

      // 查询余额与凭据 (通过 ctx.bus.request("provider:credentials", { providerId }))
      result._balances = [];
      const balApis = loadBalanceApis(cache.dataDir || "");

      for (const prov of providers) {
        const apiConf = balApis[prov.id];
        if (!apiConf || !apiConf.url) {
          result._balances.push({ provider: prov.id, label: prov.id, type: "none", display: "未配置" });
          continue;
        }

        let apiKey = null;
        let credError = null;
        try {
          const credRes = typeof ctx.providers?.getCredentials === "function"
            ? await ctx.providers.getCredentials({ providerId: prov.id })
            : await ctx.bus.request("provider:credentials", { providerId: prov.id });
          if (credRes && !credRes.error && credRes.apiKey) {
            apiKey = credRes.apiKey;
          } else if (credRes?.error) {
            credError = credRes.error;
          }
        } catch (e) {
          credError = e.message;
        }

        if (credError) {
          result._balances.push({
            provider: prov.id,
            label: prov.id,
            type: "unauthorized",
            display: "未获授权读取凭据",
            error: credError
          });
          continue;
        }

        // 若用户在 balance-apis 自定义了有效 token/apiKey，允许回退
        if (!apiKey && apiConf.apiKey && apiConf.apiKey !== "••••••••") {
          apiKey = apiConf.apiKey;
        }

        if (!apiKey) {
          result._balances.push({
            provider: prov.id,
            label: prov.id,
            type: "no-key",
            display: "无 API Key"
          });
          continue;
        }

        const b = await Promise.race([
          (apiConf.responseType === "token-plan")
            ? fetchMinimaxTokenPlan(apiConf, apiKey)
            : fetchBalance(apiConf, apiKey),
          new Promise(r => setTimeout(() => r(null), 4000))
        ]);

        if (b) result._balances.push({ provider: prov.id, label: prov.id, ...b });
        else result._balances.push({ provider: prov.id, label: prov.id, type: "error", display: "查询失败", url: apiConf.url });
      }

      // 媒体任务统计（通过官方媒体 API）
      try {
        const mediaRes = await ctx.bus.request("media:task:list", { scope: "all" });
        if (mediaRes?.tasks && Array.isArray(mediaRes.tasks)) {
          const mgMap = {};
          for (const t of mediaRes.tasks) {
            const pId = t.providerId || t.provider || "default";
            const mId = t.modelId || t.model || "default";
            const key = `${pId}/${mId}`;
            if (!mgMap[key]) {
              mgMap[key] = {
                provider: pId,
                model: mId,
                kind: t.type === "video-generation" ? "video" : "image",
                callCount: 0,
                successCount: 0,
              };
            }
            mgMap[key].callCount++;
            if (t.status === "success" || t.status === "completed") {
              mgMap[key].successCount++;
            }
          }
          result.mediaGen = Object.values(mgMap);
        }
      } catch (e) {}

      // 模型费用与明细计算
      const pt = loadPriceTable(cache.dataDir || "");
      const modelCosts = [];
      const mgMap = {};
      for (const mg of result.mediaGen || []) {
        mgMap[mg.provider + "/" + mg.model] = mg;
      }

      for (const m of result.models || []) {
        let prov = "";
        for (const pc of providers) {
          if (pc.models.includes(m.id)) { prov = pc.id; break; }
        }
        let key = prov + "/" + m.id;
        let price = pt[key];
        if (!price && pt) {
          for (const pk of Object.keys(pt)) {
            if (pk.endsWith("/" + m.id)) { price = pt[pk]; key = pk; prov = pk.split("/")[0]; break; }
          }
        }
        const mgEntry = mgMap[key];
        const mv = (price?.unit === "per_call" && mgEntry) ? { ...m, callCount: mgEntry.callCount } : m;
        const unit = price?.unit || "token";
        let inputCost = 0, outputCost = 0, cacheCost = 0;
        if (price && unit === "token") {
          const mvc = { input: m.input || 0, output: m.output || 0, cacheRead: m.cacheRead || 0, cacheWrite: m.cacheWrite || 0, assistantCount: m.assistantCount || 0, callCount: m.assistantCount || 0 };
          const tp = pickPrice(price, mvc, 12);
          if ((tp.unit || "token") === "token") {
            inputCost = mvc.input * (tp.inputPerM || 0) / 1e6;
            outputCost = mvc.output * (tp.outputPerM || 0) / 1e6;
            cacheCost = mvc.cacheRead * (tp.inputCachePerM || 0) / 1e6 + mvc.cacheWrite * (tp.cacheWritePerM || 0) / 1e6;
          } else {
            const tot = calcCost(price, mvc, 12);
            inputCost = tot; outputCost = 0; cacheCost = 0;
          }
        }
        const estimatedCost = (unit === "token" && price) ? (inputCost + outputCost + cacheCost) : calcCost(price, mv);
        modelCosts.push({
          model: m.id,
          provider: prov,
          cost: estimatedCost,
          estimatedCost,
          costSource: "local-estimate",
          priced: !!price,
          totalTokens: m.totalTokens || 0,
          unit,
          inputCost,
          outputCost,
          cacheCost,
          callCount: m.assistantCount || mgEntry?.callCount || 0,
          successCount: mgEntry?.successCount || 0,
          currency: price?.currency || "USD"
        });
      }
      result._modelCosts = modelCosts;
      result._status = trackerStatus(cache);

      // 附加价格表与脱敏后的余额配置
      result._priceTable = pt;
      result._balanceApis = sanitizeBalanceApisForClient(balApis);
      result._fxRate = fxRate;

      // 覆盖限制标记（窗口达 20000 提醒）
      result._coverageLimitReached = !!cache.data?.coverageLimitReached;
      result._coverageNotice = cache.data?.coverageLimitReached
        ? "账本读取窗口达 20,000 条；历史仅包含插件已采集并归档的记录。"
        : null;

      // 异步尝试获取 Codex 额度（复用 60s 内存防刷缓存，失败优雅降级）
      try {
        result.codexQuota = await codexQuotaService.getQuota();
      } catch {
        result.codexQuota = { connected: false, reason: "error", message: "Codex 额度读取异常" };
      }

      return c.json(result);
    } catch (e) {
      return c.json({ error: e.message || "请求处理异常", code: "INTERNAL_ERROR" }, 500);
    }
  };

  // Codex 额度查询处理器（独立轻量接口）
  const handleCodexQuota = async (c) => {
    try {
      const force = c.req.query("force") === "1" || c.req.query("refresh") === "1";
      const quota = await codexQuotaService.getQuota({ force });
      return c.json(quota);
    } catch (e) {
      return c.json({ connected: false, reason: "error", message: e.message || "Codex 额度查询失败" }, 200);
    }
  };

  // DeepSeek 余额查询处理器（独立轻量接口）
  const handleDeepseekBalance = async (c) => {
    try {
      const force = c.req.query("force") === "1" || c.req.query("refresh") === "1";
      const balance = await deepseekBalanceService.getBalance({ force });
      return c.json(balance);
    } catch (e) {
      return c.json({ connected: false, reason: "error", message: e.message || "DeepSeek 余额查询失败" }, 200);
    }
  };

  // 刷新接口处理器
  const handleRefresh = async (c) => {
    try {
      const tk = ctx._tokenCache;
      const force = c.req.query("force") === "1";
      if (force && tk?.fullScan) {
        await tk.fullScan();
        return c.json({ ok: true, lastScan: tk.data?.lastScan, full: true });
      }
      if (tk?.scan) {
        await tk.scan(false);
        return c.json({ ok: true, lastScan: tk.data?.lastScan, full: false });
      }
      return c.json({ error: "unavailable", code: "SERVICE_UNAVAILABLE" }, 503);
    } catch (err) {
      return c.json({ error: err.message, code: "REFRESH_ERROR" }, 500);
    }
  };

  // 价格表 GET / POST
  const handleGetPriceTable = (c) => {
    const tk = ctx._tokenCache;
    const pt = loadPriceTable(tk?.dataDir || "");
    return c.json(pt);
  };

  const handlePostPriceTable = async (c) => {
    try {
      const body = await c.req.json();
      const tk = ctx._tokenCache;
      const p = path.join(tk?.dataDir || "", "price-table.json");
      fs.writeFileSync(p, JSON.stringify(body, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e.message, code: "SAVE_ERROR" }, 500);
    }
  };

  // 余额配置 GET / POST（带掩码保护）
  const handleGetSettings = async (c) => {
    try {
      const dataDir = ctx.dataDir || ctx._tokenCache?.dataDir || "";
      const settings = ctx._tokenCache?.settings || await loadSettings(dataDir, ctx.config);
      return c.json(settings);
    } catch (err) {
      return c.json({ error: "获取设置失败: " + err.message }, 500);
    }
  };

  const handlePostSettings = async (c) => {
    try {
      const body = await c.req.json();
      const dataDir = ctx.dataDir || ctx._tokenCache?.dataDir || "";
      const updated = await saveSettings(dataDir, body);
      if (ctx._tokenCache) {
        ctx._tokenCache.settings = updated;
        if (ctx._tokenCache.scheduler?.updateInterval) {
          ctx._tokenCache.scheduler.updateInterval(updated.scanInterval * 1000);
        }
      }
      return c.json({ ok: true, settings: updated });
    } catch (err) {
      return c.json({ error: "保存设置失败: " + err.message }, 500);
    }
  };

  const handleGetBalanceApis = (c) => {
    const tk = ctx._tokenCache;
    const raw = loadBalanceApis(tk?.dataDir || "");
    return c.json(sanitizeBalanceApisForClient(raw));
  };

  const handlePostBalanceApis = async (c) => {
    try {
      const incoming = await c.req.json();
      const tk = ctx._tokenCache;
      const dataDir = tk?.dataDir || "";
      const p = path.join(dataDir, "balance-apis.json");
      const existing = loadBalanceApis(dataDir);
      const merged = { ...existing };

      for (const [provId, conf] of Object.entries(incoming || {})) {
        if (!conf || typeof conf !== "object") continue;
        const oldConf = existing[provId] || {};
        const newConf = { ...conf };
        // 凭据保护：掩码或空白值不覆盖原值
        for (const k of ["token", "cookie", "apiKey", "ak", "sk"]) {
          if (newConf[k] === "••••••••" || (!newConf[k] && oldConf[k])) {
            newConf[k] = oldConf[k];
          }
        }
        merged[provId] = newConf;
      }

      fs.writeFileSync(p, JSON.stringify(merged, null, 2), "utf-8");
      return c.json({ ok: true, data: sanitizeBalanceApisForClient(merged) });
    } catch (e) {
      return c.json({ error: e.message, code: "SAVE_ERROR" }, 500);
    }
  };

  // 按需获取对话记录（按需下钻，需 app/sessions.read）
  const handleSessionDetail = async (c) => {
    try {
      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return c.json({ error: "missing_sessionId", message: "缺少 sessionId 参数" }, 400);
      }
      const history = typeof ctx.sessions?.history === "function"
        ? await ctx.sessions.history({ sessionId, scope: "all" })
        : await ctx.bus.request("session:history", { sessionId, scope: "all" });
      return c.json({
        sessionId,
        messages: history?.messages || [],
      });
    } catch (e) {
      return c.json({
        error: "session_detail_forbidden",
        message: "无法获取会话对话历史（可能未授予 app/sessions.read 权限）: " + e.message
      }, 403);
    }
  };

  // Widget 实时数据流 (SSE)
  const handleWidgetStream = (c) => {
    const cache = ctx._tokenCache;
    let clientObj = null;
    const stream = new ReadableStream({
      start(controller) {
        clientObj = {
          send: (data) => {
            try {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
            } catch (err) {}
          },
          close: () => {
            try { controller.close(); } catch (err) {}
          }
        };
        cache?._realtimeClients?.add(clientObj);
      },
      cancel() {
        if (clientObj) cache?._realtimeClients?.delete(clientObj);
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  };

  // Widget 数据快照
  const handleWidgetData = (c) => {
    const cache = ctx._tokenCache;
    if (!cache?.realtime) return c.json({ error: "no_data" }, 503);
    const snap = cache.realtimeSnapshot
      ? cache.realtimeSnapshot(cache.realtime, cache.data?.agentNames || {})
      : { ...cache.realtime };
    if (cache.data?._balances) snap.balances = cache.data._balances;
    return c.json(snap);
  };

  // 轮次细粒度明细查询接口
  const handleTurns = async (c) => {
    try {
      const cache = ctx._tokenCache;
      const store = getTurnsStore();
      const from = c.req.query("from") || "";
      const to = c.req.query("to") || "";
      const agent = c.req.query("agent") || "";
      const model = c.req.query("model") || "";
      const provider = c.req.query("provider") || "";
      const type = c.req.query("type") || "";
      const minTokens = Number(c.req.query("minTokens")) || 0;
      const sortKey = c.req.query("sortKey") || "time";
      const order = c.req.query("order") || "desc";
      const page = Math.max(1, Number(c.req.query("page")) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize")) || 50));

      let res = store ? queryTurns(store, {
        from, to, agent, model, provider, type, minTokens,
        sortKey, order,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }) : { rows: [], total: 0, sumTokens: 0 };

      // 回退兼容：若 turns 表暂无数据，从 sessions.conversations 动态回退
      if ((!res.rows || res.rows.length === 0) && cache?.data?.sessions) {
        const rows = [];
        for (const [key, s] of Object.entries(cache.data.sessions)) {
          if (agent && s.agent !== agent) continue;
          if (type && s.type !== type) continue;
          for (let i = 0; i < (s.conversations || []).length; i++) {
            const cv = s.conversations[i];
            if (model && cv.model !== model) continue;
            if (provider && cv.provider !== provider) continue;
            const day = cv.time ? cv.time.slice(0, 10) : "";
            if (from && day < from) continue;
            if (to && day > to) continue;
            const total = Number(cv.totalTokens || 0);
            if (minTokens && total < minTokens) continue;
            rows.push({
              sessionKey: key,
              seq: i + 1,
              at: cv.time || "",
              day,
              agent: s.agent || "",
              type: s.type || "",
              provider: cv.provider || "",
              model: cv.model || "",
              total,
              input: cv.inTokens ?? cv.inputTokens ?? 0,
              output: cv.outTokens ?? cv.outputTokens ?? 0,
              cacheRead: cv.cacheRead ?? 0,
              calls: cv.msgCount ?? 1,
            });
          }
        }
        const total = rows.length;
        const sumTokens = rows.reduce((acc, r) => acc + r.total, 0);
        if (sortKey === "tokens") rows.sort((a, b) => b.total - a.total);
        else if (sortKey === "uncached") rows.sort((a, b) => (b.input || 0) - (a.input || 0));
        else if (sortKey === "hit") {
          const hit = (r) => {
            const tot = (r.input || 0) + (r.cacheRead || 0);
            return tot > 0 ? (r.cacheRead || 0) / tot : -1;
          };
          rows.sort((a, b) => hit(b) - hit(a));
        }
        else rows.sort((a, b) => b.at.localeCompare(a.at));
        const paged = rows.slice((page - 1) * pageSize, page * pageSize);
        res = { rows: paged, total, sumTokens };
      }

      const totalPages = Math.max(1, Math.ceil(res.total / pageSize));
      return c.json({
        rows: res.rows,
        total: res.total,
        sumTokens: res.sumTokens,
        page,
        pageSize,
        totalPages,
      });
    } catch (err) {
      return c.json({ error: err.message, code: "TURNS_ERROR" }, 500);
    }
  };

  // 轮次明细 CSV 导出接口
  const getTurnsCsv = (c) => {
    const cache = ctx._tokenCache;
    const store = getTurnsStore();
    const from = c.req.query("from") || "";
    const to = c.req.query("to") || "";
    const agent = c.req.query("agent") || "";
    const model = c.req.query("model") || "";
    const provider = c.req.query("provider") || "";
    const type = c.req.query("type") || "";
    const minTokens = Number(c.req.query("minTokens")) || 0;
    const sortKey = c.req.query("sortKey") || "time";
    const order = c.req.query("order") || "desc";

    let rows = [];
    if (store) {
      const res = queryTurns(store, { from, to, agent, model, provider, type, minTokens, sortKey, order, all: true });
      rows = res.rows || [];
    }
    if (!rows.length && cache?.data?.sessions) {
      for (const [key, s] of Object.entries(cache.data.sessions)) {
        if (agent && s.agent !== agent) continue;
        if (type && s.type !== type) continue;
        for (let i = 0; i < (s.conversations || []).length; i++) {
          const cv = s.conversations[i];
          if (model && cv.model !== model) continue;
          if (provider && cv.provider !== provider) continue;
          const day = cv.time ? cv.time.slice(0, 10) : "";
          if (from && day < from) continue;
          if (to && day > to) continue;
          const total = Number(cv.totalTokens || 0);
          if (minTokens && total < minTokens) continue;
          rows.push({
            sessionKey: key,
            seq: i + 1,
            at: cv.time || "",
            day,
            agent: s.agent || "",
            type: s.type || "",
            provider: cv.provider || "",
            model: cv.model || "",
            total,
            input: cv.inTokens ?? cv.inputTokens ?? 0,
            output: cv.outTokens ?? cv.outputTokens ?? 0,
            cacheRead: cv.cacheRead ?? 0,
            calls: cv.msgCount ?? 1,
          });
        }
      }
      if (sortKey === "tokens") rows.sort((a, b) => b.total - a.total);
      else if (sortKey === "uncached") rows.sort((a, b) => (b.input || 0) - (a.input || 0));
      else if (sortKey === "hit") {
        const hit = (r) => {
          const tot = (r.input || 0) + (r.cacheRead || 0);
          return tot > 0 ? (r.cacheRead || 0) / tot : -1;
        };
        rows.sort((a, b) => hit(b) - hit(a));
      }
      else rows.sort((a, b) => b.at.localeCompare(a.at));
    }
    return { csv: buildDetailsCSV(rows), rowCount: rows.length };
  };

  const handleTurnsCsv = async (c) => {
    try {
      const { csv } = getTurnsCsv(c);
      return c.text(csv, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="token-turns.csv"`,
      });
    } catch (err) {
      return c.text("导出失败: " + err.message, 500);
    }
  };

  const handleTurnsExport = async (c) => {
    try {
      if (!ctx._tokenCache?.ready) return c.json({ error: "数据未就绪，请稍后重试" }, 503);
      const { csv, rowCount } = getTurnsCsv(c);
      const receipt = await saveTurnsExport({ dataDir: ctx.dataDir, csv, rowCount });
      return c.json(receipt);
    } catch (error) {
      return c.json({ error: "保存 CSV 失败: " + error.message }, 500);
    }
  };

  // 兼容直接加载 HTML 路由（统一模板渲染，解耦版本硬编码）
  const handleDashboardHtml = (c) => {
    const th = c.req.query("hana-theme") || "inherit";
    return c.html(renderDashboardHtml({
      version: UI_VERSION,
      theme: th,
      basePath: "/api/apps/token-tracker/ui",
      standalone: true,
    }));
  };

  // 路由挂载（同时兼容 /dashboard/* 与标准根路由）
  app.get("/dashboard/data", handleData);
  app.get("/data", handleData);
  app.get("/status", c => c.json(trackerStatus(ctx._tokenCache)));
  app.get("/dashboard/status", c => c.json(trackerStatus(ctx._tokenCache)));

  app.get("/dashboard/turns", handleTurns);
  app.get("/turns", handleTurns);
  app.get("/dashboard/turns/csv", handleTurnsCsv);
  app.get("/turns/csv", handleTurnsCsv);
  app.post("/dashboard/turns/export", handleTurnsExport);
  app.post("/turns/export", handleTurnsExport);

  app.post("/dashboard/refresh", handleRefresh);
  app.post("/refresh", handleRefresh);

  app.get("/dashboard/price-table", handleGetPriceTable);
  app.get("/price-table", handleGetPriceTable);
  app.post("/dashboard/price-table", handlePostPriceTable);
  app.post("/price-table", handlePostPriceTable);

  app.get("/dashboard/balance-apis", handleGetBalanceApis);
  app.get("/balance-apis", handleGetBalanceApis);
  app.post("/dashboard/balance-apis", handlePostBalanceApis);
  app.post("/balance-apis", handlePostBalanceApis);

  app.get("/dashboard/settings", handleGetSettings);
  app.get("/settings", handleGetSettings);
  app.post("/dashboard/settings", handlePostSettings);
  app.post("/settings", handlePostSettings);

  app.get("/dashboard/session/detail", handleSessionDetail);
  app.get("/session/detail", handleSessionDetail);

  app.get("/dashboard/codex-quota", handleCodexQuota);
  app.get("/codex-quota", handleCodexQuota);

  app.get("/dashboard/deepseek-balance", handleDeepseekBalance);
  app.get("/deepseek-balance", handleDeepseekBalance);

  app.get("/widget/stream", handleWidgetStream);
  app.get("/widget/data", handleWidgetData);

  app.get("/dashboard", handleDashboardHtml);
  app.get("/dashboard-v:version.html", handleDashboardHtml);
  app.get("/ui/dashboard-v:version.html", handleDashboardHtml);
}

// ─── 数据聚合与统计逻辑 ───
function build(cache, range = "all", filters = {}, fxRate = null) {
  const appTimeZone = (typeof process !== "undefined" && process?.env?.TOKEN_TRACKER_FORCE_TZ) || "Asia/Shanghai";
  const priceTable = loadPriceTable(cache.dataDir || "");
  let sessions = Object.values(cache.sessions || {});
  let earliest = null;
  for (const s of sessions) {
    if (s.firstTime) {
      const d = s.firstTime.slice(0, 10);
      if (!earliest || d < earliest) earliest = d;
    }
  }

  let dateFilter = null;
  const now = new Date();
  const cnTodayStr = new Intl.DateTimeFormat("en-CA", { timeZone: appTimeZone }).format(now);

  if (range === "today") {
    dateFilter = (d) => d === cnTodayStr;
  } else if (range === "week") {
    const day = now.getDay();
    const ws = new Date(now);
    ws.setDate(ws.getDate() - ((day + 6) % 7));
    const weekStart = new Intl.DateTimeFormat("en-CA", { timeZone: appTimeZone }).format(ws);
    dateFilter = (d) => d >= weekStart;
  } else if (range === "month") {
    const monthStart = cnTodayStr.slice(0, 7) + "-01";
    dateFilter = (d) => d >= monthStart;
  } else if (range === "year") {
    const yearStart = cnTodayStr.slice(0, 4) + "-01-01";
    dateFilter = (d) => d >= yearStart;
  } else if (range === "lyear") {
    const ly = parseInt(cnTodayStr.slice(0, 4), 10) - 1;
    const ls = ly + "-01-01", le = ly + "-12-31";
    dateFilter = (d) => d >= ls && d <= le;
  }

  const { agent: filterAgent, model: filterModel, type: filterType, provider: filterProvider, from, to } = filters;
  if (filterAgent) sessions = sessions.filter((s) => s.agent === filterAgent);
  if (filterProvider) sessions = sessions.filter((s) => s.providers && Object.keys(s.providers).some((pk) => pk.startsWith(filterProvider + "/")));
  if (filterType) sessions = sessions.filter((s) => s.type === filterType);
  if (from || to) {
    const orig = dateFilter;
    dateFilter = (d) => (!from || d >= from) && (!to || d <= to) && (!orig || orig(d));
  }

  // Daily and hourly buckets carry the same model/provider dimensions.
  // Select their intersection once, without falling back to unfiltered totals.
  function selectedModels(bucket) {
    if (!filterProvider) return Object.entries(bucket.models || {}).filter(([model]) => !filterModel || model === filterModel);
    const prefix = filterProvider + "/";
    return Object.entries(bucket.providerTotals || {})
      .filter(([key]) => key.startsWith(prefix) && (!filterModel || key === prefix + filterModel))
      .map(([key, stats]) => [key.slice(prefix.length), stats]);
  }
  function selectedStats(bucket) {
    if (!filterModel && !filterProvider) return bucket;
    const result = { input: 0, output: 0, cacheRead: 0, totalTokens: 0, assistantCount: 0 };
    for (const [, stats] of selectedModels(bucket)) {
      for (const key of Object.keys(result)) result[key] += stats[key] || 0;
    }
    return result;
  }

  const sessionPool = sessions;
  if (filterModel) {
    sessions = sessions.filter((s) => s.models?.[filterModel]);
  }

  const agentMap = {};
  const modelMap = {};
  const dailyMap = {};
  const providerMap = Object.create(null);
  const sums = {
    totalInput: 0,
    totalOutput: 0,
    totalTokens: 0,
    totalCacheRead: 0,
    totalAssistant: 0,
    totalDesktop: 0,
    totalChannel: 0,
    totalBridge: 0,
    totalBackground: 0,
    totalSub: 0,
    totalLedger: 0,
  };

  for (const s of sessions) {
    const a = s.agent;
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(day)) continue;
      const stats = selectedStats(d);
      const di = stats.input || 0, dout = stats.output || 0, dcr = stats.cacheRead || 0;
      const dtot = stats.totalTokens || 0, dasst = stats.assistantCount || 0;

      if (!agentMap[a]) {
        agentMap[a] = {
          input: 0, output: 0, totalTokens: 0, cacheRead: 0, assistantCount: 0,
          desktopTotal: 0, channelTotal: 0, bridgeTotal: 0, backgroundTotal: 0, subTotal: 0, ledgerTotal: 0, models: {},
        };
      }
      agentMap[a].input += di; agentMap[a].output += dout; agentMap[a].totalTokens += dtot; agentMap[a].cacheRead += dcr;
      agentMap[a].assistantCount += dasst;
      if (s.type === "desktop") agentMap[a].desktopTotal += dtot;
      else if (s.type === "bridge") agentMap[a].bridgeTotal += dtot;
      else if (s.type === "background") agentMap[a].backgroundTotal += dtot;
      else if (s.type === "sub") agentMap[a].subTotal += dtot;
      else if (s.type === "ledger") agentMap[a].ledgerTotal += dtot;
      else agentMap[a].channelTotal += dtot;

      if (!dailyMap[day]) {
        dailyMap[day] = { totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0, cacheRead: 0, assistantCount: 0 };
      }
      dailyMap[day].totalTokens += dtot; dailyMap[day].cacheRead += dcr;
      dailyMap[day].assistantCount += dasst;
      if (s.type === "desktop") dailyMap[day].desktop += dtot;
      else if (s.type === "bridge") dailyMap[day].bridge += dtot;
      else if (s.type === "background") dailyMap[day].background += dtot;
      else if (s.type === "sub") dailyMap[day].sub += dtot;
      else if (s.type === "ledger") dailyMap[day].ledger += dtot;
      else dailyMap[day].channel += dtot;

      sums.totalInput += di; sums.totalOutput += dout; sums.totalTokens += dtot; sums.totalCacheRead += dcr;
      sums.totalAssistant += dasst;
      if (s.type === "desktop") sums.totalDesktop += dtot;
      else if (s.type === "bridge") sums.totalBridge += dtot;
      else if (s.type === "background") sums.totalBackground += dtot;
      else if (s.type === "sub") sums.totalSub += dtot;
      else if (s.type === "ledger") sums.totalLedger += dtot;
      else sums.totalChannel += dtot;

      for (const [key, stats] of Object.entries(d.providerTotals || {})) {
        const slash = key.indexOf('/');
        if (slash < 1) continue;
        const provider = key.slice(0, slash), model = key.slice(slash + 1);
        if (filterProvider && provider !== filterProvider || filterModel && model !== filterModel) continue;
        const row = providerMap[provider] ||= { provider, totalTokens: 0, count: 0 };
        row.totalTokens += stats.totalTokens || 0;
        row.count += stats.assistantCount || 0;
      }

      // 聚合 model
      for (const [mName, mData] of selectedModels(d)) {
        if (!modelMap[mName]) modelMap[mName] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, assistantCount: 0 };
        modelMap[mName].input += mData.input || 0;
        modelMap[mName].output += mData.output || 0;
        modelMap[mName].cacheRead += mData.cacheRead || 0;
        modelMap[mName].cacheWrite += mData.cacheWrite || 0;
        modelMap[mName].totalTokens += mData.totalTokens || 0;
        modelMap[mName].assistantCount += mData.assistantCount || 0;
      }
    }
  }

  // 排序 Agents
  const agents = Object.entries(agentMap).map(([id, d]) => ({
    id,
    name: cache.agentNames?.[id] || id,
    ...d,
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  // 排序 Models
  const models = Object.entries(modelMap).map(([id, d]) => ({
    id,
    ...d,
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  // 侧边栏 Agent 筛选选项：只保留当前已注册的 Agent，不展示历史已删除/已停用 Agent
  const configuredAgentNames = cache.agentNames || {};
  const configuredAgentIds = Object.keys(configuredAgentNames);
  const activeAgentList = (configuredAgentIds.length > 0 ? configuredAgentIds : Object.keys(agentMap))
    .map((id) => ({
      id,
      name: configuredAgentNames[id] || id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const agentOptions = activeAgentList;

  const modelOptions = Array.from(new Set(sessionPool.flatMap((s) => Object.keys(s.models || {})))).sort();
  const providerOptions = [...new Set(Object.values(cache.sessions || {}).flatMap(s => Object.values(s.providers || {}).map(p => p.provider)).filter(Boolean))].map(provider => ({provider}));

  // 日期趋势
  const daily = Object.entries(dailyMap).map(([date, d]) => ({
    date,
    ...d,
  })).sort((a, b) => a.date.localeCompare(b.date));

  // 30 天用量热力矩阵数据（不受 range 时间范围截断，但继承当前所选 agent/model/provider/type 筛选）
  const daily30Map = {};
  const d30Keys = [];
  for (let i = 29; i >= 0; i--) {
    const dObj = new Date(now);
    dObj.setDate(dObj.getDate() - i);
    const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: appTimeZone }).format(dObj);
    d30Keys.push(dateKey);
    daily30Map[dateKey] = {
      date: dateKey,
      totalTokens: 0,
      desktop: 0,
      channel: 0,
      bridge: 0,
      background: 0,
      sub: 0,
      ledger: 0,
      cacheRead: 0,
      assistantCount: 0,
    };
  }
  for (const s of sessions) {
    for (const [day, bd] of Object.entries(s.dailyBreakdown || {})) {
      if (!daily30Map[day]) continue;
      const stats = selectedStats(bd);
      const dtot = stats.totalTokens || 0;
      const dcr = stats.cacheRead || 0;
      const dasst = stats.assistantCount || 0;
      daily30Map[day].totalTokens += dtot;
      daily30Map[day].cacheRead += dcr;
      daily30Map[day].assistantCount += dasst;
      if (s.type === "desktop") daily30Map[day].desktop += dtot;
      else if (s.type === "bridge") daily30Map[day].bridge += dtot;
      else if (s.type === "background") daily30Map[day].background += dtot;
      else if (s.type === "sub") daily30Map[day].sub += dtot;
      else if (s.type === "ledger") daily30Map[day].ledger += dtot;
      else daily30Map[day].channel += dtot;
    }
  }
  const daily30 = d30Keys.map((k) => daily30Map[k]);

  // Single-day views use the selected day; other views expose today's hours.
  const hourlyDay = from && from === to ? from : cnTodayStr;
  const hourlyMap = {};
  for (let h = 0; h < 24; h++) {
    const hs = String(h).padStart(2, "0");
    hourlyMap[hs] = { hour: hs, totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0, cacheRead: 0, assistantCount: 0 };
  }
  for (const s of sessions) {
    if (dateFilter && !dateFilter(hourlyDay)) continue;
    const todayHours = s.hourlyBreakdown?.[hourlyDay];
    if (!todayHours) continue;
    for (const [hs, hd] of Object.entries(todayHours)) {
      if (!hourlyMap[hs]) continue;
      const stats = selectedStats(hd);
      const t = stats.totalTokens || 0;
      hourlyMap[hs].totalTokens += t;
      hourlyMap[hs].cacheRead += stats.cacheRead || 0;
      hourlyMap[hs].assistantCount += stats.assistantCount || 0;
      if (s.type === "desktop") hourlyMap[hs].desktop += t;
      else if (s.type === "bridge") hourlyMap[hs].bridge += t;
      else if (s.type === "background") hourlyMap[hs].background += t;
      else if (s.type === "sub") hourlyMap[hs].sub += t;
      else if (s.type === "ledger") hourlyMap[hs].ledger += t;
      else hourlyMap[hs].channel += t;
    }
  }
  const hourly = Object.values(hourlyMap).sort((a, b) => a.hour.localeCompare(b.hour));

  // 估算费用
  let estimatedCost = 0;
  for (const m of models) {
    let price = priceTable[m.id];
    if (!price) {
      for (const pk of Object.keys(priceTable)) {
        if (pk.endsWith("/" + m.id)) { price = priceTable[pk]; break; }
      }
    }
    estimatedCost += calcCost(price, m);
  }

  return {
    lastScan: cache.lastScan,
    agentNames: cache.agentNames || {},
    earliest,
    summary: {
      ...sums,
      cacheHitRate: sums.totalTokens > 0 ? +((sums.totalCacheRead / sums.totalTokens * 100).toFixed(1)) : 0,
      estimatedCost,
    },
    agents,
    agentOptions,
    models,
    modelOptions,
    providers: Object.values(providerMap).sort((a,b)=>b.totalTokens-a.totalTokens),
    providerOptions,
    daily,
    daily30,
    hourly,
    prediction: buildPredictionResponse(cache, daily),
    visualAnalytics: typeof buildVisualAnalytics === "function" ? buildVisualAnalytics(sessions, dateFilter, filters) : null,
  };
}

// 预测计算
function buildPredictionResponse(cache, daily) {
  const p = cache.prediction;
  if (!p) return null;
  const appTimeZone = (typeof process !== "undefined" && process?.env?.TOKEN_TRACKER_FORCE_TZ) || "Asia/Shanghai";
  const base = {
    dailyAvg: p.dailyAvg,
    monthToDate: p.monthToDate,
    daysLeftInMonth: p.daysLeftInMonth,
    projectedMonthEnd: p.projectedMonthEnd,
  };
  if (!p.cumulativePct) return { ...base, predictedToday: p.dailyAvg, trend: "持平" };

  const now = new Date();
  const cnParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: appTimeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  let curHour = 0, curMinute = 0;
  for (const part of cnParts) {
    if (part.type === "hour") curHour = parseInt(part.value, 10) % 24;
    if (part.type === "minute") curMinute = parseInt(part.value, 10);
  }

  const pPrev = curHour > 0 ? p.cumulativePct[curHour - 1] : 0;
  const pCur = p.cumulativePct[curHour];
  const pNow = pPrev + (pCur - pPrev) * (curMinute / 60);

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: appTimeZone }).format(now);
  const todayEntry = daily.find((d) => d.date === today);
  const todayTokens = todayEntry ? todayEntry.totalTokens : 0;

  let predictedToday;
  if (pNow < 0.001 || todayTokens === 0) {
    predictedToday = p.dailyAvg;
  } else {
    const raw = todayTokens / pNow;
    const maxRemaining = p.dailyAvg * (1 - pNow) * 1.5;
    predictedToday = Math.min(raw, todayTokens + maxRemaining);
  }
  predictedToday = Math.round(predictedToday);

  const expected = p.dailyAvg * pNow;
  let trend;
  if (todayTokens > expected * 1.05) trend = "上升";
  else if (todayTokens < expected * 0.95) trend = "下降";
  else trend = "持平";

  return { ...base, predictedToday, trend };
}

// 价格表与余额配置加载
function loadPriceTable(dataDir) {
  const p = path.join(dataDir, "price-table.json");
  const pt = { ...DEFAULT_PRICE_TABLE };
  try {
    if (fs.existsSync(p)) {
      const custom = JSON.parse(fs.readFileSync(p, "utf-8"));
      Object.assign(pt, custom);
    }
  } catch (e) {}
  return pt;
}

const DEFAULT_BALANCE_APIS = {
  deepseek: { url: "https://api.deepseek.com/user/balance" },
  glm: { url: "https://open.bigmodel.cn/api/paas/v4/users/me/balance" },
  moonshot: { url: "https://api.moonshot.cn/v1/users/me/balance" },
  minimax: { url: "https://api.minimaxi.com/v1/user/balance" },
  "minimax-token-plan": {
    url: "https://api.minimaxi.com/v1/token_plan/remains",
    responseType: "token-plan"
  },
};

function loadBalanceApis(dataDir) {
  const p = path.join(dataDir, "balance-apis.json");
  const saved = {};
  try {
    if (fs.existsSync(p)) Object.assign(saved, JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch {}
  return { ...DEFAULT_BALANCE_APIS, ...saved };
}

async function fetchBalance(apiConfig, apiKey) {
  return new Promise((resolve) => {
    const req = https.get(apiConfig.url, {
      headers: { "Authorization": "Bearer " + apiKey, "Accept": "application/json" }
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          if (d.balance_infos && d.balance_infos.length) {
            let total = 0; const details = [];
            for (const bi of d.balance_infos) {
              const t = parseFloat(bi.total_balance) || 0;
              total += t;
              details.push({ label: bi.label || "余额", amount: t, currency: bi.currency || "CNY" });
            }
            resolve({ type: "money", total, currency: "CNY", display: "¥" + total.toFixed(2), details });
          } else if (d.success && d.data?.limits) {
            const tokenLimit = d.data.limits.find((l) => l.type === "TOKENS_LIMIT");
            if (tokenLimit && typeof tokenLimit.percentage === "number") {
              const remain = 100 - tokenLimit.percentage;
              resolve({ type: "quota", remain, used: tokenLimit.percentage, display: "剩余 " + remain.toFixed(0) + "%" });
            } else resolve(null);
          } else {
            const avail = parseFloat(d.data?.available_balance ?? d.data?.balance ?? d.available_balance ?? d.balance ?? d.total_balance) || 0;
            if (avail > 0 || d.data || d.balance !== undefined) {
              resolve({ type: "money", total: avail, currency: d.currency || "CNY", display: "¥" + avail.toFixed(2) });
            } else resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchMinimaxTokenPlan(apiConfig, apiKey) {
  if (!apiKey) return Promise.resolve({ type: "error", display: "API Key 为空" });
  return new Promise((resolve) => {
    const req = https.get(apiConfig.url, {
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Accept": "application/json",
      }
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          if (!d || d.base_resp?.status_code !== 0) {
            resolve({ type: "error", display: d?.base_resp?.status_msg || "查询失败" });
            return;
          }
          resolve({ type: "token-plan", display: "已获取" });
        } catch (e) {
          resolve({ type: "error", display: "解析失败" });
        }
      });
    });
    req.on("error", () => resolve({ type: "error", display: "网络错误" }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ type: "error", display: "请求超时" }); });
  });
}

function esc(v) {
  return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
