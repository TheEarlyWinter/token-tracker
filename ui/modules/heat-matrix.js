// ui/modules/heat-matrix.js — 30 天用量热力矩阵组件（方案 B-2：2行 × 15列 全宽双行方块矩阵 · 5阶冷蓝）

/**
 * 将 YYYY-MM-DD 日期加上 n 天并返回新日期字符串
 */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n, 12, 0, 0);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * 5 阶冷蓝色阶映射（0用量浅底描边至峰值深蓝）
 * @param {number} tokens 当前日期消耗
 * @param {number} maxTokens 30 天窗口内的峰值消耗
 * @returns {number} 0..4
 */
export function getHeatLevel(tokens, maxTokens) {
  const t = Number(tokens) || 0;
  const max = Number(maxTokens) || 0;
  if (t <= 0 || max <= 0) return 0;
  const ratio = t / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.50) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/**
 * 计算 30 天热力矩阵数据模型（2 行 × 15 列全宽排布）
 * 第一行（前 15 天）：today - 29 天 至 today - 15 天
 * 第二行（后 15 天）：today - 14 天 至 today
 */
export function computeHeatMatrixGrid(dailyData = [], options = {}) {
  const todayStr = options.todayStr || (new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }));
  const windowDays = 30; // 固定展示 30 天窗口

  const startDateStr = addDays(todayStr, -(windowDays - 1));
  const endDateStr = todayStr;

  const dataMap = new Map();
  if (Array.isArray(dailyData)) {
    for (const item of dailyData) {
      if (item && item.date) {
        dataMap.set(item.date, Number(item.totalTokens) || 0);
      }
    }
  } else if (dailyData && typeof dailyData === "object") {
    for (const [k, v] of Object.entries(dailyData)) {
      dataMap.set(k, typeof v === "number" ? v : Number(v?.totalTokens) || 0);
    }
  }

  // 统计窗口内指标
  let maxTokens = 0;
  let totalTokens = 0;
  let activeDays = 0;
  for (let i = 0; i < windowDays; i++) {
    const d = addDays(startDateStr, i);
    const tok = dataMap.get(d) || 0;
    totalTokens += tok;
    if (tok > maxTokens) maxTokens = tok;
    if (tok > 0) activeDays++;
  }

  // 生成 2 行 × 15 列日期单元格
  const days = [];
  for (let i = 0; i < windowDays; i++) {
    const date = addDays(startDateStr, i);
    const tokens = dataMap.get(date) || 0;
    const row = Math.floor(i / 15);
    const col = i % 15;
    const isToday = (i === windowDays - 1);
    const level = getHeatLevel(tokens, maxTokens);

    days.push({
      date,
      tokens,
      level,
      row,
      col,
      index: i,
      inWindow: true,
      isToday,
    });
  }

  return {
    days,
    rows: 2,
    cols: 15,
    maxTokens,
    totalTokens,
    activeDays,
    startDate: startDateStr,
    endDate: endDateStr,
    today: todayStr,
  };
}

function formatTokens(n) {
  return Number(n || 0).toLocaleString();
}

function formatCompact(n) {
  const num = Number(n) || 0;
  if (num >= 100000000) return (num / 100000000).toFixed(2) + "亿";
  if (num >= 1000000) return (num / 1000000).toFixed(2) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "k";
  return String(num);
}

function getOrCreateTooltip() {
  if (typeof document === "undefined") return null;
  let tip = document.getElementById("hm-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "hm-tooltip";
    tip.className = "hm-tooltip";
    if (document.body) {
      document.body.appendChild(tip);
    }
  }
  return tip;
}

/**
 * 渲染 30 天用量热力矩阵组件（方案 B-2：2 行 × 15 列全宽排布）
 * @param {HTMLElement} container 渲染目标容器
 * @param {Object} options 配置项
 */
export function renderHeatMatrix(container, options = {}) {
  if (!container) return;

  const model = computeHeatMatrixGrid(options.dailyData, options);
  const selectedDate = options.selectedDate || "";

  let html = '<div class="trend-card hm-card">';
  html += '<div class="ct">';
  html += '  <div class="hm-header-left">';
  html += '    <span class="hm-title">30 天用量热力矩阵</span>';
  html += '    <span class="hm-stat-sub">近 30 天累计 ' + formatCompact(model.totalTokens) + ' Tokens · ' + model.activeDays + ' 天活跃</span>';
  html += '  </div>';
  html += '  <div class="hm-legend">';
  html += '    <span class="hm-legend-label">0</span>';
  html += '    <span class="hm-legend-cell" data-level="0" title="0 Tokens"></span>';
  html += '    <span class="hm-legend-cell" data-level="1" title="1% - 25% 峰值"></span>';
  html += '    <span class="hm-legend-cell" data-level="2" title="25% - 50% 峰值"></span>';
  html += '    <span class="hm-legend-cell" data-level="3" title="50% - 75% 峰值"></span>';
  html += '    <span class="hm-legend-cell" data-level="4" title="75% - 100% 峰值"></span>';
  html += '    <span class="hm-legend-label">峰值</span>';
  html += '  </div>';
  html += '</div>';

  html += '<div class="hm-grid">';
  for (const day of model.days) {
    const isSel = (selectedDate && day.date === selectedDate);
    const isTod = day.isToday;
    let classes = ["hm-cell"];
    if (isSel) classes.push("is-selected");
    if (isTod) classes.push("is-today");

    const label = `${day.date} · ${formatTokens(day.tokens)} Tokens`;
    html += '<div class="' + classes.join(" ") + '" ' +
      'data-date="' + day.date + '" ' +
      'data-tokens="' + day.tokens + '" ' +
      'data-level="' + day.level + '" ' +
      'data-row="' + day.row + '" ' +
      'data-col="' + day.col + '" ' +
      'tabindex="0" role="button" ' +
      'title="' + label + '" ' +
      'aria-label="' + label + '"></div>';
  }
  html += '</div>';

  html += '</div>';

  container.innerHTML = html;

  // 绑定交互事件（Tooltip 与点击下钻）
  const tip = getOrCreateTooltip();
  const cells = container.querySelectorAll(".hm-cell");

  cells.forEach(function (cell) {
    const date = cell.getAttribute("data-date");
    const tokens = Number(cell.getAttribute("data-tokens")) || 0;

    function showTooltip() {
      if (!tip) return;
      tip.textContent = `${date} · ${formatTokens(tokens)} Tokens`;
      tip.classList.add("on");

      if (typeof cell.getBoundingClientRect === "function") {
        const rect = cell.getBoundingClientRect();
        const tipW = tip.offsetWidth || 180;
        const tipH = tip.offsetHeight || 28;
        const winW = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1024;

        let left = rect.left + rect.width / 2 - tipW / 2;
        let top = rect.top - tipH - 6;

        if (left < 8) left = 8;
        if (left + tipW > winW - 8) left = winW - tipW - 8;
        if (top < 8) top = rect.bottom + 6;

        tip.style.left = left + "px";
        tip.style.top = top + "px";
      }
    }

    function hideTooltip() {
      if (tip) tip.classList.remove("on");
    }

    cell.addEventListener("mouseenter", showTooltip);
    cell.addEventListener("mousemove", showTooltip);
    cell.addEventListener("mouseleave", hideTooltip);

    function triggerSelect(e) {
      if (e) e.stopPropagation();
      hideTooltip();
      if (typeof options.onDateClick === "function") {
        options.onDateClick(date, { date, tokens });
      }
    }

    cell.addEventListener("click", triggerSelect);
    cell.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        triggerSelect(e);
      }
    });
  });

  return model;
}
