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
