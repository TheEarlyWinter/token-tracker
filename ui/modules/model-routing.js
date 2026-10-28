// ui/modules/model-routing.js — 模型路由与上游切流检测分析视图

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return v.toLocaleString("zh-CN");
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

function formatTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${m}-${day} ${h}:${min}:${s}`;
  } catch {
    return String(iso);
  }
}

function shortModel(id) {
  const s = String(id || "unknown");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

export function createModelRouting({
  container,
  fetchFn = globalThis.fetch,
  getFilters = () => ({}),
  onClearModel = null,
} = {}) {
  const state = {
    loading: false,
    error: null,
    data: null,
    loadedOnce: false,
    page: 0,
    pageSize: 50,
    status: "all", // "all" | "routed" | "normal"
    lastFilterKey: "",
    requestSeq: 0,
    activeRequest: null,
  };

  function currentFilters() {
    return typeof getFilters === "function" ? (getFilters() || {}) : {};
  }

  function filterKey(f) {
    return [
      f.agent || "",
      f.model || "",
      f.provider || "",
      f.range || "",
      f.from || "",
      f.to || "",
      state.status,
    ].join("::");
  }

  function pageCount() {
    const total = Number(state.data?.total ?? state.data?.routes?.length ?? 0);
    return Math.max(1, Math.ceil((Number.isFinite(total) ? total : 0) / state.pageSize));
  }

  function isCurrent(request) {
    return state.activeRequest?.seq === request.seq;
  }

  function loadData(force = false) {
    if (!container) return;
    const filters = currentFilters();
    const key = filterKey(filters);
    const page = state.page;
    if (
      state.activeRequest
      && state.activeRequest.filterKey === key
      && state.activeRequest.page === page
      && (!force || state.activeRequest.force)
    ) {
      return state.activeRequest.promise;
    }

    const request = {
      seq: ++state.requestSeq,
      filterKey: key,
      page,
      force,
      promise: null,
    };
    state.activeRequest = request;
    state.lastFilterKey = key;
    state.loading = true;
    state.error = null;
    render();

    const promise = (async () => {
      try {
        const params = new URLSearchParams();
        if (force) params.set("force", "true");
        if (filters.range) params.set("range", filters.range);
        if (filters.from && filters.to) {
          params.set("from", filters.from);
          params.set("to", filters.to);
        }
        if (filters.agent) params.set("agent", filters.agent);
        if (filters.model) params.set("model", filters.model);
        if (filters.provider) params.set("provider", filters.provider);
        if (state.status && state.status !== "all") {
          params.set("status", state.status);
        }
        params.set("limit", String(state.pageSize));
        params.set("offset", String(page * state.pageSize));

        const res = await fetchFn("/model-routing?" + params.toString());
        if (!res.ok) {
          throw new Error("HTTP " + res.status + " " + res.statusText);
        }
        const data = await res.json();
        if (!data || data.ok === false) {
          throw new Error(data?.error || "获取模型路由数据失败");
        }
        if (!isCurrent(request)) return;

        const total = Number(data.total ?? data.routes?.length ?? 0);
        const lastPage = Math.max(0, Math.ceil((Number.isFinite(total) ? total : 0) / state.pageSize) - 1);
        state.data = data;
        state.loadedOnce = true;
        if (state.page > lastPage) {
          state.page = lastPage;
          state.activeRequest = null;
          loadData(force);
          return;
        }
      } catch (err) {
        if (!isCurrent(request)) return;
        state.error = err?.message || String(err);
      } finally {
        if (!isCurrent(request)) return;
        state.loading = false;
        state.activeRequest = null;
        render();
      }
    })();
    request.promise = promise;
    return promise;
  }

  function render() {
    if (!container) return;

    if (state.loading && !state.loadedOnce) {
      container.innerHTML = `
        <div class="ls-wrap">
          <div class="ls-head">
            <div class="ls-head-left">
              <span class="ls-title">模型路由与切流检测</span>
              <span class="ls-sub">正在检索模型标识差异记录…</span>
            </div>
          </div>
          <div class="ls-card" style="text-align:center;padding:36px;color:var(--text-tertiary)">正在加载路由数据…</div>
        </div>
      `;
      return;
    }

    if (state.error && !state.loadedOnce) {
      container.innerHTML = `
        <div class="ls-wrap">
          <div class="ls-head">
            <div class="ls-head-left">
              <span class="ls-title">模型路由与切流检测</span>
              <span class="ls-sub">加载失败</span>
            </div>
            <div class="ls-head-right">
              <button type="button" class="btn btn-outline mr-retry-btn">重试</button>
            </div>
          </div>
          <div class="ls-card is-error" style="padding:16px;color:var(--red,#ef4444)">${esc(state.error)}</div>
        </div>
      `;
      bindEvents();
      return;
    }

    const filters = typeof getFilters === "function" ? getFilters() : {};
    const summary = state.data?.summary || {
      totalCalls: 0,
      normalCount: 0,
      routedCount: 0,
      totalRouted: 0,
      routeRate: 0,
      totalTokens: 0,
      routedTokens: 0,
      topPairs: [],
    };
    const totalCalls = summary.totalCalls ?? summary.totalRouted ?? 0;
    const normalCount = summary.normalCount ?? Math.max(0, totalCalls - (summary.routedCount ?? 0));
    const routedCount = summary.routedCount ?? summary.totalRouted ?? 0;
    const routeRate = typeof summary.routeRate === "number" ? summary.routeRate : (totalCalls > 0 ? (routedCount / totalCalls) * 100 : 0);
    const totalTokens = summary.totalTokens || 0;
    const routedTokens = summary.routedTokens || 0;
    const topPairs = summary.topPairs || [];
    const routes = state.data?.routes || [];
    const totalRecords = state.data?.total ?? routes.length;
    const totalPages = Math.ceil(totalRecords / state.pageSize) || 1;
    const errorHtml = state.error
      ? `
        <div class="ls-card is-error mr-error" style="padding:12px 16px;color:var(--red,#ef4444)">
          <strong>加载失败：</strong>${esc(state.error)}
          <span>当前保留上次成功数据，数据可能已过期。</span>
          <button type="button" class="btn btn-outline mr-retry-btn" style="margin-left:8px">重试</button>
        </div>
      `
      : "";

    // Filter badges
    const filterBadges = [];
    if (filters.agent) {
      filterBadges.push(`<span class="ls-filter-badge">Agent: ${esc(filters.agent)}</span>`);
    }
    if (filters.provider) {
      filterBadges.push(`<span class="ls-filter-badge">供应商: ${esc(filters.provider)}</span>`);
    }
    if (filters.model) {
      filterBadges.push(
        `<span class="ls-filter-badge">已筛选模型: ${esc(shortModel(filters.model))} <button type="button" class="ls-filter-clear mr-clear-model" title="清除模型筛选">✕</button></span>`
      );
    }

    // Top pairs table HTML
    let topPairsHtml = "";
    if (topPairs.length > 0) {
      topPairsHtml = `
        <div class="ls-table-card">
          <div class="ct">Top 替身重定向模式（仅表示上游返回标识不同）</div>
          <div class="ls-table-wrap">
            <table class="ls-table">
              <thead>
                <tr>
                  <th class="col-prov">供应商</th>
                  <th class="col-model">目标配置模型 (Request)</th>
                  <th style="width:24px;text-align:center"></th>
                  <th class="col-model">返回模型标识 (Response)</th>
                  <th class="col-num">切流次数</th>
                  <th class="col-num">消耗 Token</th>
                  <th class="col-num">占比</th>
                </tr>
              </thead>
              <tbody>
                ${topPairs
                  .map((p) => {
                    const share = routedCount > 0 ? (p.count / routedCount) * 100 : 0;
                    return `
                      <tr>
                        <td class="col-prov">${esc(p.provider || "—")}</td>
                        <td class="col-model"><span class="mr-target-model">${esc(p.requestedModel)}</span></td>
                        <td style="text-align:center"><span class="mr-arrow">➔</span></td>
                        <td class="col-model"><span class="mr-pill">${esc(p.responseModel)}</span></td>
                        <td class="col-num ls-strong">${fmtNum(p.count)}</td>
                        <td class="col-num">${fmtTokens(p.tokens)}</td>
                        <td class="col-num">${share.toFixed(1)}%</td>
                      </tr>
                    `;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    // Routes list HTML
    let routesListHtml = "";
    if (routes.length > 0) {
      routesListHtml = `
        <div class="ls-table-card">
          <div class="mr-table-header">
            <div class="ct" style="margin:0">对话逐次路由详细日志</div>
            <div class="mr-status-group">
              <button type="button" class="mr-status-btn ${state.status === 'all' ? 'active' : ''}" data-status="all">全部 (${fmtNum(totalCalls)})</button>
              <button type="button" class="mr-status-btn ${state.status === 'routed' ? 'active' : ''}" data-status="routed">仅切流 (${fmtNum(routedCount)})</button>
              <button type="button" class="mr-status-btn ${state.status === 'normal' ? 'active' : ''}" data-status="normal">仅直通 (${fmtNum(normalCount)})</button>
            </div>
          </div>
          <div class="ls-table-wrap">
            <table class="ls-table">
              <thead>
                <tr>
                  <th class="col-time">触发时间</th>
                  <th style="width:70px">状态</th>
                  <th class="col-agent">Agent</th>
                  <th class="col-prov">供应商</th>
                  <th class="col-model">目标模型 ➔ 返回标识</th>
                  <th class="col-num">未命中 / 缓存读</th>
                  <th class="col-num">输出</th>
                  <th class="col-num">总 Token</th>
                  <th class="col-sess">来源会话</th>
                </tr>
              </thead>
              <tbody>
                ${routes
                  .map((r) => {
                    const u = r.tokens || {};
                    const isRouted = Boolean(r.isRouted);
                    return `
                      <tr>
                        <td class="col-time">${esc(formatTime(r.at))}</td>
                        <td>
                          ${
                            isRouted
                              ? `<span class="mr-badge mr-badge-routed">切流</span>`
                              : `<span class="mr-badge mr-badge-normal">直通</span>`
                          }
                        </td>
                        <td class="col-agent"><span class="agent-tag">${esc(r.agent || "default")}</span></td>
                        <td class="col-prov">${esc(r.provider || "—")}</td>
                        <td class="col-model">
                          ${
                            isRouted
                              ? `<span class="mr-target-model">${esc(r.requestedModel)}</span>
                                 <span class="mr-arrow">➔</span>
                                 <span class="mr-pill">${esc(r.responseModel)}</span>`
                              : `<span class="mr-normal-model">${esc(r.requestedModel)}</span>`
                          }
                        </td>
                        <td class="col-num">${fmtNum(u.input)} <span class="ls-dim">/ ${fmtNum(u.cacheRead)}</span></td>
                        <td class="col-num">${fmtNum(u.output)}</td>
                        <td class="col-num ls-strong">${fmtTokens(u.total)}</td>
                        <td class="col-sess"><span class="mr-session-id" title="${esc(r.sessionId || "")}">${esc(r.sessionId ? r.sessionId.slice(-12) : "—")}</span></td>
                      </tr>
                    `;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
          <div class="mr-paging-bar">
            <span>共 ${fmtNum(totalRecords)} 条记录 · 第 ${state.page + 1} / ${totalPages} 页</span>
            <button type="button" class="btn btn-sm mr-prev-btn" ${state.page === 0 ? "disabled" : ""}>上一页</button>
            <button type="button" class="btn btn-sm mr-next-btn" ${state.page >= totalPages - 1 ? "disabled" : ""}>下一页</button>
          </div>
        </div>
      `;
    } else {
      routesListHtml = `
        <div class="ls-table-card">
          <div class="mr-table-header">
            <div class="ct" style="margin:0">对话逐次路由详细日志</div>
            <div class="mr-status-group">
              <button type="button" class="mr-status-btn ${state.status === 'all' ? 'active' : ''}" data-status="all">全部 (${fmtNum(totalCalls)})</button>
              <button type="button" class="mr-status-btn ${state.status === 'routed' ? 'active' : ''}" data-status="routed">仅切流 (${fmtNum(routedCount)})</button>
              <button type="button" class="mr-status-btn ${state.status === 'normal' ? 'active' : ''}" data-status="normal">仅直通 (${fmtNum(normalCount)})</button>
            </div>
          </div>
          <div style="text-align:center;padding:48px 16px;color:var(--text-tertiary)">
            <div style="font-size:14px;font-weight:500;color:var(--text-secondary);margin-bottom:6px">当前筛选下无匹配记录</div>
            <div style="font-size:12px">尝试切换上方状态过滤或调整顶栏筛选范围。</div>
          </div>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="ls-wrap">
        <div class="ls-head">
          <div class="ls-head-left">
            <span class="ls-title">模型路由与切流检测</span>
            <span class="ls-sub">实时监控所有对话调用上游返回的模型标识是否不同</span>
            ${filterBadges.join("")}
          </div>
          <div class="ls-head-right">
            <span class="ls-updated">${state.loading ? "正在加载…" : "实时收录中"}</span>
            <button type="button" class="btn btn-outline mr-refresh-btn">全面扫描历史</button>
          </div>
        </div>

        ${errorHtml}

        <div class="ls-cards">
          <div class="ls-card">
            <div class="ls-k">总请求调用</div>
            <div class="ls-v">${fmtNum(totalCalls)}</div>
            <div class="ls-hint">消耗 ${fmtTokens(totalTokens)} Token</div>
          </div>
          <div class="ls-card">
            <div class="ls-k">正常直通请求</div>
            <div class="ls-v" style="color:var(--text-primary)">${fmtNum(normalCount)}</div>
            <div class="ls-hint">原样返回目标模型</div>
          </div>
          <div class="ls-card">
            <div class="ls-k">替身切流请求</div>
            <div class="ls-v" style="${routedCount > 0 ? 'color:var(--orange,#ea580c)' : ''}">${fmtNum(routedCount)}</div>
            <div class="ls-hint">标识差异消耗 ${fmtTokens(routedTokens)} Token</div>
          </div>
          <div class="ls-card">
            <div class="ls-k">上游切流率</div>
            <div class="ls-v" style="${routedCount > 0 ? 'color:var(--orange,#ea580c)' : ''}">${routeRate.toFixed(1)}%</div>
            <div class="ls-hint">展示前 ${topPairs.length} 种模式</div>
          </div>
        </div>

        ${topPairsHtml}
        ${routesListHtml}

        <div class="ls-note" style="margin-top:4px">
          判定原理：实时采集每一轮 Assistant 消息与上游返回的 <code>responseModel</code>。缺少 <code>responseModel</code> 时按请求模型归为直通，这是回退推定；名称差异只证明上游返回的模型标识不同，不足以证明模型被替换。
        </div>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    const refreshBtn = container.querySelector(".mr-refresh-btn");
    if (refreshBtn) {
      refreshBtn.onclick = () => loadData(true);
    }

    const retryBtn = container.querySelector(".mr-retry-btn");
    if (retryBtn) {
      retryBtn.onclick = () => loadData(false);
    }

    const clearModelBtn = container.querySelector(".mr-clear-model");
    if (clearModelBtn && typeof onClearModel === "function") {
      clearModelBtn.onclick = onClearModel;
    }

    const statusBtns = container.querySelectorAll(".mr-status-btn");
    statusBtns.forEach((btn) => {
      btn.onclick = () => {
        const s = btn.getAttribute("data-status");
        if (s && s !== state.status) {
          state.status = s;
          state.page = 0;
          loadData(false);
        }
      };
    });

    const prevBtn = container.querySelector(".mr-prev-btn");
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (state.page > 0) {
          state.page--;
          loadData(false);
        }
      };
    }

    const nextBtn = container.querySelector(".mr-next-btn");
    if (nextBtn) {
      nextBtn.onclick = () => {
        if (state.page < pageCount() - 1) {
          state.page++;
          loadData(false);
        }
      };
    }
  }

  return {
    ensure() {
      const key = filterKey(currentFilters());
      if (key !== state.lastFilterKey) state.page = 0;
      return loadData(false);
    },
    reloadWithFilters({ refresh = false } = {}) {
      const key = filterKey(currentFilters());
      if (refresh || key !== state.lastFilterKey || !state.loadedOnce) {
        if (key !== state.lastFilterKey) state.page = 0;
        return loadData(false);
      }
    },
    refresh() {
      return loadData(false);
    },
  };
}
