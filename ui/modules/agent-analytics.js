// ui/modules/agent-analytics.js
// 多 Agent 活跃热力图与原生 SVG 平滑样条河流图

import { splineCurve, splineValueAt } from "./curve.js";
import { formatToken, escapeHtml } from "../dashboard-format.js";

const PALETTE = ["#4f80e1", "#22c55e", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#f97316", "#64748b"];

export function createAgentAnalytics({ container, getData = () => null }) {
  if (!container) return;

  let flowDim = "agent"; // 'agent' | 'kind'
  let flowScale = "abs";  // 'abs' | 'pct'

  function compact(n) {
    return formatToken(n);
  }

  function render() {
    container.innerHTML = "";
    const rootData = getData();
    const analytics = rootData?.visualAnalytics;
    if (!analytics) return;

    const wrap = document.createElement("div");
    wrap.className = "analytics-section";

    // ── 1. 多 Agent 活跃度热力图 ──
    const heatPanel = document.createElement("div");
    heatPanel.className = "analytics-panel card";
    heatPanel.innerHTML = `
      <div class="panel-header">
        <h3 class="panel-title">多 Agent 活跃分布 (Agent Activity Grid)</h3>
        <span class="panel-desc">各 Agent 在时间范围内的调用强度分布</span>
      </div>
      <div class="agent-heatmap-container"></div>
    `;

    const heatBox = heatPanel.querySelector(".agent-heatmap-container");
    const agentsList = analytics.agents || [];
    const dailyList = analytics.daily || [];

    if (!agentsList.length || !dailyList.length) {
      heatBox.innerHTML = `<div class="panel-empty">暂无 Agent 活跃记录</div>`;
    } else {
      let maxDayToken = 1;
      for (const a of agentsList) {
        for (const v of Object.values(a.days || {})) {
          if (v > maxDayToken) maxDayToken = v;
        }
      }

      // 获取所有涉及的日期列表（最多近 30 天）
      const dates = dailyList.map((d) => d.date).slice(-30);

      const table = document.createElement("div");
      table.className = "agent-heatmap-grid";

      for (const ag of agentsList) {
        const row = document.createElement("div");
        row.className = "heatmap-row";

        const nameLabel = document.createElement("div");
        nameLabel.className = "heatmap-agent-label";
        const displayName = rootData?.agentNames?.[ag.id] || ag.id;
        nameLabel.textContent = displayName;
        nameLabel.title = ag.id;
        row.appendChild(nameLabel);

        const cells = document.createElement("div");
        cells.className = "heatmap-cells";

        for (const date of dates) {
          const val = ag.days?.[date] || 0;
          const ratio = val > 0 ? val / maxDayToken : 0;
          let level = 0;
          if (ratio > 0.5) level = 4;
          else if (ratio > 0.2) level = 3;
          else if (ratio > 0.05) level = 2;
          else if (ratio > 0) level = 1;

          const cell = document.createElement("div");
          cell.className = `heat-cell level-${level}`;
          cell.title = `${displayName} · ${date}\n消耗: ${val.toLocaleString()} Token`;
          cells.appendChild(cell);
        }
        row.appendChild(cells);

        const totalLabel = document.createElement("div");
        totalLabel.className = "heatmap-total-label";
        totalLabel.textContent = compact(ag.totalTokens);
        row.appendChild(totalLabel);

        table.appendChild(row);
      }
      heatBox.appendChild(table);
    }
    wrap.appendChild(heatPanel);

    // ── 2. 用量河流图/色带图（原生 SVG + B-Spline）──
    const streamPanel = document.createElement("div");
    streamPanel.className = "analytics-panel card";
    streamPanel.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-group">
          <h3 class="panel-title">用量全景河流图 (Streamgraph)</h3>
          <span class="panel-desc">平滑三次样条曲线展示时序演变</span>
        </div>
        <div class="stream-controls">
          <div class="btn-group">
            <button type="button" class="btn btn-xs ${flowDim === "agent" ? "active" : ""}" data-dim="agent">按 Agent</button>
            <button type="button" class="btn btn-xs ${flowDim === "kind" ? "active" : ""}" data-dim="kind">按来源</button>
          </div>
          <div class="btn-group">
            <button type="button" class="btn btn-xs ${flowScale === "abs" ? "active" : ""}" data-scale="abs">总量</button>
            <button type="button" class="btn btn-xs ${flowScale === "pct" ? "active" : ""}" data-scale="pct">占比</button>
          </div>
        </div>
      </div>
      <div class="stream-chart-container"></div>
      <div class="stream-legend"></div>
    `;

    // 绑定切换按钮
    streamPanel.querySelectorAll("[data-dim]").forEach((btn) => {
      btn.onclick = () => {
        flowDim = btn.dataset.dim;
        renderStream(streamPanel, analytics, rootData);
      };
    });
    streamPanel.querySelectorAll("[data-scale]").forEach((btn) => {
      btn.onclick = () => {
        flowScale = btn.dataset.scale;
        renderStream(streamPanel, analytics, rootData);
      };
    });

    renderStream(streamPanel, analytics, rootData);
    wrap.appendChild(streamPanel);

    container.appendChild(wrap);
  }

  function renderStream(panel, analytics, rootData) {
    const box = panel.querySelector(".stream-chart-container");
    const legend = panel.querySelector(".stream-legend");
    box.innerHTML = "";
    legend.innerHTML = "";

    const days = analytics.daily || [];
    if (!days.length) {
      box.innerHTML = `<div class="panel-empty">暂无时序数据</div>`;
      return;
    }

    const W = 900;
    const H = 220;
    const PAD_L = 40;
    const PAD_R = 20;
    const PAD_T = 15;
    const PAD_B = 25;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    // 提取层 keys
    const layerTotals = new Map();
    const field = flowDim === "agent" ? "agents" : "kinds";
    for (const d of days) {
      for (const [k, v] of Object.entries(d[field] || {})) {
        layerTotals.set(k, (layerTotals.get(k) || 0) + (v || 0));
      }
    }

    const layers = [...layerTotals.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id], idx) => ({ id, color: PALETTE[idx % PALETTE.length] }));

    if (!layers.length) {
      box.innerHTML = `<div class="panel-empty">暂无可拆分图层</div>`;
      return;
    }

    // 渲染图例
    for (const l of layers) {
      const displayName =
        flowDim === "agent"
          ? rootData?.agentNames?.[l.id] || l.id
          : { desktop: "对话", sub: "子代理", bridge: "频道", background: "后台", ledger: "账本" }[l.id] || l.id;
      const legItem = document.createElement("div");
      legItem.className = "legend-item";
      legItem.innerHTML = `<span class="legend-dot" style="background:${l.color}"></span><span class="legend-text">${escapeHtml(displayName)}: ${compact(layerTotals.get(l.id))}</span>`;
      legend.appendChild(legItem);
    }

    const n = days.length;
    let maxVal = 1;
    const stackValues = [];

    for (let i = 0; i < n; i++) {
      const dayData = days[i][field] || {};
      const dayTotal = layers.reduce((acc, l) => acc + (dayData[l.id] || 0), 0);
      const col = [];
      let accum = 0;
      for (const l of layers) {
        const raw = dayData[l.id] || 0;
        const val = flowScale === "pct" ? (dayTotal > 0 ? (raw / dayTotal) * 100 : 0) : raw;
        const y0 = accum;
        accum += val;
        col.push({ y0, y1: accum, val: raw });
      }
      stackValues.push(col);
      if (accum > maxVal) maxVal = accum;
    }

    // SVG 渲染
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "stream-svg");

    // 绘制各层带
    layers.forEach((l, lIdx) => {
      const upperPts = [];
      const lowerPts = [];

      for (let i = 0; i < n; i++) {
        const x = PAD_L + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
        const col = stackValues[i][lIdx];
        const yTop = PAD_T + plotH - (col.y1 / maxVal) * plotH;
        const yBot = PAD_T + plotH - (col.y0 / maxVal) * plotH;
        upperPts.push([x, yTop]);
        lowerPts.push([x, yBot]);
      }

      let d = `M${upperPts[0][0]},${upperPts[0][1]}` + splineCurve(upperPts);
      d += ` L${lowerPts[n - 1][0]},${lowerPts[n - 1][1]}`;
      const revLower = [...lowerPts].reverse();
      d += splineCurve(revLower) + " Z";

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", l.color);
      path.setAttribute("fill-opacity", "0.75");
      path.setAttribute("stroke", l.color);
      path.setAttribute("stroke-width", "1");
      svg.appendChild(path);
    });

    // 日期横轴
    if (n > 0) {
      const step = Math.max(1, Math.floor(n / 6));
      for (let i = 0; i < n; i += step) {
        const x = PAD_L + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", x);
        text.setAttribute("y", H - 6);
        text.setAttribute("class", "axis-text");
        text.setAttribute("text-anchor", "middle");
        text.textContent = days[i].date.slice(5);
        svg.appendChild(text);
      }
    }

    box.appendChild(svg);
  }

  render();

  return {
    reload: render,
  };
}

export default { createAgentAnalytics };
