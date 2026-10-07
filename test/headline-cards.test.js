import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHeadlineCards } from '../ui/modules/headline-cards.js';

test('renderHeadlineCards correctly injects summary token values into cards', () => {
  const children = [];
  const container = {
    innerHTML: '',
    children,
  };

  const summary = {
    totalTokens: 1000000,
    totalDesktop: 800000,
    totalChannel: 200000,
    totalOutput: 150000,
    totalInput: 650000,
    totalCacheRead: 200000,
    cacheHitRate: 23.5,
  };

  renderHeadlineCards(container, summary, n => n.toLocaleString());

  assert.match(container.innerHTML, /1,000,000/);
  assert.match(container.innerHTML, /800,000/);
  assert.match(container.innerHTML, /200,000/);
  assert.match(container.innerHTML, /150,000/);
  assert.match(container.innerHTML, /650,000/);
  assert.match(container.innerHTML, /23\.5%/);
});
