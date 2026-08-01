import fs from "node:fs";
import path from "node:path";

const HOME = process.env.HANA_HOME || path.join(process.env.HOME || process.env.USERPROFILE, ".hanako");
const AGENTS = path.join(HOME, "agents");
const CACHE = "token-cache.json";
const CACHE_VERSION = 19;

function tokVal(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return v.totalTokens || 0;
  return 0;
}

export default class TokenTrackerPlugin {
  async onload() {
    const { dataDir, config, log, bus } = this.ctx;
    const cachePath = path.join(dataDir, CACHE);
    const interval = (config.get("scanInterval") || 60) * 1000;
    const shared = { data: null, ready: false, cachePath, dataDir, realtimeSnapshot };
    this.ctx._tokenCache = shared;

    // 通过 agent:list 获取 agentId → name 映射
    try {
      const result = await bus.request("agent:list");
      if (result?.agents) {
        const agentNames = {};
        for (const a of result.agents) {
          agentNames[a.id] = a.name || a.id;
        }
        shared.agentNames = agentNames;
      }
    } catch (e) {
      log.warn("[token-tracker] agent:list failed:", e.message);
    }
    // scan(force=false): 增量（靠 mtime），供定时器用
    // fullScan():        全量，供首次加载和刷新按钮用
    shared.scan = (force) => {
      if (shared.scanning) return Promise.resolve();
      shared.scanning = true;
      return scanAll(shared, log, force).finally(() => { shared.scanning = false; });
    };
    shared.fullScan = () => shared.scan(true);

    // 缓存有效时走增量扫描，仅首次/版本升级时全量（后台执行，不阻塞启动）
    const old = loadCache(cachePath, log);
    if (old && old.version === CACHE_VERSION) {
      shared.scan(false);
    } else {
      shared.fullScan();
    }
    const timer = setInterval(() => shared.scan(false), interval);
    timer.unref?.();
    this.register(() => clearInterval(timer));
    // ── 实时会话监控：订阅消息事件 ──
    // ── 实时会话监控：订阅 token_usage + context_usage ──
    const realtime = {
      agentId: null, agentName: null, sessionPath: null,
      model: null, provider: null,
      lastInput: 0, lastOutput: 0, lastReasoning: 0,
      lastCacheRead: 0, lastTotalTokens: 0, lastCost: 0,
      sessionInput: 0, sessionOutput: 0, sessionReasoning: 0,
      sessionCacheRead: 0, sessionTotalTokens: 0, sessionCost: 0, sessionMsgCount: 0,
      contextTokens: 0, contextWindow: 1000000,
      elapsed: 0, totalRequests: 0,
      balance: null, balanceCurrency: "CNY",
      updatedAt: Date.now(), currentSessionStart: Date.now()
    };
    shared.realtime = realtime;

    function pushToSSE() {
      if (!shared._realtimeClients) return;
      // 同步当前余额查询结果，供 widget SSE 推送的 balance 字段使用
      if (shared.data?._balances) {
        realtime.balances = shared.data._balances;
        realtime.balanceUpdatedAt = Date.now();
      }
      const payload = { type: "usage", data: realtimeSnapshot(realtime, shared.agentNames) };
      for (const client of shared._realtimeClients) {
        try { if (typeof client.send === "function") client.send(payload); } catch {}
      }
    }

    function agentFromPath(sp) {
      if (!sp) return null;
      const m = sp.match(/agents[\\\/]([^\\\/]+)[\\\/]/);
      return m ? m[1] : null;
    }

    // 订阅 token_usage（每次 LLM 调用完成时发出）
    const unsub1 = bus.subscribe((ev, ssp) => {
      try {

        if (ev?.type !== "token_usage") return;
        const u = ev?.usage || {};
        if (!u || !u.totalTokens) return;
        const sp = ssp || realtime.sessionPath;
        const aid = agentFromPath(sp);
        if (aid && aid !== realtime.agentId) {
          realtime.agentId = aid;
          realtime.agentName = shared.agentNames?.[aid] || aid;
          realtime.sessionInput = 0; realtime.sessionOutput = 0; realtime.sessionReasoning = 0;
          realtime.sessionCacheRead = 0; realtime.sessionTotalTokens = 0;
          realtime.sessionCost = 0; realtime.sessionMsgCount = 0;
          realtime.totalRequests = 0;
          realtime.currentSessionStart = Date.now();
        }
        if (sp) realtime.sessionPath = sp;
        realtime.model = ev?.modelId || realtime.model;
        realtime.provider = ev?.modelProvider || realtime.provider;
        const inp = u.input || 0, out = u.output || 0, rsn = u.reasoningTokens || 0;
        const cr = u.cacheRead || u.readCache || 0;
        const tot = u.totalTokens || (inp + out);
        const cost = u.cost?.total || u.cost || 0;
        realtime.lastInput = inp; realtime.lastOutput = out; realtime.lastReasoning = rsn;
        realtime.lastCacheRead = cr; realtime.lastTotalTokens = tot; realtime.lastCost = cost;
        realtime.sessionInput += inp; realtime.sessionOutput += out; realtime.sessionReasoning += rsn;
        realtime.sessionCacheRead += cr; realtime.sessionTotalTokens += tot;
        realtime.sessionCost += cost; realtime.sessionMsgCount += 1;
        realtime.totalRequests += 1;
        realtime.elapsed = Math.floor((Date.now() - realtime.currentSessionStart) / 1000);
        realtime.updatedAt = Date.now();
        pushToSSE();
      } catch (e) { /* token_usage error */ }
    });

    this.register(() => { unsub1(); });

    log.info("token-tracker loaded (interval " + interval + "ms)");
  }
}

function realtimeSnapshot(rt, agentNames) {
  const sessionRatio = rt.sessionTotalTokens > 0 ? ((rt.sessionCacheRead / rt.sessionTotalTokens) * 100).toFixed(1) : "0.0";
  const lastRatio = rt.lastTotalTokens > 0 ? ((rt.lastCacheRead / rt.lastTotalTokens) * 100).toFixed(1) : "0.0";
  const contextPercent = rt.contextWindow > 0 ? ((rt.contextTokens / rt.contextWindow) * 100).toFixed(1) : "0.0";
  return {
    agentId: rt.agentId,
    agentName: (agentNames||{})[rt.agentId] || rt.agentId || "—",
    model: rt.model || "—", provider: rt.provider || "—",
    sessionPath: rt.sessionPath,
    lastInput: rt.lastInput, lastOutput: rt.lastOutput, lastReasoning: rt.lastReasoning,
    lastCacheRead: rt.lastCacheRead, lastTotalTokens: rt.lastTotalTokens, lastCost: rt.lastCost, lastHitRate: lastRatio,
    sessionInput: rt.sessionInput, sessionOutput: rt.sessionOutput, sessionReasoning: rt.sessionReasoning,
    sessionCacheRead: rt.sessionCacheRead, sessionTotalTokens: rt.sessionTotalTokens,
    sessionCost: rt.sessionCost, sessionMsgCount: rt.sessionMsgCount, sessionHitRate: sessionRatio,
    contextTokens: rt.contextTokens, contextWindow: rt.contextWindow, contextPercent: contextPercent,
    elapsed: rt.elapsed, totalRequests: rt.totalRequests,
    balances: rt.balances || null,
    balanceUpdatedAt: rt.balanceUpdatedAt || null,
    updatedAt: rt.updatedAt
  };
}


async function scanAll(shared, log, force) {
  const old = loadCache(shared.cachePath, log);
  const cache = old || { version: CACHE_VERSION, lastScan: null, sessions: {}, agentNames: {} };
  // 版本不匹配 或 外部强制 → 全量重扫（忽略旧 mtime）
  const full = force || cache.version !== CACHE_VERSION;
  cache.version = CACHE_VERSION;
  let changed = false;

  // 优先使用 agent:list API 返回的 agent 名称
  if (shared.agentNames) {
    cache.agentNames = { ...shared.agentNames, ...cache.agentNames };
  }

  let dirs = [];
  try { dirs = fs.readdirSync(AGENTS).filter(n => fs.statSync(path.join(AGENTS, n)).isDirectory()); }
  catch { log.warn("agents dir not found"); return; }

  // Collect display names from identity.md (template-safe, fallback only)
  for (const id of dirs) {
    if (!cache.agentNames[id]) {
      try {
        const c = fs.readFileSync(path.join(AGENTS, id, "identity.md"), "utf-8");
        const m = c.match(/^#\s+(.+)/m);
        if (m) {
          const name = m[1].trim();
          if (!name.includes("{{")) {
            cache.agentNames[id] = name;
          } else {
            cache.agentNames[id] = id;
          }
        } else {
          cache.agentNames[id] = id;
        }
      } catch { cache.agentNames[id] = id; }
    }
  }
  for (const agent of dirs) {
    changed = scanDir(path.join(AGENTS, agent, "sessions"), agent, "desktop", null, cache, full ? null : old) || changed;
    const arch = path.join(AGENTS, agent, "sessions", "archived");
    if (fs.existsSync(arch)) changed = scanDir(arch, agent, "desktop", null, cache, full ? null : old) || changed;
    const phone = path.join(AGENTS, agent, "phone", "sessions");
    if (fs.existsSync(phone)) {
      for (const sub of fs.readdirSync(phone)) {
        const sp = path.join(phone, sub);
        if (!fs.statSync(sp).isDirectory()) continue;
        changed = scanDir(sp, agent, "channel", sub.replace(/-[^-]+$/, ""), cache, full ? null : old) || changed;
      }
    }
    // bridge 私聊会话
    const bridge = path.join(AGENTS, agent, "sessions", "bridge");
    if (fs.existsSync(bridge)) {
      for (const sub of fs.readdirSync(bridge)) {
        if (sub === "bridge-sessions.json") continue;
        const sp = path.join(bridge, sub);
        if (!fs.statSync(sp).isDirectory()) continue;
        changed = scanDir(sp, agent, "bridge", sub, cache, full ? null : old) || changed;
      }
    }
    // 后台活动
    const activity = path.join(AGENTS, agent, "activity");
    if (fs.existsSync(activity)) {
      changed = scanDir(activity, agent, "background", null, cache, full ? null : old) || changed;
    }
    // 子代理会话
    const subagent = path.join(AGENTS, agent, "subagent-sessions");
    if (fs.existsSync(subagent)) {
      changed = scanDir(subagent, agent, "sub", null, cache, full ? null : old) || changed;
      for (const sub of fs.readdirSync(subagent)) {
        if (sub === "session-meta.json") continue;
        const sp = path.join(subagent, sub);
        if (!fs.statSync(sp).isDirectory()) continue;
        changed = scanDir(sp, agent, "sub", sub, cache, full ? null : old) || changed;
      }
    }
    // workflow 任务会话（此前漏扫，导致 workflow 调用不计入统计）
    const wf = path.join(AGENTS, agent, "workflow-sessions");
    if (fs.existsSync(wf)) {
      changed = scanDir(wf, agent, "background", null, cache, full ? null : old) || changed;
    }
  }
  // usage-ledger.json 中无 sessionPath 的条目（memory + utility 子系统）
  changed = scanLedger(cache, log, full) || changed;

  // 保留最近5天的对话
  var cutoff5d = Date.now() - 5 * 86400000;
  for (const _key of Object.keys(cache.sessions)) {
    const _s = cache.sessions[_key];
    if (_s.conversations && _s.conversations.length) {
      var _before = _s.conversations.length;
      _s.conversations = _s.conversations.filter(function(c){ return new Date(c.time).getTime() >= cutoff5d; });
      if (_s.conversations.length !== _before) changed = true;
    }
  }

  if (changed) {
    cache.lastScan = new Date().toISOString();
    const dailyGlobal = buildDailyGlobal(cache);
    cache.prediction = computePrediction(cache, dailyGlobal);
    saveCache(shared.cachePath, cache, log);
  }
  shared.data = cache;
  shared.ready = true;

  // 汇总扫描期跳过的 JSONL 行，如果有污染的会话文件告警
  let _totalSkipped = 0;
  for (const _k of Object.keys(cache.sessions)) {
    _totalSkipped += (cache.sessions[_k].skippedLines || 0);
  }
  if (_totalSkipped > 0) {
    log.warn("[token-tracker] scan: skipped " + _totalSkipped + " invalid JSONL line(s) — some sessions may have corrupted lines, check the .jsonl files");
  }
}

function scanDir(dir, agent, type, channel, cache, old) {
  let changed = false;
  let conv = null;
  let files = [];
  try { files = fs.readdirSync(dir).filter(n => n.endsWith(".jsonl") && !n.includes(".repair.jsonl")); }
  catch { return false; }

  for (const fn of files) {
    const fp = path.join(dir, fn);
    const key = `${agent}::${type}::${channel||""}::${fn}`;
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }

    // 文件未变化则跳过
    const prev = old?.sessions?.[key];
    if (prev && prev.mtime === stat.mtimeMs) continue;

    const data = { agent, type, channelName: channel||null,  filePath: fp, mtime: stat.mtimeMs, size: stat.size, fileName: fn, firstTime: null, lastTime: null, msgCount: 0, assistantCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, models: {}, providers: {}, conversations: [], mediaGen: {} };

    try {
      var currentProvider = null;
      var _lastModel = null;
      var _skipped = 0;
      for (const line of fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean)) {
        let p;
        try { p = JSON.parse(line); } catch { _skipped++; continue; }
        if (_skipped > 0 && !(data._skipReported)) {
          // 调用方拿不到 scanDir，这里最早结束在 scanAll（data 走 changed 路径拿到）
          data._skipReported = true;
        }
        if (p.type === "model_change" && p.provider) {
          currentProvider = p.provider;
          _lastModel = null;
          continue;
        }
        if (p.type === "custom" && p.customType === "hana-deferred-result" && p.data) {
          var _hd = p.data;
          if (_hd.taskId && _hd.status === "success") {
            var _mk = _hd.type === "video-generation" ? "video" : "image";
            for (var _tk in data.mediaGen) {
              var _mg = data.mediaGen[_tk];
              if (_mg._taskIds && _mg._taskIds[_hd.taskId]) {
                _mg.successCount = (_mg.successCount || 0) + 1;
                break;
              }
            }
          }
          continue;
        }
        if (p.type !== "message" || !p.message) continue;
        const m = p.message;
        const ts = p.timestamp || m.timestamp || "";
        if (!data.firstTime) data.firstTime = ts;
        data.lastTime = ts;
        data.msgCount++;
        // 对话拆分
        if (m.role === "user") {
          if (conv) data.conversations.push(conv);
          var _txt = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content[0]?.text||"" : "");
          conv = { time: ts, userContent: _txt, userSnippet: _txt.slice(0,50), model: null, provider: null, totalTokens: 0, msgCount: 0, toolCalls: [], steps: [] };
        }
        if (m.role === "assistant" && conv) {
          const _f = m.stopReason === "error" || m.isError === true || !!m.errorMessage;
          if (!_f) {
            conv.msgCount++;
            if (!conv.model) { conv.model = m.model; conv.provider = m.provider; }
            if (m.usage) { var _tot = m.usage.totalTokens || ((m.usage.input||0)+(m.usage.output||0)); conv.totalTokens += _tot; }
          }
          if (Array.isArray(m.content)) {
            for (var _i=0; _i<m.content.length; _i++) {
              var _it = m.content[_i];
              if (!_it) continue;
              if (_it.type === "toolCall") {
                conv.toolCalls.push({ name: _it.name, args: _it.arguments });
                var _isFile = ["edit","write"].includes(_it.name);
                conv.steps.push({ t: _isFile ? "fm" : "tc", name: _it.name, args: _it.arguments });
                if (_it.name === "image-gen_generate-image" || _it.name === "image-gen_generate-video") {
                  var _mKind = _it.name === "image-gen_generate-video" ? "video" : "image";
                  var _mModel = _it.arguments?.model || "";
                  var _mProv = _it.arguments?.provider || "";
                  if (!_mModel) _mModel = _mKind === "video" ? "default-video" : "default-image";
                  if (!_mProv) _mProv = "default";
                  var _mKey = _mProv + "/" + _mModel;
                  if (!data.mediaGen[_mKey]) data.mediaGen[_mKey] = { provider: _mProv, model: _mModel, kind: _mKind, callCount: 0, successCount: 0, _taskIds: {}, _callIds: {} };
                  data.mediaGen[_mKey].callCount++;
                  if (_it.id) data.mediaGen[_mKey]._callIds[_it.id] = true;
                }
              } else if (_it.type === "thinking") {
                conv.steps.push({ t: "th", c: _it.thinking || "" });
              } else if (_it.type === "text") {
                conv.steps.push({ t: "tx", c: _it.text || "" });
              }
            }
          } else if (typeof m.content === "string" && m.content) {
            conv.steps.push({ t: "tx", c: m.content });
          }
        }
        if (m.role === "toolResult" && m.toolName && m.toolName.startsWith("image-gen_") && m.details?.mediaGeneration) {
          var _mg2 = m.details.mediaGeneration;
          var _tcid = m.toolCallId;
          if (_mg2.tasks && Array.isArray(_mg2.tasks)) {
            for (var _ti = 0; _ti < _mg2.tasks.length; _ti++) {
              var _tid = _mg2.tasks[_ti]?.taskId;
              if (!_tid) continue;
              for (var _mk2 in data.mediaGen) {
                if (_tcid && data.mediaGen[_mk2]._callIds[_tcid]) {
                  data.mediaGen[_mk2]._taskIds[_tid] = true;
                }
              }
            }
          }
        }
        // 失败请求（stopReason=error / isError / errorMessage）不产生有效调用，不计入统计
        const _failedMsg = m.role === "assistant" && m.usage && (m.stopReason === "error" || m.isError === true || !!m.errorMessage);
        if (m.role === "assistant" && m.usage && !_failedMsg) {
          const msgProvider = m.provider || currentProvider;
          const u = m.usage;
          const inp = tokVal(u.input), out = tokVal(u.output), cr = u.cacheRead||0, cw = u.cacheWrite||0;
          const tot = u.totalTokens ?? (inp + out);
          const model = m.model || "unknown";
          data.assistantCount++; data.input += inp; data.output += out; data.cacheRead += cr; data.cacheWrite += cw; data.totalTokens += tot; data.cost += u.cost?.total || 0;
          // 模型变了但没有 model_change 事件 → 不知道供应商，不归属
          if (_lastModel !== null && _lastModel !== model) currentProvider = null;
          _lastModel = model;
          // 按天统计 — 存在会话自身上，不往 cache 里累加
          const d = new Date(ts); const day = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
          if (day) {
            if (!data.dailyBreakdown) data.dailyBreakdown = {};
            if (!data.dailyBreakdown[day]) data.dailyBreakdown[day] = { totalTokens:0, desktop:0, channel:0, bridge:0, background:0, sub:0, ledger:0, input:0, output:0, cacheRead:0, cacheWrite:0, assistantCount:0, models:{} };
            data.dailyBreakdown[day].totalTokens += tot;
            data.dailyBreakdown[day].input += inp;
            data.dailyBreakdown[day].output += out;
            data.dailyBreakdown[day].cacheRead += cr;
            data.dailyBreakdown[day].cacheWrite += cw;
            data.dailyBreakdown[day].assistantCount += 1;
            if (type === "desktop") data.dailyBreakdown[day].desktop += tot;
            else if (type === "bridge") data.dailyBreakdown[day].bridge += tot;
            else if (type === "background") data.dailyBreakdown[day].background += tot;
            else if (type === "sub") data.dailyBreakdown[day].sub += tot;
            else if (type === "ledger") data.dailyBreakdown[day].ledger += tot;
            else data.dailyBreakdown[day].channel += tot;
            // 按 model 精确统计
            if (!data.dailyBreakdown[day].models[model]) data.dailyBreakdown[day].models[model] = { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, assistantCount:0 };
            data.dailyBreakdown[day].models[model].input += inp;
            data.dailyBreakdown[day].models[model].output += out;
            data.dailyBreakdown[day].models[model].cacheRead += cr;
            data.dailyBreakdown[day].models[model].cacheWrite += cw;
            data.dailyBreakdown[day].models[model].totalTokens += tot;
            data.dailyBreakdown[day].models[model].assistantCount += 1;
            // 按供应商/模型统计
            if (msgProvider) {
              const pk = msgProvider + "/" + model;
              if (!data.dailyBreakdown[day].providerTotals) data.dailyBreakdown[day].providerTotals = {};
              if (!data.dailyBreakdown[day].providerTotals[pk]) data.dailyBreakdown[day].providerTotals[pk] = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0 };
              data.dailyBreakdown[day].providerTotals[pk].totalTokens += tot;
              data.dailyBreakdown[day].providerTotals[pk].input += inp;
              data.dailyBreakdown[day].providerTotals[pk].output += out;
              data.dailyBreakdown[day].providerTotals[pk].cacheRead += cr;
              data.dailyBreakdown[day].providerTotals[pk].cacheWrite += cw;
              data.dailyBreakdown[day].providerTotals[pk].assistantCount += 1;
            }
            // 按小时统计 — 用于今日维度
            const hour = String(d.getHours()).padStart(2,"0");
            if (!data.hourlyBreakdown) data.hourlyBreakdown = {};
            if (!data.hourlyBreakdown[day]) data.hourlyBreakdown[day] = {};
            if (!data.hourlyBreakdown[day][hour]) data.hourlyBreakdown[day][hour] = { totalTokens:0, desktop:0, channel:0, bridge:0, background:0, sub:0, ledger:0, cacheRead:0, cacheWrite:0 };
            data.hourlyBreakdown[day][hour].totalTokens += tot;
            data.hourlyBreakdown[day][hour].cacheRead += cr;
            data.hourlyBreakdown[day][hour].cacheWrite += cw;
            if (type === "desktop") data.hourlyBreakdown[day][hour].desktop += tot;
            else if (type === "bridge") data.hourlyBreakdown[day][hour].bridge += tot;
            else if (type === "background") data.hourlyBreakdown[day][hour].background += tot;
            else if (type === "sub") data.hourlyBreakdown[day][hour].sub += tot;
            else if (type === "ledger") data.hourlyBreakdown[day][hour].ledger += tot;
            else data.hourlyBreakdown[day][hour].channel += tot;
            if (!data.hourlyBreakdown[day][hour].models) data.hourlyBreakdown[day][hour].models = {};
            if (!data.hourlyBreakdown[day][hour].models[model]) data.hourlyBreakdown[day][hour].models[model] = { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, assistantCount:0, desktop:0, channel:0 };
            data.hourlyBreakdown[day][hour].models[model].input += inp;
            data.hourlyBreakdown[day][hour].models[model].output += out;
            data.hourlyBreakdown[day][hour].models[model].cacheRead += cr;
            data.hourlyBreakdown[day][hour].models[model].cacheWrite += cw;
            data.hourlyBreakdown[day][hour].models[model].totalTokens += tot;
            data.hourlyBreakdown[day][hour].models[model].assistantCount += 1;
            if (type === "desktop") data.hourlyBreakdown[day][hour].models[model].desktop += tot;
            else if (type === "bridge") data.hourlyBreakdown[day][hour].models[model].bridge += tot;
            else if (type === "background") data.hourlyBreakdown[day][hour].models[model].background += tot;
            else if (type === "sub") data.hourlyBreakdown[day][hour].models[model].sub += tot;
            else if (type === "ledger") data.hourlyBreakdown[day][hour].models[model].ledger += tot;
            else data.hourlyBreakdown[day][hour].models[model].channel += tot;
            if (msgProvider) {
              const pk = msgProvider + "/" + model;
              if (!data.hourlyBreakdown[day][hour].providerTotals) data.hourlyBreakdown[day][hour].providerTotals = {};
              if (!data.hourlyBreakdown[day][hour].providerTotals[pk]) data.hourlyBreakdown[day][hour].providerTotals[pk] = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, desktop: 0, channel: 0, assistantCount: 0 };
              data.hourlyBreakdown[day][hour].providerTotals[pk].totalTokens += tot;
              data.hourlyBreakdown[day][hour].providerTotals[pk].input += inp;
              data.hourlyBreakdown[day][hour].providerTotals[pk].output += out;
              data.hourlyBreakdown[day][hour].providerTotals[pk].cacheRead += cr;
              data.hourlyBreakdown[day][hour].providerTotals[pk].cacheWrite += cw;
              data.hourlyBreakdown[day][hour].providerTotals[pk].assistantCount += 1;
              if (type === "desktop") data.hourlyBreakdown[day][hour].providerTotals[pk].desktop += tot;
              else if (type === "bridge") data.hourlyBreakdown[day][hour].providerTotals[pk].bridge += tot;
              else if (type === "background") data.hourlyBreakdown[day][hour].providerTotals[pk].background += tot;
              else if (type === "sub") data.hourlyBreakdown[day][hour].providerTotals[pk].sub += tot;
              else if (type === "ledger") data.hourlyBreakdown[day][hour].providerTotals[pk].ledger += tot;
              else data.hourlyBreakdown[day][hour].providerTotals[pk].channel += tot;
            }
          }
          if (!data.models[model]) data.models[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 };
          data.models[model].input += inp; data.models[model].output += out; data.models[model].cacheRead += cr; data.models[model].cacheWrite += cw; data.models[model].count++;
          if (msgProvider) {
            const pk = msgProvider + "/" + model;
            if (!data.providers[pk]) data.providers[pk] = { provider: msgProvider, model, totalTokens: 0, count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            data.providers[pk].totalTokens += tot;
            data.providers[pk].count++;
            data.providers[pk].input += inp;
            data.providers[pk].output += out;
            data.providers[pk].cacheRead += cr;
            data.providers[pk].cacheWrite += cw;
          }
        }
      }
    } catch {}
    if (conv) { data.conversations.push(conv); conv = null; }
    data.title = (fn.match(/^(\d{4}-\d{2}-\d{2})/)||[])[1] || "unknown";
    if (_skipped > 0) data.skippedLines = _skipped;
    cache.sessions[key] = data;
    changed = true;
  }
  return changed;
}

// ─── usage-ledger.json 扫描（memory + utility 子系统无 JSONL 的 LLM 调用）───
function scanLedger(cache, log, force) {
  const p = path.join(HOME, "usage-ledger.json");
  if (!fs.existsSync(p)) return false;

  // 增量：仅当 ledger 文件 mtime 变化或强制时重建，否则跳过（避免每次全量重算）
  const lmtime = fs.statSync(p).mtimeMs;
  if (!force && cache._ledgerMtime === lmtime) return false;

  for (const k of Object.keys(cache.sessions)) {
    if (k.startsWith("__ledger__")) delete cache.sessions[k];
  }

  let data;
  try { data = JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return false; }
  if (!data?.entries?.length) return false;

  let changed = false;
  const seen = new Set();

  for (const e of data.entries) {
    const kind = e.attribution?.kind;
    if (kind !== "memory" && kind !== "utility") continue;
    // 失败的请求不算有效调用，不进入任何统计（含次数占比）
    if (e.status === "error" || e.error != null) continue;
    if (seen.has(e.requestId)) continue;
    seen.add(e.requestId);

    const agent = e.attribution?.agentId || "hanako";
    const model = e.model?.modelId || "unknown";
    const provider = e.model?.provider || "";
    const ts = e.startedAt || e.endedAt || "";
    // 统一本地时区取日（与 scanDir 一致，避免 UTC 日期错位）
    let day = "unknown";
    if (ts) {
      const td = new Date(ts);
      if (!isNaN(td.getTime())) {
        day = td.getFullYear() + "-" + String(td.getMonth() + 1).padStart(2, "0") + "-" + String(td.getDate()).padStart(2, "0");
      }
    }
    const inpRaw = tokVal(e.usage?.input);
    const out = tokVal(e.usage?.output);
    const cr = e.usage?.cache?.readTokens || e.usage?.cacheRead || 0;
    const cw = e.usage?.cache?.writeTokens || e.usage?.cacheWrite || 0;
    const inp = (cr > 0 && inpRaw >= cr) ? inpRaw - cr : inpRaw;
    const tot = e.usage?.totalTokens ?? (inp + out + cr);
    const cost = e.usage?.costTotal || e.usage?.cost?.total || 0;

    const key = `__ledger__${agent}::${kind}::${day}`;
    if (!cache.sessions[key]) {
      cache.sessions[key] = {
        agent, type: "ledger", channelName: null, 
        filePath: p, mtime: 0, size: 0,
        fileName: "usage-ledger.json",
        firstTime: null, lastTime: null,
        msgCount: 0, assistantCount: 0,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0, cost: 0,
        models: {}, providers: {}, conversations: [], mediaGen: {},
        dailyBreakdown: {}, hourlyBreakdown: {},
        title: day,
      };
      changed = true;
    }
    const s = cache.sessions[key];
    if (!s.firstTime) s.firstTime = ts;
    s.lastTime = ts; s.msgCount++; s.assistantCount++;
    s.input += inp; s.output += out; s.cacheRead += cr; s.cacheWrite += cw;
    s.totalTokens += tot; s.cost += cost;

    if (!s.models[model]) s.models[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 };
    s.models[model].input += inp; s.models[model].output += out;
    s.models[model].cacheRead += cr; s.models[model].cacheWrite += cw; s.models[model].count++;

    if (provider) {
      const pk = provider + "/" + model;
      if (!s.providers[pk]) s.providers[pk] = { provider, model, totalTokens: 0, count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      s.providers[pk].totalTokens += tot; s.providers[pk].count++;
      s.providers[pk].input += inp; s.providers[pk].output += out; s.providers[pk].cacheRead += cr; s.providers[pk].cacheWrite += cw;
    }

    if (!s.dailyBreakdown[day]) {
      s.dailyBreakdown[day] = { totalTokens:0, desktop:0, channel:0, bridge:0, background:0, sub:0, ledger:0, input:0, output:0, cacheRead:0, cacheWrite:0, assistantCount:0, models:{} };
    }
    const bd = s.dailyBreakdown[day];
    bd.totalTokens += tot; bd.ledger += tot;
    bd.input += inp; bd.output += out;
    bd.cacheRead += cr; bd.cacheWrite += cw; bd.assistantCount++;
    if (!bd.models[model]) bd.models[model] = { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, assistantCount:0 };
    bd.models[model].input += inp; bd.models[model].output += out;
    bd.models[model].cacheRead += cr; bd.models[model].cacheWrite += cw; bd.models[model].totalTokens += tot;
    bd.models[model].assistantCount++;
    if (provider) {
      const pk = provider + "/" + model;
      if (!bd.providerTotals) bd.providerTotals = {};
      if (!bd.providerTotals[pk]) bd.providerTotals[pk] = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantCount: 0 };
      bd.providerTotals[pk].totalTokens += tot;
      bd.providerTotals[pk].input += inp;
      bd.providerTotals[pk].output += out;
      bd.providerTotals[pk].cacheRead += cr;
      bd.providerTotals[pk].cacheWrite += cw;
      bd.providerTotals[pk].assistantCount++;
    }
    const hour = ts ? ts.slice(11, 13) : "00";
    if (!s.hourlyBreakdown[day]) s.hourlyBreakdown[day] = {};
    if (!s.hourlyBreakdown[day][hour]) s.hourlyBreakdown[day][hour] = { totalTokens:0, desktop:0, channel:0, bridge:0, background:0, sub:0, ledger:0, cacheRead:0, cacheWrite:0 };
    s.hourlyBreakdown[day][hour].totalTokens += tot;
    s.hourlyBreakdown[day][hour].ledger += tot;
    s.hourlyBreakdown[day][hour].cacheRead += cr;
    s.hourlyBreakdown[day][hour].cacheWrite += cw;
  }
  cache._ledgerMtime = lmtime;
  return changed;
}

// ─── 每日全局消耗汇总 ───
function buildDailyGlobal(cache) {
  const dailyGlobal = {};
  for (const s of Object.values(cache.sessions)) {
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

  const values = days.map(d => dailyGlobal[d]);
  const dailyAvg = Math.round(values.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, values.length));

  // ── 历史小时分布（排除今天） ──
  const cnToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const hourTotals = new Array(24).fill(0);
  let histDays = 0;
  for (const s of Object.values(cache.sessions)) {
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

  // ── 本月已用 ──
  const monthPrefix = cnToday.slice(0, 7);
  let monthToDate = 0;
  for (const [d, v] of Object.entries(dailyGlobal)) {
    if (d.startsWith(monthPrefix)) monthToDate += v;
  }

  // ── 距月底 ──
  const now = new Date();
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeftInMonth = lastDayOfMonth - now.getDate();

  return {
    dailyAvg,
    cumulativePct,
    monthToDate,
    daysLeftInMonth,
    projectedMonthEnd: Math.round(monthToDate + dailyAvg * daysLeftInMonth),
  };
}

function loadCache(p, log) {
  let raw;
  try { raw = fs.readFileSync(p, "utf-8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    if (log) log.warn("[token-tracker] cache read failed:", e.code || "", e.message);
    return null;
  }
  try { return JSON.parse(raw); }
  catch (e) {
    if (log) log.warn("[token-tracker] cache parse failed (corrupted file?):", p, e.message);
    return null;
  }
}

function saveCache(p, data, log) {
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    if (log) log.warn("[token-tracker] saveCache failed:", p, e.message);
    return false;
  }
}
