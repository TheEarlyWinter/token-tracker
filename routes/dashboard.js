import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// OpenCode Go 官方定价表（opencode.ai/docs/go 校验，2026-08）
// 价格口径：全部为 OpenCode Go 官方美元价（含 DeepSeek）
// monthlyAllowance：OpenCode Go 各模型每月使用额度（美元，官方 docs「使用额度」列）
// contextTiers：长上下文分档价格（超过 maxContext tokens 用该档，如 Luna >272K、Qwen >256K）
// cacheWritePerM：缓存写入价（官方 docs「缓存写入」列，无 - 的模型为 0）
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

// 选择实际计费档位：长上下文分档（按平均单次输入 token 估算，插件无单次请求明细）→ 特殊时段
function pickPrice(price, mv, hour) {
  if (!price) return null;
  if (price.defaultPrice === undefined) return price;
  let ap = price.defaultPrice;
  // 长上下文分档：avgInputPerCall 超过阈值走高档（maxContext 为该档下限，多档取最高匹配档，不依赖配置顺序）
  if (price.contextTiers && price.contextTiers.length) {
    // 长上下文场景缓存命中占大头，用 input+cacheRead 反映总上下文量级，避免高档永不触发
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
      const f = (s.from||"00:00").split(":").map(Number);
      const t = (s.to||"24:00").split(":").map(Number);
      const fs = f[0]*60+(f[1]||0), ts = t[0]*60+(t[1]||0);
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
  // 新格式：defaultPrice（非特殊时段）+ slots（特殊时段）+ contextTiers（长上下文分档）
  if (price.defaultPrice !== undefined) {
    const ap = pickPrice(price, mv, hour);
    const unit = ap.unit || "token";
    if (unit === "per_call") return (mv.callCount || mv.assistantCount || 0) * (ap.pricePerCall || 0);
    if (unit === "per_char") { const chars = (mv.output || 0) + (mv.input || 0); return chars * (ap.pricePer10K || 0) / 10000; }
    return (mv.input || 0) * (ap.inputPerM || 0) / 1e6 + (mv.cacheRead || 0) * (ap.inputCachePerM || 0) / 1e6 + (mv.cacheWrite || 0) * (ap.cacheWritePerM || 0) / 1e6 + (mv.output || 0) * (ap.outputPerM || 0) / 1e6;
  }
  // 旧格式 slots（兼容）
  if (price.slots && price.slots.length > 0) {
    const cur = hour !== undefined ? hour * 60 + 30 : (new Date().getHours() * 60 + 30);
    let slot = null;
    for (const s of price.slots) {
      const f = (s.from||"00:00").split(":").map(Number);
      const t = (s.to||"24:00").split(":").map(Number);
      const fs = f[0]*60+(f[1]||0), ts = t[0]*60+(t[1]||0);
      if (fs <= ts) { if (cur >= fs && cur < ts) { slot = s; break; } }
      else { if (cur >= fs || cur < ts) { slot = s; break; } }
    }
    if (slot) return calcCost(slot, mv);
    return 0;
  }
  const unit = price.unit || "token";
  if (unit === "per_call") {
    return (mv.callCount || mv.assistantCount || 0) * (price.pricePerCall || 0);
  }
  if (unit === "per_char") {
    const chars = (mv.output || 0) + (mv.input || 0);
    return chars * (price.pricePer10K || 0) / 10000;
  }
  return (mv.input || 0) * (price.inputPerM || 0) / 1e6 + (mv.cacheRead || 0) * (price.inputCachePerM || 0) / 1e6 + (mv.cacheWrite || 0) * (price.cacheWritePerM || 0) / 1e6 + (mv.output || 0) * (price.outputPerM || 0) / 1e6;
}

function loadPriceTable(dataDir) {
  const p = path.join(dataDir, "price-table.json");
  const merged = { ...DEFAULT_PRICE_TABLE };
  try {
    if (fs.existsSync(p)) {
      const saved = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (saved && typeof saved === "object") {
        for (const [k, v] of Object.entries(saved)) {
          if (merged[k] && v && typeof v === "object" && typeof merged[k] === "object") {
            merged[k] = { ...merged[k], ...v };
          } else {
            merged[k] = v;
          }
        }
      }
    }
  } catch {}
  return merged;
}

// ── USD→CNY 汇率（免费 API：open.er-api.com，无 key，每日更新；本地缓存 6 小时） ──
let _fxCache = { rate: null, ts: 0 };
async function fetchFxRate() {
  const now = Date.now();
  if (_fxCache.rate && now - _fxCache.ts < 6 * 3600 * 1000) return _fxCache.rate;
  try {
    const r = await new Promise((resolve) => {
      const req = https.get("https://open.er-api.com/v6/latest/USD", { timeout: 5000 }, (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => resolve(buf));
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
    if (!r) return _fxCache.rate;
    const j = JSON.parse(r);
    const cny = j?.rates?.CNY;
    if (cny > 0) {
      _fxCache = { rate: cny, ts: now };
      return cny;
    }
  } catch {}
  return _fxCache.rate;
}

const HOME = process.env.HANA_HOME || path.join(process.env.HOME || process.env.USERPROFILE, ".hanako");
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../app");
const JS = fs.readFileSync(path.join(APP, "dashboard-app.js"), "utf-8");
const BASE = fs.readFileSync(path.join(APP, "base.css"), "utf-8");
const THEME = fs.readFileSync(path.join(APP, "theme.css"), "utf-8");

export default function (app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;

  app.get("/dashboard/data", async c => {
    try {
      const cache = ctx._tokenCache;
      if (!cache?.ready || !cache.data) return c.json({ error: "数据未就绪" }, 503);
      const range = c.req.query("range") || "all";
      const agent = c.req.query("agent") || "";
      const model = c.req.query("model") || "";
      const type = c.req.query("type") || "";
      const from = c.req.query("from") || "";
      const to = c.req.query("to") || "";
      const provider = c.req.query("provider") || "";
      // 确保汇率可用（内部统一美元口径计算用）
      const fxRate = await fetchFxRate();
      const result = build(cache.data, range, { agent, model, type, provider, from, to }, fxRate);
      // 用 agent:list 覆盖 agentNames，保证显示名正确；标记已删除的 agent
      const activeAgentIds = new Set();
      try {
        const ar = await ctx.bus.request("agent:list");
        if (ar?.agents) {
          const names = {};
          for (const a of ar.agents) { names[a.id] = a.name || a.id; activeAgentIds.add(a.id); }
          result.agentNames = names;
        }
      } catch (e) { /* non-critical */ }
      for (const a of result.agents) {
        if (!activeAgentIds.has(a.id)) a.deleted = true;
      }
      // 附上各供应商余额 + 供应商配置
      try {
        const providers = [];
        const provSeen = new Set();
        // 1) 从 provider-catalog.json 读取文本模型供应商
        const catalogPath = path.join(HOME, "provider-catalog.json");
        if (fs.existsSync(catalogPath)) {
          try {
            const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
            if (catalog.providers) {
              for (const [provId, provData] of Object.entries(catalog.providers)) {
                if (provSeen.has(provId)) continue;
                const models = [];
                if (Array.isArray(provData.models)) {
                  for (const m of provData.models) {
                    const mid = typeof m === "string" ? m : m.id;
                    if (mid) models.push(mid);
                  }
                }
                if (models.length) { providers.push({ id: provId, models }); provSeen.add(provId); }
              }
            }
          } catch {}
        }
        // 2) 从 preferences.json 读取多媒体供应商（imageGeneration / videoGeneration）
        const prefPath = path.join(HOME, "user", "preferences.json");
        if (fs.existsSync(prefPath)) {
          try {
            const pref = JSON.parse(fs.readFileSync(prefPath, "utf-8"));
            for (const cap of ["imageGeneration", "videoGeneration"]) {
              const pd = pref[cap]?.providerDefaults;
              if (!pd) continue;
              for (const [provId, provData] of Object.entries(pd)) {
                const models = [];
                if (provData.models) {
                  for (const mid of Object.keys(provData.models)) models.push(mid);
                }
                if (!models.length) continue;
                if (provSeen.has(provId)) {
                  const existing = providers.find(p => p.id === provId);
                  if (existing) { for (const m of models) { if (!existing.models.includes(m)) existing.models.push(m); } }
                } else {
                  providers.push({ id: provId, models }); provSeen.add(provId);
                }
              }
            }
          } catch {}
        }
        result._providerConfig = providers;
        // 合并 catalog/价格表中的供应商到 result.providers（前端筛选用）
        if (result.providers) {
          const seenProvs = new Set(result.providers.map(p => p.provider));
          for (const p of providers) {
            if (!seenProvs.has(p.id)) { result.providers.push({ provider: p.id, model: "", totalTokens: 0, count: 0 }); seenProvs.add(p.id); }
          }
          // 也加上价格表中的
          const pt3 = loadPriceTable(cache.dataDir || "");
          for (const pk of Object.keys(pt3)) {
            const pid = pk.split("/")[0];
            if (pid && !seenProvs.has(pid)) { result.providers.push({ provider: pid, model: "", totalTokens: 0, count: 0 }); seenProvs.add(pid); }
          }
        }
        result._balances = [];
        const balApis = loadBalanceApis(cache.dataDir || "");
        let yamlKeys = {};
        try {
          const yamlPath2 = path.join(HOME, "added-models.yaml");
          if (fs.existsSync(yamlPath2)) {
            const yaml2 = fs.readFileSync(yamlPath2, "utf-8");
            const provMatches2 = [...yaml2.matchAll(/^  (\S+):\s*\n((?:    .+\n)*)/gm)];
            for (const pm of provMatches2) {
              const keyIdx = pm[2].indexOf("api_key:");
              if (keyIdx >= 0) {
                // 取 api_key 后所有缩进 4 空格的内容，合并多行（YAML 自动折行场景）
                let block = pm[2].substring(keyIdx + 8);
                // 去掉结尾后若有下一个 key 的下一行（其它缩进 4 空格的 key），提前截断
                const nextKeyM = block.match(/\n    [a-zA-Z_][\w-]*:/);
                if (nextKeyM) block = block.substring(0, nextKeyM.index);
                // 合并 YAML 折行：移除换行 + 之后的空白
                const merged = block.replace(/\s*\n\s*/g, "").trim();
                // 去引号
                const cleaned = merged.replace(/^["']|["']$/g, "");
                yamlKeys[pm[1]] = cleaned.split(/\s/)[0];
              }
            }
          }
        } catch {}
        let catalogKeys = {};
        try {
          if (fs.existsSync(catalogPath)) {
            const cat = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
            if (cat.providers) for (const [pid, pd] of Object.entries(cat.providers)) { if (pd.api_key) catalogKeys[pid] = pd.api_key; }
          }
        } catch {}
        result._subscriptionQuotas = [];
        // ── 订阅余量查询（独立于 provider 列表，直接从 balance-apis 配置读取） ──
        const allApiConf = balApis;
        for (const [provId, apiConf] of Object.entries(allApiConf)) {
          // 火山方舟 Coding Plan（AK/SK + V4 签名）
          if (apiConf.responseType === "volcengine-coding-plan") {
            if (apiConf.enabled === false) continue;
            if (!apiConf.ak || !apiConf.sk) {
              result._subscriptionQuotas.push({ provider: provId, label: provId, type: "no-token", display: "未配置 AK/SK", providerId: provId });
              continue;
            }
            const q = await Promise.race([
              fetchVolcengineCodingPlan(apiConf),
              new Promise(r => setTimeout(() => r(null), 5500))
            ]);
            if (q) {
              result._subscriptionQuotas.push({ provider: provId, label: provId, ...q });
            } else {
              result._subscriptionQuotas.push({ provider: provId, label: provId, type: "error", display: "查询失败" });
            }
            continue;
          }
          // OpenCode Go（控制台 cookie 抓取）
          if (apiConf.responseType === "opencode-go") {
            if (apiConf.enabled === false) continue;
            if (!apiConf.workspaceId || !apiConf.cookie) {
              result._subscriptionQuotas.push({ provider: provId, label: "OpenCode Go", type: "no-token", display: "未配置 workspace/cookie", providerId: provId });
              continue;
            }
            // 余量优先：余量拿到后立即返回，stats 并行跑完即可，不拖后腿
            const gq = await Promise.race([
              fetchOpenCodeGoQuota(apiConf),
              new Promise(r => setTimeout(() => r(null), 12000))
            ]);
            const statsPromise = Promise.race([
              fetchOpenCodeGoStats(apiConf.cookie, apiConf.workspaceId),
              new Promise(r => setTimeout(() => r(null), 8000))
            ]).catch(() => null);
            const entry = { provider: provId, label: "OpenCode Go", providerId: provId };
            if (gq) {
              Object.assign(entry, gq);
              const stats = await statsPromise;
              if (stats) {
                entry.costs = stats.costs || [];
                entry.keys = stats.keys || [];
                // 把 key 名字持久化到 usage 缓存（getCosts 偶尔返回空时也能显示名字）
                if (stats.keys && stats.keys.length) {
                  try {
                    const uc = loadOgUsageCache();
                    if (!uc.keyNames) uc.keyNames = {};
                    let changed = false;
                    for (const k of stats.keys) {
                      if (k && k.id && k.displayName && uc.keyNames[k.id] !== k.displayName) {
                        uc.keyNames[k.id] = k.displayName;
                        changed = true;
                      }
                    }
                    if (changed) saveOgUsageCache(uc);
                  } catch {}
                }
                entry.usage = stats.usage || [];
                // usage 缓存提供次数/Token；官方 costs 提供最终费用。默认按全部 KEY，和官方成本页口径一致。
                const ogCache2 = loadOgUsageCache();
                const ogRecs = ogCache2.records || {};
                const selKey = (ogCache2.primaryKeyId || apiConf.selectedKeyId || "");
                const rangeRows = aggregateOgModels(ogRecs, range, from, to, "");
                const monthRows = aggregateOgModels(ogRecs, "month", "", "", "");
                const rangeCosts = aggregateOgCostSources(stats.costs, ogRecs, range, from, to, "");
                const monthCosts = aggregateOgCostSources(stats.costs, ogRecs, "month", "", "", "");
                const rangeCostMap = rangeCosts.costs;
                const monthCostMap = monthCosts.costs;
                entry.modelSummary = mergeOgOfficialCosts(rangeRows, rangeCostMap);
                // 模型月额度固定按当月口径（不随页面筛选范围变化），默认包含全部 KEY。
                entry.monthlyModelUsage = mergeOgOfficialCosts(monthRows, monthCostMap);
                entry.officialModelCosts = rangeCostMap;
                entry.officialMonthlyModelCosts = monthCostMap;
                entry.modelCostScope = "all-keys";
                entry.modelCostSource = rangeCosts.source;
                entry.monthlyCostSource = monthCosts.source;
                entry.keySummary = aggregateOgKeys(stats.keys, ogRecs, range, from, to);
                entry.selectedKeyId = selKey;
                entry.truncated = !!stats.truncated;
                entry.statsFetchedAt = stats.fetchedAt || null;
                // 官方口径可用时校准本地估算系数
                if (!gq.est) {
                  // stats.costs 同时带当前月与上月，校准只取当前月，避免把两个月账单混进本地月估算。
                  const monthUsd = Object.values(aggregateOgOfficialCosts(stats.costs, "month", "", "", "")).reduce((s, v) => s + v, 0);
                  const est = estimateOpenCodeGoUsage();
                  if (est) {
                    const estWin = (est.windows || []).find(w => w.level === "monthly");
                    if (estWin) calibrateOg(estWin.usedUsd, monthUsd);
                  }
                }
              }
              result._subscriptionQuotas.push(entry);
              // 自动增量同步：usage 缓存超过 2 分钟未同步则后台补拉（不阻塞本次响应）
              const ogCache = loadOgUsageCache();
              if (!ogCache.syncedAt || Date.now() - ogCache.syncedAt > 120000) {
                syncOgUsage(apiConf.cookie, apiConf.workspaceId, "incremental").catch(() => {});
              }
            } else {
              entry.type = "error";
              entry.display = "查询失败";
              result._subscriptionQuotas.push(entry);
            }
            continue;
          }
          if (apiConf.responseType !== "per-model-quota") continue;
          if (apiConf.enabled === false) continue;
          if (!apiConf.url) {
            result._subscriptionQuotas.push({ provider: provId, label: provId, type: "no-token", display: "未配置 URL", providerId: provId });
            continue;
          }
          if (!apiConf.token) {
            result._subscriptionQuotas.push({ provider: provId, label: provId, type: "no-token", display: "未配置 Token", providerId: provId });
            continue;
          }
          const q = await Promise.race([
            fetchSubscriptionQuota(apiConf),
            new Promise(r => setTimeout(() => r(null), 2000))
          ]);
          if (q) {
            result._subscriptionQuotas.push({ provider: provId, label: provId, type: "quota", ...q });
          } else {
            result._subscriptionQuotas.push({ provider: provId, label: provId, type: "error", display: "查询失败", url: apiConf.url });
          }
        }
        // ── 传统余额/配额查询 ──
        for (const prov of providers) {
          const apiConf = balApis[prov.id];
          if (!apiConf || !apiConf.url) {
            result._balances.push({ provider: prov.id, label: prov.id, type: "none", display: "未配置" });
            continue;
          }
          const apiKey = (catalogKeys[prov.id] && catalogKeys[prov.id].length >= 40) ? catalogKeys[prov.id] : (yamlKeys[prov.id] || catalogKeys[prov.id]);
          if (apiConf.responseType === "token-plan") {
            try { console.error("[token-tracker/minimax] prov=" + prov.id + " yaml=" + (yamlKeys[prov.id]?"Y":"N") + " catalog=" + (catalogKeys[prov.id]?"Y":"N") + " finalLen=" + (apiKey||"").length); } catch {}
          }
          if (!apiKey) {
            result._balances.push({ provider: prov.id, label: prov.id, type: "no-key", display: "无 API Key" });
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
        const pt = result._priceTable || loadPriceTable(cache.dataDir || "");
        const modelCosts = [];
        const mgMap = {};
        for (const mg of result.mediaGen || []) { mgMap[mg.provider + "/" + mg.model] = mg; }
        const ogEntryForCosts = (result._subscriptionQuotas || []).find(q => q && q.provider === "opencode-go" && q.officialModelCosts);
        const officialOgCosts = ogEntryForCosts ? ogEntryForCosts.officialModelCosts : null;
        const officialOgRows = ogEntryForCosts ? (ogEntryForCosts.modelSummary || []) : [];
        const officialOgRowMap = Object.fromEntries(officialOgRows.map(r => [r.model, r]));
        // 官方成本没有 Agent/类型维度；只有全局视图才覆盖本地 token 估算，筛选到 Agent/类型时保留本地口径。
        const useOfficialOgCosts = !!officialOgCosts && !agent && !type && (!provider || provider === "opencode-go");
        for (const m of result.models || []) {
          let prov = "";
          for (const pc of providers) { if (pc.models.includes(m.id)) { prov = pc.id; break; } }
          let key = prov + "/" + m.id;
          let price = pt[key];
          // 如果 key 匹配不到，尝试从 priceTable 的 key 中匹配（用户手动配置的模型）
          if (!price && pt) {
            for (const pk of Object.keys(pt)) {
              if (pk.endsWith("/" + m.id)) { price = pt[pk]; key = pk; prov = pk.split("/")[0]; break; }
            }
          }
          const mgEntry = mgMap[key];
          const mv = (price?.unit === "per_call" && mgEntry) ? { ...m, callCount: mgEntry.callCount } : m;
          const unit = price?.unit || "token";
          var inputCost=0,outputCost=0,cacheCost=0;
          if(price&&unit==="token"){
            // 统一用完整用量判定分档（pickPrice 内部按平均输入 token 选档），三项同档计费，避免明细与顶部估算口径不一致
            const mvc = { input: m.input||0, output: m.output||0, cacheRead: m.cacheRead||0, cacheWrite: m.cacheWrite||0, assistantCount: m.assistantCount||0, callCount: m.assistantCount||0 };
            const tp = pickPrice(price, mvc, 12);
            if ((tp.unit || "token") === "token") {
              inputCost = mvc.input * (tp.inputPerM||0) / 1e6;
              outputCost = mvc.output * (tp.outputPerM||0) / 1e6;
              cacheCost = mvc.cacheRead * (tp.inputCachePerM||0) / 1e6 + mvc.cacheWrite * (tp.cacheWritePerM||0) / 1e6;
            } else {
              // 匹配到 per_call/per_char 特殊时段：无法按 token 拆分，总额走 calcCost
              const tot = calcCost(price, mvc, 12);
              inputCost = tot; outputCost = 0; cacheCost = 0;
            }
          }
          const estimatedCost = (unit==="token"&&price) ? inputCost+outputCost+cacheCost : calcCost(price, mv);
          const hasOfficialCost = prov === "opencode-go" && useOfficialOgCosts && Object.prototype.hasOwnProperty.call(officialOgCosts, m.id);
          const cost = hasOfficialCost ? officialOgCosts[m.id] : estimatedCost;
          const officialRow = officialOgRowMap[m.id];
          const officialHasTokens = !!officialRow && (officialRow.count > 0 || officialRow.inputTokens > 0 || officialRow.outputTokens > 0);
          modelCosts.push({ model: m.id, provider: prov, cost, estimatedCost, costSource: hasOfficialCost ? "official" : "local-estimate", officialInputTokens: officialHasTokens ? officialRow.inputTokens : null, officialOutputTokens: officialHasTokens ? officialRow.outputTokens : null, unit, inputCost, outputCost, cacheCost, callCount: mgEntry?.callCount || 0, successCount: mgEntry?.successCount || 0, currency: price?.currency || "USD" });
        }
        // KEY2 可能只调用了 Kimi 等模型，本地 Hana 日志没有对应行；补入官方费用行，保证消费明细合计可对账。
        if (useOfficialOgCosts && officialOgCosts && (!provider || provider === "opencode-go")) {
          for (const [officialModel, cost] of Object.entries(officialOgCosts)) {
            if (model && model !== officialModel) continue;
            if (modelCosts.some(mc => mc.provider === "opencode-go" && mc.model === officialModel)) continue;
            const officialRow = officialOgRowMap[officialModel];
            const officialHasTokens = !!officialRow && (officialRow.count > 0 || officialRow.inputTokens > 0 || officialRow.outputTokens > 0);
            modelCosts.push({ model: officialModel, provider: "opencode-go", cost, estimatedCost: 0, costSource: "official", officialInputTokens: officialHasTokens ? officialRow.inputTokens : null, officialOutputTokens: officialHasTokens ? officialRow.outputTokens : null, unit: "token", inputCost: 0, outputCost: 0, cacheCost: 0, callCount: officialRow?.count || 0, successCount: 0, currency: "USD" });
          }
        }
        for (const mg of result.mediaGen || []) {
          const key = mg.provider + "/" + mg.model;
          if (modelCosts.find(mc => mc.provider + "/" + mc.model === key)) continue;
          const price = pt[key];
          const cost = calcCost(price, mg);
          modelCosts.push({ model: mg.model, provider: mg.provider, cost, unit: price?.unit || "per_call", callCount: mg.callCount, successCount: mg.successCount });
        }
        result._modelCosts = modelCosts;
      } catch(e) { result._balanceError = e.message; }
      result._priceTable = loadPriceTable(cache.dataDir || "");
      result._balanceApis = loadBalanceApis(cache.dataDir || "");
      result._fxRate = await fetchFxRate();
      return c.json(result);
    } catch(e) { return c.json({ error: e.message, stack: e.stack }, 500); }
  });

  app.post("/price-table", async c => {
    try {
      const body = await c.req.json();
      const tk = ctx._tokenCache;
      const p = path.join(tk?.dataDir || "", "price-table.json");
      fs.writeFileSync(p, JSON.stringify(body, null, 2));
      return c.json({ ok: true });
    } catch(e) { return c.json({ error: e.message }, 500); }
  });

  app.post("/balance-apis", async c => {
    try {
      const body = await c.req.json();
      const tk = ctx._tokenCache;
      const p = path.join(tk?.dataDir || "", "balance-apis.json");
      fs.writeFileSync(p, JSON.stringify(body, null, 2));
      return c.json({ ok: true });
    } catch(e) { return c.json({ error: e.message }, 500); }
  });

  app.post("/dashboard/refresh", async c => {
    try {
      const tk = ctx._tokenCache;
      const force = c.req.query("force") === "1";
      if (force && tk?.fullScan) { await tk.fullScan(); return c.json({ ok: true, lastScan: tk.data?.lastScan, full: true }); }
      if (tk?.scan) { await tk.scan(false); return c.json({ ok: true, lastScan: tk.data?.lastScan, full: false }); }
      return c.json({ error: "unavailable" }, 503);
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // 供应商余额查询代理
  app.get("/dashboard/balance", async c => {
    try {
      const yamlPath = path.join(HOME, "added-models.yaml");
      const yaml = fs.readFileSync(yamlPath, "utf-8");
      const balances = [];
      const dsM = yaml.match(/\bdeepseek:\s*[\s\S]*?api_key:\s*(\S+)/);
      if (dsM) { const b = await fetchDeepSeekBalance(dsM[1]); if (b) balances.push({ provider: "deepseek", label: "DeepSeek", ...b }); }
      const glmM = yaml.match(/\bglm:\s*[\s\S]*?api_key:\s*(\S+)/);
      if (glmM) { const b = await fetchGLMBalance(glmM[1]); if (b) balances.push({ provider: "glm", label: "GLM", ...b }); }
      return c.json({ balances });
    } catch(e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ── 实时监控 widget ──
  const WIDGET_CSS = fs.readFileSync(path.join(APP, "widget.css"), "utf-8");
  const WIDGET_JS = fs.readFileSync(path.join(APP, "widget.js"), "utf-8");

  app.get("/widget/stream", c => {
    const cache = ctx._tokenCache;
    if (!cache?.realtime) return c.json({ error: "not ready" }, 503);

    const encoder = new TextEncoder();
    let streamController = null;
    let closed = false;

    const safeSend = (payload) => {
      if (closed || !streamController) return false;
      try {
        streamController.enqueue(encoder.encode("data: " + JSON.stringify(payload) + "\n\n"));
        return true;
      } catch { return false; }
    };

    const sendUsage = () => {
      const snap = cache.realtimeSnapshot ? cache.realtimeSnapshot(cache.realtime, cache.data?.agentNames || {}) : { ...cache.realtime, balances: cache.data?._balances || null, balanceUpdatedAt: cache.realtime.balanceUpdatedAt };
      if (cache.data?._subscriptionQuotas) snap.quotas = cache.data._subscriptionQuotas;
      safeSend({ type: "usage", data: snap });
    };

    if (!cache._realtimeClients) cache._realtimeClients = new Set();
    const client = { send: safeSend };
    cache._realtimeClients.add(client);

    sendUsage();

    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
        const hb = setInterval(() => { if (!safeSend({ type: "heartbeat", ts: Date.now() })) { clearInterval(hb); } }, 15000);
      },
      cancel() {
        closed = true;
        cache._realtimeClients?.delete(client);
      },
    });

    c.header("Content-Type", "text/event-stream; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    return c.body(stream);
  });

  app.get("/widget/data", c => {
    const cache = ctx._tokenCache;
    if (!cache?.realtime) return c.json({ error: "not ready" }, 503);
    const snap = cache.realtimeSnapshot ? cache.realtimeSnapshot(cache.realtime, cache.data?.agentNames || {}) : { ...cache.realtime, balances: cache.data?._balances || null, balanceUpdatedAt: cache.realtime.balanceUpdatedAt };
    if (cache.data?._balances) snap.balances = cache.data._balances;
    if (cache.data?._subscriptionQuotas) snap.quotas = cache.data._subscriptionQuotas;
    if (cache.data) {
      const today = cnToday();
      const todayData = cache.data.sessions && Object.values(cache.data.sessions).reduce((acc, s) => {
        const db = s.dailyBreakdown?.[today];
        if (db) { acc.input += db.input||0; acc.output += db.output||0; acc.cacheRead += db.cacheRead||0; acc.totalTokens += db.totalTokens||0; acc.assistantCount += db.assistantCount||0; }
        return acc;
      }, { input:0, output:0, cacheRead:0, totalTokens:0, assistantCount:0 });
      snap.today = todayData;
      snap.todayAgentCount = new Set(Object.values(cache.data.sessions).filter(s => s.dailyBreakdown?.[today]).map(s => s.agent)).size;
    }
    return c.json(snap);
  });

  // ── OpenCode Go 模型用量（全量同步 + 按模型聚合）──
  // POST 触发同步：mode=incremental/full，返回同步结果
  app.post("/dashboard/og-sync", async c => {
    try {
      const cache = ctx._tokenCache;
      const apis = cache?.dataDir ? loadBalanceApis(cache.dataDir) : {};
      let cookie = "", ws = "";
      for (const provId of Object.keys(apis || {})) {
        const ac = apis[provId];
        if (ac && ac.responseType === "opencode-go") { cookie = ac.cookie || ""; ws = ac.workspaceId || ""; break; }
      }
      if (!cookie || !ws) return c.json({ error: "未配置 OpenCode Go workspace/cookie" }, 400);
      const mode = c.req.query("mode") === "full" ? "full" : "incremental";
      const result = await syncOgUsage(cookie, ws, mode);
      return c.json(result);
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // GET 查询模型用量：?range=today/week/month/year/all&from=&to=（口径与模型/Key 汇总统一）
  app.get("/dashboard/og-models", c => {
    try {
      const cache = loadOgUsageCache();
      const range = c.req.query("range") || "all";
      const from = c.req.query("from") || "";
      const to = c.req.query("to") || "";
      const models = aggregateOgModelUsage(cache.records, range, from, to);
      return c.json({ models, total: cache.total, syncedAt: cache.syncedAt || 0, deepestPage: cache.deepestPage });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get("/widget", c => {
    const th = c.req.query("hana-theme") || "inherit";
    const token = c.req.query("token") || "";
    return c.html(widgetHtml(ctx, th, token, WIDGET_CSS, WIDGET_JS));
  });

  app.get("/dashboard", c => {
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    return c.html(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Token 用量</title>
${hcLink}
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>${BASE}${THEME}<\/style>
<\/head>
<body data-hana-theme="${esc(th)}" data-surface="page">
<div id="app"></div>
<script>(function(){window.parent.postMessage({source:"hana-plugin",type:"ready"},"*")})();<\/script>
<script>${JS}<\/script>
</body>
</html>`);
  });
}

// ── 后端数据构建 ──

function build(cache, range = "all", filters = {}, fxRate = null) {
  const priceTable = loadPriceTable(cache.dataDir || "");
  let sessions = Object.values(cache.sessions);
  let earliest = null;
  for (const s of sessions) { if (s.firstTime) { const d = s.firstTime.slice(0, 10); if (!earliest || d < earliest) earliest = d; } }

  // ── 按时间维度确定过滤函数 ──
  let dateFilter = null;
  if (range !== "all") {
    const now = new Date();
    const today = cnToday();
    if (range === "today") {
      dateFilter = d => d === today;
    } else if (range === "week") {
      const day = now.getDay();
      const ws = new Date(now);
      // 与 OpenCode Go 官方口径统一：本周从周一开始。
      ws.setDate(ws.getDate() - ((day + 6) % 7));
      const weekStart = ws.getFullYear() + "-" + String(ws.getMonth()+1).padStart(2,"0") + "-" + String(ws.getDate()).padStart(2,"0");
      dateFilter = d => d >= weekStart;
    } else if (range === "year") {
      const yearStart = now.getFullYear() + "-01-01";
      dateFilter = d => d >= yearStart;
    } else if (range === "lyear") {
      const ly = now.getFullYear() - 1;
      const ls = ly + "-01-01", le = ly + "-12-31";
      dateFilter = d => d >= ls && d <= le;
    } else if (range === "month") {
      const monthStart = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
      dateFilter = d => d >= monthStart;
    }
  }

  // ── Agent / Provider / Type / 自定义日期筛选 ──
  const { agent: filterAgent, model: filterModel, type: filterType, provider: filterProvider, from, to } = filters;
  if (filterAgent) {
    sessions = sessions.filter(s => s.agent === filterAgent);
  }
  if (filterProvider) {
    sessions = sessions.filter(s => s.providers && Object.keys(s.providers).some(pk => pk.startsWith(filterProvider + "/")));
  }
  if (filterType) {
    sessions = sessions.filter(s => s.type === filterType);
  }
  if (from) {
    const orig = dateFilter;
    dateFilter = d => d >= from && (!to || d <= to) && (!orig || orig(d));
  }

  // 保存一份不含模型筛选的 sessions，用于前端下拉选项
  const sessionPool = sessions;

  if (filterModel) {
    sessions = sessions.filter(s => s.models?.[filterModel]);
  }

  // ── 统一汇总（无论什么维度都从 dailyBreakdown 取值） ──
  const agentMap = {};
  const modelMap = {};
  const dailyMap = {};
  const sums = { totalInput: 0, totalOutput: 0, totalTokens: 0, totalCacheRead: 0, totalAssistant: 0, totalDesktop: 0, totalChannel: 0, totalBridge: 0, totalBackground: 0, totalSub: 0, totalLedger: 0 };

  for (const s of sessions) {
    const a = s.agent;

    // 会话级模型→供应商映射
    const provModels = {};
    if (s.providers) {
      for (const pk of Object.keys(s.providers)) {
        const sep = pk.indexOf("/");
        if (sep > 0) provModels[pk.slice(sep + 1)] = pk.slice(0, sep);
      }
    }

    // Agent / daily / sums <- dailyBreakdown
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(day)) continue;
      let di, dout, dcr, dtot, dasst;
      if (filterProvider && filterModel) {
        // 精确：优先用 providerTotals（仅 totalTokens 精确）
        const provPk = filterProvider + "/" + filterModel;
        const pt = d.providerTotals?.[provPk];
        if (pt !== undefined) {
          dtot = pt.totalTokens; di = pt.input; dout = pt.output; dcr = pt.cacheRead; dasst = pt.assistantCount || 0;
        } else {
          di = 0; dout = 0; dcr = 0; dtot = 0; dasst = 0;
        }
      } else if (filterProvider && !filterModel) {
        di = 0; dout = 0; dcr = 0; dtot = 0; dasst = 0;
        if (d.providerTotals) {
          for (const [pk, pt] of Object.entries(d.providerTotals)) {
            if (pk.startsWith(filterProvider + "/")) {
              dtot += pt.totalTokens; di += pt.input; dout += pt.output; dcr += pt.cacheRead; dasst += pt.assistantCount || 0;
            }
          }
        }
      } else if (filterModel) {
        if (d.models?.[filterModel]) {
          const md = d.models[filterModel];
          di = md.input || 0; dout = md.output || 0; dcr = md.cacheRead || 0; dtot = md.totalTokens || 0; dasst = md.assistantCount || 0;
        } else {
          di = 0; dout = 0; dcr = 0; dtot = 0; dasst = 0;
        }
      } else {
        di = d.input || 0; dout = d.output || 0; dcr = d.cacheRead || 0; dtot = d.totalTokens || 0; dasst = d.assistantCount || 0;
      }

      if (!agentMap[a]) agentMap[a] = { input: 0, output: 0, totalTokens: 0, cacheRead: 0, assistantCount: 0, desktopTotal: 0, channelTotal: 0, bridgeTotal: 0, backgroundTotal: 0, subTotal: 0, ledgerTotal: 0, models: {} };
      agentMap[a].input += di; agentMap[a].output += dout; agentMap[a].totalTokens += dtot; agentMap[a].cacheRead += dcr;
      agentMap[a].assistantCount += dasst;
      if (s.type === "desktop") agentMap[a].desktopTotal += dtot;
      else if (s.type === "bridge") agentMap[a].bridgeTotal += dtot;
      else if (s.type === "background") agentMap[a].backgroundTotal += dtot;
      else if (s.type === "sub") agentMap[a].subTotal += dtot;
      else if (s.type === "ledger") agentMap[a].ledgerTotal += dtot;
      else agentMap[a].channelTotal += dtot;

      if (!dailyMap[day]) dailyMap[day] = { totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0, cacheRead: 0, assistantCount: 0 };
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

      // 模型精确统计（按日级数据，不按比例推算）
      for (const [mn, mv] of Object.entries(d.models || {})) {
        if (filterModel && mn !== filterModel) continue;
        if (filterProvider && !filterModel && provModels[mn] !== filterProvider) continue;
        if (!modelMap[mn]) modelMap[mn] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0, totalTokens: 0 };
        modelMap[mn].input += mv.input || 0;
        modelMap[mn].output += mv.output || 0;
        modelMap[mn].cacheRead += mv.cacheRead || 0;
        modelMap[mn].cacheWrite += mv.cacheWrite || 0;
        modelMap[mn].assistantCount += mv.assistantCount || 0;
        modelMap[mn].totalTokens += mv.totalTokens || 0;
        if (agentMap[a]) {
          if (!agentMap[a].models[mn]) agentMap[a].models[mn] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
          agentMap[a].models[mn].input += mv.input || 0;
          agentMap[a].models[mn].output += mv.output || 0;
          agentMap[a].models[mn].cacheRead += mv.cacheRead || 0;
          agentMap[a].models[mn].cacheWrite += mv.cacheWrite || 0;
          agentMap[a].models[mn].totalTokens += mv.totalTokens || 0;
        }
      }
    }
  }

  // ── 模型下拉选项（排除模型筛选，让前端下拉始终显示可用模型） ──
  const modelOptMap = {};
  for (const s of sessionPool) {
    const pmo = {};
    if (s.providers) {
      for (const pk of Object.keys(s.providers)) {
        const sp = pk.indexOf("/");
        if (sp > 0) pmo[pk.slice(sp + 1)] = pk.slice(0, sp);
      }
    }
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(day)) continue;
      for (const mn of Object.keys(d.models || {})) {
        if (filterProvider && pmo[mn] !== filterProvider) continue;
        modelOptMap[mn] = (modelOptMap[mn] || 0) + (d.models[mn].totalTokens || 0);
      }
    }
  }
  const modelOptions = Object.entries(modelOptMap).sort((a, b) => b[1] - a[1]).map(([id]) => ({ id }));

  // ── 供应商/模型组合饼图（受日期/Agent/类型/供应商筛选影响） ──
  const provBrkMap = {};
  var provAttributed = 0;
  var provDayTotal = 0;
  for (const s of sessions) {
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(day)) continue;
      provDayTotal += d.totalTokens || 0;
      if (d.providerTotals) {
        for (const [pk, pt] of Object.entries(d.providerTotals)) {
          if (filterProvider && !pk.startsWith(filterProvider + "/")) continue;
          if (filterModel && !pk.endsWith("/" + filterModel)) continue;
          if (!provBrkMap[pk]) {
            const sep = pk.indexOf("/");
            provBrkMap[pk] = { provider: pk.slice(0, sep), model: pk.slice(sep + 1), totalTokens: 0, count: 0 };
          }
          provBrkMap[pk].totalTokens += pt.totalTokens;
          provBrkMap[pk].count += pt.assistantCount || 0;
          provAttributed += pt.totalTokens;
        }
      } else if (s.providers && d.models) {
        for (const [mn, mv] of Object.entries(d.models)) {
          const pk = Object.keys(s.providers).find(p => p.endsWith("/" + mn));
          if (!pk) continue;
          const pv = s.providers[pk];
          if (filterProvider && pv.provider !== filterProvider) continue;
          if (filterModel && pv.model !== filterModel) continue;
          if (!provBrkMap[pk]) provBrkMap[pk] = { provider: pv.provider, model: pv.model, totalTokens: 0, count: 0 };
          provBrkMap[pk].totalTokens += mv.totalTokens || 0;
          provBrkMap[pk].count += mv.assistantCount || 0;
          provAttributed += mv.totalTokens || 0;
        }
      }
    }
  }
  const providerBreakdown = Object.values(provBrkMap).sort((a, b) => b.totalTokens - a.totalTokens);
  // 补上未归属的用量，使饼图总和 = 日数据总和（仅无供应商筛选时）
  var gap = provDayTotal - provAttributed;
  if (gap > 0 && !filterProvider && !filterModel) {
    providerBreakdown.push({ provider: "?", model: "未归属", totalTokens: gap });
  }

  const agents = Object.entries(agentMap).map(([id, d]) => ({ id, ...d })).sort((a, b) => b.totalTokens - a.totalTokens);
  const models = Object.entries(modelMap).map(([id, d]) => ({ id, ...d })).sort((a, b) => (b.input + b.output + (b.cacheRead || 0)) - (a.input + a.output + (a.cacheRead || 0)));
  const daily = Object.keys(dailyMap).sort().map(d => ({ date: d, totalTokens: dailyMap[d].totalTokens, desktop: dailyMap[d].desktop, channel: dailyMap[d].channel, bridge: dailyMap[d].bridge, background: dailyMap[d].background, sub: dailyMap[d].sub, ledger: dailyMap[d].ledger, cacheRead: dailyMap[d].cacheRead, assistantCount: dailyMap[d].assistantCount }));

  // ── 按小时汇总（今日或自定义单天） ──
  let hourly = null;
  let hourlyTargetDay = null;
  if (range === "today") {
    hourlyTargetDay = cnToday();
  } else if (from && to && from === to) {
    hourlyTargetDay = from;
  }
  if (hourlyTargetDay) {
    const hMap = {};
    const hMMap = {};
    for (const s of sessions) {
      const hb = s.hourlyBreakdown?.[hourlyTargetDay];
      if (!hb) continue;
      // 会话级模型→供应商映射
      const hp = {};
      if (s.providers) {
        for (const pk of Object.keys(s.providers)) {
          const sep = pk.indexOf("/");
          if (sep > 0) hp[pk.slice(sep + 1)] = pk.slice(0, sep);
        }
      }
      for (const [hour, v] of Object.entries(hb)) {
        if (!hMap[hour]) hMap[hour] = { totalTokens: 0, desktop: 0, channel: 0, bridge: 0, background: 0, sub: 0, ledger: 0, cacheRead: 0, assistantCount: 0 };
        if (!hMMap[hour]) hMMap[hour] = {};
        // 模型级明细（供时段分模型对比）
        if (v.models) {
          for (const [mn, mv] of Object.entries(v.models)) {
            if (!hMMap[hour][mn]) hMMap[hour][mn] = { totalTokens: 0, cacheRead: 0 };
            hMMap[hour][mn].totalTokens += mv.totalTokens || 0;
            hMMap[hour][mn].cacheRead += mv.cacheRead || 0;
          }
        }
        if (filterProvider && filterModel) {
          const pk = filterProvider + "/" + filterModel;
          const vt = v.providerTotals?.[pk];
          if (vt !== undefined) {
            hMap[hour].totalTokens += vt.totalTokens;
            hMap[hour].desktop += vt.desktop || 0;
            hMap[hour].channel += vt.channel || 0;
            hMap[hour].cacheRead += vt.cacheRead;
            hMap[hour].assistantCount += vt.assistantCount || 0;
          }
        } else if (filterProvider && !filterModel) {
          if (v.providerTotals) {
            // totalTokens 精确，desktop/channel/cacheRead 从 model 级推算
            for (const [pk, pt] of Object.entries(v.providerTotals)) {
              if (pk.startsWith(filterProvider + "/")) {
                hMap[hour].totalTokens += pt.totalTokens;
                hMap[hour].desktop += pt.desktop || 0;
                hMap[hour].channel += pt.channel || 0;
                hMap[hour].cacheRead += pt.cacheRead;
                hMap[hour].assistantCount += pt.assistantCount || 0;
              }
            }
            for (const [mn, mv] of Object.entries(v.models || {})) {
              if (hp[mn] === filterProvider) {
                hMap[hour].desktop += mv.desktop || 0;
                hMap[hour].channel += mv.channel || 0;
                hMap[hour].cacheRead += mv.cacheRead || 0;
              }
            }
          } else if (v.models) {
            for (const [mn, mv] of Object.entries(v.models)) {
              if (hp[mn] === filterProvider) {
                hMap[hour].totalTokens += mv.totalTokens || 0; hMap[hour].desktop += mv.desktop || 0;
                hMap[hour].channel += mv.channel || 0; hMap[hour].cacheRead += mv.cacheRead || 0;
              }
            }
          }
        } else if (filterModel) {
          if (v.models?.[filterModel]) {
            const vm = v.models[filterModel];
            hMap[hour].totalTokens += vm.totalTokens || 0; hMap[hour].desktop += vm.desktop || 0; hMap[hour].channel += vm.channel || 0; hMap[hour].cacheRead += vm.cacheRead || 0; hMap[hour].assistantCount += vm.assistantCount || 0;
          }
        } else {
          hMap[hour].totalTokens += v.totalTokens; hMap[hour].desktop += v.desktop; hMap[hour].channel += v.channel; hMap[hour].bridge += v.bridge||0; hMap[hour].background += v.background||0; hMap[hour].sub += v.sub||0; hMap[hour].ledger += v.ledger||0; hMap[hour].cacheRead += (v.cacheRead || 0); hMap[hour].assistantCount += (v.assistantCount || 0);
        }
      }
    }
    hourly = Array.from({ length: 24 }, (_, h) => {
      const hh = String(h).padStart(2, "0");
      return { hour: hh, totalTokens: hMap[hh]?.totalTokens || 0, desktop: hMap[hh]?.desktop || 0, channel: hMap[hh]?.channel || 0, bridge: hMap[hh]?.bridge || 0, background: hMap[hh]?.background || 0, sub: hMap[hh]?.sub || 0, ledger: hMap[hh]?.ledger || 0, cacheRead: hMap[hh]?.cacheRead || 0, assistantCount: hMap[hh]?.assistantCount || 0, models: hMMap[hh] || {} };
    });
  }

  // ── 对话流水 & 异常对话（不受筛选影响） ──
  var convs = [];
  for (const s of Object.values(cache.sessions)) {
    if (s.conversations) {
      for (const c of s.conversations) {
        convs.push({ time:c.time, userSnippet:c.userSnippet, userContent:c.userContent, model:c.model||"", provider:c.provider||"", totalTokens:c.totalTokens||0, msgCount:c.msgCount||0, toolCalls:c.toolCalls||[], steps:c.steps||[], agent:s.agent, agentName:(cache.agentNames && cache.agentNames[s.agent]) || s.agent });
      }
    }
  }
  convs.sort((a,b) => a.time < b.time ? 1 : (a.time > b.time ? -1 : 0));
  var stream = convs.slice(0, 100);
  var today = cnToday();
  var abnormal = convs.filter(function(c){if(!c.time)return false;var d=new Date(c.time);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")===today;}).sort(function(a,b){return b.totalTokens - a.totalTokens;}).slice(0, 10);

  // ── 供应商全量列表（不受筛选影响，用于前端下拉） ──
  const allProviders = {};
  for (const s of Object.values(cache.sessions)) {
    if (s.providers) for (const [pk, pv] of Object.entries(s.providers)) {
      if (!allProviders[pk]) allProviders[pk] = { provider: pv.provider, model: pv.model, totalTokens: 0, count: 0 };
      allProviders[pk].totalTokens += pv.totalTokens;
      allProviders[pk].count += pv.count;
    }
  }
  const allProviderList = Object.values(allProviders).sort((a, b) => b.totalTokens - a.totalTokens);

  let estimatedCost = 0;
  const mediaGenMap = {};
  for (const s of sessions) {
    if (!s.providers) continue;
    const provModels = {};
    for (const pk of Object.keys(s.providers)) {
      const sep = pk.indexOf("/");
      if (sep > 0) provModels[pk.slice(sep + 1)] = pk.slice(0, sep);
    }
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (dateFilter && !dateFilter(day)) continue;
      for (const [mn, mv] of Object.entries(d.models || {})) {
        if (filterModel && mn !== filterModel) continue;
        if (filterProvider && provModels[mn] !== filterProvider) continue;
        const prov = provModels[mn];
        if (!prov) continue;
        const price = priceTable[prov + "/" + mn];
        let est = calcCost(price, mv, 12);
        // 本地货币转美元统一口径（DeepSeek 人民币、GPT 美元）
        if (price?.currency === "CNY" && fxRate) est = est / fxRate;
        estimatedCost += est;
      }
      if (d.mediaGen) {
        for (const [mk, mg] of Object.entries(d.mediaGen)) {
          if (filterProvider && mg.provider !== filterProvider) continue;
          if (!mediaGenMap[mk]) mediaGenMap[mk] = { provider: mg.provider, model: mg.model, kind: mg.kind, callCount: 0, successCount: 0 };
          mediaGenMap[mk].callCount += mg.callCount || 0;
          mediaGenMap[mk].successCount += mg.successCount || 0;
        }
      }
    }
  }
  const mediaGen = Object.values(mediaGenMap);
  for (const mg of mediaGen) {
    const price = priceTable[mg.provider + "/" + mg.model];
    if (price && price.unit === "per_call") {
      mg.cost = mg.callCount * (price.pricePerCall || 0);
      let est = mg.cost;
      if (price.currency === "CNY" && fxRate) est = est / fxRate;
      estimatedCost += est;
    }
  }

  // 按小时分摊消费金额
  if (hourly && hourly.length > 0) {
    const hTotal = hourly.reduce(function(s, h) { return s + (h.totalTokens || 0); }, 0);
    if (hTotal > 0) {
      for (const h of hourly) {
        h.cost = +((h.totalTokens || 0) / hTotal * estimatedCost).toFixed(4);
      }
    }
  }

  // ── 缓存命中率下钻（Agent + 模型）──
  const agentCacheBreakdown = agents.map(a => {
    const totalAll = a.totalTokens > 0 ? a.totalTokens : 1;
    return {
      id: a.id,
      hitRate: +((a.cacheRead || 0) / totalAll * 100).toFixed(1),
      cacheRead: a.cacheRead || 0,
      cacheWrite: Math.max(0, (a.totalTokens || 0) - (a.output || 0) - (a.cacheRead || 0)),
      totalTokens: a.totalTokens,
    };
  }).sort((a, b) => b.hitRate - a.hitRate);

  const modelCacheBreakdown = models.map(m => {
    const total = m.totalTokens > 0 ? m.totalTokens : 1;
    return {
      id: m.id,
      hitRate: +((m.cacheRead || 0) / total * 100).toFixed(1),
      cacheRead: m.cacheRead || 0,
      cacheWrite: Math.max(0, (m.totalTokens || 0) - (m.output || 0) - (m.cacheRead || 0)),
      totalTokens: m.totalTokens,
    };
  }).sort((a, b) => b.hitRate - a.hitRate);

  return {
    lastScan: cache.lastScan, agentNames: cache.agentNames || {}, earliest,
    summary: { ...sums, cacheHitRate: sums.totalTokens > 0 ? +((sums.totalCacheRead / sums.totalTokens * 100).toFixed(1)) : 0, estimatedCost },
    agents, models, modelOptions, providerBreakdown, providers: allProviderList, daily, hourly, stream, abnormal, mediaGen,
    agentCacheBreakdown, modelCacheBreakdown, prediction: buildPredictionResponse(cache, daily),
  };
}

// ── 预测：请求时实时计算 P_now / predictedToday / trend ──
function buildPredictionResponse(cache, daily) {
  const p = cache.prediction;
  if (!p) return null;
  const base = { dailyAvg: p.dailyAvg, monthToDate: p.monthToDate, daysLeftInMonth: p.daysLeftInMonth, projectedMonthEnd: p.projectedMonthEnd };
  if (!p.cumulativePct) return { ...base, predictedToday: p.dailyAvg, trend: "持平" };

  // 当前时间（Asia/Shanghai）
  const now = new Date();
  const cnParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  let curHour = 0, curMinute = 0;
  for (const part of cnParts) { if (part.type === "hour") curHour = parseInt(part.value, 10) % 24; if (part.type === "minute") curMinute = parseInt(part.value, 10); }

  // P_now
  const pPrev = curHour > 0 ? p.cumulativePct[curHour - 1] : 0;
  const pCur = p.cumulativePct[curHour];
  const pNow = pPrev + (pCur - pPrev) * (curMinute / 60);

  // 今日已消耗
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
  const todayEntry = daily.find(d => d.date === today);
  const todayTokens = todayEntry ? todayEntry.totalTokens : 0;

  // 预测
  let predictedToday;
  if (pNow < 0.001 || todayTokens === 0) {
    predictedToday = p.dailyAvg;
  } else {
    const raw = todayTokens / pNow;
    const maxRemaining = p.dailyAvg * (1 - pNow) * 1.5;
    predictedToday = Math.min(raw, todayTokens + maxRemaining);
  }
  predictedToday = Math.round(predictedToday);

  // 趋势
  const expected = p.dailyAvg * pNow;
  let trend;
  if (todayTokens > expected * 1.05) trend = "上升";
  else if (todayTokens < expected * 0.95) trend = "下降";
  else trend = "持平";

  return { ...base, predictedToday, trend };
}

// ── 余额查询配置 ──
const DEFAULT_BALANCE_APIS = {
  deepseek: { url: "https://api.deepseek.com/user/balance" },
  glm: { url: "https://open.bigmodel.cn/api/paas/v4/users/me/balance" },
  moonshot: { url: "https://api.moonshot.cn/v1/users/me/balance" },
  minimax: { url: "https://api.minimaxi.com/v1/user/balance" },
  "minimax-token-plan": {
    url: "https://api.minimaxi.com/v1/token_plan/remains",
    responseType: "token-plan"
  },
  sensenova: {
    url: "https://platform.sensenova.cn/lite/console/v1/user/coding-plan/usages?account_id={YOUR_SENSENOVA_ACCOUNT_ID}&model_ids=sensenova-6.7-flash-lite&model_ids=sensenova-u1-fast&model_ids=deepseek-v4-flash",
    authType: "bearer-token",
    token: "",
    accountId: "",
    modelIds: ["sensenova-6.7-flash-lite", "sensenova-u1-fast", "deepseek-v4-flash"],
    responseType: "per-model-quota",
    enabled: false
  },
  "volcengine-coding": {
    responseType: "volcengine-coding-plan",
    ak: "",
    sk: "",
    region: "cn-beijing",
    enabled: false
  },
  "opencode-go": {
    responseType: "opencode-go",
    workspaceId: "",
    cookie: "",
    enabled: false
  },
};

function loadBalanceApis(dataDir) {
  const p = path.join(dataDir, "balance-apis.json");
  const saved = {};
  try {
    if (fs.existsSync(p)) Object.assign(saved, JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch {}
  // 合并默认配置，保留用户覆盖的字段
  const merged = { ...DEFAULT_BALANCE_APIS };
  for (const [k, v] of Object.entries(saved)) {
    if (merged[k] && typeof v === "object" && typeof merged[k] === "object") {
      merged[k] = { ...merged[k], ...v };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

async function fetchBalance(apiConfig, apiKey) {
  return new Promise((resolve) => {
    const req = https.get(apiConfig.url, {
      headers: { "Authorization": "Bearer " + apiKey, "Accept": "application/json" }
    }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          // DeepSeek 格式
          if (d.balance_infos && d.balance_infos.length) {
            let total = 0; const details = [];
            for (const bi of d.balance_infos) {
              const t = parseFloat(bi.total_balance) || 0;
              total += t;
              const label = bi.label || (bi.currency === "CNY" ? "余额" : bi.currency);
              details.push({ label, amount: t, currency: bi.currency || "CNY" });
            }
            resolve({ type: "money", total, currency: "CNY", display: "¥" + total.toFixed(2), details });
          }
          // GLM/智谱 配额格式
          else if (d.success && d.data && d.data.limits) {
            const tokenLimit = d.data.limits.find(l => l.type === "TOKENS_LIMIT");
            if (tokenLimit && typeof tokenLimit.percentage === "number") {
              const used = tokenLimit.percentage; const remain = 100 - used;
              resolve({ type: "quota", remain, used, display: "剩余 " + remain.toFixed(0) + "%" });
            } else resolve(null);
          }
          // 通用货币格式：尝试常见字段
          else {
            const avail = parseFloat(d.data?.available_balance ?? d.data?.balance ?? d.available_balance ?? d.balance ?? d.total_balance) || 0;
            if (avail > 0 || d.data || d.balance !== undefined) {
              resolve({ type: "money", total: avail, currency: d.currency || d.data?.currency || "CNY", display: "¥" + avail.toFixed(2) });
            } else resolve(null);
          }
        } catch(e) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

// ── MiniMax Token Plan 查询：5 小时 + 周限额双窗口 ──
function parseMinimaxWindow(total, used, remainPercent, status) {
  const totalN = parseInt(total, 10) || 0;
  const usedN = parseInt(used, 10) || 0;
  let remainPct = parseFloat(remainPercent);
  if (!isFinite(remainPct) || remainPct < 0 || remainPct > 100) remainPct = null;
  const usedPercent = remainPct != null ? +Math.min(100, Math.max(0, (100 - remainPct))).toFixed(1) : null;
  return {
    total: totalN,
    used: usedN,
    remain: Math.max(0, totalN - usedN),
    percent: usedPercent,        // 已用百分比
    remainPercent: remainPct,   // 剩余百分比（API 原始）
    countBased: totalN > 0,
    status: typeof status === "number" ? status : null
  };
}

async function fetchMinimaxTokenPlan(apiConfig, apiKey) {
  if (!apiKey) return Promise.resolve({ type: "error", display: "API Key 为空" });
  return new Promise((resolve) => {
    const req = https.get(apiConfig.url, {
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          if (!d || d.base_resp?.status_code !== 0 || !Array.isArray(d.model_remains)) {
            const msg = d?.base_resp?.status_msg || "查询失败";
            resolve({ type: "error", display: msg });
            return;
          }
          const plan = d.current_subscribe_title || d.plan_name || d.plan || null;
          const models = d.model_remains.map(m => {
            const name = m.model_name || m.model || "";
            const interval = parseMinimaxWindow(
              m.current_interval_total_count,
              m.current_interval_usage_count,
              m.current_interval_remaining_percent,
              m.current_interval_status
            );
            const weekly = parseMinimaxWindow(
              m.current_weekly_total_count,
              m.current_weekly_usage_count,
              m.current_weekly_remaining_percent,
              m.current_weekly_status
            );
            return {
              modelName: name,
              interval: {
                ...interval,
                endTime: m.current_interval_end_time || m.end_time || null,
                remainsMs: m.remains_time || null,
              },
              weekly: {
                ...weekly,
                endTime: m.current_weekly_end_time || m.weekly_end_time || null,
                remainsMs: m.weekly_remains_time || null,
              }
            };
          });
          resolve({ type: "token-plan", plan, models });
        } catch (e) {
          resolve({ type: "error", display: "解析失败" });
        }
      });
    });
    req.on("error", () => resolve({ type: "error", display: "网络错误" }));
    req.setTimeout(3500, () => { req.destroy(); resolve({ type: "error", display: "超时" }); });
  });
}

// ── 订阅余量查询（Sensenova 等 per-model-quota 类型） ──
async function fetchSubscriptionQuota(apiConfig) {
  const url = new URL(apiConfig.url);
  // 如果配置字段为空，保留 URL 上已有的查询参数
  if (apiConfig.accountId) url.searchParams.set("account_id", apiConfig.accountId);
  if (apiConfig.modelIds && apiConfig.modelIds.length) {
    // 清除 URL 中原有的 model_ids 参数，用配置的替换
    url.searchParams.delete("model_ids");
    for (const mid of apiConfig.modelIds) {
      url.searchParams.append("model_ids", mid);
    }
  }

  const headers = { "Accept": "application/json" };
  if (apiConfig.authType === "bearer-token") {
    headers["Authorization"] = "Bearer " + apiConfig.token;
  } else if (apiConfig.authType === "cookie") {
    headers["Cookie"] = "oauth2_authentication_session=" + apiConfig.token;
  }

  return new Promise((resolve) => {
    const req = https.get(url.toString(), { headers }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          const models = parsePerModelQuota(d);
          if (models && models.length) {
            const totalUsed = models.reduce((s, m) => s + (m.used || 0), 0);
            const totalLimit = models.reduce((s, m) => s + (m.limit || 0), 0);
            resolve({ models, totalUsed, totalLimit });
          } else resolve(null);
        } catch(e) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

// ── 火山方舟 V4 签名 + Coding Plan 用量查询 ──
function signVolcengineV4(ak, sk, region, service, host, method, path, queryString, body) {
  const now = new Date();
  const xDate = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const shortDate = xDate.slice(0, 8);
  const bodyHash = crypto.createHash("sha256").update(body || "").digest("hex");
  const credentialScope = shortDate + "/" + region + "/" + service + "/request";
  const canonicalHeaders = "host:" + host + "\nx-content-sha256:" + bodyHash + "\nx-date:" + xDate + "\n";
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalRequest = [method, path, queryString, canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const kDate = crypto.createHmac("sha256", sk).update(shortDate).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("request").digest();
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = "HMAC-SHA256 Credential=" + ak + "/" + credentialScope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  return { authorization, xDate, bodyHash };
}

async function fetchVolcengineCodingPlan(apiConfig) {
  const ak = apiConfig.ak || "";
  const sk = apiConfig.sk || "";
  const region = apiConfig.region || "cn-beijing";
  if (!ak || !sk) return { type: "error", display: "未配置 AK/SK" };
  const host = "open.volcengineapi.com";
  const qs = "Action=GetCodingPlanUsage&Version=2024-01-01";
  const sig = signVolcengineV4(ak, sk, region, "ark", host, "GET", "/", qs, "");
  return new Promise((resolve) => {
    const req = https.get({
      hostname: host,
      path: "/?" + qs,
      headers: { Authorization: sig.authorization, "X-Date": sig.xDate, "X-Content-Sha256": sig.bodyHash, Host: host }
    }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          if (d.ResponseMetadata?.Error) {
            resolve({ type: "error", display: d.ResponseMetadata.Error.Message || "查询失败" });
            return;
          }
          const result = d.Result;
          if (!result || !Array.isArray(result.QuotaUsage)) {
            resolve({ type: "error", display: "响应格式异常" });
            return;
          }
          const windows = result.QuotaUsage.map(q => ({
            level: q.Level,
            usedPercent: +parseFloat(q.Percent).toFixed(2),
            remainPercent: +(100 - parseFloat(q.Percent)).toFixed(2),
            resetAt: q.ResetTimestamp
          }));
          resolve({
            type: "coding-plan-quota",
            status: result.Status || "Unknown",
            updateTimestamp: result.UpdateTimestamp || null,
            windows
          });
        } catch (e) {
          resolve({ type: "error", display: "解析失败" });
        }
      });
    });
    req.on("error", () => resolve({ type: "error", display: "网络错误" }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ type: "error", display: "超时" }); });
  });
}

// ── OpenCode Go 套餐余量（控制台 cookie 抓取，无公开 API）──
// 页面内嵌初始状态形如：{rollingUsage:$R[0]={status:"ok",resetInSec:123,usagePercent:45},...}
const OPENCODE_GO_METER_RE = /(rollingUsage|weeklyUsage|monthlyUsage):\$R\[\d+\]=\{status:"([^"]+)",resetInSec:(\d+),usagePercent:(\d+)\}/g;

// ── OpenCode Go 用量统计（Serenity RPC，内部接口，无公开 API）──
// reference hash 随前端构建可能变化：从 https://opencode.ai/_build/assets/ 的 index-*.js 中搜 createServerReference 提取
const OPENCODE_GO_REF_COSTS = "15702f3a12ff8bff357f8c2aa154a17e65b746d5f6b96adc9002c86ee0c15205"; // getCosts(workspaceId, year, month, tzOffsetStr)
const OPENCODE_GO_REF_USAGE = "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c"; // getUsageInfo(workspaceId, page)

let ogStatsCache = { ts: 0, data: null };
let ogQuotaCache = { ts: 0, data: null };

// ── OpenCode Go 本地估算（无 cookie 兜底）──
// 官方计价规则：从 usage 明细 200 条线性回归（R²=0.9999）得出：
//   input $0.14/M + output $0.28/M + cache $0.0028/M，reasoning 免费
// 官方套餐窗口额度：$12 / 5h，$30 / 周，$60 / 月（opencode docs + 社区确认）
const OPENCODE_GO_PRICING = { inputPerM: 0.14, outputPerM: 0.28, cachePerM: 0.0028 };
const OPENCODE_GO_LIMITS = { rolling: 12, weekly: 30, monthly: 60 };
let ogCalibRatio = 1; // cookie 可用时用官方 totalCost 校准（官方/本地估算）

function loadOgCalibration() {
  try {
    const p = path.join(process.env.HANA_HOME || path.join(process.env.HOME || process.env.USERPROFILE, ".hanako"), "plugin-data", "token-tracker", "og-calib.json");
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (c && typeof c.ratio === "number" && c.ratio > 0) ogCalibRatio = c.ratio;
    }
  } catch {}
}
function saveOgCalibration(ratio) {
  if (!(ratio > 0) || ratio > 5) return;
  ogCalibRatio = ratio;
  try {
    const p = path.join(process.env.HANA_HOME || path.join(process.env.HOME || process.env.USERPROFILE, ".hanako"), "plugin-data", "token-tracker", "og-calib.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ratio, updatedAt: Date.now() }));
  } catch {}
}
loadOgCalibration();

// 从 usage-ledger 聚合 opencode-go 各窗口消耗，按官方价估算美元
function estimateOpenCodeGoUsage() {
  try {
    const ledgerPath = path.join(process.env.HANA_HOME || path.join(process.env.HOME || process.env.USERPROFILE, ".hanako"), "usage-ledger.json");
    if (!fs.existsSync(ledgerPath)) return null;
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
    const entries = ledger.entries || [];
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = (now.getDay() + 6) % 7; // 周一 = 0
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - dow);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const acc = { rolling: { i: 0, o: 0, c: 0 }, weekly: { i: 0, o: 0, c: 0 }, monthly: { i: 0, o: 0, c: 0 } };
    const fiveH = now.getTime() - 5 * 3600 * 1000;
    for (const e of entries) {
      if (!e.model || e.model.provider !== "opencode-go") continue;
      const t = new Date(e.startedAt);
      if (isNaN(t.getTime())) continue;
      const u = e.usage || {};
      const i = u.input?.totalTokens || 0, o = u.output?.totalTokens || 0, c = u.cache?.readTokens || 0;
      if (t.getTime() >= fiveH) { acc.rolling.i += i; acc.rolling.o += o; acc.rolling.c += c; }
      if (t >= startOfWeek) { acc.weekly.i += i; acc.weekly.o += o; acc.weekly.c += c; }
      if (t >= startOfMonth) { acc.monthly.i += i; acc.monthly.o += o; acc.monthly.c += c; }
    }
    const p = OPENCODE_GO_PRICING;
    const usdOf = (s) => (s.i * p.inputPerM + s.o * p.outputPerM + s.c * p.cachePerM) / 1e6 * ogCalibRatio;
    const windows = [
      { level: "rolling", usedUsd: usdOf(acc.rolling), limitUsd: OPENCODE_GO_LIMITS.rolling },
      { level: "weekly", usedUsd: usdOf(acc.weekly), limitUsd: OPENCODE_GO_LIMITS.weekly },
      { level: "monthly", usedUsd: usdOf(acc.monthly), limitUsd: OPENCODE_GO_LIMITS.monthly }
    ];
    return { type: "opencode-go-quota-est", windows, est: true, calibRatio: ogCalibRatio };
  } catch (e) {
    return null;
  }
}

// 校准：官方本月 totalCost vs 本地估算
function calibrateOg(estMonthUsd, officialMonthUsd) {
  if (estMonthUsd > 0.01 && officialMonthUsd >= 0) {
    saveOgCalibration(officialMonthUsd / estMonthUsd);
  }
}

// ── OpenCode Go 时间范围过滤（统一口径：本地时区时间戳）──
function ogRangeStartTs(range) {
  const now = new Date();
  if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === "week") {
    const dow = (now.getDay() + 6) % 7;
    const ws = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    ws.setDate(ws.getDate() - dow);
    return ws.getTime();
  }
  if (range === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (range === "year") return new Date(now.getFullYear(), 0, 1).getTime();
  if (range === "lyear") return new Date(now.getFullYear() - 1, 0, 1).getTime();
  return 0;
}
function ogInRange(ts, range, from, to) {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (isNaN(t)) return false;
  if (t < ogRangeStartTs(range)) return false;
  // lyear 需要上限：去年 12-31 23:59:59
  if (range === "lyear") {
    const now = new Date();
    const le = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59).getTime();
    if (t > le) return false;
  }
  if (from) { const f = new Date(from + "T00:00:00").getTime(); if (t < f) return false; }
  if (to) { const tt = new Date(to + "T23:59:59").getTime(); if (t > tt) return false; }
  return true;
}

// 模型汇总（按时间范围 + 可选 keyId 过滤）：次数与费用均来自官方 usage 明细缓存
function aggregateOgModels(ogRecs, range, from, to, keyId) {
  const src = ogRecs && typeof ogRecs === "object" && Object.keys(ogRecs).length ? ogRecs : null;
  if (!src) return [];
  const map = {};
  for (const id in src) {
    const u = src[id];
    if (!u || !u.model || !ogInRange(u.ts, range, from, to)) continue;
    if (keyId && u.keyId !== keyId) continue;
    if (!map[u.model]) map[u.model] = { model: u.model, cost: 0, count: 0, inputTokens: 0, outputTokens: 0 };
    map[u.model].cost += u.cost || 0;
    map[u.model].count++;
    map[u.model].inputTokens += u.inputTokens || 0;
    map[u.model].outputTokens += u.outputTokens || 0;
  }
  return Object.values(map)
    .map(x => ({ model: x.model, count: x.count, costUsd: (x.cost || 0) / 1e8, inputTokens: x.inputTokens, outputTokens: x.outputTokens }))
    .filter(x => x.count > 0 || x.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd);
}

// 官方成本接口按日期/模型/KEY 汇总，totalCost 与 usage.cost 同为 1e-8 美元整数。
// 费用展示优先使用这里的结果，避免本地 token 估算与官方账单产生口径差异。
function aggregateOgOfficialCosts(costs, range, from, to, keyId) {
  const map = {};
  for (const c of costs || []) {
    const day = String(c?.date || "").slice(0, 10);
    if (!day || !c?.model || !ogInRange(day + "T12:00:00", range, from, to)) continue;
    if (keyId && c.keyId !== keyId) continue;
    map[c.model] = (map[c.model] || 0) + (Number(c.totalCost) || 0);
  }
  for (const model of Object.keys(map)) map[model] /= 1e8;
  return map;
}

function mergeOgOfficialCosts(rows, costMap) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const next = { ...row };
    if (Object.prototype.hasOwnProperty.call(costMap || {}, next.model)) next.costUsd = costMap[next.model];
    out.push(next);
    seen.add(next.model);
  }
  for (const [model, costUsd] of Object.entries(costMap || {})) {
    if (seen.has(model)) continue;
    out.push({ model, count: 0, costUsd, inputTokens: 0, outputTokens: 0 });
  }
  return out.sort((a, b) => b.costUsd - a.costUsd || b.count - a.count);
}

// 官方成本仅覆盖当前月/上月；更早日期用已同步 usage 缓存补齐，按日期去重避免重复计费。
function aggregateOgCostSources(costs, ogRecs, range, from, to, keyId) {
  const map = {};
  const officialDays = new Set();
  for (const c of costs || []) {
    const day = String(c?.date || "").slice(0, 10);
    if (!day || !c?.model || !ogInRange(day + "T12:00:00", range, from, to)) continue;
    if (keyId && c.keyId !== keyId) continue;
    officialDays.add(day);
    map[c.model] = (map[c.model] || 0) + (Number(c.totalCost) || 0) / 1e8;
  }
  let fallbackUsed = false;
  for (const r of Object.values(ogRecs || {})) {
    const rd = r?.ts ? new Date(r.ts) : null;
    const day = rd && !isNaN(rd.getTime()) ? rd.getFullYear() + "-" + String(rd.getMonth() + 1).padStart(2, "0") + "-" + String(rd.getDate()).padStart(2, "0") : "";
    if (!day || !r?.model || !ogInRange(r.ts, range, from, to)) continue;
    if (keyId && r.keyId !== keyId) continue;
    if (officialDays.has(day)) continue;
    map[r.model] = (map[r.model] || 0) + (Number(r.cost) || 0) / 1e8;
    fallbackUsed = true;
  }
  return {
    costs: map,
    source: officialDays.size ? (fallbackUsed ? "official+usage-cache" : "official") : "usage-cache"
  };
}

// Serenity server function 的参数序列化（devalue 风格）
function devalueArgs(args) {
  const a = args.map(x => typeof x === "string" ? { t: 1, s: x } : { t: 0, s: x });
  return { t: { t: 9, i: 0, l: a.length, a, o: 0 }, f: 31, m: [] };
}

// Serenity RPC 响应反序列化：;0x00000000;((self.$R=...)...,(FN)(ARGS))
// 在 vm 沙箱中求值（响应来自 opencode.ai 官方，只读数据不执行其他逻辑）
function parseSerenity(raw) {
  const m = String(raw).match(/;0x[0-9a-f]+;([\s\S]+)$/);
  if (!m) return null;
  const sandbox = { self: { $R: {} }, Date, JSON, Math, console };
  sandbox.$R = sandbox.self.$R;
  vm.createContext(sandbox);
  try {
    vm.runInContext(m[1], sandbox, { timeout: 2000 });
    const slot = sandbox.self.$R["server-fn:1"];
    return slot && slot[0];
  } catch (e) {
    return null;
  }
}

// opencode.ai 服务器响应偏慢，复用 TLS 连接减少握手开销
const ogHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

// 用量记录字段规范化（兼容 camelCase / snake_case，usg_id 去重键）
function normalizeOgUsageRecord(r) {
  if (!r || typeof r !== "object") return null;
  const id = r.id || r.usg_id || r.usageId || "";
  if (!id) return null;
  const rawCost = r.cost != null ? r.cost : (r.costRaw != null ? r.costRaw : (r.totalCost != null ? r.totalCost : 0));
  return {
    id,
    ts: r.timeCreated || r.created_at || r.timestamp || r.createdAt || "",
    model: r.model || r.modelId || "unknown",
    provider: r.provider || "",
    inputTokens: r.inputTokens != null ? r.inputTokens : (r.input_tokens || 0),
    outputTokens: r.outputTokens != null ? r.outputTokens : (r.output_tokens || 0),
    cost: Number(rawCost) || 0,
    keyId: r.keyID || r.key_id || "",
    plan: r.plan || null
  };
}

// ── OpenCode Go 用量全量同步（按 usg_id 去重持久化，参考 68hub usage-sync）──
const OG_USAGE_CACHE_VERSION = 1;
const OG_USAGE_PAGE_SIZE = 50;
const OG_USAGE_MAX_PAGES = 500;   // 每页 50 条，最多 25000 条
const OG_SYNC_LOCKS = new Set();   // 防止并发同步

function ogUsageCachePath() {
  return path.join(HOME, "plugin-data", "token-tracker", "og-usage-cache.json");
}

function loadOgUsageCache() {
  try {
    const p = ogUsageCachePath();
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (c && c.version === OG_USAGE_CACHE_VERSION && c.records) return c;
    }
  } catch {}
  return { version: OG_USAGE_CACHE_VERSION, records: {}, deepestPage: -1, syncedAt: 0, total: 0 };
}

function saveOgUsageCache(cache) {
  try {
    const p = ogUsageCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache));
  } catch {}
}

// 拉取一页 usage 记录（含超时/失败保护）
async function fetchOgUsagePage(cookie, ws, page) {
  try {
    const raw = await openCodeGoRpc(cookie, OPENCODE_GO_REF_USAGE, [ws, page]);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeOgUsageRecord).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// 同步：mode=incremental 增量（默认）/ full 全量。返回 { inserted, pages, done }
async function syncOgUsage(cookie, ws, mode) {
  if (!cookie || !ws) return { inserted: 0, pages: 0, done: false, error: "未配置" };
  const lockKey = ws;
  if (OG_SYNC_LOCKS.has(lockKey)) return { inserted: 0, pages: 0, done: false, error: "同步中" };
  OG_SYNC_LOCKS.add(lockKey);
  try {
    const cache = loadOgUsageCache();
    let inserted = 0;
    let pages = 0;
    // 增量：先刷前 20 页拿最新，再从断点继续往后补（页号越大越旧）
    let deepest = cache.deepestPage;
    if (mode !== "full" && deepest >= 0) {
      const headPages = Math.min(deepest + 1, 20);
      for (let p = 0; p < headPages; p++) {
        const recs = await fetchOgUsagePage(cookie, ws, p);
        pages++;
        if (!recs.length) break;
        let hasNew = false;
        for (const r of recs) {
          if (!cache.records[r.id]) { cache.records[r.id] = r; inserted++; hasNew = true; }
        }
        if (recs.length < OG_USAGE_PAGE_SIZE) break;
        if (!hasNew && p >= 1) break;   // 头部无新数据 → 增量完成
      }
    }
    let start = Math.max(0, deepest + 1);
    const pageLimit = mode === "full" ? OG_USAGE_MAX_PAGES : Math.min(OG_USAGE_MAX_PAGES, 60);
    for (let p = start; p < start + pageLimit; p++) {
      const recs = await fetchOgUsagePage(cookie, ws, p);
      pages++;
      if (!recs.length) break;
      let hasNew = false;
      for (const r of recs) {
        if (!cache.records[r.id]) { cache.records[r.id] = r; inserted++; hasNew = true; }
      }
      deepest = p;
      if (recs.length < OG_USAGE_PAGE_SIZE) break;
      if (!hasNew) break;
    }
    cache.deepestPage = deepest;
    cache.syncedAt = Date.now();
    cache.total = Object.keys(cache.records).length;
    // 自动识别主 key：最近 24h 内调用最多的 keyId（Hana 绑定的 sk-key 对应它）
    const dayAgo = Date.now() - 86400000;
    const keyCount = {};
    for (const id in cache.records) {
      const r = cache.records[id];
      if (!r || !r.keyId || !r.ts) continue;
      const t = new Date(r.ts).getTime();
      if (isNaN(t) || t < dayAgo) continue;
      keyCount[r.keyId] = (keyCount[r.keyId] || 0) + 1;
    }
    let primaryKey = null, maxC = 0;
    for (const kid of Object.keys(keyCount)) {
      if (keyCount[kid] > maxC) { maxC = keyCount[kid]; primaryKey = kid; }
    }
    if (primaryKey) cache.primaryKeyId = primaryKey;
    saveOgUsageCache(cache);
    return { inserted, pages, done: true, total: cache.total, deepestPage: deepest, primaryKeyId: cache.primaryKeyId };
  } catch (e) {
    return { inserted: 0, pages, done: false, error: e.message || "同步失败" };
  } finally {
    OG_SYNC_LOCKS.delete(lockKey);
  }
}

// 从持久化缓存按模型聚合（请求数 + 费用 + tokens），时间口径与模型/Key 汇总统一
function aggregateOgModelUsage(records, range, from, to) {
  const map = {};
  for (const id in records) {
    const r = records[id];
    if (!r || !ogInRange(r.ts, range, from, to)) continue;
    const m = r.model || "unknown";
    if (!map[m]) map[m] = { model: m, count: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    map[m].count++;
    map[m].costUsd += r.cost / 1e8;   // usage 接口 cost 为 1e-8 美元整数（与 getCosts totalCost 同口径，实测 8/1 官方账单对齐）
    map[m].inputTokens += r.inputTokens || 0;
    map[m].outputTokens += r.outputTokens || 0;
  }
  return Object.values(map)
    .map(x => ({ model: x.model, count: x.count, costUsd: x.costUsd, inputTokens: x.inputTokens, outputTokens: x.outputTokens }))
    .sort((a, b) => b.costUsd - a.costUsd || b.count - a.count);
}

// 调用一个 Serenity server reference（POST /_server）
function openCodeGoRpc(cookie, refId, args) {
  const body = JSON.stringify(devalueArgs(args));
  return new Promise((resolve) => {
    const req = https.request("https://opencode.ai/_server", {
      method: "POST",
      agent: ogHttpsAgent,
      headers: {
        "Cookie": "auth=" + cookie,
        "User-Agent": "token-tracker/1.0",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Server-Id": refId,
        "X-Server-Instance": "server-fn:1"
      }
    }, res => {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        resolve(parseSerenity(out));
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// 用量统计：当月+上月 Cost（按天聚合）+ 最近调用明细（第 1 页）。10 分钟缓存。
async function fetchOpenCodeGoStats(cookie, ws) {
  if (!cookie || !ws) return null;
  const now = new Date();
  const key = now.getFullYear() + "/" + now.getMonth();
  if (ogStatsCache.data && ogStatsCache.key === key && Date.now() - ogStatsCache.ts < 180000) {
    return ogStatsCache.data;
  }
  const y = now.getFullYear();
  const m = now.getMonth();
  const tz = "+08:00";
  const months = [];
  for (let i = 0; i < 2; i++) {
    let yy = y, mm = m - i;
    while (mm < 0) { mm += 12; yy--; }
    months.push([yy, mm]);
  }
  const results = await Promise.all([
    ...months.map(([yy, mm]) => openCodeGoRpc(cookie, OPENCODE_GO_REF_COSTS, [ws, yy, mm, tz])),
    ...Array.from({ length: 14 }, (_, i) => openCodeGoRpc(cookie, OPENCODE_GO_REF_USAGE, [ws, i]))
  ]);
  const costs = [];
  let keys = [];
  const keysMap = {};   // 合并两个月返回的 keys（当月为空时用上月补）
  for (let i = 0; i < 2; i++) {
    const r = results[i];
    if (r && Array.isArray(r.usage)) {
      for (const u of r.usage) costs.push(u);
      if (r.keys && r.keys.length) {
        for (const k of r.keys) {
          if (k && k.id && !keysMap[k.id]) keysMap[k.id] = k;
        }
      }
    }
  }
  keys = Object.values(keysMap);
  const usage = [];
  for (let i = 2; i < results.length; i++) {
    if (Array.isArray(results[i])) usage.push(...results[i]);
  }
  const truncated = Array.isArray(results[results.length - 1]) && results[results.length - 1].length >= 50;
  const data = { costs, keys, usage, truncated, fetchedAt: Date.now() };
  ogStatsCache = { key, ts: Date.now(), data };
  return data;
}

// Key 汇总（按时间范围 + 可选 keyId 过滤）：每个 key 下钻到模型明细
function aggregateOgKeys(keys, ogRecs, range, from, to, filterKeyId) {
  const idToName = {};
  for (const k of keys || []) if (k && k.id) idToName[k.id] = k.displayName || k.id;
  // 兜底：从 usage 缓存的 keyNames 补（getCosts 偶尔返回空时）
  try {
    const uc = loadOgUsageCache();
    if (uc && uc.keyNames) {
      for (const kid of Object.keys(uc.keyNames)) {
        if (!idToName[kid]) idToName[kid] = uc.keyNames[kid];
      }
    }
  } catch {}
  const src = ogRecs && typeof ogRecs === "object" && Object.keys(ogRecs).length ? ogRecs : null;
  if (!src) return [];
  const keyMap = {};
  for (const id in src) {
    const u = src[id];
    if (!u || !u.keyId || !ogInRange(u.ts, range, from, to)) continue;
    if (filterKeyId && u.keyId !== filterKeyId) continue;
    const kid = u.keyId;
    if (!keyMap[kid]) keyMap[kid] = { keyId: kid, cost: 0, count: 0, models: {} };
    keyMap[kid].cost += u.cost || 0;
    keyMap[kid].count++;
    const m = u.model || "unknown";
    if (!keyMap[kid].models[m]) keyMap[kid].models[m] = { model: m, cost: 0, count: 0, inputTokens: 0, outputTokens: 0 };
    keyMap[kid].models[m].cost += u.cost || 0;
    keyMap[kid].models[m].count++;
    keyMap[kid].models[m].inputTokens += u.inputTokens || 0;
    keyMap[kid].models[m].outputTokens += u.outputTokens || 0;
  }
  return Object.values(keyMap)
    .map(x => ({
      keyId: x.keyId,
      name: idToName[x.keyId] || x.keyId,
      count: x.count,
      costUsd: (x.cost || 0) / 1e8,
      models: Object.values(x.models)
        .map(mo => ({ model: mo.model, count: mo.count, costUsd: (mo.cost || 0) / 1e8, inputTokens: mo.inputTokens, outputTokens: mo.outputTokens }))
        .filter(mo => mo.count > 0 || mo.costUsd > 0)
        .sort((a, b) => b.costUsd - a.costUsd || b.count - a.count)
    }))
    .filter(x => x.count > 0 || x.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd);
}

async function fetchOpenCodeGoQuota(apiConfig) {
  const ws = apiConfig.workspaceId || "";
  const cookie = apiConfig.cookie || "";
  if (!ws || !cookie) return { type: "error", display: "未配置 workspace/cookie" };
  // 余量窗口以小时/天计，5 分钟内变化可忽略；缓存避免每次刷新都等慢速 SSR
  if (ogQuotaCache.data && Date.now() - ogQuotaCache.ts < 300000) {
    return ogQuotaCache.data;
  }
  const url = "https://opencode.ai/workspace/" + ws + "/go";
  return new Promise((resolve) => {
    const req = https.get(url, {
      agent: ogHttpsAgent,
      headers: {
        "Cookie": "auth=" + cookie,
        "Accept": "text/html",
        "User-Agent": "token-tracker/1.0"
      }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
        const loc = res.headers.location || "";
        res.resume();
        resolve(estimateOpenCodeGoUsage() || { type: "error", display: "Cookie 过期，请更新" });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(estimateOpenCodeGoUsage() || { type: "error", display: "获取失败" });
        return;
      }
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          OPENCODE_GO_METER_RE.lastIndex = 0;
          const meters = [...body.matchAll(OPENCODE_GO_METER_RE)];
          if (!meters.length) {
            resolve(estimateOpenCodeGoUsage() || { type: "error", display: "页面无用量数据（未订阅或页面改版）" });
            return;
          }
          const windows = meters.map(m => ({
            level: m[1] === "rollingUsage" ? "rolling" : (m[1] === "weeklyUsage" ? "weekly" : "monthly"),
            usedPercent: +m[4],
            resetInSec: +m[3],
            status: m[2]
          }));
          const data = { type: "opencode-go-quota", windows };
          ogQuotaCache = { ts: Date.now(), data };
          resolve(data);
        } catch (e) {
          resolve(estimateOpenCodeGoUsage() || { type: "error", display: "解析失败" });
        }
      });
    });
    req.on("error", () => resolve(estimateOpenCodeGoUsage() || { type: "error", display: "网络错误" }));
    // 服务器 SSR 渲染慢（实测 4-9s），超时线放宽到与 race 一致
    req.setTimeout(12000, () => { req.destroy(); resolve(estimateOpenCodeGoUsage() || { type: "error", display: "超时" }); });
  });
}

function parsePerModelQuota(data) {
  if (!data || typeof data !== "object") return null;
  let items = null;
  // 尝试多种常见响应结构
  if (data.data && Array.isArray(data.data)) items = data.data;
  else if (data.usages && Array.isArray(data.usages)) items = data.usages;
  else if (Array.isArray(data.data?.usages)) items = data.data.usages;
  else if (Array.isArray(data.data?.list)) items = data.data.list;
  else if (Array.isArray(data.list)) items = data.list;
  // Sensenova 格式：{ "model_remaining_percent": { "model_id": 75.4, ... } }
  else if (data.model_remaining_percent && typeof data.model_remaining_percent === "object") {
    return Object.entries(data.model_remaining_percent).map(([modelId, pct]) => {
      const remainPct = parseFloat(pct) || 0;
      const usedPct = +(100 - remainPct).toFixed(1);
      // 不知道总限额，显示百分比
      return {
        modelId,
        used: usedPct,
        limit: 100,
        remain: remainPct,
        pct: usedPct,
        display: "剩余 " + remainPct.toFixed(1) + "%",
        _isPercent: true
      };
    }).filter(Boolean);
  }
  // 兜底：找第一个数组字段
  if (!items) {
    for (const k of Object.keys(data)) {
      if (Array.isArray(data[k]) && data[k].length > 0 && data[k][0].model_id !== undefined) {
        items = data[k]; break;
      }
    }
  }
  if (!items) return null;

  return items.map(item => {
    const modelId = item.model_id || item.modelId || item.model || item.id || "";
    const used = parseInt(item.used || item.used_calls || item.consumed || item.usage || item.usedTokens || 0, 10);
    const limit = parseInt(item.limit || item.total || item.total_calls || item.quota || item.limit_calls || item.maxCalls || 0, 10);
    const remain = parseInt(item.remaining || item.remaining_calls || (limit - used), 10);
    if (!modelId || !limit) return null;
    const pct = limit > 0 ? ((used / limit) * 100).toFixed(1) : "0";
    return { modelId, used, limit, remain, pct, display: remain + "/" + limit };
  }).filter(Boolean);
}

function esc(v) { return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function cnToday(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date())}

function widgetHtml(ctx, th, token, css, js) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/api/plugins/${ctx.pluginId}/widget.css?token=${esc(token)}">
<style>${css}</style>
</head><body data-hana-theme="${esc(th)}" data-surface="widget">
<div id="app"><div class="loading">翻阅档案…</div></div>
<script>${js}</script>
</body></html>`;
}

// realtimeSnapshot 函数不再重复定义；使用 cache.realtimeSnapshot（由 index.js onload 时挂入到 shared）
