import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtReset,
  fmtUsdDollar,
  quotaColor,
  renderHdrQuota,
  renderSubscriptionQuotas,
} from '../ui/modules/subscription-quotas.js';

test('fmtReset formats seconds into readable intervals', () => {
  assert.equal(fmtReset(0), '即将重置');
  assert.equal(fmtReset(45), '45秒后重置');
  assert.equal(fmtReset(120), '2分后重置');
  assert.equal(fmtReset(3600), '1时后重置');
  assert.equal(fmtReset(3660), '1时1分后重置');
  assert.equal(fmtReset(86400), '1天后重置');
  assert.equal(fmtReset(90000), '1天1时后重置');
});

test('quotaColor returns appropriate CSS color variables based on threshold', () => {
  assert.equal(quotaColor(40), 'var(--green)');
  assert.equal(quotaColor(65), 'var(--orange)');
  assert.equal(quotaColor(85), 'var(--red)');
});

test('renderHdrQuota renders quota pills or hides when no data exists', () => {
  const container = { style: { display: '' }, innerHTML: '' };
  renderHdrQuota({ container, quotas: [] });
  assert.equal(container.style.display, 'none');

  const ogQuota = {
    type: 'opencode-go-quota',
    windows: [{ level: 'rolling', usedPercent: 40, resetInSec: 1800 }],
  };
  renderHdrQuota({ container, quotas: [ogQuota] });
  assert.equal(container.style.display, '');
  assert.match(container.innerHTML, /5小时/);
  assert.match(container.innerHTML, /剩余 60%/);
});

test('estimated-only subscription data remains visible when official quota is unavailable', () => {
  const container = { style: { display: 'none' }, innerHTML: '' };
  renderSubscriptionQuotas({
    container,
    quotas: [{
      type: 'opencode-go-quota-est',
      label: 'OpenCode Go',
      est: true,
      windows: [{ level: 'rolling', usedUsd: 1, limitUsd: 12 }],
      monthlyModelUsage: [{ model: 'deepseek-v4-flash', costUsd: 2.5, count: 10 }],
    }],
    priceTable: { 'opencode-go/deepseek-v4-flash': { monthlyAllowance: 60 } },
  });
  assert.equal(container.style.display, '');
  assert.match(container.innerHTML, /本地估算/);
  assert.match(container.innerHTML, /deepseek-v4-flash/);
  assert.match(container.innerHTML, /2\.50/);
});

test('官方百分比窗口不拿硬编码月上限倒推金额', () => {
  const container = { style: { display: '' }, innerHTML: '' };
  renderHdrQuota({
    container,
    quotas: [{
      type: 'opencode-go-quota',
      label: 'OpenCode Go',
      est: false,
      windows: [
        { level: 'rolling', usedPercent: 25, remainingPercent: 75, resetInSec: 1800, known: true },
        { level: 'monthly', usedPercent: 80, remainingPercent: 20, resetInSec: 86400, known: true },
      ],
    }],
  });
  // 没有 limitUsd 就不能出现美元金额
  assert.doesNotMatch(container.innerHTML, /\$/);
  assert.match(container.innerHTML, /剩余 75%/);
  assert.match(container.innerHTML, /剩余 20%/);

  // 本地估算真有 usedUsd/limitUsd 时才写金额
  const estContainer = { style: { display: '' }, innerHTML: '' };
  renderHdrQuota({
    container: estContainer,
    quotas: [{
      type: 'opencode-go-quota-est',
      est: true,
      windows: [{ level: 'rolling', usedUsd: 3, limitUsd: 12 }],
    }],
    dual: (v) => '$' + Number(v).toFixed(2),
  });
  assert.match(estContainer.innerHTML, /\$9\.00/);
});

test('官方百分比窗口在没有按模型明细时也要画出三个窗口', () => {
  const container = { style: { display: 'none' }, innerHTML: '' };
  renderSubscriptionQuotas({
    container,
    quotas: [{
      type: 'opencode-go-quota',
      label: 'OpenCode Go',
      est: false,
      windows: [
        { level: 'rolling', usedPercent: 25, resetInSec: 1800, known: true },
        { level: 'weekly', usedPercent: 62.5, resetInSec: 3600, known: true },
        { level: 'monthly', usedPercent: null, known: false },
      ],
    }],
  });
  assert.equal(container.style.display, '');
  assert.match(container.innerHTML, /官方/);
  assert.match(container.innerHTML, /5小时/);
  assert.match(container.innerHTML, /已用 25%/);
  assert.match(container.innerHTML, /已用 62\.5%/);
  assert.doesNotMatch(container.innerHTML, /\$/);
});

test('renderSubscriptionQuotas correctly renders cards and badges', () => {
  const container = { style: { display: '' }, innerHTML: '' };
  const quotas = [
    {
      type: 'quota',
      label: 'DeepSeek 充值包',
      models: [{ label: 'deepseek-chat', used: 20, limit: 100 }],
    },
  ];

  renderSubscriptionQuotas({ container, quotas });
  assert.equal(container.style.display, '');
  assert.match(container.innerHTML, /DeepSeek 充值包/);
  assert.match(container.innerHTML, /已用 20%/);
});
