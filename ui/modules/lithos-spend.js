// ui/modules/lithos-spend.js — LithosAI 本月消费（控制台口径）
//
// 数据来自 /lithos-spend（引擎侧转成按天 × 模型的金额），余额另取 /lithos-balance。
// 口径说明必须写在界面上：控制台按 **UTC** 切日、按 **纳美元** 记账，
// 与看板其它地方的本地时区 / 估算费用不是一回事，混着看会差一天、差几个点。
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return "低于 $0.01";
  return "$" + n.toFixed(2);
}

function moneyFine(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return "<$0.01";
  return "$" + n.toFixed(2);
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

function shortDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return String(day || "");
  return `${Number(m[2])}月${Number(m[3])}日`;
}

// 模型名去掉供应商前缀（deepseek-ai/DeepSeek-V4.1-Flash → DeepSeek-V4.1-Flash），
// 图例上放得下；完整名留在表格里。
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

export function createLithosSpend({
  container,
  fetchFn,
  getColors = () => ({}),
  getFilters = () => ({}),
  onClearModel,
} = {}) {
  if (!container) return null;

  const state = {
    loading: false,
    error: null,
    spend: null,
    balance: null,
    chart: null,
    loadedOnce: false,
    lastFrom: "",
    lastTo: "",
    pendingLoad: null,
  };

  function dateFilterKey(filters) {
    return `${filters?.from || ""}|${filters?.to || ""}`;
  }

  function queueLoad(force) {
    state.pendingLoad = {
      force: Boolean(force) || Boolean(state.pendingLoad?.force),
    };
  }

  async function load(force = false) {
    if (state.loading) {
      queueLoad(force);
      return;
    }
    const filters = typeof getFilters === "function" ? getFilters() : {};
    const requestedFilterKey = dateFilterKey(filters);
    state.loading = true;
    state.error = null;
    state.lastFrom = filters.from || "";
    state.lastTo = filters.to || "";
    render();
    try {
      const params = new URLSearchParams();
      if (force) params.set("refresh", "1");
      if (filters.from && filters.to) {
        params.set("start", filters.from);
        params.set("end", filters.to);
      }
      const q = params.toString() ? "?" + params.toString() : "";
      const bq = force ? "?refresh=1" : "";
      const [spendRes, balanceRes] = await Promise.all([
        fetchFn("/lithos-spend" + q),
        fetchFn("/lithos-balance" + bq),
      ]);
      const spend = await spendRes.json();
      const balance = await balanceRes.json();
      const filtersChanged = dateFilterKey(typeof getFilters === "function" ? getFilters() : {}) !== requestedFilterKey;
      if (filtersChanged && !state.pendingLoad) queueLoad(false);
      if (!filtersChanged && !state.pendingLoad) {
        if (!spendRes.ok) throw new Error(spend?.message || spend?.error || "HTTP " + spendRes.status);
        if (!balanceRes.ok) throw new Error(balance?.message || balance?.error || "HTTP " + balanceRes.status);
        if (!spend || (spend.ok === false && !spend.reason)) throw new Error(spend?.message || "消费数据无法识别");
        state.spend = spend;
        state.balance = balance;
        state.error = spend?.connected === false ? spend?.message || "拿不到消费数据" : null;
        state.loadedOnce = true;
      }
    } catch (e) {
      const filtersChanged = dateFilterKey(typeof getFilters === "function" ? getFilters() : {}) !== requestedFilterKey;
      if (filtersChanged && !state.pendingLoad) queueLoad(false);
      if (!filtersChanged && !state.pendingLoad) {
        state.error = e?.message || String(e);
        state.spend = null;
        state.balance = null;
        state.loadedOnce = true;
      }
    } finally {
      state.loading = false;
      const pending = state.pendingLoad;
      state.pendingLoad = null;
      if (pending) {
        void load(pending.force);
      } else {
        render();
      }
    }
  }

  function modelDatasets(days, models, colors) {
    const palette = colors.lithos && colors.lithos.length
      ? colors.lithos
      : ["#2f6fb3", "#4a9d7f", "#c58a3c", "#8b6bb1", "#b5544c", "#5f8fa8", "#a1743f", "#6f7f8f"];
    return models.map((m, i) => ({
      label: shortModel(m.modelId),
      data: days.map((d) => Number((d.byModel || {})[m.modelId] || 0)),
      backgroundColor: palette[i % palette.length],
      borderRadius: 4,
      borderSkipped: false,
      barPercentage: 0.7,
      categoryPercentage: 0.8,
    }));
  }

  function renderChart(spend, chartModels) {
    const canvas = container.querySelector("#lithos-spend-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (state.chart) { try { state.chart.destroy(); } catch {} state.chart = null; }
    const colors = getColors() || {};
    const days = spend.days || [];
    const models = (chartModels || []).slice(0, 8); // 图例最多 8 个，再多就不适合看了
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
              // 控制台自己也标 UTC，这里保持一致，别让人以为是本地日期
              title: (items) => (items.length ? shortDate(days[items[0].dataIndex]?.day) + " UTC" : ""),
              label: (ctx) => ` ${ctx.dataset.label}  ${moneyFine(ctx.parsed.y)}`,
              footer: (items) => {
                if (!items.length) return "";
                const d = days[items[0].dataIndex];
                return "合计 " + moneyFine(d?.usd || 0);
              },
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 } },
          y: {
            stacked: true,
            grid: { color: colors.grid },
            ticks: { callback: (v) => "$" + Number(v).toFixed(2), font: { size: 11 } },
          },
        },
      },
    });
  }

  function render() {
    const spend = state.spend;
    const balance = state.balance;

    if (state.loading && !state.loadedOnce) {
      container.innerHTML = `<div class="ls-empty">正在读 Lithos 控制台的消费记录…</div>`;
      return;
    }

    if (state.error && !spend?.connected) {
      const notConfigured = spend?.reason === "not_configured";
      container.innerHTML = `
        <div class="ls-empty">
          <div class="ls-empty-title">${notConfigured ? "还没配置 LithosAI" : "拿不到 Lithos 消费数据"}</div>
          <div class="ls-empty-note">${esc(notConfigured ? "到设置里粘贴控制台 Cookie（__Host-console_session 与 __Host-console_csrf 两个都要）。" : state.error)}</div>
        </div>
      `;
      return;
    }

    const filters = typeof getFilters === "function" ? getFilters() : {};
    const selModel = (filters.model || "").trim();

    const allModels = spend?.models || [];
    const models = selModel
      ? allModels.filter((m) => matchModel(m.modelId, selModel))
      : allModels;

    const days = spend?.days || [];
    const total = selModel
      ? models.reduce((sum, m) => sum + (Number(m.usd) || 0), 0)
      : (spend?.totalUsd || 0);
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayRecord = days.find((day) => day.day === todayKey);
    const today = todayRecord
      ? (selModel ? models.reduce((sum, m) => sum + (Number((todayRecord.byModel || {})[m.modelId]) || 0), 0) : (todayRecord.usd || 0))
      : 0;
    const avg = days.length ? total / days.length : 0;
    const ranged = spend?.start && spend?.end ? `${shortDate(spend.start)} – ${shortDate(spend.end)} UTC` : "";
    const balanceText = balance?.connected ? balance.display : "—";

    const rowsHtml = models.length
      ? models
          .map((m) => {
            const cachedShare = m.inputTokens > 0 ? (m.cachedTokens / m.inputTokens) * 100 : null;
            return `
              <tr>
                <td class="col-model"><span class="model-name">${esc(m.modelId)}</span></td>
                <td class="col-num ls-strong">${esc(money(m.usd))}</td>
                <td class="col-num">${(m.share * 100).toFixed(1)}%</td>
                <td class="col-num">${fmtTokens(m.inputTokens)}</td>
                <td class="col-num">${fmtTokens(m.cachedTokens)}${cachedShare == null ? "" : ` <span class="ls-dim">${cachedShare.toFixed(0)}%</span>`}</td>
                <td class="col-num">${fmtTokens(m.outputTokens)}</td>
                <td class="col-num">${m.days || 0}</td>
              </tr>`;
          })
          .join("")
      : `<tr><td colspan="7" class="ls-empty-row">${selModel ? "该模型在当前区间没有消费记录" : "这个区间没有消费记录"}</td></tr>`;

    container.innerHTML = `
      <div class="ls-wrap">
        <div class="ls-head">
          <div class="ls-head-left">
            <span class="ls-title">LithosAI 消费</span>
            <span class="ls-sub">${esc(ranged)}</span>
            ${selModel ? `<span class="ls-filter-badge">已筛选模型: ${esc(shortModel(selModel))} <button type="button" class="ls-filter-clear" title="清除模型筛选">✕</button></span>` : ""}
          </div>
          <div class="ls-head-right">
            <span class="ls-updated">${state.loading ? "刷新中…" : spend?.updatedAt ? "更新于 " + new Date(spend.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
            <button type="button" class="btn btn-outline ls-refresh">刷新</button>
          </div>
        </div>

        <div class="ls-cards">
          <div class="ls-card"><div class="ls-k">区间合计</div><div class="ls-v">${esc(money(total))}</div><div class="ls-hint">${days.length} 天有记录</div></div>
          <div class="ls-card"><div class="ls-k">今日（UTC）</div><div class="ls-v">${esc(money(today))}</div><div class="ls-hint">${esc(shortDate(todayKey))}</div></div>
          <div class="ls-card"><div class="ls-k">日均</div><div class="ls-v">${esc(money(avg))}</div><div class="ls-hint">按有消费的天数平摊</div></div>
          <div class="ls-card"><div class="ls-k">预付余额</div><div class="ls-v">${esc(balanceText)}</div><div class="ls-hint">${balance?.connected ? esc(balance.organization?.name || "") : esc(balance?.message || "")}</div></div>
        </div>

        <div class="ls-chart-card">
          <div class="ct">每日消费 · 按模型</div>
          <div class="ls-chart-box"><canvas id="lithos-spend-chart"></canvas></div>
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
                  <th class="col-num">缓存命中</th>
                  <th class="col-num">输出</th>
                  <th class="col-num">天数</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          <div class="ls-note">
            这些数字来自 Lithos 控制台（按 UTC 切日、按纳美元记账），是**官方扣费**；
            看板其它地方的「估算费用」是按价格表算的，两者对不上是正常的。
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
    renderChart(spend, models);
  }

  // 首次进入这个 tab 才拉数据：没配置的人不该因为切页签就吃一次失败
  function ensure() {
    const filters = typeof getFilters === "function" ? getFilters() : {};
    const dateChanged = (filters.from || "") !== state.lastFrom || (filters.to || "") !== state.lastTo;
    if (!state.loadedOnce || dateChanged) {
      load(false);
    } else {
      render();
    }
  }

  container.innerHTML = `<div class="ls-empty">正在准备 Lithos 消费视图…</div>`;
  return {
    ensure,
    reloadWithFilters: () => {
      const filters = typeof getFilters === "function" ? getFilters() : {};
      const dateChanged = (filters.from || "") !== state.lastFrom || (filters.to || "") !== state.lastTo;
      if (dateChanged) {
        load(false);
      } else {
        render();
      }
    },
    reload: (force = true) => load(force),
    destroy: () => {
      if (state.chart) { try { state.chart.destroy(); } catch {} state.chart = null; }
    },
  };
}

export default { createLithosSpend };
