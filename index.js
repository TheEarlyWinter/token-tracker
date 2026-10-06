import fs from "node:fs";
import path from "node:path";
import { defineApp } from "./sdk/app-contract/server-client.js";

const CACHE_FILE = "token-cache.json";
const ARCHIVE_FILE = "usage-archive.json";
const CACHE_VERSION = 20;
const MAX_LEDGER_LIMIT = 20000;

function tokVal(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object") return v.totalTokens || 0;
  return 0;
}

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const hourFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false });

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  const cachePath = path.join(dataDir, CACHE_FILE);
  const archivePath = path.join(dataDir, ARCHIVE_FILE);

  let scanIntervalSec = 60;
  try {
    const cfgVal = await sdk.config?.get?.("scanInterval");
    if (typeof cfgVal === "number" && cfgVal > 0) scanIntervalSec = cfgVal;
  } catch (e) {
    // 异步读取配置降级默认值，避免激活时 schema 校验前报错
  }
  const interval = scanIntervalSec * 1000;

  const archive = loadArchive(archivePath);
  const shared = {
    sdk,
    bus: sdk.bus,
    log: sdk.logger || console,
    dataDir,
    cachePath,
    archivePath,
    archive,
    data: null,
    ready: false,
    scanning: false,
    agentNames: {},
    _realtimeClients: new Set(),
    realtimeSnapshot,
  };

  // 挂载至 sdk._tokenCache 供后端路由读取
  sdk._tokenCache = shared;
  if (sdk.rawContext) {
    try { sdk.rawContext._tokenCache = shared; } catch {}
  }

  // 注册 HTTP 路由（标准 v2 路由注册机制）
  if (typeof sdk.routes?.register === "function") {
    try {
      const { default: registerRoutes } = await import("./server/dashboard.js");
      sdk.routes.register((app) => registerRoutes(app, sdk));
    } catch (err) {
      shared.log.warn?.("[token-tracker] route registration failed:", err.message);
    }
  }

  // 尝试获取所有 Agent 名称映射（需 app/agents.read）
  await refreshAgentNames(shared);

  // scan(force): 全量从 usage:list 拉取并结合本地归档重新汇总
  shared.scan = (force = false) => {
    if (shared.scanning) return Promise.resolve();
    shared.scanning = true;
    return scanFromLedger(shared, force).finally(() => {
      shared.scanning = false;
    });
  };
  shared.fullScan = () => shared.scan(true);

  // 初始加载：后台执行扫描，不阻塞 App 装载
  const oldCache = loadCache(cachePath);
  if (oldCache && oldCache.version === CACHE_VERSION && Object.keys(archive.entries).length > 0) {
    shared.scan(false);
  } else {
    shared.fullScan();
  }

  // 定时增量扫描
  const timer = setInterval(() => {
    shared.scan(false);
  }, interval);
  timer.unref?.();

  // 实时状态结构
  const realtime = {
    agentId: null,
    agentName: null,
    sessionId: null,
    model: null,
    provider: null,
    lastInput: 0,
    lastOutput: 0,
    lastReasoning: 0,
    lastCacheRead: 0,
    lastTotalTokens: 0,
    lastCost: 0,
    sessionInput: 0,
    sessionOutput: 0,
    sessionReasoning: 0,
    sessionCacheRead: 0,
    sessionTotalTokens: 0,
    sessionCost: 0,
    sessionMsgCount: 0,
    contextTokens: 0,
    contextWindow: 1000000,
    elapsed: 0,
    totalRequests: 0,
    balances: null,
    balanceUpdatedAt: null,
    updatedAt: Date.now(),
    currentSessionStart: Date.now(),
  };
  shared.realtime = realtime;

  // 订阅宿主事件：llm_usage 与 legacy token_usage
  let unsubBus = null;
  try {
    if (typeof sdk.bus?.subscribe === "function") {
      unsubBus = await sdk.bus.subscribe((ev) => {
        try {
          if (ev?.type === "llm_usage" && ev?.entry) {
            handleLlmUsageEvent(shared, ev.entry);
          } else if (ev?.type === "token_usage") {
            handleLegacyTokenUsageEvent(shared, ev);
          }
        } catch (err) {
          shared.log.warn?.("[token-tracker] event handling error:", err.message);
        }
      });
    }
  } catch (err) {
    shared.log.warn?.("[token-tracker] bus.subscribe failed:", err.message);
  }

  // 幂等清理闭包
  shared.dispose = () => {
    clearInterval(timer);
    try {
      if (typeof unsubBus === "function") unsubBus();
      else if (unsubBus?.disposeAsync) unsubBus.disposeAsync();
      else if (unsubBus?.unsubscribe) unsubBus.unsubscribe();
    } catch {}
    if (shared._realtimeClients) {
      for (const client of shared._realtimeClients) {
        try { client.close?.(); } catch {}
      }
      shared._realtimeClients.clear();
    }
  };

  shared.log.info?.("[token-tracker] v2 app loaded (interval " + interval + "ms)");
});

// ─── 刷新 Agent 名称（失败优雅降级）───
async function refreshAgentNames(shared) {
  try {
    const listFn = typeof shared.sdk?.agents?.list === "function"
      ? (params) => shared.sdk.agents.list(params)
      : (params) => shared.bus.request("agent:list", params);
    const res = await listFn({ scope: "all" });
    if (res?.agents && Array.isArray(res.agents)) {
      const names = {};
      for (const a of res.agents) {
        if (a?.id) names[a.id] = a.name || a.id;
      }
      shared.agentNames = { ...shared.agentNames, ...names };
    }
  } catch (e) {
    shared.log.warn?.("[token-tracker] agent:list failed (retaining existing mappings):", e.message);
  }
}

// ─── 核心：从官方 usage-ledger 读取并结合本地归档 ───
async function scanFromLedger(shared, force = false) {
  const archive = shared.archive;
  const old = loadCache(shared.cachePath);
  const cache = old || {
    version: CACHE_VERSION,
    lastScan: null,
    sessions: {},
    agentNames: {},
  };
  cache.version = CACHE_VERSION;
  let changed = false;

  // 合并 Agent 映射（不因失败清除旧有已存在 Agent）
  if (shared.agentNames && Object.keys(shared.agentNames).length > 0) {
    cache.agentNames = { ...shared.agentNames, ...cache.agentNames };
  }

  // 1. 从官方账本查询（最大拉取当前保留窗口 20000 条，无需也不传非法 cursor/all）
  let entries = [];
  let usageQueryError = null;
  try {
    const listUsage = typeof shared.sdk?.usage?.list === "function"
      ? (params) => shared.sdk.usage.list(params)
      : (params) => shared.bus.request("usage:list", params);
    const result = await listUsage({ limit: MAX_LEDGER_LIMIT });
    entries = result?.entries || [];
  } catch (e) {
    usageQueryError = e.message || "usage_query_failed";
    shared.log.warn?.("[token-tracker] usage:list failed:", e.message);
  }

  // 覆盖限制标志
  const coverageLimitReached = entries.length >= MAX_LEDGER_LIMIT;
  shared.coverageLimitReached = coverageLimitReached;
  shared.usageQueryError = usageQueryError;

  // 2. 将账本记录幂等追加至本地 usage-archive.json
  let newArchivedCount = 0;
  for (const raw of entries) {
    const rid = raw.requestId;
    if (!rid) continue;
    // 校验终态与有效性：usage 为 null 不当有效 0 请求
    if (raw.status !== "ok" || !raw.usage) {
      continue;
    }
    if (!archive.entries[rid]) {
      archive.entries[rid] = normalizeEntryForArchive(raw);
      newArchivedCount++;
    }
  }

  if (newArchivedCount > 0 || !archive.updatedAt) {
    archive.updatedAt = new Date().toISOString();
    saveArchive(shared.archivePath, archive);
    changed = true;
  }

  // 3. 基于归档重建会话与统计视图
  const sessionMap = {};
  const allEntries = Object.values(archive.entries);

  for (const rec of allEntries) {
    const provider = rec.provider || "";
    const model = rec.model || "unknown";
    const ts = rec.startedAt || rec.endedAt || "";
    const tsDate = ts ? new Date(ts) : new Date();
    const day = dayFmt.format(tsDate);
    const hour = String(hourFmt.format(tsDate)).padStart(2, "0");
    const agent = rec.agentId || "unknown";
    const type = rec.type || "desktop";

    const inp = rec.inputTokens || 0;
    const inpUncached = rec.inputUncachedTokens ?? inp;
    const out = rec.outputTokens || 0;
    const cr = rec.cacheReadTokens || 0;
    const cw = rec.cacheWriteTokens || 0;
    const tot = rec.totalTokens || (inp + out + cr);
    const cost = rec.costTotal || 0;

    const key = `${agent}::${type}::${day}`;
    if (!sessionMap[key]) {
      sessionMap[key] = {
        agent,
        type,
        channelName: null,
        filePath: "usage-ledger.sqlite",
        mtime: 0,
        size: 0,
        fileName: "usage-ledger.sqlite",
        firstTime: null,
        lastTime: null,
        msgCount: 0,
        assistantCount: 0,
        input: 0,
        inputUncached: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
        models: {},
        providers: {},
        conversations: [],
        mediaGen: {},
        dailyBreakdown: {},
        hourlyBreakdown: {},
        title: day,
      };
    }
    const s = sessionMap[key];
    if (!s.firstTime) s.firstTime = ts;
    if (!s.lastTime || ts > s.lastTime) s.lastTime = ts;
    s.msgCount++;
    s.assistantCount++;
    s.input += inp;
    s.inputUncached += inpUncached;
    s.output += out;
    s.cacheRead += cr;
    s.cacheWrite += cw;
    s.totalTokens += tot;
    s.cost += cost;

    // 模型统计
    if (!s.models[model]) {
      s.models[model] = { input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 };
    }
    s.models[model].input += inp;
    s.models[model].inputUncached += inpUncached;
    s.models[model].output += out;
    s.models[model].cacheRead += cr;
    s.models[model].cacheWrite += cw;
    s.models[model].count++;

    // 供应商/模型统计
    if (provider) {
      const pk = provider + "/" + model;
      if (!s.providers[pk]) {
        s.providers[pk] = { provider, model, totalTokens: 0, count: 0, input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      }
      s.providers[pk].totalTokens += tot;
      s.providers[pk].count++;
      s.providers[pk].input += inp;
      s.providers[pk].inputUncached += inpUncached;
      s.providers[pk].output += out;
      s.providers[pk].cacheRead += cr;
      s.providers[pk].cacheWrite += cw;
    }

    // 每日细分
    if (!s.dailyBreakdown[day]) {
      s.dailyBreakdown[day] = {
        totalTokens: 0,
        desktop: 0,
        channel: 0,
        bridge: 0,
        background: 0,
        sub: 0,
        ledger: 0,
        input: 0,
        inputUncached: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        assistantCount: 0,
        models: {},
        providerTotals: {},
      };
    }
    const bd = s.dailyBreakdown[day];
    bd.totalTokens += tot;
    if (bd[type] !== undefined) bd[type] += tot;
    else bd[type] = tot;
    bd.input += inp;
    bd.inputUncached += inpUncached;
    bd.output += out;
    bd.cacheRead += cr;
    bd.cacheWrite += cw;
    bd.assistantCount++;

    if (!bd.models[model]) {
      bd.models[model] = { input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, assistantCount: 0 };
    }
    bd.models[model].input += inp;
    bd.models[model].inputUncached += inpUncached;
    bd.models[model].output += out;
    bd.models[model].cacheRead += cr;
    bd.models[model].cacheWrite += cw;
    bd.models[model].totalTokens += tot;
    bd.models[model].assistantCount++;

    if (provider) {
      const pk = provider + "/" + model;
      if (!bd.providerTotals[pk]) {
        bd.providerTotals[pk] = { totalTokens: 0, input: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0 };
      }
      bd.providerTotals[pk].totalTokens += tot;
      bd.providerTotals[pk].input += inp;
      bd.providerTotals[pk].inputUncached += inpUncached;
      bd.providerTotals[pk].output += out;
      bd.providerTotals[pk].cacheRead += cr;
      bd.providerTotals[pk].cacheWrite += cw;
      bd.providerTotals[pk].assistantCount++;
    }

    // 每小时细分
    if (!s.hourlyBreakdown[day]) s.hourlyBreakdown[day] = {};
    if (!s.hourlyBreakdown[day][hour]) {
      s.hourlyBreakdown[day][hour] = {
        totalTokens: 0,
        desktop: 0,
        channel: 0,
        bridge: 0,
        background: 0,
        sub: 0,
        ledger: 0,
        cacheRead: 0,
        cacheWrite: 0,
        assistantCount: 0,
        models: {},
        providerTotals: {},
      };
    }
    const hb = s.hourlyBreakdown[day][hour];
    hb.totalTokens += tot;
    if (hb[type] !== undefined) hb[type] += tot;
    hb.cacheRead += cr;
    hb.cacheWrite += cw;
    hb.assistantCount++;

    if (!hb.models[model]) {
      hb.models[model] = {
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        assistantCount: 0,
        desktop: 0,
        channel: 0,
        bridge: 0,
        background: 0,
        sub: 0,
        ledger: 0,
      };
    }
    hb.models[model].totalTokens += tot;
    hb.models[model].cacheRead += cr;
    hb.models[model].cacheWrite += cw;
    hb.models[model].assistantCount++;
    if (hb.models[model][type] !== undefined) hb.models[model][type] += tot;

    if (provider) {
      const pk = provider + "/" + model;
      if (!hb.providerTotals[pk]) {
        hb.providerTotals[pk] = {
          totalTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          assistantCount: 0,
          desktop: 0,
          channel: 0,
          bridge: 0,
          background: 0,
          sub: 0,
          ledger: 0,
        };
      }
      hb.providerTotals[pk].totalTokens += tot;
      hb.providerTotals[pk].cacheRead += cr;
      hb.providerTotals[pk].cacheWrite += cw;
      hb.providerTotals[pk].assistantCount++;
      if (hb.providerTotals[pk][type] !== undefined) hb.providerTotals[pk][type] += tot;
    }
  }

  // 清除未知的无效 agent
  for (const [key, sess] of Object.entries(sessionMap)) {
    if (sess.agent === "unknown") delete sessionMap[key];
  }
  cache.sessions = sessionMap;
  cache.lastScan = new Date().toISOString();
  cache.coverageLimitReached = coverageLimitReached;
  cache.usageQueryError = usageQueryError;

  const dailyGlobal = buildDailyGlobal(cache);
  cache.prediction = computePrediction(cache, dailyGlobal);

  saveCache(shared.cachePath, cache);
  shared.data = cache;
  shared.ready = true;

  shared.log.info?.(
    `[token-tracker] ledger scan: ${entries.length} window entries, ${newArchivedCount} newly archived, ${allEntries.length} total history.`
  );
}

// ─── 归一化 entry 用于本地归档 ───
function normalizeEntryForArchive(raw) {
  const usage = raw.usage || {};
  const inputInfo = usage.input || {};
  const outputInfo = usage.output || {};
  const cacheInfo = usage.cache || {};

  // SDK 规范：优先使用 input.uncachedTokens，不要擅自扣除缓存
  const inpUncached = typeof inputInfo.uncachedTokens === "number" ? inputInfo.uncachedTokens : null;
  const inpTotal = typeof inputInfo.totalTokens === "number" ? inputInfo.totalTokens : (inpUncached ?? 0);
  const out = outputInfo.totalTokens || 0;
  const reasoning = outputInfo.reasoningTokens || 0;
  const cr = cacheInfo.readTokens || 0;
  const cw = cacheInfo.writeTokens || 0;
  const hitRatio = cacheInfo.hitRatio != null ? cacheInfo.hitRatio : null;
  const tot = usage.totalTokens != null ? usage.totalTokens : (inpTotal + out + cr);
  const cost = usage.costTotal || 0;

  const subsystem = raw.source?.subsystem || "";
  const kind = raw.attribution?.kind || "session";
  const surface = raw.source?.surface || "";
  const convType = raw.attribution?.conversationType || "";

  let type = "desktop";
  if (subsystem === "automation" || subsystem === "compaction") type = "background";
  else if (subsystem === "subagent") type = "sub";
  else if (kind === "memory" || kind === "utility" || subsystem === "memory" || subsystem === "utility") type = "ledger";
  else if (kind === "phone" && (convType === "channel" || surface === "channel")) type = "channel";
  else if (kind === "phone" && (convType === "bridge" || surface === "bridge")) type = "bridge";

  return {
    requestId: raw.requestId,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt || null,
    durationMs: raw.durationMs || 0,
    status: raw.status || "ok",
    agentId: raw.attribution?.agentId || "unknown",
    sessionId: raw.attribution?.sessionId || null,
    provider: raw.model?.provider || "",
    model: raw.model?.modelId || "unknown",
    type,
    inputTokens: inpTotal,
    inputUncachedTokens: inpUncached,
    outputTokens: out,
    reasoningTokens: reasoning,
    cacheReadTokens: cr,
    cacheWriteTokens: cw,
    totalTokens: tot,
    costTotal: cost,
    hitRatio,
  };
}

// ─── 实时事件处理：llm_usage ───
function handleLlmUsageEvent(shared, rawEntry) {
  if (!rawEntry || rawEntry.status !== "ok" || !rawEntry.usage) return;
  const rid = rawEntry.requestId;
  if (!rid) return;

  const archive = shared.archive;
  if (!archive.entries[rid]) {
    const norm = normalizeEntryForArchive(rawEntry);
    archive.entries[rid] = norm;
    saveArchive(shared.archivePath, archive);

    const rt = shared.realtime;
    if (rt) {
      const aid = norm.agentId;
      if (aid && aid !== rt.agentId) {
        rt.agentId = aid;
        rt.agentName = shared.agentNames?.[aid] || aid;
        rt.sessionInput = 0;
        rt.sessionOutput = 0;
        rt.sessionReasoning = 0;
        rt.sessionCacheRead = 0;
        rt.sessionTotalTokens = 0;
        rt.sessionCost = 0;
        rt.sessionMsgCount = 0;
        rt.totalRequests = 0;
        rt.currentSessionStart = Date.now();
      }
      rt.model = norm.model;
      rt.provider = norm.provider;
      rt.lastInput = norm.inputTokens;
      rt.lastOutput = norm.outputTokens;
      rt.lastReasoning = norm.reasoningTokens;
      rt.lastCacheRead = norm.cacheReadTokens;
      rt.lastTotalTokens = norm.totalTokens;
      rt.lastCost = norm.costTotal;

      rt.sessionInput += norm.inputTokens;
      rt.sessionOutput += norm.outputTokens;
      rt.sessionReasoning += norm.reasoningTokens;
      rt.sessionCacheRead += norm.cacheReadTokens;
      rt.sessionTotalTokens += norm.totalTokens;
      rt.sessionCost += norm.costTotal;
      rt.sessionMsgCount += 1;
      rt.totalRequests += 1;
      rt.elapsed = Math.floor((Date.now() - rt.currentSessionStart) / 1000);
      rt.updatedAt = Date.now();

      pushToSSE(shared);
    }
  }
}

// ─── 实时事件处理：兼容 legacy token_usage ───
function handleLegacyTokenUsageEvent(shared, ev) {
  const u = ev?.usage || {};
  if (!u || !u.totalTokens) return;
  const rt = shared.realtime;
  if (!rt) return;

  const inp = tokVal(u.input), out = tokVal(u.output), rsn = u.reasoningTokens || 0;
  const cr = u.cacheRead || u.readCache || 0;
  const tot = u.totalTokens || (inp + out);
  const cost = u.cost?.total || u.cost || 0;

  rt.lastInput = inp;
  rt.lastOutput = out;
  rt.lastReasoning = rsn;
  rt.lastCacheRead = cr;
  rt.lastTotalTokens = tot;
  rt.lastCost = cost;
  rt.sessionInput += inp;
  rt.sessionOutput += out;
  rt.sessionReasoning += rsn;
  rt.sessionCacheRead += cr;
  rt.sessionTotalTokens += tot;
  rt.sessionCost += cost;
  rt.sessionMsgCount += 1;
  rt.totalRequests += 1;
  rt.elapsed = Math.floor((Date.now() - rt.currentSessionStart) / 1000);
  rt.updatedAt = Date.now();

  pushToSSE(shared);
}

function pushToSSE(shared) {
  if (!shared._realtimeClients || shared._realtimeClients.size === 0) return;
  const rt = shared.realtime;
  if (!rt) return;
  if (shared.data?._balances) {
    rt.balances = shared.data._balances;
    rt.balanceUpdatedAt = Date.now();
  }
  const payload = { type: "usage", data: realtimeSnapshot(rt, shared.agentNames) };
  for (const client of shared._realtimeClients) {
    try {
      if (typeof client.send === "function") client.send(payload);
    } catch {}
  }
}

function realtimeSnapshot(rt, agentNames) {
  const sessionRatio = rt.sessionTotalTokens > 0 ? ((rt.sessionCacheRead / rt.sessionTotalTokens) * 100).toFixed(1) : "0.0";
  const lastRatio = rt.lastTotalTokens > 0 ? ((rt.lastCacheRead / rt.lastTotalTokens) * 100).toFixed(1) : "0.0";
  const contextPercent = rt.contextWindow > 0 ? ((rt.contextTokens / rt.contextWindow) * 100).toFixed(1) : "0.0";
  return {
    agentId: rt.agentId,
    agentName: (agentNames || {})[rt.agentId] || rt.agentId || "—",
    model: rt.model || "—",
    provider: rt.provider || "—",
    sessionId: rt.sessionId || null,
    lastInput: rt.lastInput,
    lastOutput: rt.lastOutput,
    lastReasoning: rt.lastReasoning,
    lastCacheRead: rt.lastCacheRead,
    lastTotalTokens: rt.lastTotalTokens,
    lastCost: rt.lastCost,
    lastHitRate: lastRatio,
    sessionInput: rt.sessionInput,
    sessionOutput: rt.sessionOutput,
    sessionReasoning: rt.sessionReasoning,
    sessionCacheRead: rt.sessionCacheRead,
    sessionTotalTokens: rt.sessionTotalTokens,
    sessionCost: rt.sessionCost,
    sessionMsgCount: rt.sessionMsgCount,
    sessionHitRate: sessionRatio,
    contextTokens: rt.contextTokens,
    contextWindow: rt.contextWindow,
    contextPercent: contextPercent,
    elapsed: rt.elapsed,
    totalRequests: rt.totalRequests,
    balances: rt.balances || null,
    balanceUpdatedAt: rt.balanceUpdatedAt || null,
    updatedAt: rt.updatedAt,
  };
}

// ─── 每日全局消耗汇总 ───
function buildDailyGlobal(cache) {
  const dailyGlobal = {};
  for (const s of Object.values(cache.sessions || {})) {
    for (const [day, d] of Object.entries(s.dailyBreakdown || {})) {
      if (!dailyGlobal[day]) dailyGlobal[day] = 0;
      dailyGlobal[day] += d.totalTokens || 0;
    }
  }
  return dailyGlobal;
}

// ─── 预测：历史小时分布 + 实时占比 ───
function computePrediction(cache, dailyGlobal) {
  const days = Object.keys(dailyGlobal).sort();
  if (days.length < 2) return null;

  const values = days.map((d) => dailyGlobal[d]);
  const dailyAvg = Math.round(values.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, values.length));

  const cnToday = dayFmt.format(new Date());
  const hourTotals = new Array(24).fill(0);
  let histDays = 0;
  for (const s of Object.values(cache.sessions || {})) {
    const hb = s.hourlyBreakdown || {};
    for (const [day, hours] of Object.entries(hb)) {
      if (day === cnToday) continue;
      let hasData = false;
      for (const [h, v] of Object.entries(hours)) {
        hourTotals[parseInt(h, 10)] += v.totalTokens || 0;
        hasData = true;
      }
      if (hasData) histDays++;
    }
  }
  const histTotal = hourTotals.reduce((a, b) => a + b, 0);
  let cumulativePct = null;
  if (histDays >= 3 && histTotal > 0) {
    cumulativePct = new Array(24);
    let running = 0;
    for (let h = 0; h < 24; h++) {
      running += hourTotals[h] / histTotal;
      cumulativePct[h] = running;
    }
  }

  const monthPrefix = cnToday.slice(0, 7);
  let monthToDate = 0;
  for (const [d, v] of Object.entries(dailyGlobal)) {
    if (d.startsWith(monthPrefix)) monthToDate += v;
  }

  const now = new Date();
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeftInMonth = Math.max(0, lastDayOfMonth - now.getDate());

  return {
    dailyAvg,
    cumulativePct,
    monthToDate,
    daysLeftInMonth,
    projectedMonthEnd: Math.round(monthToDate + dailyAvg * daysLeftInMonth),
  };
}

// ─── 文件持久化（原子写保护）───
function loadCache(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCache(p, data) {
  return atomicWriteJson(p, data);
}

function loadArchive(p) {
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const d = JSON.parse(raw);
      if (d && typeof d === "object" && d.entries) return d;
    }
  } catch {}
  return { version: 1, updatedAt: null, entries: {} };
}

function saveArchive(p, data) {
  return atomicWriteJson(p, data);
}

function atomicWriteJson(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}
