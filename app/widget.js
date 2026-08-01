// widget.js — 实时模型调用监控 (Apple Minimalist)
(function(){
"use strict";

function es(s){ return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmt(n){ if(!n||n===0) return "0"; if(n>=1e8) return (n/1e8).toFixed(1)+"亿"; if(n>=1e6) return (n/1e6).toFixed(1)+"M"; if(n>=1e3) return (n/1e3).toFixed(1)+"k"; return Number(n).toLocaleString(); }
function fmtCost(n){ if(!n||n===0) return "¥0"; var v=Number(n); if(v<0.01) return v.toFixed(6).replace(/0+$/,"").replace(/\.$/,""); if(v<1) return "¥"+v.toFixed(4); return "¥"+v.toFixed(4).replace(/\.?0+$/,""); }
function timeAgo(ts){ if(!ts) return ""; var s=Math.floor((Date.now()-ts)/1000); if(s<10) return "刚刚"; if(s<60) return s+"秒前"; return Math.floor(s/60)+"分钟前"; }
function fmtDur(s){ if(!s||s<0) return "0秒"; var m=Math.floor(s/60),h=Math.floor(m/60); s=s%60; m=m%60; if(h) return h+"时"+m+"分"+s+"秒"; if(m) return m+"分"+s+"秒"; return s+"秒"; }

var app = document.getElementById("app");
var R = 28, C = 2 * Math.PI * R;
function ringHtml(pct){
  var dash = Math.max(0, Math.min(C, C * (pct / 100)));
  return '<svg viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="'+R+'"/><circle class="fg" cx="32" cy="32" r="'+R+'" stroke-dasharray="'+C+'" stroke-dashoffset="'+(C-dash)+'"/></svg>';
}

function renderQuotas(data){
  var qs=data.quotas||[];
  var go=null;
  for(var i=0;i<qs.length;i++){if(qs[i].type==="opencode-go-quota"){go=qs[i];break;}}
  if(!go)return "";
  if(go.type==="error"||go.type==="no-token")return '<div class="sec"><div class="st">OpenCode Go</div><div class="bl-row"><span class="bl-l">'+es(go.label||"OpenCode Go")+'</span><span class="bl-v">'+es(go.display||"未配置")+'</span></div></div>';
  if(!go.windows||!go.windows.length)return "";
  var names={rolling:"5小时",weekly:"本周",monthly:"本月"};
  var h='<div class="sec"><div class="st">OpenCode Go 余量</div>';
  for(var w=0;w<go.windows.length;w++){
    var win=go.windows[w];
    var p=Math.min(100,Math.max(0,win.usedPercent||0));
    var remain=(100-p).toFixed(0);
    var color=p>=75?"var(--red)":(p>=50?"var(--orange)":"var(--green)");
    h+='<div class="tk-row"><span class="l">'+es(names[win.level]||win.level)+'</span><span class="r" style="color:'+color+'">已用 '+p+'% · 剩 '+remain+'%</span></div>';
  }
  h+='</div>';
  return h;
}

function render(data){
  if(!data){ app.innerHTML='<div class="loading">翻阅档案…</div>'; return; }

  var hasActive = data.sessionTotalTokens > 0 || (data.agentId && data.agentId !== null);
  var today = data.today;

  if(!hasActive && today){
    renderToday(data, today);
    return;
  }

  var cp = parseFloat(data.contextPercent) || 0;
  var cpShow = cp > 100 ? "99+" : cp.toFixed(0);

  var balHtml = "";
  if(data.balances && data.balances.length){
    var b = data.balances[0];
    var warn = b.type==="money" && b.total<=10;
    balHtml = '<div class="sec"><div class="st">余额</div><div class="bl-row'+(warn?" warn":"")+'"><span class="bl-l">'+es(b.label||"余额")+'</span><span class="bl-v">'+es(b.display||"")+'</span></div></div>';
  }
  var quotaHtml = renderQuotas(data);

  var mi = '<div class="sec"><div class="st">当前模型</div><div class="mi-grid">'+
    '<span class="mi-lbl">Agent</span><span class="mi-val">'+es(data.agentName)+'</span>'+
    '<span class="mi-lbl">模型</span><span class="mi-val">'+es(data.model)+'</span>'+
    '<span class="mi-lbl">供应商</span><span class="mi-val">'+es(data.provider)+'</span>'+
    '</div></div>';

  var segInput = Math.max(0, data.sessionInput - (data.sessionReasoning||0));
  var totalSeg = data.sessionTotalTokens || 1;
  var pIn = (segInput/totalSeg*100).toFixed(0);
  var pOut = ((data.sessionOutput||0)/totalSeg*100).toFixed(0);
  var pRsn = ((data.sessionReasoning||0)/totalSeg*100).toFixed(0);
  var pCache = ((data.sessionCacheRead||0)/totalSeg*100).toFixed(0);

  var ctxHtml = '<div class="sec"><div class="st">上下文窗口 <span>'+fmt(data.contextTokens)+' / '+fmt(data.contextWindow)+'</span></div>'+
    '<div class="gauge-wrap"><div class="gauge">'+ringHtml(cp)+'<div class="ct">'+cpShow+'%<span>使用率</span></div></div></div>'+
    '<div class="tk-row"><span class="l">缓存命中率</span><span class="r">本次 '+data.lastHitRate+'% 会话 '+data.sessionHitRate+'%</span></div>'+
    '</div>';

  var tkHtml = '<div class="sec"><div class="st">Token 明细 <span>总计 '+fmt(data.sessionTotalTokens)+'</span></div>'+
    '<div class="tk-strip"><div class="seg" style="flex:'+pIn+';background:var(--seg-input)" title="输入"></div><div class="seg" style="flex:'+pRsn+';background:var(--seg-reason)" title="推理"></div><div class="seg" style="flex:'+pOut+';background:var(--seg-output)" title="输出"></div><div class="seg" style="flex:'+pCache+';background:var(--seg-cache)" title="缓存"></div></div>'+
    '<div class="tk-row"><span class="l">输入</span><span class="r">'+fmt(data.sessionInput)+'</span></div>'+
    '<div class="tk-row"><span class="l">推理</span><span class="r">'+fmt(data.sessionReasoning||0)+'</span></div>'+
    '<div class="tk-row"><span class="l">输出</span><span class="r">'+fmt(data.sessionOutput)+'</span></div>'+
    '<div class="tk-row"><span class="l">缓存命中</span><span class="r">'+fmt(data.sessionCacheRead)+'</span></div>'+
    '</div>';

  var mtHtml = '<div class="sec"><div class="st">运行指标</div><div class="mt-row">'+
    '<div class="mt"><div class="mt-v">'+fmtDur(data.elapsed)+'</div><div class="mt-l">耗时</div></div>'+
    '<div class="mt"><div class="mt-v">'+fmt(data.totalRequests)+'</div><div class="mt-l">请求数</div></div>'+
    '<div class="mt"><div class="mt-v">'+fmt(data.sessionTotalTokens)+'</div><div class="mt-l">会话Tokens</div></div>'+
    '</div></div>';

  var lastHtml = '<div class="sec"><div class="st">本次调用</div><div class="sc-row">'+
    '<div class="sc"><div class="sc-v">'+fmt(data.lastTotalTokens)+'</div><div class="sc-l">Tokens</div></div>'+
    '<div class="sc"><div class="sc-v">'+fmt(data.lastCacheRead)+'</div><div class="sc-l">缓存命中</div></div>'+
    '<div class="sc"><div class="sc-v">'+fmtCost(data.lastCost)+'</div><div class="sc-l">费用</div></div>'+
    '</div></div>';

  app.innerHTML = mi + tkHtml + ctxHtml + mtHtml + lastHtml + balHtml + quotaHtml + '<div class="update">'+timeAgo(data.updatedAt)+'</div>';
}

function renderToday(data, today){
  var balHtml = "";
  if(data.balances && data.balances.length){
    var b = data.balances[0];
    var warn = b.type==="money" && b.total<=10;
    balHtml = '<div class="sec"><div class="st">余额</div><div class="bl-row'+(warn?" warn":"")+'"><span class="bl-l">'+es(b.label||"余额")+'</span><span class="bl-v">'+es(b.display||"")+'</span></div></div>';
  }
  var quotaHtml = renderQuotas(data);

  var totalSeg = today.totalTokens || 1;
  var pIn = ((today.input||0)/totalSeg*100).toFixed(0);
  var pOut = ((today.output||0)/totalSeg*100).toFixed(0);
  var pCache = ((today.cacheRead||0)/totalSeg*100).toFixed(0);
  var hitRate = today.totalTokens > 0 ? ((today.cacheRead/today.totalTokens)*100).toFixed(1) : "0.0";

  var sumHtml = '<div class="sec"><div class="st">今日汇总</div><div class="mi-grid">'+
    '<span class="mi-lbl">Agents</span><span class="mi-val">'+(data.todayAgentCount||0)+'</span>'+
    '<span class="mi-lbl">请求数</span><span class="mi-val">'+fmt(today.assistantCount)+'</span>'+
    '<span class="mi-lbl">缓存命中率</span><span class="mi-val">'+hitRate+'%</span>'+
    '</div></div>';

  var tkHtml = '<div class="sec"><div class="st">Token 明细 <span>总计 '+fmt(today.totalTokens)+'</span></div>'+
    '<div class="tk-strip"><div class="seg" style="flex:'+pIn+';background:var(--seg-input)" title="输入"></div><div class="seg" style="flex:'+pOut+';background:var(--seg-output)" title="输出"></div><div class="seg" style="flex:'+pCache+';background:var(--seg-cache)" title="缓存"></div></div>'+
    '<div class="tk-row"><span class="l">输入</span><span class="r">'+fmt(today.input)+'</span></div>'+
    '<div class="tk-row"><span class="l">输出</span><span class="r">'+fmt(today.output)+'</span></div>'+
    '<div class="tk-row"><span class="l">缓存命中</span><span class="r">'+fmt(today.cacheRead)+'</span></div>'+
    '</div>';

  app.innerHTML = sumHtml + tkHtml + balHtml + quotaHtml + '<div class="update">'+timeAgo(data.updatedAt)+'</div>';
}

var base = window.location.pathname.replace(/\/widget\/?$/, "") || "/api/plugins/token-tracker";
var esUrl = base + "/widget/stream" + (window.location.search||"");
var evtSource;

function connectSSE() {
  if(evtSource) evtSource.close();
  evtSource = new EventSource(esUrl);
  evtSource.onmessage = function(e){
    try {
      var d = JSON.parse(e.data);
      if(d.type==="usage" && d.data) render(d.data);
    } catch(err){}
  };
  evtSource.onerror = function(){
    evtSource.close();
    evtSource = null;
    setTimeout(connectSSE, 1000);
  };
}

fetch(base + "/widget/data" + (window.location.search||""))
  .then(function(r){ return r.json(); })
  .then(function(d){ if(d && !d.error) render(d); })
  .catch(function(){});

connectSSE();

try { parent.postMessage({source:"hana-plugin",type:"ready"},"*"); } catch(e){}
})();
