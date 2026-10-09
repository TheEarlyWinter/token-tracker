import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getHeatLevel,
  computeHeatMatrixGrid,
  renderHeatMatrix,
} from '../ui/modules/heat-matrix.js';

test('ui/base.css contains 30-day heat matrix (2x15 full-width) and 5-level cold-blue styles', () => {
  const cssPath = path.join(process.cwd(), 'ui/base.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /\.hm-card\s*\{/);
  assert.match(css, /\.hm-cell\s*\{/);
  assert.match(css, /\.hm-cell\[data-level="0"\]/);
  assert.match(css, /\.hm-cell\[data-level="1"\]/);
  assert.match(css, /\.hm-cell\[data-level="2"\]/);
  assert.match(css, /\.hm-cell\[data-level="3"\]/);
  assert.match(css, /\.hm-cell\[data-level="4"\]/);
  assert.match(css, /\.hm-grid\s*\{[^}]*grid-template-columns:\s*repeat\(15,\s*1fr\)/s);
  assert.match(css, /\.hm-grid\s*\{[^}]*grid-template-rows:\s*repeat\(2,\s*1fr\)/s);
  assert.match(css, /\.hm-tooltip/);
  assert.doesNotMatch(css, /\.hm-weekdays/);
  assert.doesNotMatch(css, /\.hm-footer/);
});

test('getHeatLevel computes 5-level cold-blue transitions with extreme normalization', () => {
  // 0 或无效值
  assert.equal(getHeatLevel(0, 1000), 0);
  assert.equal(getHeatLevel(-50, 1000), 0);
  assert.equal(getHeatLevel(100, 0), 0);
  assert.equal(getHeatLevel(0, 0), 0);

  // 1 阶: 1% - 25%
  assert.equal(getHeatLevel(10, 1000), 1);
  assert.equal(getHeatLevel(250, 1000), 1);

  // 2 阶: 26% - 50%
  assert.equal(getHeatLevel(251, 1000), 2);
  assert.equal(getHeatLevel(500, 1000), 2);

  // 3 阶: 51% - 75%
  assert.equal(getHeatLevel(501, 1000), 3);
  assert.equal(getHeatLevel(750, 1000), 3);

  // 4 阶: 76% - 100% 峰值
  assert.equal(getHeatLevel(751, 1000), 4);
  assert.equal(getHeatLevel(1000, 1000), 4);
  assert.equal(getHeatLevel(1200, 1000), 4);
});

test('computeHeatMatrixGrid generates 2 rows by 15 cols full-width grid for exactly 30 days', () => {
  const todayStr = '2026-10-08';
  const sampleData = [
    { date: '2026-10-08', totalTokens: 10000 },
    { date: '2026-10-07', totalTokens: 5000 },
    { date: '2026-10-01', totalTokens: 2500 },
    { date: '2026-09-15', totalTokens: 1000 },
  ];

  const grid = computeHeatMatrixGrid(sampleData, { todayStr, windowDays: 30 });

  assert.equal(grid.rows, 2, '必须为 2 行');
  assert.equal(grid.cols, 15, '必须为 15 列');
  assert.equal(grid.days.length, 30, '总天数必须精确为 30 天');
  assert.equal(grid.today, '2026-10-08');
  assert.equal(grid.endDate, '2026-10-08');
  assert.equal(grid.startDate, '2026-09-09', '30 天前（含今天）必须是 2026-09-09');
  assert.equal(grid.maxTokens, 10000);
  assert.equal(grid.totalTokens, 18500);
  assert.equal(grid.activeDays, 4);

  // 第一行（前 15 天）：0..14 -> row 0, col 0..14
  for (let i = 0; i < 15; i++) {
    const day = grid.days[i];
    assert.equal(day.row, 0, `第 ${i} 天必须在 row 0`);
    assert.equal(day.col, i, `第 ${i} 天的 col 必须为 ${i}`);
    assert.equal(day.isToday, false);
  }

  // 第二行（后 15 天）：15..29 -> row 1, col 0..14
  for (let i = 15; i < 30; i++) {
    const day = grid.days[i];
    assert.equal(day.row, 1, `第 ${i} 天必须在 row 1`);
    assert.equal(day.col, i - 15, `第 ${i} 天的 col 必须为 ${i - 15}`);
  }

  // 验证第一格（today - 29 天）与最后一格（today）
  const firstSlot = grid.days[0];
  assert.equal(firstSlot.date, '2026-09-09');

  const lastSlot = grid.days[29];
  assert.equal(lastSlot.date, '2026-10-08');
  assert.equal(lastSlot.isToday, true);
  assert.equal(lastSlot.tokens, 10000);
  assert.equal(lastSlot.level, 4);
});

test('renderHeatMatrix renders DOM elements, 2x15 cells, footer labels, and dispatches click drill-down', () => {
  const originalDoc = globalThis.document;
  const originalWindow = globalThis.window;

  try {
    const docListeners = {};
    const elements = {};

    function createMockElement(tagName = 'div', id = '') {
      const el = {
        tagName,
        _id: id,
        className: '',
        style: {},
        dataset: {},
        attributes: {},
        _html: '',
        _listeners: {},
        _cellEls: [],
        classList: {
          _classes: new Set(),
          add(c) { el.classList._classes.add(c); el.className = Array.from(el.classList._classes).join(' '); },
          remove(c) { el.classList._classes.delete(c); el.className = Array.from(el.classList._classes).join(' '); },
          contains(c) { return el.classList._classes.has(c); },
          toggle(c, val) {
            if (val === undefined) val = !el.classList._classes.has(c);
            if (val) el.classList.add(c); else el.classList.remove(c);
            return val;
          },
        },
        setAttribute(k, v) { el.attributes[k] = String(v); },
        getAttribute(k) { return el.attributes[k] !== undefined ? el.attributes[k] : null; },
        addEventListener(type, fn) {
          (el._listeners[type] = el._listeners[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
          if (el._listeners[type]) {
            el._listeners[type] = el._listeners[type].filter(f => f !== fn);
          }
        },
        appendChild(child) {
          child.parentElement = el;
          return child;
        },
        getBoundingClientRect() {
          return { top: 100, bottom: 140, left: 200, right: 240, width: 40, height: 40 };
        },
        querySelectorAll(selector) {
          if (selector === '.hm-cell') {
            return el._cellEls || [];
          }
          return [];
        },
      };

      Object.defineProperty(el, 'id', {
        get() { return el._id || ''; },
        set(val) { el._id = val; if (val) elements[val] = el; },
      });

      Object.defineProperty(el, 'innerHTML', {
        get() { return el._html || ''; },
        set(val) {
          el._html = val;
          const matches = Array.from(val.matchAll(/<div class="([^"]*)"([^>]*)data-date="([^"]+)"\s+data-tokens="([^"]+)"\s+data-level="([^"]+)"/g));
          el._cellEls = matches.map(m => {
            const cls = m[1];
            const date = m[3];
            const tokens = m[4];
            const level = m[5];
            const cell = createMockElement('div');
            cell.className = cls;
            cell.setAttribute('data-date', date);
            cell.setAttribute('data-tokens', tokens);
            cell.setAttribute('data-level', level);
            return cell;
          });
        },
      });

      if (id) elements[id] = el;
      return el;
    }

    const mockBody = createMockElement('body');
    const mockDoc = {
      body: mockBody,
      createElement: (t) => createMockElement(t),
      getElementById: (id) => elements[id] || null,
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    };

    globalThis.document = mockDoc;
    globalThis.window = { innerWidth: 1200, innerHeight: 800 };

    const container = createMockElement('div', 'heat-matrix-section');

    let clickedDate = null;
    let clickedPayload = null;

    const dailyData = [
      { date: '2026-10-08', totalTokens: 50000 },
      { date: '2026-10-05', totalTokens: 25000 },
      { date: '2026-09-20', totalTokens: 12000 },
    ];

    const model = renderHeatMatrix(container, {
      dailyData,
      todayStr: '2026-10-08',
      selectedDate: '2026-10-05',
      onDateClick: (date, item) => {
        clickedDate = date;
        clickedPayload = item;
      },
    });

    assert.ok(container.innerHTML.includes('30 天用量热力矩阵'));
    assert.ok(container.innerHTML.includes('hm-legend'));
    assert.ok(container.innerHTML.includes('is-selected'));
    assert.ok(!container.innerHTML.includes('hm-footer'), '不得包含底部小字容器');
    assert.ok(!container.innerHTML.includes('30天前'), '不得包含30天前字样');
    assert.ok(!container.innerHTML.includes('今天（'), '不得包含今天字样');
    assert.ok(!container.innerHTML.includes('hm-weekdays'), '不得包含星期标签');

    // 验证 30 个方块
    const cells = container.querySelectorAll('.hm-cell');
    assert.equal(cells.length, 30, '必须严格渲染 30 个单元格');

    const targetCell = cells.find(c => c.getAttribute('data-date') === '2026-10-08');
    assert.ok(targetCell, '应找到 2026-10-08 单元格');

    // 模拟点击
    const clickHandler = targetCell._listeners['click']?.[0];
    assert.ok(typeof clickHandler === 'function', '必须绑定 click 监听器');
    clickHandler({ stopPropagation() {} });

    assert.equal(clickedDate, '2026-10-08');
    assert.equal(clickedPayload.tokens, 50000);
  } finally {
    globalThis.document = originalDoc;
    globalThis.window = originalWindow;
  }
});

test('computeHeatMatrixGrid handles empty data, all zeros, and boundary leap years', () => {
  // 空数据
  const emptyGrid = computeHeatMatrixGrid([], { todayStr: '2026-10-08', windowDays: 30 });
  assert.equal(emptyGrid.maxTokens, 0);
  assert.equal(emptyGrid.totalTokens, 0);
  assert.equal(emptyGrid.activeDays, 0);
  assert.equal(emptyGrid.rows, 2);
  assert.equal(emptyGrid.cols, 15);
  assert.equal(emptyGrid.days.length, 30);
  for (const d of emptyGrid.days) {
    assert.equal(d.level, 0, '0 消耗时色阶必须为 0');
  }

  // 跨闰年测试（2024-03-15 回推 29 天到 2024-02-15，必须包含 2024-02-29）
  const leapGrid = computeHeatMatrixGrid([], { todayStr: '2024-03-15', windowDays: 30 });
  assert.equal(leapGrid.today, '2024-03-15');
  assert.equal(leapGrid.days.length, 30);
  const feb29 = leapGrid.days.find(d => d.date === '2024-02-29');
  assert.ok(feb29, '闰年 2 月 29 日必须包含在窗口内');
});

test('renderHeatMatrix tooltip triggers mouseenter and mouseleave classes', () => {
  const originalDoc = globalThis.document;
  const originalWindow = globalThis.window;

  try {
    const elements = {};
    function createMockElement(tagName = 'div', id = '') {
      const el = {
        tagName,
        _id: id,
        className: '',
        style: {},
        attributes: {},
        _listeners: {},
        _cellEls: [],
        classList: {
          _classes: new Set(),
          add(c) { el.classList._classes.add(c); el.className = Array.from(el.classList._classes).join(' '); },
          remove(c) { el.classList._classes.delete(c); el.className = Array.from(el.classList._classes).join(' '); },
          contains(c) { return el.classList._classes.has(c); },
        },
        setAttribute(k, v) { el.attributes[k] = String(v); },
        getAttribute(k) { return el.attributes[k] !== undefined ? el.attributes[k] : null; },
        addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
        appendChild(c) { return c; },
        getBoundingClientRect() { return { top: 50, bottom: 90, left: 100, right: 140, width: 40, height: 40 }; },
        querySelectorAll(selector) {
          if (selector === '.hm-cell') return el._cellEls || [];
          return [];
        },
      };
      Object.defineProperty(el, 'id', {
        get() { return el._id || ''; },
        set(val) { el._id = val; if (val) elements[val] = el; },
      });
      Object.defineProperty(el, 'innerHTML', {
        get() { return el._html || ''; },
        set(val) {
          el._html = val;
          const matches = Array.from(val.matchAll(/<div class="([^"]*)"([^>]*)data-date="([^"]+)"\s+data-tokens="([^"]+)"\s+data-level="([^"]+)"/g));
          el._cellEls = matches.map(m => {
            const cell = createMockElement('div');
            cell.className = m[1];
            cell.setAttribute('data-date', m[3]);
            cell.setAttribute('data-tokens', m[4]);
            cell.setAttribute('data-level', m[5]);
            return cell;
          });
        },
      });
      if (id) elements[id] = el;
      return el;
    }

    const mockDoc = {
      body: createMockElement('body'),
      createElement: (t) => createMockElement(t),
      getElementById: (id) => elements[id] || null,
    };
    globalThis.document = mockDoc;
    globalThis.window = { innerWidth: 1000, innerHeight: 700 };

    const container = createMockElement('div', 'heat-matrix-container');
    renderHeatMatrix(container, {
      dailyData: [{ date: '2026-10-08', totalTokens: 12345 }],
      todayStr: '2026-10-08',
    });

    const tip = elements['hm-tooltip'];
    assert.ok(tip, '必须在 document.body 创建 #hm-tooltip');

    const cell = container.querySelectorAll('.hm-cell').find(c => c.getAttribute('data-date') === '2026-10-08');
    assert.ok(cell);

    // 触发 mouseenter
    const enterFn = cell._listeners['mouseenter']?.[0];
    assert.ok(typeof enterFn === 'function');
    enterFn();
    assert.ok(tip.classList.contains('on'), '悬浮时 tooltip 必须追加 .on 类名');
    assert.match(tip.textContent, /2026-10-08/);
    assert.match(tip.textContent, /12,345/);

    // 触发 mouseleave
    const leaveFn = cell._listeners['mouseleave']?.[0];
    assert.ok(typeof leaveFn === 'function');
    leaveFn();
    assert.equal(tip.classList.contains('on'), false, '移出后 tooltip 必须移除 .on');
  } finally {
    globalThis.document = originalDoc;
    globalThis.window = originalWindow;
  }
});
