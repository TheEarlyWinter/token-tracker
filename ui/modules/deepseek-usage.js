// ui/modules/deepseek-usage.js — DeepSeek 官方用量（消费明细）
//
// 数据来自 /deepseek-usage，它背后是平台的内部接口（by_api_key/amount + by_api_key/cost）。
// 凭证是**网页登录令牌**，不是 API Key——这两者互不通用，贴错了会稳定 40003。
// 所以空状态里就把这件事写明白，并把输入框直接放在这个页签里：
// 需要它的地方就在这里，不必再让人绕去设置。
//
// 口径同样要写在界面上：平台按本机时区切日、金额是人民币（含峰谷计价），
// 与看板别处的「估算费用」不是一回事。
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(cny) {
  const n = Number(cny);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "¥0.00";
  if (Math.abs(n) < 0.01) return "低于 ¥0.01";
  return "¥" + n.toFixed(2);
}

function moneyFine(cny) {
  const n = Number(cny);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "¥0.00";
  if (Math.abs(n) < 0.01) return "<¥0.01";
  return "¥" + n.toFixed(2);
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

function pct(rate) {
  if (rate == null || !Number.isFinite(Number(rate))) return "—";
  return (Number(rate) * 100).toFixed(1) + "%";
}

function shortDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return String(day || "");
  return `${Number(m[2])}月${Number(m[3])}日`;
}

// 平台返回的模型名本来就是 deepseek-v4-flash 这种，没有供应商前缀，
// 但保不齐哪天加上，所以还是按 / 切一下再上legend。
function shortModel(id) {
  const s = String(id || "unknown");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function matchModel(targetModel, selectedModel) {
  if (!selectedModel) return true;
  if (!targetModel) return false;
  if (targetModel === selectedModel) return true;
  const normSelected = selectedModel.includes("/") ? selectedModel.split("/").slice(1).join("/") : selectedModel;
  const normTarget = targetModel.includes("/") ? targetModel.split("/").slice(1).join("/") : targetModel;
  if (normSelected === normTarget) return true;
  const leafSelected = selectedModel.split("/").pop();
  const leafTarget = targetModel.split("/").pop();
  if (leafSelected === leafTarget) return true;
  return false;
}

// 平台只有按月接口，所以区间只能是「几个月」，不能切成 7 天这样的跨度。
const RANGES = [
  { key: "month", label: "本月" },
  { key: "last", label: "上月" },
  { key: "q3", label: "近 3 个月" },
];

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function naturalRange(key, now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  if (key === "last") {
    return { key, from: dateKey(new Date(year, month - 1, 1)), to: dateKey(new Date(year, month, 0)) };
  }
  if (key === "q3") {
    return { key, from: dateKey(new Date(year, month - 2, 1)), to: dateKey(now) };
  }
  return { key: key || "month", from: dateKey(new Date(year, month, 1)), to: dateKey(now) };
}

export function createDeepSeekUsage({
  container,
  fetchFn,
  getColors = () => ({}),
  getFilters = () => ({}),
  onClearModel,
  onSelectRange,
} = {}) {
  if (!container) return null;

  const state = {
    range: "month",
    loading: false,
    error: null,
    data: null,
    chart: null,
    loadedOnce: false,
    saving: false,
    saveError: null,
    lastFrom: "",
    lastTo: "",
    pendingLoad: null,
  };

  function dateFilterKey(filters) {
    return `${filters?.from || ""}|${filters?.to || ""}`;
  }

  function queueLoad(force, range) {
    state.pendingLoad = {
      force: Boolean(force) || Boolean(state.pendingLoad?.force),
      range: range || state.range,
    };
  }

  async function load(force = false, range = state.range) {
    if (state.loading) {
      queueLoad(force, range);
      return;
    }
    const filters = typeof getFilters === "function" ? getFilters() : {};
    const explicitRangeSelection = range && typeof range === "object";
    const selectedRange = explicitRangeSelection ? range : naturalRange(range || state.range);
    state.range = selectedRange.key;
    const requestedFilterKey = dateFilterKey(filters);
    const requestFrom = !explicitRangeSelection && filters.from && filters.to ? filters.from : selectedRange.from;
    const requestTo = !explicitRangeSelection && filters.from && filters.to ? filters.to : selectedRange.to;
    state.loading = true;
    state.error = null;
    state.lastFrom = filters.from || "";
    state.lastTo = filters.to || "";
    render();
    try {
      const params = new URLSearchParams();
      if (force) params.set("refresh", "1");
      if (requestFrom && requestTo) {
        params.set("start", requestFrom);
        params.set("end", requestTo);
      } else if (selectedRange.key) {
        params.set("range", selectedRange.key);
      }
      const res = await fetchFn("/deepseek-usage?" + params.toString());
      const data = await res.json();
      const filtersChanged = dateFilterKey(typeof getFilters === "function" ? getFilters() : {}) !== requestedFilterKey;
      if (filtersChanged && !state.pendingLoad) queueLoad(false, state.range);
      if (!filtersChanged && !state.pendingLoad) {
        if (!res.ok) {
          state.error = data?.message || data?.error || "HTTP " + res.status;
          state.data = null;
        } else {
          state.data = data || null;
          state.error = data?.connected === false ? data?.message || "拿不到官方用量" : null;
        }
        state.loadedOnce = true;
      }
    } catch (e) {
      const filtersChanged = dateFilterKey(typeof getFilters === "function" ? getFilters() : {}) !== requestedFilterKey;
      if (filtersChanged && !state.pendingLoad) queueLoad(false, state.range);
      if (!filtersChanged && !state.pendingLoad) {
        state.error = e?.message || String(e);
        state.data = null;
        state.loadedOnce = true;
      }
    } finally {
      state.loading = false;
      const pending = state.pendingLoad;
      state.pendingLoad = null;
      if (pending) {
        void load(pending.force, pending.range);
      } else {
        render();
      }
    }
  }

  async function saveToken(token) {
    if (state.saving) return;
    state.saving = true;
    state.saveError = null;
    render();
    try {
      const res = await fetchFn("/deepseek-usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.ok === false) {
        state.saveError = data?.message || data?.summary?.message || `保存失败（HTTP ${res.status}）`;
        state.saving = false;
        render();
        return;
      }
      state.saving = false;
      await load(true);
    } catch (e) {
      state.saving = false;
      state.saveError = e?.message || String(e);
      render();
    }
  }

  function modelDatasets(days, models, colors) {
    const palette =
      colors.deepseek && colors.deepseek.length
        ? colors.deepseek
        : ["#4d6bfe", "#7c93ff", "#2f9e7b", "#c58a3c", "#8b6bb1", "#b5544c", "#5f8fa8", "#6f7f8f"];
    return models.map((m, i) => ({
      label: shortModel(m.model),
      data: days.map((d) => Number(d?.byModel?.[m.model]?.cost || 0)),
      backgroundColor: palette[i % palette.length],
      borderRadius: 4,
      borderSkipped: false,
      barPercentage: 0.7,
      categoryPercentage: 0.8,
    }));
  }

  function renderChart(data, chartModels) {
    const canvas = container.querySelector("#ds-usage-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (state.chart) {
      try {
        state.chart.destroy();
      } catch {}
      state.chart = null;
    }
    const colors = getColors() || {};
    const days = data.days || [];
    const models = (chartModels || []).slice(0, 8);
    const labels = days.map((d) => shortDate(d.day));

    state.chart = new Chart(canvas, {
      type: "bar",
      data: { labels, datasets: modelDatasets(days, models, colors) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        color: colors.text,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "top",
            align: "start",
            labels: { color: colors.text, boxWidth: 8, boxHeight: 8, font: { size: 12, weight: "500" }, padding: 14, usePointStyle: true, pointStyle: "circle" },
          },
          tooltip: {
            backgroundColor: "rgba(24,24,27,0.92)",
            titleFont: { size: 12, weight: "600" },
            bodyFont: { size: 12 },
            padding: 10,
            cornerRadius: 8,
            boxPadding: 4,
            usePointStyle: true,
            callbacks: {
              title: (items) => (items.length ? shortDate(days[items[0].dataIndex]?.day) : ""),
              label: (ctx) => ` ${ctx.dataset.label}  ${moneyFine(ctx.parsed.y)}`,
              footer: (items) => {
                if (!items.length) return "";
                const d = days[items[0].dataIndex];
                return "合计 " + moneyFine(d?.cost || 0);
              },
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 } },
          y: {
            stacked: true,
            grid: { color: colors.grid },
            ticks: { callback: (v) => "¥" + Number(v).toFixed(2), font: { size: 11 } },
          },
        },
      },
    });
  }

  function renderTokenForm({ expired = false } = {}) {
    const err = state.saveError || (expired ? state.error : "");
    return `
      <div class="ls-empty">
        <div class="ls-empty-title">${expired ? "平台令牌失效了" : "还没配置 DeepSeek 平台令牌"}</div>
        <div class="ls-empty-note">
          ${esc(
            expired
              ? "重新登录 platform.deepseek.com，再取一次 userToken 贴进来。"
              : "用量接口不吃 API Key（sk- 开头的那种），要的是网页登录令牌："
          )}
        </div>
        ${
          expired
            ? ""
            : `<div class="ls-empty-steps">
                 <div>1. 浏览器登录 platform.deepseek.com</div>
                 <div>2. F12 → Application → Local Storage → <code>userToken</code></div>
                 <div>3. 复制整串值贴到下面</div>
               </div>`
        }
        <div class="ls-token-form">
          <input type="password" class="set-input" id="ds-usage-token" placeholder="粘贴 userToken" autocomplete="off">
          <button type="button" class="btn btn-outline" id="ds-usage-save" ${state.saving ? "disabled" : ""}>${state.saving ? "验证中…" : "保存并验证"}</button>
        </div>
        ${err ? `<div class="ls-token-error">${esc(err)}</div>` : ""}
      </div>
    `;
  }

  function bindTokenForm() {
    const input = container.querySelector("#ds-usage-token");
    const btn = container.querySelector("#ds-usage-save");
    if (!btn) return;
    const submit = () => {
      const token = (input?.value || "").trim();
      if (!token) {
        state.saveError = "先把令牌贴进来";
        render();
        return;
      }
      saveToken(token);
    };
    btn.onclick = submit;
    if (input) {
      input.onkeydown = (e) => {
        if (e?.key === "Enter") submit();
      };
    }
  }

  function render() {
    const data = state.data;
    const notConfigured = data?.connected === false && data?.reason === "not_configured";
    const expired = data?.connected === false && data?.reason === "unauthorized";

    if ((state.loading && !state.loadedOnce) || (!state.loadedOnce && !data && !state.error)) {
      container.innerHTML = `<div class="ls-empty">正在读 DeepSeek 官方用量…</div>`;
      return;
    }

    if (notConfigured || expired) {
      container.innerHTML = renderTokenForm({ expired });
      bindTokenForm();
      return;
    }

    if (state.error && !data?.connected) {
      container.innerHTML = `
        <div class="ls-empty">
          <div class="ls-empty-title">拿不到 DeepSeek 官方用量</div>
          <div class="ls-empty-note">${esc(state.error)}</div>
          <div class="ls-token-form"><button type="button" class="btn btn-outline" id="ds-usage-retry">重新取一次</button></div>
        </div>
      `;
      const retry = container.querySelector("#ds-usage-retry");
      if (retry) retry.onclick = () => load(true);
      return;
    }

    const filters = typeof getFilters === "function" ? getFilters() : {};
    const selModel = (filters.model || "").trim();
    const from = filters.from || "";
    const to = filters.to || "";

    // Client-side date slicing: filter days by from/to
    let rawDays = data?.days || [];
    if (from || to) {
      rawDays = rawDays.filter((d) => (!from || d.day >= from) && (!to || d.day <= to));
    }
    const days = rawDays;

    // Filter models and aggregate for sliced days
    let models = [];
    if (from || to) {
      const modelMap = new Map();
      for (const d of days) {
        for (const [mName, mData] of Object.entries(d.byModel || {})) {
          if (selModel && !matchModel(mName, selModel)) continue;
          const cur = modelMap.get(mName) || {
            model: mName,
            cost: 0,
            hitTokens: 0,
            missTokens: 0,
            outputTokens: 0,
            tokens: 0,
            requests: 0,
            days: new Set(),
          };
          cur.cost += mData.costRaw ?? mData.cost ?? 0;
          cur.tokens += mData.tokens || 0;
          cur.hitTokens += mData.hitTokens || 0;
          cur.missTokens += mData.missTokens || 0;
          cur.outputTokens += mData.outputTokens || 0;
          cur.requests += mData.requests || 0;
          cur.days.add(d.day);
          modelMap.set(mName, cur);
        }
      }
      const totalCost = [...modelMap.values()].reduce((sum, m) => sum + m.cost, 0);
      models = [...modelMap.values()]
        .map((m) => ({
          model: m.model,
          cost: Number(m.cost.toFixed(4)),
          costDisplay: `¥${m.cost.toFixed(2)}`,
          hitTokens: m.hitTokens,
          missTokens: m.missTokens,
          outputTokens: m.outputTokens,
          tokens: m.tokens,
          requests: m.requests,
          hitRate: m.hitTokens + m.missTokens > 0 ? m.hitTokens / (m.hitTokens + m.missTokens) : null,
          days: m.days.size,
          share: totalCost > 0 ? m.cost / totalCost : 0,
        }))
        .filter((m) => m.tokens > 0 || m.cost > 0 || m.requests > 0)
        .sort((a, b) => b.cost - a.cost);
    } else {
      const allModels = data?.models || [];
      models = selModel
        ? allModels.filter((m) => matchModel(m.model, selModel))
        : allModels;
    }

    const total = models.reduce((sum, m) => sum + (Number(m.cost) || 0), 0);
    const totalTokens = models.reduce(
      (sum, m) => sum + (Number(m.hitTokens || 0) + Number(m.missTokens || 0) + Number(m.outputTokens || 0)),
      0
    );
    const totalHit = models.reduce((sum, m) => sum + Number(m.hitTokens || 0), 0);
    const totalMiss = models.reduce((sum, m) => sum + Number(m.missTokens || 0), 0);
    const hitRate = totalHit + totalMiss > 0 ? totalHit / (totalHit + totalMiss) : null;

    const isSingleDay = from && to && from === to;
    const todayKey = dateKey(new Date());
    const metricDay = isSingleDay ? from : todayKey;
    const todayRecord = days.find((day) => day.day === metricDay);
    const todayCost = todayRecord
      ? models.reduce((sum, m) => sum + (Number(todayRecord.byModel?.[m.model]?.cost) || 0), 0)
      : 0;

    const balance = data?.balance;
    const ranged = (from && to)
      ? (from === to ? from : `${from} – ${to}`)
      : (data?.start && data?.end
          ? (data.start === data.end ? data.start : `${data.start} – ${data.end}`)
          : ((data?.months || []).length
              ? (data.months.length === 1 ? data.months[0] : `${data.months[0]} – ${data.months[data.months.length - 1]}`)
              : ""));
    const activeRangeKey = (from || to) ? "" : (data?.range || state.range);
    const rangeLabel = RANGES.find((r) => r.key === activeRangeKey)?.label || "";

    const rowsHtml = models.length
      ? models
          .map(
            (m) => `
              <tr>
                <td class="col-model"><span class="model-name">${esc(m.model)}</span></td>
                <td class="col-num ls-strong">${esc(money(m.cost))}</td>
                <td class="col-num">${(m.share * 100).toFixed(1)}%</td>
                <td class="col-num">${fmtTokens(m.hitTokens + m.missTokens)} <span class="ls-dim">命中 ${pct(m.hitRate)}</span></td>
                <td class="col-num">${fmtTokens(m.outputTokens)}</td>
                <td class="col-num">${m.requests || 0}</td>
                <td class="col-num">${m.days || 0}</td>
              </tr>`
          )
          .join("")
      : `<tr><td colspan="7" class="ls-empty-row">${selModel ? "该模型在当前区间没有用量记录" : "这个区间没有用量记录"}</td></tr>`;

    container.innerHTML = `
      <div class="ls-wrap">
        <div class="ls-head">
          <div class="ls-head-left">
            <span class="ls-title">DeepSeek 官方用量</span>
            <span class="ls-sub">${esc(ranged)}${rangeLabel ? " · " + esc(rangeLabel) : ""}</span>
            ${selModel ? `<span class="ls-filter-badge">已筛选模型: ${esc(shortModel(selModel))} <button type="button" class="ls-filter-clear" title="清除模型筛选">✕</button></span>` : ""}
          </div>
          <div class="ls-head-right">
            <div class="ds-range">${RANGES.map(
              (r) => `<button type="button" class="ds-range-btn${r.key === activeRangeKey ? " on" : ""}" data-range="${r.key}">${r.label}</button>`
            ).join("")}</div>
            <span class="ls-updated">${state.loading ? "刷新中…" : data?.updatedAt ? "更新于 " + new Date(data.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
            <button type="button" class="btn btn-outline ls-refresh">刷新</button>
          </div>
        </div>

        <div class="ls-cards">
          <div class="ls-card"><div class="ls-k">区间消费</div><div class="ls-v">${esc(money(total))}</div><div class="ls-hint">${days.length} 天有记录</div></div>
          <div class="ls-card"><div class="ls-k">${isSingleDay ? "当日" : "今日"}</div><div class="ls-v">${esc(money(todayCost))}</div><div class="ls-hint">${esc(shortDate(metricDay))}</div></div>
          <div class="ls-card"><div class="ls-k">区间 Token</div><div class="ls-v">${fmtTokens(totalTokens)}</div><div class="ls-hint">缓存命中 ${pct(hitRate)}</div></div>
          <div class="ls-card"><div class="ls-k">官方余额</div><div class="ls-v">${esc(balance?.connected ? balance.balanceDisplay || "—" : "—")}</div><div class="ls-hint">${esc(balance?.connected ? `可用约 ${fmtTokens(balance.tokenEstimation || 0)} tokens` : balance?.message || "")}</div></div>
        </div>

        <div class="ls-chart-card">
          <div class="ct">每日消费 · 按模型</div>
          <div class="ls-chart-box"><canvas id="ds-usage-chart"></canvas></div>
        </div>

        <div class="ls-table-card">
          <div class="ct">按模型</div>
          <div class="ls-table-wrap">
            <table class="ls-table">
              <thead>
                <tr>
                  <th class="col-model">模型</th>
                  <th class="col-num">消费</th>
                  <th class="col-num">占比</th>
                  <th class="col-num">输入</th>
                  <th class="col-num">输出</th>
                  <th class="col-num">请求</th>
                  <th class="col-num">天数</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          <div class="ls-note">
            这些是开放平台的**官方账单**（人民币、含峰谷计价、按平台自己的月份切分）；
            看板别处的「估算费用」是按价格表在本地算的，两者对不上是正常的。
            平台只提供按月接口，所以这里的时间粒度是天，但区间只能按月选。
          </div>
        </div>
      </div>
    `;

    const btn = container.querySelector(".ls-refresh");
    if (btn) btn.onclick = () => load(true);
    const clearBtn = container.querySelector(".ls-filter-clear");
    if (clearBtn && typeof onClearModel === "function") {
      clearBtn.onclick = () => onClearModel();
    }
    for (const chip of container.querySelectorAll("[data-range]")) {
      chip.onclick = () => {
        const selected = naturalRange(chip.getAttribute("data-range"));
        if (typeof onSelectRange === "function") {
          onSelectRange(selected);
          return;
        }
        state.lastFrom = "";
        state.lastTo = "";
        load(true, selected);
      };
    }
    renderChart({ days }, models);
  }

  container.innerHTML = `<div class="ls-empty">正在准备 DeepSeek 官方用量视图…</div>`;
  return {
    ensure: () => {
      const filters = typeof getFilters === "function" ? getFilters() : {};
      const from = filters.from || "";
      const to = filters.to || "";
      if (!state.loadedOnce && !state.loading) {
        load(false);
      } else if (from !== state.lastFrom || to !== state.lastTo) {
        load(false);
      } else {
        render();
      }
    },
    reloadWithFilters: () => {
      const filters = typeof getFilters === "function" ? getFilters() : {};
      const from = filters.from || "";
      const to = filters.to || "";
      if (from !== state.lastFrom || to !== state.lastTo) {
        load(false);
      } else {
        render();
      }
    },
    reload: (force = true) => load(force),
    destroy: () => {
      if (state.chart) {
        try {
          state.chart.destroy();
        } catch {}
        state.chart = null;
      }
    },
  };
}

export default { createDeepSeekUsage };
