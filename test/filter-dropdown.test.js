import test from 'node:test';
import assert from 'node:assert/strict';
import { initFilterDropdowns } from '../ui/modules/filter-dropdown.js';

test('initFilterDropdowns captures option selection and fires onSelect callback', () => {
  let selected = null;
  const listeners = [];
  const openElements = new Set();

  globalThis.document = {
    addEventListener: (type, fn) => { listeners.push(fn); },
    removeEventListener: () => {},
    querySelectorAll: () => Array.from(openElements),
  };

  const controller = initFilterDropdowns({
    onSelect: payload => { selected = payload; },
  });

  const txtEl = { textContent: '' };
  const csEl = {
    id: 'sm',
    classList: {
      toggle: () => {},
      remove: () => {},
    },
    querySelector: sel => (sel === '.cs-txt' ? txtEl : null),
  };

  const optEl = {
    dataset: { v: 'gpt-4o' },
    textContent: 'GPT-4o',
  };

  const fakeEvent = {
    target: {
      closest: sel => (sel === '.cs' ? csEl : sel === '.cs-opt' ? optEl : null),
    },
    stopPropagation: () => {},
  };

  // Dispatch fake click to registered listener
  listeners[0](fakeEvent);

  assert.deepEqual(selected, { name: 'sm', value: 'gpt-4o', label: 'GPT-4o' });
  assert.equal(txtEl.textContent, 'GPT-4o');
});
