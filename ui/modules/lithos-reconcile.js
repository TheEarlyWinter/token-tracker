// ui/modules/lithos-reconcile.js — LithosAI 官方扣费 vs 本地估算对账模块
//
// 本模块将 LithosAI 官方扣费与本地价目表估算数据并排展示，直观呈现估算偏差与缺价模型。
// 遵循严谨的防御性编程与 Clean Code 规范，禁止使用外部框架，严格转义所有动态字符串。

/**
 * 字符串 HTML 安全转义
 * @param {*} str
 * @returns {string}
 */
export function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 渲染 null 占位符及原因提示
 * @param {string} reason
 * @returns {string}
 */
export function renderNull(reason = "无数据") {
  return `<span class="lr-null" title="${esc(reason)}">—</span>`;
}

/**
 * 美元金额格式化（两位小数，小于 0.01 且大于 0 显示 <$0.01）
 * 若为 null/undefined/非数值则返回 null（由调用方使用 renderNull 渲染为 "—" 并标注原因）
 * @param {number|null} usd
 * @returns {string|null}
 */
export function money(usd) {
  if (usd === null || usd === undefined) return null;
  const n = Number(usd);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "$0.00";
  if (n > 0 && n < 0.01) return "<$0.01";
  if (n < 0 && n > -0.01) return "-<$0.01";
  if (n < 0) return "-$" + Math.abs(n).toFixed(2);
  return "$" + n.toFixed(2);
}

/**
 * 差额金额格式化（带显式正负号，正数前缀 +）
 * @param {number|null} usd
 * @returns {string|null}
 */
export function moneyDelta(usd) {
  if (usd === null || usd === undefined) return null;
  const n = Number(usd);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "$0.00";
  if (n > 0 && n < 0.01) return "+<$0.01";
  if (n < 0 && n > -0.01) return "-<$0.01";
  if (n > 0) return "+$" + n.toFixed(2);
  return "-$" + Math.abs(n).toFixed(2);
}

/**
 * 偏差百分比格式化（保留一位小数，带显式正负号）
 * @param {number|null} pct
 * @returns {string|null}
 */
export function formatDeltaPct(pct) {
  if (pct === null || pct === undefined) return null;
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "0.0%";
  if (n > 0) return "+" + n.toFixed(1) + "%";
  return n.toFixed(1) + "%";
}

/**
 * Token 用量格式化（按 万 / 亿 智能缩写）
 * @param {number|null} n
 * @returns {string}
 */
export function fmtTokens(n) {
  if (n === null || n === undefined) return "0";
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e8) {
    const s = (abs / 1e8).toFixed(1).replace(/\.0$/, "");
    return sign + s + "亿";
  }
  if (abs >= 1e4) {
    const s = (abs / 1e4).toFixed(1).replace(/\.0$/, "");
    return sign + s + "万";
  }
  return sign + abs.toLocaleString();
}

/**
 * 每百万 Token 单价格式化（$/1M，保留 3~4 位有效小数）
 * @param {number|null} rate
 * @returns {string|null}
 */
export function formatRate(rate) {
  if (rate === null || rate === undefined) return null;
  const n = Number(rate);
  if (!Number.isFinite(n)) return null;
  return "$" + n.toFixed(3);
}

/**
 * 日期格式化：YYYY-MM-DD → MM月DD日
 * @param {string} day
 * @returns {string}
 */
export function shortDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return String(day || "");
  return `${m[2]}月${m[3]}日`;
}

/**
 * 模型名精简（去掉路径前缀，用于空间紧张的图例或副标签）
 * @param {string} id
 * @returns {string}
 */
export function shortModel(id) {
  const s = String(id || "unknown");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 差额数值对应的色彩样式类名
 * 差额为正标绿（估算偏高→我们在多算钱），为负标橙（估算偏低→我们在少算钱），0 为中性色
 * @param {number|null} delta
 * @returns {string}
 */
export function deltaClass(delta) {
  if (delta === null || delta === undefined || !Number.isFinite(Number(delta))) return "";
  const n = Number(delta);
  if (n > 0) return "lr-delta-pos";
  if (n < 0) return "lr-delta-neg";
  return "";
}

/**
 * 构建 LithosAI 对账面板控制器
 * @param {object} options
 * @param {HTMLElement} options.container - 容器元素
 * @param {Function} options.fetchFn - 数据请求方法
 * @param {Function} [options.getColors] - 图表与主题色彩提取函数
 * @param {Function} [options.getFilters] - 全局日期/模型过滤器读取函数
 * @returns {{ ensure: Function, reload: Function, destroy: Function }}
 */
export function createLithosReconcile({
  container,
  fetchFn,
  getColors = () => ({}),
  getFilters = () => ({}),
} = {}) {
  if (!container) return null;

  const state = {
    loading: false,
    loadedOnce: false,
    error: null,
    errorCode: null,
    data: null,
    chart: null,
    lastStart: "",
    lastEnd: "",
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

  /**
   * 拉取对账数据
   * @param {boolean} force - 是否强制刷新后端缓存
   */
  async function load(force = false) {
    if (state.loading) {
      queueLoad(force);
      return;
    }

    const filters = typeof getFilters === "function" ? getFilters() : {};
    const requestedFilterKey = dateFilterKey(filters);

    state.loading = true;
    state.error = null;
    state.errorCode = null;
    state.lastStart = filters.from || "";
    state.lastEnd = filters.to || "";
    render();

    try {
      const params = new URLSearchParams();
      if (force) params.set("force", "1");
      if (filters.from && filters.to) {
        params.set("start", filters.from);
        params.set("end", filters.to);
      }
      const q = params.toString() ? "?" + params.toString() : "";

      const res = await fetchFn("/lithos-reconcile" + q);
      let json = null;
      try {
        json = await res.json();
      } catch (parseErr) {
        throw new Error("接口返回无法解析的响应 (HTTP " + res.status + ")");
      }

      const filtersChanged =
        dateFilterKey(typeof getFilters === "function" ? getFilters() : {}) !== requestedFilterKey;
      if (filtersChanged && !state.pendingLoad) queueLoad(false);

      if (!filtersChanged && !state.pendingLoad) {
        if (!res.ok || json?.ok === false) {
          state.errorCode = json?.code || "request_failed";
          state.error = json?.message || "拉取对账数据失败 (HTTP " + res.status + ")";
          state.data = null;
        } else {
          state.data = json;
          state.error = null;
          state.errorCode = null;
        }
        state.loadedOnce = true;
      }
    } catch (e) {
      const filtersChanged =
        dateFilterKey(typeof getFilters === "function" ? getFilters() : {}) !== requestedFilterKey;
      if (filtersChanged && !state.pendingLoad) queueLoad(false);

      if (!filtersChanged && !state.pendingLoad) {
        state.error = e?.message || String(e);
        state.errorCode = "request_failed";
        state.data = null;
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

  /**
   * 渲染每日官方 vs 估算对比柱状图
   */
  function renderChart(data) {
    const canvas = container.querySelector("#lithos-reconcile-chart");
    if (!canvas || typeof Chart === "undefined") return;

    if (state.chart) {
      try {
        state.chart.destroy();
      } catch {}
      state.chart = null;
    }

    const days = data?.days || [];
    if (!days.length) return;

    const colors = (typeof getColors === "function" ? getColors() : {}) || {};
    const officialColor = colors.blue || colors.accent || "#007AFF";
    const estimateColor = colors.purple || "#5856D6";

    const labels = days.map((d) => shortDate(d.day));
    const officialData = days.map((d) => (d.officialUsd != null ? Number(d.officialUsd) : null));
    const estimateData = days.map((d) => (d.estimateUsd != null ? Number(d.estimateUsd) : null));

    state.chart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "官方扣费",
            data: officialData,
            backgroundColor: officialColor,
            borderRadius: 4,
            borderSkipped: false,
            barPercentage: 0.6,
            categoryPercentage: 0.7,
          },
          {
            label: "本地估算",
            data: estimateData,
            backgroundColor: estimateColor,
            borderRadius: 4,
            borderSkipped: false,
            barPercentage: 0.6,
            categoryPercentage: 0.7,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        color: colors.text || "rgba(29,29,31,0.7)",
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "top",
            align: "start",
            labels: {
              color: colors.text || "rgba(29,29,31,0.7)",
              boxWidth: 8,
              boxHeight: 8,
              font: { size: 12, weight: "500" },
              padding: 14,
              usePointStyle: true,
              pointStyle: "circle",
            },
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
              title: (items) => (items.length ? shortDate(days[items[0].dataIndex]?.day) + " · UTC" : ""),
              label: (ctx) => {
                const val = ctx.parsed.y;
                const d = days[ctx.dataIndex];
                if (ctx.datasetIndex === 1 && d.estimateUsd === null) {
                  return ` ${ctx.dataset.label}: — (未定价)`;
                }
                return ` ${ctx.dataset.label}: ${money(val) ?? "—"}`;
              },
              footer: (items) => {
                if (!items.length) return "";
                const d = days[items[0].dataIndex];
                if (!d) return "";
                const deltaStr = d.deltaUsd != null ? moneyDelta(d.deltaUsd) : "—";
                const pctStr = d.deltaPct != null ? ` (${formatDeltaPct(d.deltaPct)})` : "";
                return `差额: ${deltaStr}${pctStr}  |  Tokens: ${fmtTokens(d.tokens?.total)}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 },
          },
          y: {
            grid: { color: colors.grid || "rgba(0,0,0,0.06)" },
            ticks: {
              callback: (v) => "$" + Number(v).toFixed(2),
              font: { size: 11 },
            },
          },
        },
      },
    });
  }

  /**
   * 渲染完整面板 DOM
   */
  function render() {
    // 首次进入且加载中：渲染骨架屏
    if (state.loading && !state.loadedOnce) {
      container.innerHTML = `
        <div class="lr-wrap">
          <div class="lr-skeleton-head">
            <div class="lr-sk lr-sk-title"></div>
            <div class="lr-sk lr-sk-btn"></div>
          </div>
          <div class="lr-cards">
            <div class="lr-card lr-sk-card"><div class="lr-sk lr-sk-line-sm"></div><div class="lr-sk lr-sk-line-lg"></div></div>
            <div class="lr-card lr-sk-card"><div class="lr-sk lr-sk-line-sm"></div><div class="lr-sk lr-sk-line-lg"></div></div>
            <div class="lr-card lr-sk-card"><div class="lr-sk lr-sk-line-sm"></div><div class="lr-sk lr-sk-line-lg"></div></div>
            <div class="lr-card lr-sk-card"><div class="lr-sk lr-sk-line-sm"></div><div class="lr-sk lr-sk-line-lg"></div></div>
          </div>
          <div class="lr-empty">正在加载 LithosAI 对账明细…</div>
        </div>
      `;
      return;
    }

    // 错误状态渲染
    if (state.error && !state.data) {
      let title = "拿不到对账数据";
      let note = state.error;

      if (state.errorCode === "not_configured") {
        title = "还没配置 LithosAI";
        note = "请到设置里填写控制台 Cookie（__Host-console_session 与 __Host-console_csrf）。";
      } else if (state.errorCode === "session_expired") {
        title = "LithosAI 会话已过期";
        note = "控制台 Cookie 已失效，请在 LithosAI 重新登录并重新粘贴最新的 Cookie。";
      } else if (state.errorCode === "invalid_range") {
        title = "日期区间无效";
        note = state.error || "请检查查询起止日期范围是否合规。";
      }

      container.innerHTML = `
        <div class="lr-wrap">
          <div class="lr-head">
            <div class="lr-head-left">
              <span class="lr-title">对账</span>
            </div>
            <div class="lr-head-right">
              <button type="button" class="btn btn-outline lr-refresh">重试</button>
            </div>
          </div>
          <div class="lr-empty">
            <div class="lr-empty-title">${esc(title)}</div>
            <div class="lr-empty-note">${esc(note)}</div>
          </div>
        </div>
      `;
      const retryBtn = container.querySelector(".lr-refresh");
      if (retryBtn) retryBtn.onclick = () => load(true);
      return;
    }

    const data = state.data || {};
    const range = data.range || {};
    const totals = data.totals || {};
    const days = data.days || [];
    const models = data.models || [];
    const unmatched = data.unmatched || {};
    const notes = Array.isArray(data.notes) ? data.notes : [];

    // 区间文案处理
    let rangeText = "";
    if (range.start && range.end) {
      rangeText = `${shortDate(range.start)} – ${shortDate(range.end)} · UTC`;
    }

    // 更新时间文本
    let updatedText = "";
    if (state.loading) {
      updatedText = "刷新中…";
    } else if (data.updatedAt) {
      try {
        updatedText = "更新于 " + new Date(data.updatedAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch {
        updatedText = "";
      }
    }

    // ── 1. 四张 KPI 卡片计算 ──
    // 官方扣费
    const officialUsdStr = money(totals.officialUsd) ?? renderNull("无官方扣费");
    const officialSub = totals.tokens?.total != null
      ? `总用量 ${fmtTokens(totals.tokens.total)} tokens`
      : "官方控制台扣费合计";

    // 本地估算
    const estimateUsdStr = money(totals.estimateUsd) ?? renderNull("缺少价目表配置或无估算数据");
    const estimateSub = "按价目表规则重算";

    // 差额与偏差率
    let deltaDisplay = renderNull("缺少估算数据，无法计算差额");
    let deltaSub = "缺少估算数据";
    let deltaCss = "";
    if (totals.deltaUsd !== null && totals.deltaUsd !== undefined) {
      const dUsd = moneyDelta(totals.deltaUsd);
      const dPct = formatDeltaPct(totals.deltaPct);
      deltaDisplay = `${esc(dUsd)}${dPct ? ` <span class="lr-pct">(${esc(dPct)})</span>` : ""}`;
      deltaCss = deltaClass(totals.deltaUsd);
      if (Number(totals.deltaUsd) > 0) {
        deltaSub = "估算偏高（我们在多算钱）";
      } else if (Number(totals.deltaUsd) < 0) {
        deltaSub = "估算偏低（我们在少算钱）";
      } else {
        deltaSub = "估算与官方扣费完全一致";
      }
    }

    // 覆盖率
    const matched = Number(totals.matchedModels) || 0;
    const missingList = Array.isArray(totals.missingPriceModels) ? totals.missingPriceModels : [];
    const missingCount = missingList.length;
    const totalModels = matched + missingCount;
    const coveragePct = totalModels > 0 ? ((matched / totalModels) * 100).toFixed(1) + "%" : "—";
    let coverageSub = `<span class="lr-text-ok">全部模型已配置价格</span>`;
    if (missingCount > 0) {
      coverageSub = `<span class="lr-text-warn" title="${esc(missingList.join(', '))}">${missingCount} 个模型缺价</span>`;
    }

    // ── 2. 每日表格行 ──
    const dayRowsHtml = days.length
      ? days
          .map((d) => {
            const dOfficial = money(d.officialUsd) ?? renderNull("无扣费记录");
            const dEstimate = money(d.estimateUsd) ?? renderNull("未定价或无估算");
            const dDelta = d.deltaUsd != null ? moneyDelta(d.deltaUsd) : renderNull("未定价");
            const dDeltaPct = d.deltaPct != null ? formatDeltaPct(d.deltaPct) : renderNull("未定价");
            const rowDeltaClass = deltaClass(d.deltaUsd);

            // hover 气泡中展示 token 分项
            const tokIn = fmtTokens(d.tokens?.input);
            const tokCache = fmtTokens(d.tokens?.cacheRead);
            const tokOut = fmtTokens(d.tokens?.output);
            const tokTotal = fmtTokens(d.tokens?.total);
            const tokTitle = `输入: ${tokIn} | 缓存读取: ${tokCache} | 输出: ${tokOut}`;

            return `
              <tr>
                <td class="col-date" title="${esc(d.day)}">${esc(shortDate(d.day))}</td>
                <td class="col-num lr-strong">${dOfficial}</td>
                <td class="col-num">${dEstimate}</td>
                <td class="col-num lr-strong ${rowDeltaClass}">${dDelta}</td>
                <td class="col-num ${rowDeltaClass}">${dDeltaPct}</td>
                <td class="col-num" title="${esc(tokTitle)}">${tokTotal}</td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="6" class="lr-empty-row">当前区间没有每日对账记录</td></tr>`;

    // ── 3. 模型表格行 ──
    const modelRowsHtml = models.length
      ? models
          .map((m) => {
            const mOfficial = money(m.officialUsd) ?? renderNull("无官方扣费");
            const mEstimate = money(m.estimateUsd) ?? renderNull("未定价或无估算");
            const mDeltaPct = m.deltaPct != null ? formatDeltaPct(m.deltaPct) : renderNull("未定价");
            const rowDeltaClass = deltaClass(m.deltaUsd ?? m.deltaPct);

            const impliedRate = formatRate(m.impliedPerMUsd) ?? renderNull("官方未产生扣费或用量为0");
            const ourRate = formatRate(m.ourBlendedPerMUsd) ?? renderNull("价目表未定价");

            const tokIn = fmtTokens(m.tokens?.input);
            const tokCache = fmtTokens(m.tokens?.cacheRead);
            const tokOut = fmtTokens(m.tokens?.output);
            const tokTotal = fmtTokens(m.tokens?.total);
            const tokTitle = `输入: ${tokIn} | 缓存读取: ${tokCache} | 输出: ${tokOut}`;

            const isMissingPrice = m.status === "missing_price";
            const statusBadge = isMissingPrice
              ? `<span class="lr-badge lr-badge-warn" title="该模型尚未在本地价目表配置价格">缺价</span>`
              : `<span class="lr-badge lr-badge-ok">正常</span>`;

            return `
              <tr>
                <td class="col-model" title="${esc(m.modelId)}">
                  <span class="lr-model-name">${esc(m.modelId)}</span>
                </td>
                <td class="col-num lr-strong">${mOfficial}</td>
                <td class="col-num">${mEstimate}</td>
                <td class="col-num ${rowDeltaClass}">${mDeltaPct}</td>
                <td class="col-num" title="官方实测每百万 Token 综合单价">${impliedRate}</td>
                <td class="col-num" title="本地配置每百万 Token 综合单价">${ourRate}</td>
                <td class="col-num" title="${esc(tokTitle)}">${tokTotal}</td>
                <td class="col-status">${statusBadge}</td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="8" class="lr-empty-row">当前区间没有模型消费数据</td></tr>`;

    // ── 4. 未匹配区（官方有本地无 / 本地有官方无） ──
    const officialOnly = Array.isArray(unmatched.officialOnly) ? unmatched.officialOnly : [];
    const estimateOnly = Array.isArray(unmatched.estimateOnly) ? unmatched.estimateOnly : [];
    const hasUnmatched = officialOnly.length > 0 || estimateOnly.length > 0;

    let unmatchedSectionHtml = "";
    if (hasUnmatched) {
      const officialOnlyRows = officialOnly.length
        ? officialOnly
            .map((item) => `
              <tr>
                <td>${esc(shortDate(item.day))}</td>
                <td title="${esc(item.modelId)}">${esc(shortModel(item.modelId))}</td>
                <td class="col-num">${money(item.officialUsd) ?? renderNull("—")}</td>
                <td class="col-num">${fmtTokens(item.tokens?.total)}</td>
              </tr>
            `)
            .join("")
        : `<tr><td colspan="4" class="lr-empty-row-subtle">无记录</td></tr>`;

      const estimateOnlyRows = estimateOnly.length
        ? estimateOnly
            .map((item) => `
              <tr>
                <td>${esc(shortDate(item.day))}</td>
                <td title="${esc(item.modelId)}">${esc(shortModel(item.modelId))}</td>
                <td class="col-num">${fmtTokens(item.tokens?.total)}</td>
              </tr>
            `)
            .join("")
        : `<tr><td colspan="3" class="lr-empty-row-subtle">无记录</td></tr>`;

      unmatchedSectionHtml = `
        <div class="lr-unmatched-card">
          <div class="lr-card-title">未匹配记录</div>
          <div class="lr-unmatched-grid">
            <div class="lr-unmatched-block">
              <div class="lr-unmatched-header">
                <span class="lr-unmatched-name">官方有 · 本地无</span>
                <span class="lr-unmatched-count">${officialOnly.length} 项</span>
              </div>
              <div class="lr-unmatched-desc">官方记录里这些天/模型我们没有对应调用</div>
              <div class="lr-table-wrap">
                <table class="lr-table lr-table-sm">
                  <thead>
                    <tr><th>日期</th><th>模型</th><th class="col-num">官方扣费</th><th class="col-num">Tokens</th></tr>
                  </thead>
                  <tbody>${officialOnlyRows}</tbody>
                </table>
              </div>
            </div>

            <div class="lr-unmatched-block">
              <div class="lr-unmatched-header">
                <span class="lr-unmatched-name">本地有 · 官方无</span>
                <span class="lr-unmatched-count">${estimateOnly.length} 项</span>
              </div>
              <div class="lr-unmatched-desc">这些调用没走 LithosAI 结算</div>
              <div class="lr-table-wrap">
                <table class="lr-table lr-table-sm">
                  <thead>
                    <tr><th>日期</th><th>模型</th><th class="col-num">Tokens</th></tr>
                  </thead>
                  <tbody>${estimateOnlyRows}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // ── 5. 口径说明与底部注意事项 ──
    const notesHtml = notes.length
      ? `<ul class="lr-notes-list">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : "";
    const fixedNote = "官方只给总额，不给输入/输出分项，所以本页只能定位到模型×日，不能定位到 token 类型。";

    // 拼装整体 HTML
    container.innerHTML = `
      <div class="lr-wrap">
        <!-- 头部 -->
        <div class="lr-head">
          <div class="lr-head-left">
            <span class="lr-title">对账</span>
            ${rangeText ? `<span class="lr-sub">${esc(rangeText)}</span>` : ""}
          </div>
          <div class="lr-head-right">
            ${updatedText ? `<span class="lr-updated">${esc(updatedText)}</span>` : ""}
            <button type="button" class="btn btn-outline lr-refresh" ${state.loading ? "disabled" : ""}>
              ${state.loading ? "刷新中…" : "刷新"}
            </button>
          </div>
        </div>

        <!-- 四张 KPI 卡片 -->
        <div class="lr-cards">
          <div class="lr-card">
            <div class="lr-k">官方扣费</div>
            <div class="lr-v">${officialUsdStr}</div>
            <div class="lr-hint">${esc(officialSub)}</div>
          </div>
          <div class="lr-card">
            <div class="lr-k">本地估算</div>
            <div class="lr-v">${estimateUsdStr}</div>
            <div class="lr-hint">${esc(estimateSub)}</div>
          </div>
          <div class="lr-card">
            <div class="lr-k">估算差额</div>
            <div class="lr-v ${deltaCss}">${deltaDisplay}</div>
            <div class="lr-hint">${esc(deltaSub)}</div>
          </div>
          <div class="lr-card">
            <div class="lr-k">定价覆盖率</div>
            <div class="lr-v">${coveragePct}</div>
            <div class="lr-hint">${coverageSub}</div>
          </div>
        </div>

        <!-- 每日对比图表 -->
        <div class="lr-chart-card">
          <div class="lr-card-title">每日 官方 vs 估算</div>
          <div class="lr-chart-box"><canvas id="lithos-reconcile-chart"></canvas></div>
        </div>

        <!-- 每日表 -->
        <div class="lr-table-card">
          <div class="lr-card-title">每日明细</div>
          <div class="lr-table-wrap">
            <table class="lr-table">
              <thead>
                <tr>
                  <th class="col-date">日期</th>
                  <th class="col-num">官方</th>
                  <th class="col-num">估算</th>
                  <th class="col-num">差额</th>
                  <th class="col-num">偏差%</th>
                  <th class="col-num">Tokens</th>
                </tr>
              </thead>
              <tbody>${dayRowsHtml}</tbody>
            </table>
          </div>
        </div>

        <!-- 模型表 -->
        <div class="lr-table-card">
          <div class="lr-card-title">模型明细</div>
          <div class="lr-table-wrap">
            <table class="lr-table">
              <thead>
                <tr>
                  <th class="col-model">模型</th>
                  <th class="col-num">官方</th>
                  <th class="col-num">估算</th>
                  <th class="col-num">偏差%</th>
                  <th class="col-num">官方实测 $/1M</th>
                  <th class="col-num">我们 $/1M</th>
                  <th class="col-num">Tokens</th>
                  <th class="col-status">状态</th>
                </tr>
              </thead>
              <tbody>${modelRowsHtml}</tbody>
            </table>
          </div>
        </div>

        <!-- 未匹配区（两项皆空时不渲染） -->
        ${unmatchedSectionHtml}

        <!-- 口径说明 -->
        <div class="lr-notes-card">
          <div class="lr-notes-title">口径说明</div>
          ${notesHtml}
          <div class="lr-notes-fixed">${esc(fixedNote)}</div>
        </div>
      </div>
    `;

    // 绑定刷新事件
    const refreshBtn = container.querySelector(".lr-refresh");
    if (refreshBtn) {
      refreshBtn.onclick = () => load(true);
    }

    // 渲染图表
    renderChart(data);
  }

  /**
   * 确保数据加载（首次进入时懒加载）
   * @returns {Promise<void>}
   */
  function ensure() {
    const filters = typeof getFilters === "function" ? getFilters() : {};
    const dateChanged =
      (filters.from || "") !== state.lastStart || (filters.to || "") !== state.lastEnd;
    if (!state.loadedOnce || dateChanged) {
      return load(false);
    } else {
      render();
      return Promise.resolve();
    }
  }

  /**
   * 重新拉取对账数据
   * @param {object} [opts] - 刷新配置，例如 { force: true }
   */
  function reload(opts = {}) {
    const force = Boolean(opts?.force);
    return load(force);
  }

  /**
   * 销毁实例，清理事件与图表
   */
  function destroy() {
    if (state.chart) {
      try {
        state.chart.destroy();
      } catch {}
      state.chart = null;
    }
    state.data = null;
    state.loadedOnce = false;
  }

  // 初始化占位
  container.innerHTML = `<div class="lr-empty">准备对账数据…</div>`;

  return {
    ensure,
    reload,
    destroy,
  };
}

export default { createLithosReconcile };
