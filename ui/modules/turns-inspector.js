// ui/modules/turns-inspector.js
// Turn 级单轮细粒度明细排障面板：支持未命中输入倒序、极端门槛过滤、分页与 CSV 导出

import { escapeHtml, formatToken } from "../dashboard-format.js";

export function createTurnsInspector({
  container,
  fetchFn = (endpoint, opts) => fetch(endpoint, opts),
  getApiBase = () => "",
  getFilters = () => ({}),
  onExportCsv = () => {},
}) {
  if (!container) return;

  let state = {
    sortKey: "time",
    order: "desc",
    minTokens: 0,
    page: 1,
    pageSize: 50,
    loading: false,
    data: { rows: [], total: 0, sumTokens: 0, totalPages: 1 },
  };

  function fmtNum(n) {
    return Number(n || 0).toLocaleString();
  }

  function formatTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtPct(read, uncached) {
    const r = Number(read || 0);
    const u = Number(uncached || 0);
    const total = r + u;
    if (total <= 0) return "—";
    return ((r / total) * 100).toFixed(1) + "%";
  }

  function copyToClipboardFallback(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    document.body.removeChild(ta);
    return ok;
  }

  async function copyTextToClipboard(text) {
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }
    return copyToClipboardFallback(text);
  }

  async function fetchTurns() {
    state.loading = true;
    render();
    try {
      const filters = getFilters();
      const params = new URLSearchParams({
        sortKey: state.sortKey,
        order: state.order,
        minTokens: String(state.minTokens),
        page: String(state.page),
        pageSize: String(state.pageSize),
        ...(filters.range ? { range: filters.range } : {}),
        ...(filters.from ? { from: filters.from } : {}),
        ...(filters.to ? { to: filters.to } : {}),
        ...(filters.agent ? { agent: filters.agent } : {}),
        ...(filters.model ? { model: filters.model } : {}),
        ...(filters.provider ? { provider: filters.provider } : {}),
        ...(filters.type ? { type: filters.type } : {}),
      });

      const res = await fetchFn("/turns?" + params.toString());
      if (res.ok) {
        state.data = await res.json();
      }
    } catch (e) {
      console.warn("[turns-inspector] fetch turns error:", e);
    } finally {
      state.loading = false;
      render();
    }
  }

  function render() {
    container.innerHTML = "";

    const card = document.createElement("div");
    card.className = "turns-panel card";

    // Header 区域（标题 + 统计信息 + 过滤排控件）
    const header = document.createElement("div");
    header.className = "turns-header";
    header.innerHTML = `
      <div class="turns-title-group">
        <h3 class="turns-title">单轮明细排障 (Turn-level Inspector)</h3>
        <span class="turns-summary-badge">
          共 ${state.data.total.toLocaleString()} 轮调用 · 总计 ${formatToken(state.data.sumTokens)} Token
        </span>
      </div>
      <div class="turns-controls">
        <div class="turns-filter-group">
          <label>排序：</label>
          <select class="tt-select turns-sort-select">
            <option value="time" ${state.sortKey === "time" ? "selected" : ""}>时间 ↓</option>
            <option value="tokens" ${state.sortKey === "tokens" ? "selected" : ""}>用量 ↓</option>
            <option value="uncached" ${state.sortKey === "uncached" ? "selected" : ""}>未命中输入 ↓ (排障首选)</option>
            <option value="hit" ${state.sortKey === "hit" ? "selected" : ""}>命中率 ↓</option>
          </select>
        </div>
        <div class="turns-filter-group">
          <label>门槛：</label>
          <select class="tt-select turns-threshold-select">
            <option value="0" ${state.minTokens === 0 ? "selected" : ""}>不限</option>
            <option value="100000" ${state.minTokens === 100000 ? "selected" : ""}>≥10万</option>
            <option value="1000000" ${state.minTokens === 1000000 ? "selected" : ""}>≥100万</option>
            <option value="3000000" ${state.minTokens === 3000000 ? "selected" : ""}>≥300万</option>
            <option value="10000000" ${state.minTokens === 10000000 ? "selected" : ""}>≥1000万</option>
          </select>
        </div>
        <button type="button" class="btn btn-outline turns-export-btn" title="导出当前筛选条件下的全部轮次到文件">
          导出 CSV
        </button>
        <button type="button" class="btn btn-outline turns-copy-btn" title="一键复制全部 CSV 文本，可直接粘贴到 Excel">
          复制 CSV
        </button>
      </div>
    `;

    // 绑定事件
    const sortSel = header.querySelector(".turns-sort-select");
    sortSel.onchange = (e) => {
      state.sortKey = e.target.value;
      state.page = 1;
      fetchTurns();
    };

    const threshSel = header.querySelector(".turns-threshold-select");
    threshSel.onchange = (e) => {
      state.minTokens = Number(e.target.value);
      state.page = 1;
      fetchTurns();
    };

    const exportBtn = header.querySelector(".turns-export-btn");
    exportBtn.onclick = async () => {
      const filters = getFilters();
      const params = new URLSearchParams({
        sortKey: state.sortKey,
        order: state.order,
        minTokens: String(state.minTokens),
        all: "true",
        ...(filters.range ? { range: filters.range } : {}),
        ...(filters.from ? { from: filters.from } : {}),
        ...(filters.to ? { to: filters.to } : {}),
        ...(filters.agent ? { agent: filters.agent } : {}),
        ...(filters.model ? { model: filters.model } : {}),
        ...(filters.provider ? { provider: filters.provider } : {}),
        ...(filters.type ? { type: filters.type } : {}),
      });

      try {
        exportBtn.disabled = true;
        exportBtn.textContent = "正在处理…";
        const res = await fetchFn("/turns/csv?" + params.toString());
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        const dateStr = new Date().toISOString().slice(0, 10);
        const filename = `token-turns-${dateStr}.csv`;

        // 1. 标准 Blob 下载（外部独立浏览器访问时可直接落盘）
        try {
          const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {}

        // 2. 同时拷贝到剪贴板（卡片槽内宿主拦截原生下载时的双保险）
        const copied = await copyTextToClipboard(text);
        if (copied) {
          exportBtn.textContent = "已复制到剪贴板！(桌面已有离线文件)";
          setTimeout(() => { exportBtn.textContent = "导出 CSV"; }, 3000);
        } else {
          exportBtn.textContent = "文件已存在于电脑桌面！";
          setTimeout(() => { exportBtn.textContent = "导出 CSV"; }, 3000);
        }
      } catch (err) {
        exportBtn.textContent = "导出失败: " + err.message;
        setTimeout(() => { exportBtn.textContent = "导出 CSV"; }, 3000);
      } finally {
        exportBtn.disabled = false;
      }
    };

    const copyBtn = header.querySelector(".turns-copy-btn");
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const filters = getFilters();
        const params = new URLSearchParams({
          sortKey: state.sortKey,
          order: state.order,
          minTokens: String(state.minTokens),
          all: "true",
          ...(filters.range ? { range: filters.range } : {}),
          ...(filters.from ? { from: filters.from } : {}),
          ...(filters.to ? { to: filters.to } : {}),
          ...(filters.agent ? { agent: filters.agent } : {}),
          ...(filters.model ? { model: filters.model } : {}),
          ...(filters.provider ? { provider: filters.provider } : {}),
          ...(filters.type ? { type: filters.type } : {}),
        });

        try {
          copyBtn.disabled = true;
          copyBtn.textContent = "正在读取…";
          const res = await fetchFn("/turns/csv?" + params.toString());
          if (!res.ok) throw new Error("HTTP " + res.status);
          const text = await res.text();
          const copied = await copyTextToClipboard(text);
          if (copied) {
            copyBtn.textContent = "已复制！可直接粘贴至 Excel";
            setTimeout(() => { copyBtn.textContent = "复制 CSV"; }, 2500);
          } else {
            throw new Error("剪贴板写入受限");
          }
        } catch (err) {
          copyBtn.textContent = "复制失败: " + err.message;
          setTimeout(() => { copyBtn.textContent = "复制 CSV"; }, 2500);
        } finally {
          copyBtn.disabled = false;
        }
      };
    }

    card.appendChild(header);

    // Table 区域
    const tableWrap = document.createElement("div");
    tableWrap.className = "turns-table-wrap";

    if (state.loading) {
      tableWrap.innerHTML = `<div class="turns-loading">正在拉取轮次明细数据…</div>`;
    } else if (!state.data.rows || state.data.rows.length === 0) {
      tableWrap.innerHTML = `<div class="turns-empty">所选条件暂无轮次用量记录</div>`;
    } else {
      const rowsHtml = state.data.rows
        .map((r) => {
          const uncached = Number(r.input || 0);
          const cacheRead = Number(r.cacheRead || 0);
          const totalInput = uncached + cacheRead;
          const hit = fmtPct(cacheRead, uncached);
          const timeStr = r.at ? formatTime(r.at) : r.day || "—";
          return `
            <tr>
              <td class="col-time" title="${escapeHtml(r.at)}">${escapeHtml(timeStr)}</td>
              <td class="col-agent"><span class="agent-tag">${escapeHtml(r.agent || "default")}</span></td>
              <td class="col-model" title="${escapeHtml((r.provider ? r.provider + "/" : "") + r.model)}">
                <span class="provider-prefix">${escapeHtml(r.provider || "")}</span>
                <span class="model-name">${escapeHtml(r.model || "—")}</span>
              </td>
              <td class="col-num col-uncached" title="未命中: ${fmtNum(uncached)}, 命中: ${fmtNum(cacheRead)}, 总输入: ${fmtNum(totalInput)}">
                <span class="uncached-val">${fmtNum(uncached)}</span>
                <span class="sub-val">/ ${fmtNum(totalInput)}</span>
              </td>
              <td class="col-num">${fmtNum(r.output)}</td>
              <td class="col-hit"><span class="hit-pill">${hit}</span></td>
              <td class="col-num col-total" title="精确值: ${fmtNum(r.total)}">${formatToken(r.total)}</td>
            </tr>
          `;
        })
        .join("");

      tableWrap.innerHTML = `
        <table class="turns-table">
          <thead>
            <tr>
              <th class="col-time">时间</th>
              <th class="col-agent">Agent</th>
              <th class="col-model">模型</th>
              <th class="col-num">未命中输入 / 输入</th>
              <th class="col-num">输出</th>
              <th class="col-hit">缓存率</th>
              <th class="col-num col-total">总用量</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      `;
    }

    card.appendChild(tableWrap);

    // Footer 分页
    const footer = document.createElement("div");
    footer.className = "turns-footer";
    footer.innerHTML = `
      <div class="turns-pagination-info">
        第 ${state.page} / ${state.data.totalPages} 页
      </div>
      <div class="turns-pagination-actions">
        <button type="button" class="btn btn-sm turns-prev-btn" ${state.page <= 1 ? "disabled" : ""}>上一页</button>
        <button type="button" class="btn btn-sm turns-next-btn" ${state.page >= state.data.totalPages ? "disabled" : ""}>下一页</button>
      </div>
    `;

    footer.querySelector(".turns-prev-btn").onclick = () => {
      if (state.page > 1) {
        state.page--;
        fetchTurns();
      }
    };
    footer.querySelector(".turns-next-btn").onclick = () => {
      if (state.page < state.data.totalPages) {
        state.page++;
        fetchTurns();
      }
    };

    card.appendChild(footer);
    container.appendChild(card);
  }

  // 初始加载
  fetchTurns();

  return {
    reload: (resetPage = false) => {
      if (resetPage) state.page = 1;
      fetchTurns();
    },
  };
}

export default { createTurnsInspector };
