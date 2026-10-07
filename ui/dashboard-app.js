// dashboard-app.js — Token 用量仪表盘 (Apple Minimalist)
import {
  getThemeMode,
  setThemeMode,
  syncThemeUI,
  syncHanaTheme,
  toggleTheme,
} from "./modules/theme.js";
import { initDatePicker } from "./modules/date-picker.js";
import { initSettingsDialog } from "./modules/settings-dialog.js";
import { renderHeadlineCards } from "./modules/headline-cards.js";
import { initFilterDropdowns } from "./modules/filter-dropdown.js";
import {
  renderSubscriptionQuotas as renderSubQuotas,
  renderHdrQuota as renderHeaderQuota,
} from "./modules/subscription-quotas.js";
import { renderMediaSection as renderMedia } from "./modules/media-section.js";
import { createAgentAnalytics } from "./modules/agent-analytics.js";
import { createTurnsInspector } from "./modules/turns-inspector.js";

(function(){
"use strict";

function getAppApiBase() {
  if (window.hana?.api?.url) {
    try { return window.hana.api.url(""); } catch(e) {}
  }
  var p = window.location.pathname;
  if (p.indexOf("/api/apps/token-tracker/routes") >= 0) {
    return p.split("/routes")[0] + "/routes";
  }
  if (p.indexOf("/api/plugins/token-tracker") >= 0) {
    return p.split("/dashboard")[0];
  }
  return "/api/apps/token-tracker/routes";
}

function trackerFetch(endpoint, options) {
  var clean = endpoint.charAt(0) === "/" ? endpoint : "/" + endpoint;
  if (window.hana?.api?.fetch) {
    try {
      return window.hana.api.fetch(clean, options);
    } catch(e) {}
  }
  return fetch(getAppApiBase() + clean, options);
}

var _status = null, _viewError = false, _loadSequence = 0, _statusTimer = null, _closed = false;
var D, R = "today", tc, mc, ac, _allAgents = null, _allModels = null, _allProviders = null, _selAgent = "", _selModel = "", _selProvider = "", _selType = "", _selBalance = "deepseek", _provNames = null, _modelProv = "", _provRowHtml = "", _fxRate = null, _dispCur = "CNY";
(function(){ try{_provNames=JSON.parse(localStorage.getItem("tt-prov-names")||"{}");}catch(e){_provNames={};} })();

function $(id) { return document.getElementById(id); }
function fmt(n) { if(!n||n===0) return "0"; if(n>=1e8) return (n/1e8).toFixed(1)+"亿"; if(n>=1e6) return (n/1e6).toFixed(1)+"M"; if(n>=1e3) return (n/1e3).toFixed(1)+"k"; return n.toLocaleString(); }
function fmtAxis(n) { if(!n||n===0) return "0"; if(n>=1e8) return (n/1e8).toFixed(1)+"亿"; if(n>=1e6) return (n/1e6).toFixed(1)+"M"; if(n>=1e3) return (n/1e3).toFixed(1)+"k"; return n.toLocaleString(); }
function _pn(p) { return (_provNames && _provNames[p]) || p; }
// 展示币种偏好（localStorage + 头部按钮切换）：USD / CNY，全页单一币种
function getDispCur() { try { return localStorage.getItem("tt-disp-cur") || "CNY"; } catch(e) { return "CNY"; } }
function setDispCur(v) { try { localStorage.setItem("tt-disp-cur", v); } catch(e) {} _dispCur = v; }
// 美元→人民币（汇率来自后端 _fxRate，失败时仅显示美元）
function cny(v) {
  if (!(v > 0) || !_fxRate) return "";
  return "¥" + (_fxRate * v).toFixed(2);
}
// 美元金额：按 _dispCur 只显示一种币种
function dual(v) {
  var amount = Number.isFinite(v) ? Math.max(0,v) : 0;
  if (_dispCur === "CNY" && _fxRate > 0) return "¥" + (amount * _fxRate).toFixed(amount * _fxRate >= 1 ? 2 : 4);
  return "$" + (amount === 0 ? "0" : amount.toFixed(amount >= 1 ? 2 : 4));
}
// Missing FX is unknown, never treat CNY as USD.
function toUsd(v, cur) {
  if (cur === "CNY" && !(_fxRate > 0)) return null;
  if (!(v > 0)) return 0;
  return cur === "CNY" ? v / _fxRate : v;
}
function dualByCur(v, cur) {
  if (cur !== "CNY") return dual(v);
  if (_dispCur === "CNY" || !(_fxRate > 0)) return "¥" + (v >= 1 ? v.toFixed(2) : v.toFixed(4));
  return dual(v / _fxRate);
}

function cnToday(){return new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Shanghai"})}

function chartColors() {
  const s = getComputedStyle(document.body);
  return {
    text: s.getPropertyValue("--chart-text").trim(),
    grid: s.getPropertyValue("--chart-grid").trim(),
    chat: s.getPropertyValue("--chart-bar-chat").trim(),
    channel: s.getPropertyValue("--chart-bar-channel").trim(),
    doughnut: s.getPropertyValue("--chart-doughnut-colors").trim().split(",").map(c => c.trim()),
    agent: s.getPropertyValue("--chart-agent-colors").trim().split(",").map(c => c.trim()),
    hitRate: s.getPropertyValue("--chart-hit-rate").trim(),
    reqCount: s.getPropertyValue("--chart-req-count").trim(),
  };
}

function isHourlyMode() {
  if (R === "today") return true;
  const df = $("df"), dt = $("dt");
  if (df && dt && df.value && dt.value && df.value === dt.value) return true;
  return false;
}

function syncDateInputs() {
  var df=$("df"),dt=$("dt");
  if(!df||!dt)return;
  var t=cnToday();
  if(R==="today"){df.value=t;dt.value=t;}
  else if(R==="week"){
    var d=new Date(),day=d.getDay();
    // 与后端/官方口径统一：本周从周一开始。
    d.setDate(d.getDate()-((day+6)%7));
    df.value=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");dt.value=t;
  }else if(R==="year"){
    var d=new Date();
    df.value=d.getFullYear()+"-01-01";dt.value=t;
  }else if(R==="lyear"){
    var d=new Date();
    var ly=d.getFullYear()-1;
    df.value=ly+"-01-01";dt.value=ly+"-12-31";
  }else if(R==="month"){
    var d=new Date();
    df.value=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-01";dt.value=t;
  }else if(R==="all"){
    df.value=(D&&D.earliest)?D.earliest:"";dt.value=D?t:"";
  }
}

function modelLabel(id) {
  return id==="unknown"?"未标注模型":id+(D.modelStates?.[id]==="historical"?"（历史，当前未配置）":"");
}
function updateFilterOpts() {
  var sa=$("sa"),sp=$("sp"),sm=$("sm"); if(!sa||!sm) return;
  var la=sa.querySelector(".cs-list"),lp=sp?.querySelector(".cs-list"),lm=sm.querySelector(".cs-list");
  var ta=sa.querySelector(".cs-txt"),tp=sp?.querySelector(".cs-txt"),tm=sm.querySelector(".cs-txt");
  if(!la||!lm||!ta||!tm) return;
  ta.textContent=_selAgent?((D.agentNames||{})[_selAgent]||_selAgent):"Agent";
  if(tp){
    if(_selProvider){
      var selProv=(_allProviders||[]).find(function(p){return p.provider===_selProvider;});
      tp.textContent=_pn(_selProvider)+(selProv&&selProv.state==="historical"?"（历史配置）":"");
    } else tp.textContent="供应商";
  }
  tm.textContent=_selModel?modelLabel(_selModel):"模型";
  if(_allAgents) {
    var h='<div class="cs-opt'+(_selAgent===""?" sel":"")+'" data-v="">全部 Agent</div>';
    _allAgents.forEach(function(a){var n=(D.agentNames||{})[a.id]||a.id;if(a.deleted)n+='（历史 Agent）';h+='<div class="cs-opt'+(_selAgent===a.id?" sel":"")+'" data-v="'+a.id+'">'+n+'</div>'});
    la.innerHTML=h;
  }
  if(sp&&lp&&D){
    var seen={},ph='<div class="cs-opt'+(_selProvider===""?" sel":"")+'" data-v="">全部</div>';
    var providerList=_allProviders||D.providerOptions||D.providers||[];
    providerList.forEach(function(p){
      if(!p.provider||seen[p.provider])return;
      seen[p.provider]=1;
      var n=_pn(p.provider)+(p.state==="historical"?"（历史配置）":"");
      ph+='<div class="cs-opt'+(_selProvider===p.provider?" sel":"")+'" data-v="'+escHTML(p.provider)+'">'+escHTML(n)+'</div>';
    });
    lp.innerHTML=ph;
  }
  if(Array.isArray(_allModels) || Array.isArray(D.modelOptions)) {
    lm.innerHTML=window.TokenTrackerModelOptions.renderModelFilterOptions(D.modelOptions,_allModels,_selModel);
  }
}

$("app").innerHTML =
  '<div class="app-layout">'+
  '<div class="sidebar">'+
  '<div class="sidebar-section">'+
  '<div class="sidebar-label">时间范围</div>'+
  '<div class="time-group">'+
  '<button class="fb" data-r="all">全部</button>'+
  '<button class="fb" data-r="lyear">去年</button>'+
  '<button class="fb" data-r="year">本年</button>'+
  '<button class="fb" data-r="month">本月</button>'+
  '<button class="fb" data-r="week">本周</button>'+
  '<button class="fb act" data-r="today">今日</button>'+
  '</div></div>'+
  '<div class="sidebar-divider"></div>'+
  '<div class="sidebar-section">'+
  '<div class="sidebar-label">日期</div>'+
  '<div class="date-row"><span class="fi-wrap"><input type="text" readonly class="fi" id="df"></span></div>'+
  '<div class="date-row" style="margin-top:4px"><span class="fi-wrap"><input type="text" readonly class="fi" id="dt"></span></div>'+
  '</div>'+
  '<div class="sidebar-divider"></div>'+
  '<div class="sidebar-section">'+
  '<div class="sidebar-label">筛选</div>'+
  '<span class="cs" id="sa"><span class="cs-txt">Agent</span><span class="cs-arw">▾</span><div class="cs-list"></div></span>'+
  '<span class="cs" id="sp"><span class="cs-txt">供应商</span><span class="cs-arw">▾</span><div class="cs-list"></div></span>'+
  '<span class="cs" id="sm"><span class="cs-txt">模型</span><span class="cs-arw">▾</span><div class="cs-list"></div></span>'+
  '<span class="cs" id="stype"><span class="cs-txt">类型</span><span class="cs-arw">▾</span><div class="cs-list"><div class="cs-opt sel" data-v="">全部</div><div class="cs-opt" data-v="desktop">聊天</div><div class="cs-opt" data-v="channel">频道</div></div></span>'+
  '</div>'+
  '<div id="fx" class="fx-side" style="display:none"></div>'+
  '</div>'+
  '<div class="main-area">'+
  '<div class="archive-intro"><span>PERSONAL USAGE ARCHIVE / 01</span><p>把每一次调用，放回工作流里看。</p></div>'+
  '<div class="hdr"><div class="hdr-left"><span class="hdr-title">用量</span><span id="lu">—</span></div><div id="hdrQuota" class="hdr-quota"></div><div class="hdr-right"><button class="btn-icon" id="rf" title="刷新数据"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button><button class="btn-icon" id="th-btn" title="切换深色模式"></button><button class="btn-icon" id="st-btn" title="设置"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button><span class="unit-hint" id="uh">ⓘ</span></div></div>'+
  '<details id="runtime-health" class="runtime-health"><summary id="health-summary">运行状态 · 尚未取得检查结果</summary><div id="health-details"></div><details class="metric-help"><summary>指标与采集范围说明</summary><p>首响：请求发出至 provider 响应元数据到达，不是真正的首 token TTFT。</p><p>速度：输出 token ÷ 完整请求时长，包含等待；优先实时请求计量，无有效实时样本时使用同模型最近 8 条有效账本时长回退，不是流式瞬时速度。</p><p>胶囊缓存率：本会话当前模型最近 50 条记录，按 token 体量加权；看板缓存率维持缓存读 token ÷ 当前筛选范围总 token 的既有口径。</p><p>费用为估算，与供应商账单可能不同。余额查询时间不代表用量同步时间。</p><p id="coverage-help"></p></details><details class="diagnostic-preview"><summary>查看诊断摘要</summary><pre id="diagnostic-text"></pre><button class="btn" id="copy-diagnostic">复制诊断摘要</button><span id="copy-result" role="status"></span><p>仅复制已预览的摘要，不会自动上传。</p></details></details>'+
  '<div id="cards" class="cg"></div>'+
  '<div id="media-section" style="display:none"></div>'+
  '<div class="main-layout"><div class="main-left">'+
  '<div class="trend-card"><div class="ct" id="tc-title">消耗趋势</div><canvas id="tc"></canvas></div>'+
  '<div class="chart-row"><div class="cx"><div class="ct">模型占比</div><canvas id="mc"></canvas></div>'+
  '<div class="cx"><div class="ct">Agent 消耗对比</div><canvas id="ac"></canvas></div></div>'+
  '</div></div>'+
  '<div id="agent-analytics-section"></div>'+
  '<div id="turns-inspector-section"></div>'+
  '<div id="sub-quota-section" style="display:none"></div>'+
  '<div id="ld" class="ld">翻阅档案…</div>'+
  '</div>'+
  '</div>'+
  '<div class="set-shade" id="set-shade" style="display:none"></div><div class="set-panel" id="set-panel" style="display:none"><div class="set-hdr"><span>设置</span><div style="display:flex;gap:8px;align-items:center"><button class="btn" id="set-save">保存</button><button class="btn" id="set-close">✕</button></div></div><div class="set-body"><div class="set-sec"><div class="set-sec-title">外观</div><div class="set-theme-row" id="set-theme"><button class="set-theme-opt" data-v="auto">跟随系统</button><button class="set-theme-opt" data-v="light">浅色</button><button class="set-theme-opt" data-v="dark">深色</button></div></div></div></div>';

function load(refreshFirst) {
  var sequence = ++_loadSequence;
  const el = $("ld");
  if (el) { el.textContent = "翻阅档案…"; el.style.display = D ? "none" : "block"; }
  const qs = window.location.search;
  const sep = qs ? '&' : '?';
  var p = "range="+R+($("df").value?"&from="+$("df").value:"")+($("dt").value?"&to="+$("dt").value:"")+(_selAgent?"&agent="+encodeURIComponent(_selAgent):"")+(_selProvider?"&provider="+encodeURIComponent(_selProvider):"")+(_selModel?"&model="+encodeURIComponent(_selModel):"")+(_selType?"&type="+_selType:"");
  const doFetch = () => trackerFetch("/data" + qs + sep + p).then(async r => {
    var d = await r.json();
    if(sequence !== _loadSequence || _closed) return;
    if(d._status) _status=d._status;
    if(!r.ok || d.error) throw Error("数据暂不可用");
    if(!_allAgents||!D){_allAgents=d.agents.slice();_allModels=d.models.slice();}
    _allProviders=(d.providerOptions||d.providers||[]).slice();
    D = d; _viewError=false; _fxRate = d._fxRate > 0 ? d._fxRate : null;
    if (el) el.style.display = "none";
    render();
  }).catch(() => {
    if(sequence !== _loadSequence || _closed) return;
    _viewError=true;
    renderStatus();
    if(!D && el) el.textContent = _status?.freshness?.syncFailed ? "首次同步失败，数据尚未就绪。请展开运行状态查看原因。" : "尚未取得用量数据，等待同步或检查运行状态。";
  });
  if (refreshFirst) {
    trackerFetch("/refresh" + qs + sep + "range=" + R, {method: "POST"}).then(doFetch,doFetch);
  } else doFetch();
}
function localTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN") : "未知";
}
function diagnosticText(status) {
  if(!status) return "尚未取得诊断信息。";
  var f=status.freshness||{};
  var lines=["Token Tracker 诊断摘要", "插件版本："+status.pluginVersion, "宿主版本："+status.hostVersion,
    "界面版本："+(document.body.dataset.uiVersion||"未知"),
    "最后尝试同步："+localTime(f.lastAttemptAt), "最后成功同步："+localTime(f.lastSuccessAt), "扫描间隔："+f.intervalMs/1000+" 秒"];
  (status.components||[]).forEach(function(c){lines.push(c.label+"："+c.state+" / "+c.code+" / "+localTime(c.at));});
  Object.keys(status.metrics||{}).forEach(function(id){lines.push((id==="speed"?"速度":"首响")+"："+status.metrics[id].code);});
  return lines.join("\n");
}
function renderStatus() {
  var st=_status;
  if(!st)return;
  var f=st.freshness||{}, components=st.components||[];
  var degraded=components.some(function(c){return c.state==="degraded";}) || Object.values(st.metrics||{}).some(function(m){return !["ok","pending","no_sample"].includes(m.code);});
  var unknown=components.some(function(c){return c.state==="unknown";});
  var uiVersion=document.body.dataset.uiVersion;
  var versionMismatch=uiVersion && uiVersion!==st.pluginVersion;
  $("health-summary").textContent="运行状态 · "+(degraded?"部分能力异常或降级":unknown?"部分能力尚未取得检查结果":"正常");
  if(versionMismatch) $("health-summary").textContent="运行状态 · 界面版本已过期，请重新打开卡片";
  var freshness=f.syncFailed?(f.dataAvailable?"同步失败，当前展示上次成功数据":"首次同步失败，尚无可用数据"):f.scanning?"正在同步":f.stale?"数据已超过两个扫描间隔，等待同步":f.lastSuccessAt?"最后成功同步："+localTime(f.lastSuccessAt):"等待首次同步";
  if(_viewError && D) freshness="看板加载失败，当前保留上次展示的数据";
  $("lu").textContent=freshness;
  $("runtime-health").classList.toggle("degraded",degraded||f.syncFailed||f.stale||_viewError||versionMismatch);
  var html='<p>插件版本：'+escHTML(st.pluginVersion)+' · 界面版本：'+escHTML(uiVersion||"未知")+'<br>最后尝试同步：'+escHTML(localTime(f.lastAttemptAt))+'<br>最后成功同步：'+escHTML(localTime(f.lastSuccessAt))+'<br>扫描间隔：'+f.intervalMs/1000+' 秒</p>';
  components.forEach(function(c){
    html+='<div class="health-row"><strong>'+escHTML(c.label)+' · '+({ok:"正常",degraded:"异常/降级",unknown:"未知/检查中"}[c.state]||"未知")+'</strong><span>'+escHTML(c.reason)+' '+escHTML(c.suggestion)+'</span><small>'+escHTML(localTime(c.at))+'</small></div>';
  });
  var metrics=st.metrics||{};
  Object.keys(metrics).forEach(function(id){html+='<p>'+ (id==="speed"?"最近胶囊速度":"最近胶囊首响") +'：'+escHTML(metrics[id].reason)+(id==='speed'&&metrics[id].code==='ok'?' 来源：'+escHTML(metrics[id].source):'')+'</p>';});
  $("health-details").innerHTML=html;
  $("coverage-help").textContent=st.coverage||"采集范围未知";
  $("diagnostic-text").textContent=diagnosticText(st);
}
async function pollStatus() {
  if(_closed)return;
  try {
    const r=await trackerFetch("/status"+window.location.search);
    if(!r.ok)throw Error();
    const status=await r.json();
    if(_closed)return;
    _status=status;
    renderStatus();
    // Only label data with the scan that actually produced it.
    if(status.freshness.dataAvailable && (!D || D.lastScan!==status.freshness.lastSuccessAt)) load(false);
  } catch {}
  if(!_closed)_statusTimer=setTimeout(pollStatus,Math.min(60000,Math.max(5000,(_status?.freshness?.intervalMs||60000)/2)));
}

function refresh() { load(true); }

function render() {
  if (!D) return;
  updateFilterOpts();
  renderHdrQuota();
  renderStatus();
  // 汇率标注（双币显示时展示换算依据）
  var fxEl=$("fx");
  if(fxEl){
    if(_fxRate&&_fxRate>0)fxEl.textContent="1 USD = "+_fxRate.toFixed(4)+" CNY";
    else fxEl.textContent="";
  }
  renderHeadlineCards($("cards"), D.summary, fmt);
  renderMediaSection();
  renderTrend();
  renderModel();
  renderAgent();
  renderSubscriptionQuotas();
  renderAgentAnalyticsSection();
  renderTurnsInspectorSection();
}

let _agentAnalyticsInstance = null;
function renderAgentAnalyticsSection() {
  const el = $("agent-analytics-section");
  if (!el || !D) return;
  if (!_agentAnalyticsInstance) {
    _agentAnalyticsInstance = createAgentAnalytics({
      container: el,
      getData: () => D,
    });
  } else {
    _agentAnalyticsInstance.reload();
  }
}

let _turnsInspectorInstance = null;
function renderTurnsInspectorSection() {
  const el = $("turns-inspector-section");
  if (!el || !D) return;
  if (!_turnsInspectorInstance) {
    _turnsInspectorInstance = createTurnsInspector({
      container: el,
      fetchFn: trackerFetch,
      getApiBase: getAppApiBase,
      getFilters: () => ({
        range: R,
        from: $("df") ? $("df").value : "",
        to: $("dt") ? $("dt").value : "",
        agent: _selAgent || "",
        provider: _selProvider || "",
        model: _selModel || "",
        type: _selType || "",
      }),
    });
  } else {
    _turnsInspectorInstance.reload(true);
  }
}



function renderMediaSection(){
  renderMedia({
    container: $("media-section"),
    mediaGen: D ? D.mediaGen : [],
    costs: D ? D._modelCosts : [],
    dual: dual,
    escHTML: escHTML,
  });
}

var _trendMode = "scene";
function renderTrend() {
  if (tc) tc.destroy();
  const cc = chartColors();
  const useHourly = isHourlyMode() && D.hourly && D.hourly.length > 0;
  let data = useHourly ? D.hourly : D.daily;
  try{_trendMode=localStorage.getItem("tt-trend-mode")||"scene";}catch(e){_trendMode="scene";}

  var tEl = $("tc-title");
  tEl.textContent = (useHourly ? "消耗趋势（按小时）" : "消耗趋势");
  if (!data || !data.length) return;

  if (!useHourly) {
    const now = new Date();
    let startDate;
    if (R === "all") {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      startDate = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    } else if (R === "month") {
      startDate = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
    } else if (R === "week") {
      const d = new Date();
      // 与后端/官方口径统一：本周从周一开始。
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      startDate = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    }
    if (startDate) data = data.filter(d => d.date >= startDate);
  }

  const labels = data.map(d => useHourly ? d.hour+":00" : d.date.slice(5));

  // 视图切换：场景（聊天/频道） / 构成（输入/推理/输出/缓存）
  if(!tEl.querySelector(".mm-switch")){
    var sw=document.createElement("span");
    sw.className="mm-switch";
    sw.innerHTML='<button data-v="scene" class="'+( _trendMode==="scene"?"on":"")+'">场景</button><button data-v="mix" class="'+( _trendMode==="mix"?"on":"")+'">构成</button>';
    sw.addEventListener("click",function(e){
      var b=e.target.closest("button"); if(!b)return;
      _trendMode=b.getAttribute("data-v");
      try{localStorage.setItem("tt-trend-mode",_trendMode);}catch(err){}
      renderTrend();
    });
    tEl.appendChild(sw);
  }else{
    var btns=tEl.querySelectorAll(".mm-switch button");
    for(var bi=0;bi<btns.length;bi++)btns[bi].className=(btns[bi].getAttribute("data-v")===_trendMode?"on":"");
  }

  if(_trendMode==="mix"){
    var sumInp=0,sumOut=0,sumRsn=0,sumCache=0,sumTotal=0;
    for(var i=0;i<data.length;i++){var d=data[i];sumInp+=d.input||0;sumOut+=d.output||0;sumRsn+=d.reasoning||0;sumCache+=d.cacheRead||0;sumTotal+=d.totalTokens||0;}
    var hasInp=sumInp>0,hasOut=sumOut>0,hasRsn=sumRsn>0;
    var inp,rsn,out,cache;
    if(hasInp||hasOut){
      inp=data.map(function(d){return (d.input||0)-(hasRsn?(d.reasoning||0):0);});
      rsn=hasRsn?data.map(function(d){return d.reasoning||0;}):null;
      out=data.map(function(d){return d.output||0;});
      cache=data.map(function(d){return d.cacheRead||0;});
    }else{
      var ttlInp=D.summary&&D.summary.totalInput?D.summary.totalInput:0;
      var ttlOut=D.summary&&D.summary.totalOutput?D.summary.totalOutput:0;
      var ttlSum=D.summary&&D.summary.totalTokens?D.summary.totalTokens:sumTotal;
      if(ttlInp>0||ttlOut>0){
        inp=data.map(function(d){var r=(d.totalTokens||0)/ttlSum;return Math.round(ttlInp*r);});
        out=data.map(function(d){var r=(d.totalTokens||0)/ttlSum;return Math.round(ttlOut*r);});
        rsn=null;
        cache=data.map(function(d){return d.cacheRead||0;});
      }else{
        inp=null;out=null;rsn=null;
        cache=data.map(function(d){return d.cacheRead||0;});
      }
    }
    var datasets=[];
    if(inp)datasets.push({label:"输入",data:inp,backgroundColor:cc.doughnut[0],borderRadius:6,borderSkipped:false,barPercentage:0.65,categoryPercentage:0.75});
    if(rsn)datasets.push({label:"推理",data:rsn,backgroundColor:cc.doughnut[4],borderRadius:6,borderSkipped:false,barPercentage:0.65,categoryPercentage:0.75});
    if(out)datasets.push({label:"输出",data:out,backgroundColor:cc.hitRate,borderRadius:6,borderSkipped:false,barPercentage:0.65,categoryPercentage:0.75});
    datasets.push({label:"缓存命中",data:cache,backgroundColor:cc.channel,borderRadius:6,borderSkipped:false,barPercentage:0.65,categoryPercentage:0.75});
    tc = new Chart($("tc"),{type:"bar",data:{labels,datasets:datasets},options:{responsive:true,maintainAspectRatio:false,color:cc.text,plugins:{legend:{position:"top",align:"start",labels:{color:cc.text,boxWidth:8,boxHeight:8,font:{size:12,weight:'500'},padding:16,usePointStyle:true,pointStyle:"circle"}},tooltip:{backgroundColor:"rgba(24,24,27,0.92)",titleFont:{size:12,weight:'600'},bodyFont:{size:12},padding:10,cornerRadius:8,boxPadding:4,usePointStyle:true}},scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:12}}},y:{stacked:true,grid:{color:cc.grid},ticks:{callback:function(v){return fmtAxis(v)},font:{size:12}}}}}});
    return;
  }

  const desk = data.map(d => d.desktop||0);
  const chan = data.map(d => d.channel||0);
  tc = new Chart($("tc"),{type:"bar",data:{labels,datasets:[
    {label:"聊天",data:desk,backgroundColor:cc.chat,borderRadius:6,borderSkipped:false,barPercentage:0.65,categoryPercentage:0.75},
    {label:"频道",data:chan,backgroundColor:cc.channel,borderRadius:6,borderSkipped:false,barPercentage:0.65,categoryPercentage:0.75}
  ]},options:{responsive:true,maintainAspectRatio:false,color:cc.text,plugins:{legend:{position:"top",align:"start",labels:{color:cc.text,boxWidth:8,boxHeight:8,font:{size:12,weight:'500'},padding:16,usePointStyle:true,pointStyle:"circle"}},tooltip:{backgroundColor:"rgba(24,24,27,0.92)",titleFont:{size:12,weight:'600'},bodyFont:{size:12},padding:10,cornerRadius:8,boxPadding:4,usePointStyle:true}},scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:12}}},y:{stacked:true,grid:{color:cc.grid},ticks:{callback:function(v){return fmtAxis(v)},font:{size:12}}}}}});
}

function renderModel() {
  const cc = chartColors(); if (mc) { mc.destroy(); mc = null; }
  var listEl = $("mc-list");
  if (!listEl) {
    listEl = document.createElement("div");
    listEl.id = "mc-list";
    listEl.className = "model-rank";
    $("mc").parentNode.appendChild(listEl);
  }
  function emptyRank() {
    listEl.innerHTML='<div class="rank-note">当前筛选范围暂无可展示的模型 Token 用量。</div>'+(unattributed?'<div class="rank-note">另有 '+unattributed+' 次调用未标注模型，已包含于总览。</div>':'');
    $("mc").style.display="none";
  }
  var smv=$("sm")?_selModel:"";
  var items = [];
  _provRowHtml = "";
  var title = "模型占比";
  var unattributed=(D.models||[]).filter(function(m){return m.id==="unknown"&&!(m.totalTokens>0);}).reduce(function(n,m){return n+(m.assistantCount||0);},0);
  if (smv && !_selAgent) {
    var ag=!D.agents?null:D.agents; if(!ag||!ag.length){emptyRank();return;}
    title = "Agent 占比";
    items = ag.map(function(a,i){var n=(D.agentNames||{})[a.id]||a.id;if(a.deleted)n+='（历史 Agent）';return{label:n,tokens:a.totalTokens,count:a.assistantCount||0,color:cc.agent[i%cc.agent.length]};});
  } else if (D.providerBreakdown && D.providerBreakdown.length) {
    // 供应商选择分类（卡内筛选，仅影响模型占比视图）
    var provs=[], seenP={};
    for(var pi=0;pi<D.providerBreakdown.length;pi++){var pp=D.providerBreakdown[pi].provider;if(!seenP[pp]){seenP[pp]=1;provs.push(pp);}}
    if(_modelProv && !seenP[_modelProv]) _modelProv="";
    var pbd = _modelProv ? D.providerBreakdown.filter(function(p){return p.provider===_modelProv;}) : D.providerBreakdown;
    var pLabels = pbd.map(function(p){return modelLabel(p.model);});
    var countMap={};
    if(D._subscriptionQuotas){for(var oi=0;oi<D._subscriptionQuotas.length;oi++){var ogq=D._subscriptionQuotas[oi];if(ogq&&ogq.modelSummary){for(var oj=0;oj<ogq.modelSummary.length;oj++){var msm=ogq.modelSummary[oj];if(msm&&msm.model){countMap[msm.model]=(msm.count||0);}}}}}
    items = pbd.map(function(p,i){return{label:pLabels[i],tokens:p.totalTokens||0,count:countMap[p.model]!==undefined?countMap[p.model]:(p.count||0),color:cc.doughnut[i%cc.doughnut.length]};});
    // 卡内供应商筛选行（始终展示，供应商即分类）
    var provRow='<div class="mr-prov-row"><button data-p="" class="'+( _modelProv===""?"on":"")+'">全部</button>';
    for(var pj=0;pj<provs.length;pj++){
      provRow+='<button data-p="'+escHTML(provs[pj])+'" class="'+( _modelProv===provs[pj]?"on":"")+'">'+escHTML(_pn(provs[pj]))+'</button>';
    }
    provRow+='</div>';
    _provRowHtml=provRow;
  } else {
    var m=(D.models||[]).filter(function(md){return md.id!=="unknown"||md.totalTokens>0;}); if(!m.length){emptyRank();return;}
    items = m.map(function(md,i){
      return{label:modelLabel(md.id),tokens:md.totalTokens||0,count:md.assistantCount||0,color:cc.doughnut[i%cc.doughnut.length]};
    });
  }
  var ctEl=$("mc").parentElement.querySelector(".ct");
  ctEl.textContent=title;

  // 双栏独立排行：Token / 次数
  var TOP=8;
  function rankBy(fn, valFn, fmtFn, hasFn){
    var arr=items.filter(hasFn).slice().sort(function(a,b){return fn(b)-fn(a);}).slice(0,TOP);
    var total=0; for(var i=0;i<arr.length;i++)total+=fn(arr[i]);
    if(!total)return {arr:[],total:0,empty:true};
    var h='<div class="mr-col-item">';
    arr.forEach(function(it,k){
      var w=total>0?(fn(it)/total*100):0;
      h+='<div class="mr-row"><div class="mr-rank">'+(k+1)+'</div>'+
        '<span class="mr-dot" style="background:'+it.color+'"></span>'+
        '<div class="mr-info"><div class="mr-name" title="'+escHTML(it.label)+'">'+escHTML(it.label)+'</div>'+
        '<div class="mr-bar"><div class="mr-bar-fill" style="width:'+w+'%;background:'+it.color+'"></div></div></div>'+
        '<div class="mr-val" title="'+escHTML(fn(it).toLocaleString())+'">'+fmtFn(fn(it))+'</div></div>';
    });
    h+='</div>';
    return {arr:arr,total:total,html:h};
  }
  var colToken=rankBy(function(it){return it.tokens||0;},null,function(v){return fmtAxis(v);},function(it){return (it.tokens||0)>0;});
  var colCount=rankBy(function(it){return it.count||0;},null,function(v){return fmt(v)+" 次";},function(it){return (it.count||0)>0;});

  var html=(_provRowHtml||"")+'<div class="mr-cols" style="--rank-columns:'+(1+(colCount.empty?0:1))+'">';
  html+='<div class="mr-col"><div class="mr-col-title">Token</div>'+(colToken.html||'<div class="mr-col-empty">无数据</div>')+'</div>';
  if(!colCount.empty)html+='<div class="mr-col"><div class="mr-col-title">次数</div>'+colCount.html+'</div>';
  html+='</div>';
  if(colCount.empty)html+='<div class="rank-note">当前范围暂无调用次数记录。</div>';
  if(unattributed)html+='<div class="rank-note">另有 '+unattributed+' 次调用未标注模型，已包含于总览，不作为已配置模型展示。</div>';
  listEl.innerHTML=html;
  $("mc").style.display="none";
  listEl.style.display="block";
  // 供应商筛选点击（委托绑定，避免重复注册）
  if(!listEl.__provBound){
    listEl.__provBound=true;
    listEl.addEventListener("click",function(e){
      var b=e.target.closest(".mr-prov-row button");
      if(!b)return;
      _modelProv=b.getAttribute("data-p")||"";
      renderModel();
    });
  }
}

function renderAgent() {
  const cc = chartColors(); if (ac) ac.destroy();
  if (_selAgent && !_selModel) {
    var ag=D.agents.find(function(a){return a.id===_selAgent}); if(!ag||!ag.models)return;
    var mods=Object.entries(ag.models).sort(function(a,b){return(b[1].totalTokens||0)-(a[1].totalTokens||0)});
    if(!mods.length)return;
    $("ac").parentElement.querySelector(".ct").textContent="模型占比";
    ac = new Chart($("ac"),{type:"bar",data:{labels:mods.map(function(m){return m[0]}),datasets:[{label:"消耗",data:mods.map(function(m){return m[1].totalTokens||0}),backgroundColor:cc.doughnut.slice(0,mods.length),borderRadius:6,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,color:cc.text,indexAxis:"y",scales:{x:{grid:{color:cc.grid},ticks:{callback:function(v){return fmtAxis(v)},font:{size:12}}},y:{grid:{display:false},ticks:{font:{size:12}}}},plugins:{legend:{display:false},tooltip:{backgroundColor:"rgba(24,24,27,0.92)",titleFont:{size:12,weight:'600'},bodyFont:{size:12},padding:10,cornerRadius:8,boxPadding:4}}}});
  } else {
    var ags=!D.agents?null:D.agents; if(!ags||!ags.length)return;
    $("ac").parentElement.querySelector(".ct").textContent="Agent 消耗对比";
    ac = new Chart($("ac"),{type:"bar",data:{labels:ags.map(function(a){var n=(D.agentNames||{})[a.id]||a.id;if(a.deleted)n+='（历史 Agent）';return n}),datasets:[{label:"消耗",data:ags.map(function(a){return a.totalTokens}),backgroundColor:cc.agent.slice(0,ags.length),borderRadius:6,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,color:cc.text,indexAxis:"y",scales:{x:{grid:{color:cc.grid},ticks:{callback:function(v){return fmtAxis(v)},font:{size:12}}},y:{grid:{display:false},ticks:{font:{size:12}}}},plugins:{legend:{display:false},tooltip:{backgroundColor:"rgba(24,24,27,0.92)",titleFont:{size:12,weight:'600'},bodyFont:{size:12},padding:10,cornerRadius:8,boxPadding:4}}}});
  }
}

function renderSubscriptionQuotas(){
  renderSubQuotas({
    container: $("sub-quota-section"),
    quotas: D ? D._subscriptionQuotas : [],
    priceTable: D ? D._priceTable : {},
    escHTML: escHTML,
    fmt: fmt,
  });
}

function renderHdrQuota(){
  renderHeaderQuota({
    container: $("hdrQuota"),
    quotas: D ? D._subscriptionQuotas : [],
    escHTML: escHTML,
    dual: dual,
  });
}

function renderConsumption(){
  var costs=D._modelCosts||[];
  if(!costs.length){var cs=$("cs-section");if(cs)cs.style.display="none";return;}
  var hasCost=false, hasKnownCost=false, incomplete=false;
  for(var i=0;i<costs.length;i++){if(costs[i].cost>0)hasCost=true;if(costs[i].priced!==false && toUsd(costs[i].cost,costs[i].currency)!==null)hasKnownCost=true;if(costs[i].priced===false || toUsd(costs[i].cost,costs[i].currency)===null)incomplete=true;}
  var total=0;
  for(var i=0;i<costs.length;i++){if(costs[i].cost>0){total+=toUsd(costs[i].cost,costs[i].currency);}}
  var displayTotal=total;
  var h='<div class="cs-wrap"><div class="cs-title">消费明细</div>';
  h+='<div class="cs-table"><div class="cs-th"><span class="ct-c1">模型</span><span class="ct-n">输入 tok</span><span class="ct-n">输出 tok</span><span class="ct-n">缓存 tok</span><span class="ct-a">费用</span></div>';

  var modelInfo={};
  for(var mi=0;mi<(D.models||[]).length;mi++){var m2=D.models[mi];modelInfo[m2.id]={totalTokens:m2.totalTokens||0,tokIn:m2.input||0,tokOut:m2.output||0,tokCache:m2.cacheRead||0,tokCacheW:m2.cacheWrite||0};}

  var nonSlotTotalUsd=0;
  for(var i=0;i<costs.length;i++){
    var c=costs[i];
    if(!((c.totalTokens || modelInfo[c.model]?.totalTokens || 0)>0) && !(c.callCount>0) && !(c.cost>0))continue;
    var curM=c.currency||"USD";
    if(c.model==="unknown" && !(c.totalTokens>0) && !(c.cost>0))continue;
    var label=modelLabel(c.model);
    nonSlotTotalUsd+=toUsd(c.cost,c.currency);
    var tokIn=0,tokOut=0,tokCache=0;
    var info2=modelInfo[c.model];
    if(c.costSource==='official'){
      if(c.officialInputTokens!=null || c.officialOutputTokens!=null){tokIn=c.officialInputTokens;tokOut=c.officialOutputTokens;tokCache=null;}
      else{tokIn=null;tokOut=null;tokCache=null;}
    }else if(info2){tokIn=info2.tokIn;tokOut=info2.tokOut;tokCache=info2.tokCache;}
    var fmtTokCell=function(v){return v==null?'—':v.toLocaleString();};
    h+='<div class="cs-tr"><span class="ct-c1">'+escHTML(label)+'<span class="ct-cur">'+(curM==="CNY"?"人民币":"美元")+'</span></span><span class="ct-n">'+fmtTokCell(tokIn)+'</span><span class="ct-n">'+fmtTokCell(tokOut)+'</span><span class="ct-n">'+fmtTokCell(tokCache)+'</span><span class="ct-a">'+(c.priced===false?'<span title="未配置价格，不能推断为免费">—（未定价）</span>':dualByCur(c.cost,curM))+'</span></div>';
  }
  displayTotal=nonSlotTotalUsd;
  h+='<div class="cs-total-row"><span class="ct-c1">合计'+(incomplete?'（部分费用）':'')+'</span><span class="ct-n"></span><span class="ct-n"></span><span class="ct-n"></span><span class="ct-a">'+(hasKnownCost?dual(displayTotal):'—')+'</span></div>';
  h+='</div><div class="rank-note">费用为估算，与供应商账单可能不同。'+(incomplete?'未定价及缺少汇率的费用不计入合计。':'')+'</div></div>';
  var el=$("cs-section");
  if(el){el.innerHTML=h;el.style.display="";}
}


function escHTML(s){if(!s)return'';return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

$("rf").onclick = refresh;
var thBtn = $("th-btn");
if (thBtn) thBtn.onclick = function() { toggleTheme({ onThemeChange: function() { if (D) render(); } }); };
initSettingsDialog({ onThemeChange: function() { if (D) render(); } });
document.querySelectorAll(".fb").forEach(b => {
  b.onclick = function() { R = this.dataset.r; document.querySelectorAll(".fb").forEach(x => x.classList.toggle("act", x.dataset.r === R)); _selAgent=""; _selModel=""; _selProvider=""; syncDateInputs(); load(); };
});

initFilterDropdowns({
  onSelect: function(item) {
    if (item.name === "stype") {
      _selType = item.value;
      var tx = $("stype")?.querySelector(".cs-txt");
      if (tx) {
        if (item.value === "") tx.textContent = "类型";
        else tx.textContent = item.value === "desktop" ? "聊天" : "频道";
      }
      load();
      return;
    }
    if (item.name === "sp") {
      _selProvider = item.value;
      _selModel = "";
      load();
      return;
    }
    _selAgent = item.name === "sa" ? item.value : _selAgent;
    _selModel = item.name === "sm" ? item.value : _selModel;
    load();
  }
});

initDatePicker({
  fromInputId: "df",
  toInputId: "dt",
  onDateSelect: function() {
    document.querySelectorAll(".fb").forEach(function(x){ x.classList.toggle("act", false); });
    R = "";
    load();
  }
});

(function(){document.addEventListener("click",function(e){
  if(e.target.id==="uh"){
    var u=$("uh");if(!u)return;
    var t=u.getBoundingClientRect();
    var d=$("uh-tip");
    if(d){d.remove();return;}
    d=document.createElement("div");
    d.id="uh-tip";
    d.style.cssText="position:fixed;top:"+(t.bottom+6)+"px;right:"+(document.body.clientWidth-t.right)+"px;background:var(--bg-card);border:1px solid var(--card-border);border-radius:8px;padding:8px 12px;font-size:11px;color:var(--text-secondary);box-shadow:var(--shadow-lg);z-index:300;white-space:nowrap;";
    d.innerHTML="1k = 1,000 &nbsp;·&nbsp; 1M = 1,000,000 &nbsp;·&nbsp; 1亿 = 100,000,000";
    document.body.appendChild(d);
    setTimeout(function(){if(d.parentNode)d.remove();},3000);
  }
});})();

syncHanaTheme();
_dispCur = getDispCur();
new MutationObserver(function(ms){
  for(var i=0;i<ms.length;i++){
    if(ms[i].attributeName==="data-hana-theme"){syncHanaTheme();if(D)render();}
  }
}).observe(document.body,{attributes:true,attributeFilter:["data-hana-theme"]});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){
  var ht=document.body.getAttribute("data-hana-theme")||"warm-paper";
  if(ht==="inherit"||ht==="system"){syncHanaTheme();if(D)render();}
});
// ── 订阅余量自动刷新：轻量拉取，只更新余量仪表，不重建图表（后端 5 分钟缓存天然节流） ──
function refreshQuota() {
  if (!D) return;
  const qs = window.location.search;
  const sep = qs ? '&' : '?';
  var p = "range=" + R + ($("df") && $("df").value ? "&from=" + $("df").value : "") + ($("dt") && $("dt").value ? "&to=" + $("dt").value : "");
  trackerFetch("/data" + qs + sep + p)
    .then(function(r){ if(!r.ok) throw Error(r.statusText); return r.json(); })
    .then(function(d){
      if (!d || d.error || !D) return;
      var nq = d._subscriptionQuotas || [];
      var oq = D._subscriptionQuotas || [];
      if (JSON.stringify(nq) === JSON.stringify(oq)) return;
      D._subscriptionQuotas = nq;
      renderHdrQuota();
      renderSubscriptionQuotas();
    })
    .catch(function(){});
}
var quotaTimer=setInterval(function(){ refreshQuota(); }, 60000);
document.addEventListener("visibilitychange", function(){
  if (!document.hidden) refreshQuota();
});

$("copy-diagnostic").onclick=async function(){
  var text=$("diagnostic-text").textContent;
  try {
    var result=await window.TokenTrackerCopyDiagnostic(text);
    $("copy-result").textContent=result.ok?"已复制":result.reason==="permission_denied"?"未获剪贴板写入授权，请在插件权限入口授权。":"复制不可用，请选择上方摘要手动复制。";
  } catch { $("copy-result").textContent="复制不可用，请选择上方摘要手动复制。"; }
};
window.addEventListener("pagehide",function(){_closed=true;clearTimeout(_statusTimer);clearInterval(quotaTimer);});
syncDateInputs();
load(false);
pollStatus();
})();
