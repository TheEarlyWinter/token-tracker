// ui/modules/subscription-quotas.js — 订阅配额与额度余量视图模块

export const OG_LIMITS = { rolling: 12, weekly: 30, monthly: 60 };

export function fmtReset(sec) {
  if (!sec || sec <= 0) return "即将重置";
  if (sec < 60) return sec + "秒后重置";
  if (sec < 3600) return Math.floor(sec / 60) + "分后重置";
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m ? h + "时" + m + "分后重置" : h + "时后重置";
  }
  const d = Math.floor(sec / 86400);
  const h2 = Math.floor((sec % 86400) / 3600);
  return h2 ? d + "天" + h2 + "时后重置" : d + "天后重置";
}

export function fmtUsd(v8) {
  const d = (v8 || 0) / 1e8;
  if (d <= 0) return "$0";
  return "$" + d.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function fmtUsdShort(v8) {
  const d = (v8 || 0) / 1e8;
  if (d <= 0) return "$0";
  return d >= 0.01 ? "$" + d.toFixed(3) : "$" + d.toFixed(4);
}

export function fmtUsdDollar(v) {
  if (!(v > 0)) return "0";
  if (v < 1) return v.toFixed(6);
  return v.toFixed(2);
}

export function quotaColor(p) {
  if (p >= 80) return "var(--red)";
  if (p >= 60) return "var(--orange)";
  return "var(--green)";
}

export function renderHdrQuota({
  container,
  quotas = [],
  escHTML = s => String(s ?? ""),
  dual = v => "$" + Number(v ?? 0).toFixed(2),
} = {}) {
  if (!container) return;
  let og = null;
  for (let i = 0; i < quotas.length; i++) {
    if (quotas[i].type === "opencode-go-quota" || quotas[i].type === "opencode-go-quota-est") {
      og = quotas[i];
      break;
    }
  }
  if (!og || !og.windows || !og.windows.length) {
    container.style.display = "none";
    return;
  }
  container.style.display = "";
  const winNames = { rolling: "5小时", weekly: "本周", monthly: "本月" };
  let h = '<div class="hq-title">订阅余量</div><div class="hq-wins">';
  for (let w = 0; w < og.windows.length; w++) {
    const win = og.windows[w];
    let p = og.est
      ? (win.limitUsd > 0 ? Math.round(((win.usedUsd || 0) / win.limitUsd) * 100) : 0)
      : Math.min(100, Math.max(0, win.usedPercent || 0));
    p = Math.min(100, Math.max(0, p));
    const remainPct = 100 - p;
    const remainPctStr = remainPct % 1 === 0 ? remainPct.toFixed(0) : remainPct.toFixed(2);
    const limitUsd = og.est ? (win.limitUsd || 0) : (OG_LIMITS[win.level] || 0);
    const remainUsd = og.est
      ? Math.max(0, limitUsd - (win.usedUsd || 0))
      : Math.max(0, (limitUsd * (100 - p)) / 100);
    const c = quotaColor(p);
    const amtCls = p >= 80 ? " hq-urgent" : (p >= 60 ? " hq-warn" : "");
    const resetTxt = og.est ? "估算" : fmtReset(win.resetInSec);

    h += '<div class="hq-win"><span class="hq-wl">' + escHTML(winNames[win.level] || win.level) + '</span><b class="' + amtCls + '" style="color:' + c + '">' + dual(remainUsd) + '</b><div class="hq-track"><i style="width:' + p + '%;background:' + c + '"></i></div><i class="hq-note">剩余 ' + remainPctStr + '%<em class="hq-reset"><svg class="hq-hg" viewBox="0 0 12 16" aria-hidden="true"><path d="M2 1h8v2L6.5 8l3.5 5v2H2v-2l3.5-5L2 3V1z" fill="none" stroke="currentColor"/><path class="hg-sand-top" d="M3 2.1h6L6 7.5 3 2.1z" fill="currentColor"/><path class="hg-sand-bot" d="M6 8.5l3 5.4H3l3-5.4z" fill="currentColor" opacity=".45"/></svg>' + resetTxt + '</em></i></div>';
  }
  h += '</div>';
  container.innerHTML = h;
}

export function renderSubscriptionQuotas({
  container,
  quotas = [],
  priceTable = {},
  escHTML = s => String(s ?? ""),
  fmt = n => String(n ?? 0),
} = {}) {
  if (!container) return;
  let hasData = false;
  for (let i = 0; i < quotas.length; i++) {
    const qt = quotas[i].type || "";
    if (qt === "opencode-go-quota" || qt === "quota" || qt === "coding-plan-quota" || qt === "error" || qt === "no-token") {
      hasData = true;
      break;
    }
  }
  if (!hasData) {
    container.style.display = "none";
    return;
  }

  let h = '<div class="subq-wrap"><div class="subq-title">订阅余量</div>';
  for (let i = 0; i < quotas.length; i++) {
    const q = quotas[i];
    const label = q.label || q.provider || "";
    const isOg = q.type === "opencode-go-quota" || q.type === "opencode-go-quota-est";
    const srcBadge = isOg ? (q.est ? '<span class="subq-src est">本地估算</span>' : '<span class="subq-src">官方</span>') : '';
    h += '<div class="subq-card"><div class="subq-hdr"><span class="subq-prov">' + escHTML(label) + '</span>' + srcBadge + '</div>';

    if (isOg && q.windows && q.windows.length) {
      let uh = '';
      const ogUsageSrc = q.monthlyModelUsage || [];
      if (ogUsageSrc && ogUsageSrc.length) {
        const allowRows = [];
        for (let oai = 0; oai < ogUsageSrc.length; oai++) {
          const oms = ogUsageSrc[oai];
          const ope = priceTable["opencode-go/" + oms.model] || {};
          const allow = ope.monthlyAllowance || 0;
          if (!allow) continue;
          const usedAmt = oms.costUsd || 0;
          const usedPct = Math.min(100, Math.max(0, (usedAmt / allow) * 100));
          allowRows.push({ model: oms.model, allow, used: usedAmt, pct: usedPct, count: oms.count || 0 });
        }
        if (allowRows.length) {
          const scopeTag = q.modelCostScope === 'all-keys' ? ' · 全部 KEY' : '';
          uh += '<div class="og-usage"><div class="og-cost-title">模型月额度<span class="og-title-total">套餐月限 $60' + scopeTag + '</span></div>';
          for (let oai2 = 0; oai2 < allowRows.length; oai2++) {
            const ar = allowRows[oai2];
            const ac = quotaColor(ar.pct);
            uh += '<div class="og-usage-row og-mrow"><span class="og-u-model">' + escHTML(ar.model) + '</span><span class="og-u-tok">已用 $' + fmtUsdDollar(ar.used) + ' / $' + ar.allow + '</span><span class="og-u-pct" style="color:' + ac + '">' + ar.pct.toFixed(1) + '%</span></div>';
          }
          uh += '</div>';
        }
      }

      if (q.keySummary && q.keySummary.length) {
        let ogCallsTmp = 0;
        for (let kt0 = 0; kt0 < q.keySummary.length; kt0++) { ogCallsTmp += (q.keySummary[kt0].count || 0); }
        uh += '<div class="og-usage"><div class="og-cost-title">Key 汇总<span class="og-title-total">' + fmt(ogCallsTmp) + ' 次</span></div><div class="ogk-grid">';
        let ksCalls = 0;
        for (let ki0 = 0; ki0 < q.keySummary.length; ki0++) { ksCalls += (q.keySummary[ki0].count || 0); }
        for (let ki = 0; ki < q.keySummary.length; ki++) {
          const ks = q.keySummary[ki];
          const kname = (ks.name || ks.keyId || "");
          let kShort = kname.split(" - ").pop();
          if (kShort.length > 22) kShort = kShort.slice(0, 20) + "…";
          const kpct = ksCalls > 0 ? Math.round(((ks.count || 0) / ksCalls) * 100) : 0;
          uh += '<div class="ogk-card"><div class="ogk-hdr"><span class="ogk-name">' + escHTML(kShort) + '</span><span class="ogk-pct">' + kpct + '%</span></div>';
          uh += '<div class="ogk-sub">' + fmt(ks.count || 0) + ' 次</div>';
          uh += '<div class="ogk-bar"><div class="ogk-bar-fill" style="width:' + kpct + '%"></div></div>';

          if (ks.models && ks.models.length) {
            let kmTotal = 0;
            for (let kmt = 0; kmt < ks.models.length; kmt++) { kmTotal += (ks.models[kmt].count || 0); }
            uh += '<div class="ogk-models">';
            for (let kmi = 0; kmi < ks.models.length; kmi++) {
              const km = ks.models[kmi];
              const kmpct = kmTotal > 0 ? Math.round(((km.count || 0) / kmTotal) * 100) : 0;
              uh += '<div class="ogk-mrow"><span class="ogk-mname">' + escHTML(km.model) + '</span><span class="ogk-mbar"><i style="width:' + kmpct + '%"></i></span><span class="ogk-mcnt">' + fmt(km.count || 0) + ' 次</span></div>';
            }
            uh += '</div>';
          }
          uh += '</div>';
        }
        uh += '</div></div>';
      }
      h += uh;
    } else if (q.type === "quota" && q.models && q.models.length) {
      for (let w = 0; w < q.models.length; w++) {
        const m = q.models[w];
        const mp = (m.limit && m.limit > 0) ? Math.min(100, Math.max(0, ((m.used || 0) / m.limit) * 100)) : 0;
        const mc = quotaColor(mp);
        h += '<div class="subq-row"><div class="subq-lbl">' + escHTML(m.label || m.model || ("模型" + w)) + '</div>' +
          '<div class="subq-bar"><div class="subq-bar-fill" style="width:' + mp + '%;background:' + mc + '"></div></div>' +
          '<div class="subq-pct" style="color:' + mc + '">已用 ' + mp.toFixed(0) + '%</div></div>';
      }
    } else if (q.type === "coding-plan-quota" && q.windows && q.windows.length) {
      for (let w = 0; w < q.windows.length; w++) {
        const win = q.windows[w];
        const p = Math.min(100, Math.max(0, win.usedPercent || 0));
        const c = quotaColor(p);
        h += '<div class="subq-row"><div class="subq-lbl">' + escHTML(win.level || "窗口") + '</div>' +
          '<div class="subq-bar"><div class="subq-bar-fill" style="width:' + p + '%;background:' + c + '"></div></div>' +
          '<div class="subq-pct" style="color:' + c + '">已用 ' + p + '%</div></div>';
      }
    } else if (q.type === "error" || q.type === "no-token") {
      h += '<div class="subq-err">' + escHTML(q.display || "未配置") + '</div>';
    } else if (q.display) {
      h += '<div class="subq-err">' + escHTML(q.display) + '</div>';
    }
    h += '</div>';
  }
  h += '</div>';
  container.innerHTML = h;
  container.style.display = "";
}
