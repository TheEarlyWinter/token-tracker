import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initDatePicker } from '../ui/modules/date-picker.js';

test('ui/base.css contains .cal.on display rule', () => {
  const cssPath = path.join(process.cwd(), 'ui/base.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /\.cal\.on\s*\{[^}]*display:\s*block;/s, 'ui/base.css must define .cal.on { display: block; }');
  assert.match(css, /\.cal\s*\{[^}]*position:\s*fixed;/s, '.cal should use fixed positioning for viewport-relative placement');
});

test('initDatePicker binds inputs, toggles .on, switches months and triggers onDateSelect', async () => {
  const originalDoc = globalThis.document;
  const originalWindow = globalThis.window;

  try {
    const docListeners = {};
    const elements = {};

    function createMockElement(tagName = 'div', id = '') {
      const el = {
        tagName,
        id,
        className: '',
        style: {},
        value: '',
        dataset: {},
        innerHTML: '',
        children: [],
        parentElement: null,
        _listeners: {},
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
          el.children.push(child);
          return child;
        },
        remove() {
          if (el.parentElement) {
            el.parentElement.children = el.parentElement.children.filter(c => c !== el);
          }
        },
        contains(target) {
          let curr = target;
          while (curr) {
            if (curr === el) return true;
            curr = curr.parentElement;
          }
          return false;
        },
        getBoundingClientRect() {
          return { top: 100, bottom: 130, left: 50, right: 150, width: 100, height: 30 };
        },
        querySelector(selector) {
          if (selector === '[data-a=prev]') return el._prevBtn || null;
          if (selector === '[data-a=next]') return el._nextBtn || null;
          return null;
        },
        querySelectorAll(selector) {
          if (selector === '[data-d]') return el._dayEls || [];
          return [];
        },
      };

      // 当修改 innerHTML 时，解析虚拟按钮和日期网格
      Object.defineProperty(el, 'innerHTML', {
        get() { return el._html || ''; },
        set(val) {
          el._html = val;
          el._prevBtn = {
            parentElement: el,
            onclick: null,
          };
          el._nextBtn = {
            parentElement: el,
            onclick: null,
          };
          // 提取所有 data-d
          const dayMatches = Array.from(val.matchAll(/<div([^>]*)data-d="(\d+)"[^>]*>(\d+)<\/div>/g));
          el._dayEls = dayMatches.map(m => {
            const rawAttrs = m[1];
            const d = m[2];
            const isToday = rawAttrs.includes('today');
            const isSel = rawAttrs.includes('sel');
            return {
              dataset: { d },
              isToday,
              isSel,
              parentElement: el,
              onclick: null,
            };
          });
        }
      });

      if (id) elements[id] = el;
      return el;
    }

    const df = createMockElement('input', 'df');
    df.value = '2026-10-01';
    const dt = createMockElement('input', 'dt');
    dt.value = '2026-10-07';

    const body = createMockElement('body');

    globalThis.document = {
      body,
      createElement: (tag) => createMockElement(tag),
      getElementById: (id) => elements[id] || null,
      addEventListener: (type, fn) => {
        (docListeners[type] = docListeners[type] || []).push(fn);
      },
      removeEventListener: (type, fn) => {
        if (docListeners[type]) {
          docListeners[type] = docListeners[type].filter(f => f !== fn);
        }
      },
    };

    globalThis.window = {
      innerWidth: 1200,
      innerHeight: 800,
    };

    let selectedRange = null;
    const picker = initDatePicker({
      fromInputId: 'df',
      toInputId: 'dt',
      onDateSelect: (f, t) => { selectedRange = { from: f, to: t }; },
    });

    const cal = body.children.find(c => c.className.includes('cal'));
    assert.ok(cal, 'initDatePicker must append .cal to document.body');
    assert.equal(cal.classList.contains('on'), false, 'Calendar initially hidden');

    // 1. 点击 #df 触发弹出
    assert.ok(df._listeners['click']?.length > 0, '#df click listener must be attached');
    df._listeners['click'][0]({ stopPropagation: () => {} });

    assert.equal(cal.classList.contains('on'), true, 'Calendar must have .on class after click');
    assert.match(cal.style.top, /^\d+px$/, 'Top coordinate must be set');
    assert.match(cal.style.left, /^\d+px$/, 'Left coordinate must be set');
    assert.ok(cal.innerHTML.includes('2026年10月'), 'Should render current month and year');

    // 检查选中高亮
    const selDay = cal._dayEls.find(d => d.dataset.d === '1');
    assert.ok(selDay, 'Day 1 exists in October');
    assert.equal(selDay.isSel, true, 'Day 1 should have sel class because df.value = 2026-10-01');

    // 2. 月份切换测试
    cal._prevBtn.onclick({ stopPropagation: () => {} });
    assert.ok(cal.innerHTML.includes('2026年9月'), 'Previous month should be 2026年9月');
    cal._nextBtn.onclick({ stopPropagation: () => {} });
    assert.ok(cal.innerHTML.includes('2026年10月'), 'Next month should return to 2026年10月');

    // 3. 点击某日（例如 5 号）
    const day5 = cal._dayEls.find(d => d.dataset.d === '5');
    assert.ok(day5, 'Day 5 exists');
    day5.onclick({ stopPropagation: () => {} });

    // df 原为 2026-10-01，点击 5 号变为 2026-10-05；dt 为 2026-10-07
    assert.equal(df.value, '2026-10-05');
    assert.deepEqual(selectedRange, { from: '2026-10-05', to: '2026-10-07' });
    assert.equal(cal.classList.contains('on'), false, 'Calendar hides after selection');

    // 4. 单日范围选择：再次点击 #dt 并选择 5 号（5 号到 5 号）
    dt._listeners['click'][0]({ stopPropagation: () => {} });
    assert.equal(cal.classList.contains('on'), true, 'Calendar re-opened on #dt click');
    const day5Again = cal._dayEls.find(d => d.dataset.d === '5');
    day5Again.onclick({ stopPropagation: () => {} });

    assert.equal(df.value, '2026-10-05');
    assert.equal(dt.value, '2026-10-05');
    assert.deepEqual(selectedRange, { from: '2026-10-05', to: '2026-10-05' }, 'Single-day range from 5 to 5 must trigger onDateSelect');
    assert.equal(cal.classList.contains('on'), false);

    // 5. 倒序日期自动调正：点击 #df 选 8 号（此时 dt 是 5 号，df 变 8 号，应自动 swap 为 5 到 8）
    df._listeners['click'][0]({ stopPropagation: () => {} });
    const day8 = cal._dayEls.find(d => d.dataset.d === '8');
    day8.onclick({ stopPropagation: () => {} });
    assert.equal(df.value, '2026-10-05');
    assert.equal(dt.value, '2026-10-08');
    assert.deepEqual(selectedRange, { from: '2026-10-05', to: '2026-10-08' }, 'Swaps inverted start and end dates gracefully');

    // 6. 点击外部关闭
    df._listeners['click'][0]({ stopPropagation: () => {} });
    assert.equal(cal.classList.contains('on'), true);
    docListeners['click'].forEach(fn => fn({ target: body }));
    assert.equal(cal.classList.contains('on'), false, 'Click outside must remove .on');

    // 7. Escape 键关闭
    df._listeners['click'][0]({ stopPropagation: () => {} });
    assert.equal(cal.classList.contains('on'), true);
    docListeners['keydown'].forEach(fn => fn({ key: 'Escape' }));
    assert.equal(cal.classList.contains('on'), false, 'Escape key must close calendar');

    picker.destroy();
    assert.equal(body.children.length, 0, 'destroy() removes .cal element');
  } finally {
    globalThis.document = originalDoc;
    globalThis.window = originalWindow;
  }
});
