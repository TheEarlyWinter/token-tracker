// 输入栏状态位数据源：本会话缓存命中率与可用时长记录推导的输出速度。
//
// ── 缓存命中率 ──
// 口径：命中 = 缓存读 token，未命中 = 未缓存输入 token，
//   命中率 = Σ缓存读 ÷ (Σ缓存读 + Σ未命中输入)
// 范围：这条会话、当前模型、最近的 50 条记录。
// 不是自己发明的式子：宿主账本每条记录同时给 cache.readTokens 和 input.uncachedTokens，
// 这个比值与宿主自己的 cache.hitRatio 一致（真实记录核对过：74112 与 930 得 98.7607%）。
// 不做的事：不把各次请求的 hitRatio 取平均（每次请求的输入体量差几个量级，平均没有意义）；
// 不把"没有缓存信息"当 0（供应商没上报和真的没命中是两回事）。
//
// ── 生成速度 ──
// 优先使用 before-request → post-assistant 的实时请求时长与完成消息 usage.output，按模型取最近 8 个样本。
// 没有实时样本时使用同模型最近 8 条有效账本时长（至少 100ms）。
// 速度 = Σ输出 token / Σ请求时长，包含响应等待；不是流式瞬时 tok/s。无有效时长时不猜测数值。
// 界面上不给这个数加修饰语（2026-09-25：曾在速度前自行加过一个「约」，被要求去掉）。要不要表达
// “这是估算”由用户决定，不由代码替他决定。
// 口径不写进 tooltip：用户不说添加什么具体内容，不得自行添加。
//
// ── 调用次数 ──
// 口径：这条会话在宿主账本里全部的请求记录数，按 requestId 去重。工具结果回喂后的续写、子代理
//   内部的每一次调用都各自成一条记录；账本把子代理记录挂在父会话的 attribution.sessionId 上，
//   父子关系另存在 source.parent / source.actor（2026-09-25 实测：本会话 563 条 = session/reply 301
//   + subagent/run 262，两者都随对话增长，此处只是当时的快照）。这一项不看模型、也不受上面 50 条窗口影响：窗口只服务于命中率。
//
// ── 数据来源 ──
// 缓存与速度均走宿主 usage:list（权威），只读取账本指标，不读取会话正文。会话身份从总线拿：
// session_created / session_forked 带 sessionId + sessionPath，llm_usage 带 entry.attribution.sessionId。

import { RetainedMap, observeAsync } from "./retained-map.mjs";

export const CACHE_ITEM_ID = "session-cache";

const DEFAULT_THROTTLE_MS = 1500; // 同一条会话在这个窗口内只查一次
const CACHE_WINDOW = 50;          // 命中率只算最近的 50 条记录（这条会话、当前模型）
const WARM_WINDOW_MS = 24 * 3600 * 1000; // 启动预热只看最近 24 小时
const WARM_LIMIT = 50;
const WARM_SESSIONS = 3;
const WARM_DELAY_MS = 2500;       // 等贡献表登记完再写覆盖（apply 返回后才登记）

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

function fmtNum(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return String(Math.round(n));
}

// 输出 token 单独用 k：它比命中/未命中小一个量级，走万位会把有效数字吃掉（3.2万 → 32.0k）。
function fmtK(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return k >= 100 ? String(Math.round(k)) + "k" : k.toFixed(1) + "k";
}

// 从一条账本记录里取出 (缓存读, 未命中输入)，并标出这条记录能不能用。
//   usable   —— 输入侧有数，能参与比例计算
//   reported —— 这条记录明确带了缓存口径（不是"缺失"）
export function splitCache(usage) {
  const cache = usage && typeof usage.cache === "object" && usage.cache !== null ? usage.cache : null;
  const read = num(cache?.readTokens) ?? 0;
  const uncachedRaw = num(usage?.input?.uncachedTokens);
  const inputTotal = num(usage?.input?.totalTokens);

  let uncached = uncachedRaw;
  if (uncached === null) {
    // input.totalTokens 可能已经含缓存读，先减再算；减不动就按原值。
    if (inputTotal === null) return { read, uncached: 0, usable: false, reported: false };
    uncached = read > 0 && inputTotal >= read ? inputTotal - read : inputTotal;
  }

  const reported = uncachedRaw !== null
    || (cache !== null && (num(cache.readTokens) !== null || cache.hitRatio != null || cache.support != null || cache.hit != null));
  return { read, uncached, usable: true, reported };
}

// 从一条账本记录里取输出 token。不同供应商的字段形状不一样，按顺序认几种，取不到就 null
// （不假装是 0：没有口径和真的输出 0 是两回事，和缓存那半同一个原则）。
export function outputOf(usage) {
  const direct = num(usage?.output);
  if (direct !== null) return direct;
  const out = usage && typeof usage.output === "object" && usage.output !== null ? usage.output : null;
  return num(out?.totalTokens) ?? num(out?.total) ?? null;
}

export function renderCachePart(read, uncached) {
  const total = read + uncached;
  if (!(total > 0)) return "缓存：—";
  return `缓存：${((read / total) * 100).toFixed(1)}%`; // 输出一位小数
}

export function renderSpeedPart(sample) {
  const tps = num(sample?.tps);
  if (tps === null || tps <= 0) return "速度：—";
  return `速度：${Math.round(tps)} tok/s`;
}

// 首响 = 请求发出到宿主观察到 provider 响应元数据的时长，不是首 token 延迟。
export function renderFirstResponsePart(ms) {
  const value = num(ms);
  if (value === null || value <= 0) return "";
  return `首响：${(Math.round(value / 100) / 10).toFixed(1)} s`;
}

export function durationMsOf(entry) {
  const direct = num(entry?.durationMs);
  if (direct !== null && direct > 0 && direct < 600000) return direct;
  const started = Date.parse(String(entry?.startedAt || ""));
  const ended = Date.parse(String(entry?.endedAt || ""));
  const elapsed = ended - started;
  return Number.isFinite(elapsed) && elapsed > 0 && elapsed < 600000 ? elapsed : null;
}

// Ledger duration is optional; don't fabricate TPS from absent/zero duration data.
export function estimateOutputSpeed(entries) {
  const samples = [];
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const output = outputOf(entry?.usage);
    const duration = durationMsOf(entry);
    // 0–1ms records are ledger bookkeeping, not usable generation windows.
    if (output !== null && output > 0 && duration !== null && duration >= 100) {
      samples.push({ output, duration });
      if (samples.length > 8) samples.shift();
    }
  }
  const totalOutput = samples.reduce((sum, sample) => sum + sample.output, 0);
  const totalDuration = samples.reduce((sum, sample) => sum + sample.duration, 0);
  const tps = totalDuration > 0 ? totalOutput / (totalDuration / 1000) : 0;
  return tps > 0 && Number.isFinite(tps) ? { scope: "session", tps } : null;
}
// 条目里的模型形状是 { provider, modelId, api }。缺字段就返回 null，调用方宁可不筛，也别筛错。
export function modelKeyOf(entry) {
  const m = entry && typeof entry.model === "object" ? entry.model : null;
  const id = m && typeof m.modelId === "string" && m.modelId ? m.modelId : null;
  if (!id) return null;
  const prov = m && typeof m.provider === "string" && m.provider ? m.provider : "";
  return prov ? prov + "/" + id : id;
}

// 当前模型 = 最新一条记录的模型。一个会话换了模型，命中率也要跟着换，
// 否则新旧模型的请求会被混成一个百分比（比值不会跳，只会安静地说一个谁都不像的数）。
export function pickCurrentModel(entries) {
  let best = null, bestT = -Infinity;
  for (const entry of entries) {
    const key = modelKeyOf(entry);
    if (!key) continue;
    const t = Date.parse(String(entry?.startedAt || ""));
    if (!Number.isFinite(t) || t <= bestT) continue;
    bestT = t; best = key;
  }
  return best;
}

// 按 requestId 去重后聚合。usage:list 一般已经去过重，这里只是防重不漏。
export function aggregate(entries) {
  const seen = new Set();
  let read = 0, uncached = 0, requests = 0, usable = 0, reported = 0, output = 0, outputReported = 0;
  for (const entry of entries) {
    const id = entry?.requestId;
    if (typeof id === "string" && id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    requests += 1;
    const amount = splitCache(entry?.usage);
    if (!amount.usable) continue;
    usable += 1;
    if (amount.reported) reported += 1;
    read += amount.read;
    uncached += amount.uncached;
    const out = outputOf(entry?.usage);
    if (out !== null) { output += out; outputReported += 1; }
  }
  return { read, uncached, requests, usable, reported, output, outputReported };
}

export class SessionCacheStatus {
  constructor({ bus, inputStatus, sessions = null, log = () => {}, firstResponseQuery = null, generationSpeedQuery = null, getPrefs = null, throttleMs = DEFAULT_THROTTLE_MS, warmDelayMs = WARM_DELAY_MS, maxSessions = 512, ttlMs = 1800000, clock = Date.now }) {
    this.bus = bus;
    this.inputStatus = inputStatus;
    this.sessions = sessions;
    this.sessionLookup = null;
    this.firstResponseQuery = firstResponseQuery;
    this.generationSpeedQuery = generationSpeedQuery;
    // 可选显示开关；未配置时按全开显示已具备的数据项。
    this.getPrefs = typeof getPrefs === "function" ? getPrefs : null;
    this.log = (...args) => observeAsync(() => log(...args));
    this.maxSessions = maxSessions;
    this.throttleMs = throttleMs;
    this.warmDelayMs = warmDelayMs;
    this.timers = new Map();
    this.running = new Set();
    this.dirty = new Set();
    this.applied = new Set(); // 当前挂着卡片的会话（card 由开变关时按这份名单逐个收起）
    this.sessionIdByPath = new RetainedMap({ max: maxSessions, ttlMs, clock });
    this.sessionPathById = new RetainedMap({ max: maxSessions, ttlMs, clock });
    this.warmTimer = null;
    this.disposed = false;
  }

  // 读一次当前开关。任何缺失/异常都按全开处理：给不出偏好时退回到没有开关的旧行为。
  prefs() {
    let raw = null;
    try {
      raw = this.getPrefs ? this.getPrefs() : null;
    } catch (e) {
      this.log("warn", `输入栏偏好读取失败，按全开处理：${e?.message || e}`);
    }
    const p = raw && typeof raw === "object" ? raw : {};
    return { card: p.card !== false, cache: p.cache !== false, speed: p.speed !== false };
  }

  // App SDK 的订阅注册跨 IPC，异步取得可释放的 registration。
  async start() {
    if (typeof this.bus?.subscribe !== "function" || typeof this.inputStatus?.set !== "function") {
      this.log("warn", "输入栏状态位不可用：缺少 bus.subscribe 或 inputStatus.set");
      return () => {};
    }
    try {
      this.subscription = await this.bus.subscribe((event) => {
        try { this.onEvent(event); }
        catch (error) { this.log("warn", "输入栏状态位事件处理失败：", error?.message || error); }
      }, { types: ["session_created", "session_forked", "llm_usage"] });
      this.subscription?.ready?.catch?.((error) => this.log("warn", "输入栏状态位订阅未就绪：", error?.message || error));
    } catch (error) {
      this.log("warn", "输入栏状态位订阅失败：", error?.message || error);
      return () => {};
    }
    this.warmStart();
    return () => { this.dispose(); };
  }

  onEvent(event) {
    const type = event?.type;
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : event;

    if (type === "session_created" || type === "session_forked") {
      const sessionId = payload?.sessionId;
      // 隔离会话（子代理、后台任务）不进桌面输入框，不必挂。
      if (typeof sessionId !== "string" || !sessionId || payload?.isolated === true) return;
      this.rememberSession(sessionId, payload.sessionPath);
      this.schedule(sessionId, true);
      return;
    }

    if (type !== "llm_usage") return;
    const entry = event?.entry || payload?.entry;
    const sessionId = entry?.attribution?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) return;
    this.rememberSession(sessionId, entry?.attribution?.sessionPath);
    this.schedule(sessionId, false);
  }

  rememberSession(sessionId, sessionPath) {
    if (typeof sessionId === "string" && sessionId && typeof sessionPath === "string" && sessionPath) {
      this.sessionIdByPath.set(sessionPath, sessionId);
      this.sessionPathById.set(sessionId, sessionPath);
    }
  }

  sessionIdForPath(sessionPath) {
    return typeof sessionPath === "string" ? this.sessionIdByPath.get(sessionPath) || null : null;
  }

  sessionPathForId(sessionId) {
    return typeof sessionId === "string" ? this.sessionPathById.get(sessionId) || null : null;
  }

  async resolveSessionPath(sessionId, wantedPath = null) {
    if ((wantedPath ? this.sessionIdForPath(wantedPath) : this.sessionPathForId(sessionId)) || typeof this.sessions?.list !== "function") return;
    if (!this.sessionLookup) {
      this.sessionLookup = Promise.resolve().then(() => this.sessions.list({ scope: "all", lifecycle: "all" }))
        .catch(error => { this.log("warn", "首响会话路径查询失败：", error?.message || error); return null; })
        .finally(() => { this.sessionLookup = null; });
    }
    const result = await this.sessionLookup;
    if (this.disposed) return;
    // Cache requested identities only. Bulk insertion would evict hot sessions
    // when an old/archived catalog exceeds the cache's hard limit. Each caller
    // resolves its own target even when sharing the same in-flight lookup.
    const session = (result?.sessions || []).find(item => wantedPath ? item.path === wantedPath : item.sessionId === sessionId);
    if (session) this.rememberSession(session.sessionId, session.path);
  }

  async onFirstResponseMetric(metric) {
    if (this.disposed || !metric) return;
    if (metric.sessionPath && !this.sessionIdForPath(metric.sessionPath)) {
      await this.resolveSessionPath(metric.sessionId, metric.sessionPath);
    }
    const sessionId = metric.sessionPath ? this.sessionIdForPath(metric.sessionPath) : metric.sessionId;
    if (sessionId) this.schedule(sessionId, true);
    else this.log("warn", "首响已计量，但尚未找到对应的账本会话 ID");
  }

  prune() {
    this.sessionIdByPath.prune();
    this.sessionPathById.prune();
  }

  schedule(sessionId, immediate) {
    if (this.disposed || !sessionId) return;
    const pending = this.timers.get(sessionId);
    if (pending && !immediate) return;
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(sessionId);
    }
    if (this.timers.size >= this.maxSessions) {
      const oldest = this.timers.keys().next().value;
      clearTimeout(this.timers.get(oldest));
      this.timers.delete(oldest);
    }
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      if (this.disposed) return;
      this.refresh(sessionId).catch(() => {});
    }, immediate ? 120 : this.throttleMs);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  async lookupSpeed(sessionId, entries, modelKey) {
    try {
      const live = this.generationSpeedQuery?.(sessionId, this.sessionPathForId(sessionId), modelKey);
      if (live?.unavailable || (live && (num(live.tps) ?? 0) > 0)) return live;
    } catch (error) { this.log("warn", "实时速度读取失败：", error?.message || error); }
    return estimateOutputSpeed(entries);
  }

  async refresh(sessionId) {
    if (this.disposed) return;
    if (this.running.has(sessionId)) {
      this.dirty.add(sessionId);
      return;
    }
    if (this.running.size >= 32) { this.schedule(sessionId, false); return; }
    const prefs = this.prefs();
    // card 关着：这张卡片整体不显示。连查都不查 —— 省下一次账本请求与一次速度请求。
    if (!prefs.card) {
      await this.apply(sessionId, { visible: false });
      return;
    }
    this.running.add(sessionId);
    try {
      // 不传 limit：宿主的过滤器里没有模型字段，先拿这条会话的记录，再自己筛模型、取最近 50 条。
      const result = await this.bus.request("usage:list", { sessionId });
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      for (const entry of entries) {
        if (entry?.attribution?.sessionId === sessionId) {
          this.rememberSession(sessionId, entry.attribution.sessionPath);
        }
      }
      // 只算当前这个模型的请求（与速度那半同一个口径）；算不出当前模型时就退回全部，不硬猜。
      const currentModel = pickCurrentModel(entries);
      const byModel = currentModel ? entries.filter((e) => modelKeyOf(e) === currentModel) : entries;
      // 宿主按写入顺序返回（旧→新），末尾才是最近的：命中率取最近 50 条。
      const agg = aggregate(byModel.slice(-CACHE_WINDOW));
      // 次数取整条会话（含工具回合续写与子代理内部调用），与窗口和模型都无关。
      const sessionCalls = aggregate(entries).requests;
      const cacheKnown = agg.usable > 0 && agg.reported > 0;
      await this.resolveSessionPath(sessionId);
      if (this.disposed) return;
      const sample = await this.lookupSpeed(sessionId, byModel, currentModel);
      const speedKnown = (num(sample?.tps) ?? 0) > 0;
      let firstResponseMs = null;
      let firstResponseUnavailable = false;
      try {
        const metric = this.firstResponseQuery?.(sessionId, this.sessionPathForId(sessionId));
        firstResponseMs = metric?.lastMs ?? null;
        firstResponseUnavailable = metric?.unavailable === true;
      } catch {}
      const firstResponseKnown = (num(firstResponseMs) ?? 0) > 0;
      // 没有可用时长数据时不伪造速度；缓存信息与首响可独立显示。
      const anyVisible = (cacheKnown && prefs.cache) || (speedKnown && prefs.speed) || firstResponseKnown || firstResponseUnavailable || (prefs.speed && sample?.unavailable);
      if (!anyVisible) {
        await this.apply(sessionId, { visible: false });
        return;
      }
      await this.publish(sessionId, agg, cacheKnown, sample, sessionCalls, prefs, firstResponseMs, firstResponseUnavailable);
    } catch (e) {
      this.log("warn", `输入栏状态位查询失败（${sessionId}）：${e?.message || e}`);
    } finally {
      this.running.delete(sessionId);
      if (this.dirty.delete(sessionId)) this.schedule(sessionId, true);
    }
  }

  // 覆盖是按会话存的：写一次就跟着那个会话走，切回来不用重算。
  // 顺手维护 applied 名单：挂上卡片就记一笔，收起就抹掉，card 由开变关时靠它逐个关。
  async apply(sessionId, payload) {
    if (this.disposed) return;
    if (payload?.visible === false) this.applied.delete(sessionId);
    else {
      if (!this.applied.has(sessionId) && this.applied.size >= this.maxSessions) {
        const oldest = this.applied.values().next().value;
        this.applied.delete(oldest);
        observeAsync(() => this.inputStatus.set({ sessionId: oldest, id: CACHE_ITEM_ID, visible: false }));
      }
      this.applied.add(sessionId);
    }
    await this.inputStatus.set({ sessionId, id: CACHE_ITEM_ID, ...payload });
  }

  // card 由开变关：把已经挂过卡片的会话逐个收起。
  // 名单只记「本进程真的 apply 过、且当前可见」的会话；没记到的（本进程没来得及刷新）靠 refresh 的 card 前置判断兜底。
  async hideAll() {
    const ids = [...this.applied];
    this.applied.clear();
    for (const sessionId of ids) {
      try {
        await this.apply(sessionId, { visible: false });
      } catch (e) {
        this.log("warn", `收起输入栏状态位失败（${sessionId}）：${e?.message || e}`);
      }
    }
  }

  async publish(sessionId, agg, cacheKnown, sample, sessionCalls, prefs, firstResponseMs = null, firstResponseUnavailable = false) {
    const p = prefs || this.prefs();
    const tps = num(sample?.tps);
    const speedKnown = tps !== null && tps > 0;
    const firstResponse = firstResponseUnavailable ? "首响：—" : renderFirstResponsePart(firstResponseMs);
    // 卡片只显示有证据的指标；全角空格避免 HTML 折叠分隔符。
    const text = [
      cacheKnown && p.cache ? renderCachePart(agg.read, agg.uncached) : null,
      (speedKnown || sample?.unavailable) && p.speed ? renderSpeedPart(sample) : null,
      firstResponse || null,
    ].filter(Boolean).join("　");
    // 过滤后没有内容就把卡片收起来。注意是 apply(visible:false)，不是 return —— 直接 return 会保留上一次的文本。
    if (!text) {
      await this.apply(sessionId, { visible: false });
      return;
    }

    // 用户不说添加什么具体内容，不得自行添加。
    // tooltip 只放卡片放不下的既有信息：命中/未命中、输出、次数、截断说明——这几项都有据可循。
    // 这些都是缓存派生内容，跟随 cache 开关：关掉缓存这一段就整段不拼（连“缓存暂无口径”也不拼）。
    // 动态内容只能占一行（2026-09-25 实测）：tooltip 里的 \n 会被宿主折叠成空格，分不了行；
    // 弹层上方那行来自 manifest 里静态的 title（必填非空），拿不到实时数字。所以下面统一用「 · 」
    // 串成一行，别再试图塞换行。
    // （2026-09-25：曾在此自行加了一句“速度按本会话样本校准”，被要求删除。备注、口径、措辞
    //   都不属于“既有信息”，要写什么得等用户点名。）
    const parts = [];
    if (p.cache) {
      if (cacheKnown) {
        parts.push(`命中 ${fmtNum(agg.read)} / 未命中 ${fmtNum(agg.uncached)}`);
        // 有 output 口径才写“输出”：取不到就整段不出现，不写“输出 0”制造假精确。
        if (agg.outputReported > 0) parts.push(`输出 ${fmtK(agg.output)}`);
        parts.push(`${sessionCalls} 次`);
        const missing = agg.usable - agg.reported;
        if (missing > 0) parts.push(`${missing} 次无口径`);
      } else {
        parts.push("缓存暂无口径");
      }
    }

    const payload = { text, visible: true };
    const tooltip = parts.join(" · ");
    // cache 关掉后 tooltip 可能为空：为空就不传这个字段（不传空串冒充 tooltip）。
    if (tooltip) payload.tooltip = tooltip;
    await this.apply(sessionId, payload);
    // 速度来源写进日志：session 是本会话自己的采样，global 是全机兜底（对照表没兜住时）。
    const from = speedKnown ? `，速度来源=${sample?.scope || "?"}` : "";
    this.log("info", `输入栏状态位：${sessionId} → ${text}${from}`);
  }

  // 宿主重启 / 应用重载后，动态覆盖会清空，而已打开的会话不会再发 session_created。
  // 启动时拿最近窗口内出现过的会话 id 预热一下，把这一个缝补上。
  warmStart() {
    if (this.disposed || typeof this.bus?.request !== "function") return;
    const timer = setTimeout(() => {
      this.warm().catch(() => {});
    }, this.warmDelayMs);
    timer.unref?.();
    this.warmTimer = timer;
  }

  async warm() {
    try {
      const since = new Date(Date.now() - WARM_WINDOW_MS).toISOString();
      const result = await this.bus.request("usage:list", { since, limit: WARM_LIMIT });
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      const ids = [];
      for (const entry of entries) {
        const sessionId = entry?.attribution?.sessionId;
        if (typeof sessionId === "string" && sessionId) {
          this.rememberSession(sessionId, entry?.attribution?.sessionPath);
          if (!ids.includes(sessionId)) ids.push(sessionId);
        }
        if (ids.length >= WARM_SESSIONS) break;
      }
      for (const sessionId of ids) await this.refresh(sessionId);
    } catch (e) {
      this.log("warn", `输入栏状态位预热失败：${e?.message || e}`);
    }
  }

  dispose() {
    if (this.disposed) return this.disposePromise || Promise.resolve();
    this.disposed = true;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.running.clear();
    this.dirty.clear();
    this.applied.clear();
    this.sessionIdByPath.clear();
    this.sessionPathById.clear();
    const registration = this.subscription;
    this.subscription = null;
    this.disposePromise = Promise.resolve().then(async () => {
      try {
        if (registration?.disposeAsync) await registration.disposeAsync();
        else if (typeof registration === "function") registration();
        else registration?.unsubscribe?.();
      } catch (error) { this.log("warn", `输入栏状态位退订失败：${error?.message || error}`); }
    });
    return this.disposePromise;
  }
}
