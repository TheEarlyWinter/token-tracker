// 在本机静态测试服务器中导入并调用 runBrowserReviewSmoke()。
// 只使用假网络。不查询账户，不调用真实核销接口。
import { renderCodexQuotaCard } from '../ui/modules/codex-card.js';
import { showResetCreditsModal } from '../ui/modules/reset-credits-modal.js';
import { createTurnsInspector } from '../ui/modules/turns-inspector.js';
import { createDeepSeekUsage } from '../ui/modules/deepseek-usage.js';
import { createLithosSpend } from '../ui/modules/lithos-spend.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const response = body => ({ ok: true, status: 200, json: async () => body });
const cards = [{ id: 'fake-a', title: '测试卡 A', status: 'available' }, { id: 'fake-b', title: '测试卡 B', status: 'available' }];
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export async function runBrowserReviewSmoke() {
  const results = [];
  const root = document.createElement('section');
  document.body.append(root);
  try {
    let consumes = 0;
    renderCodexQuotaCard(root, { connected: true, resetCredits: 2 }, {
      onOpenResetModal: async () => false,
      onFetchResetCredits: async () => ({ connected: true, credits: cards }),
      onConsumeResetCredit: async () => { consumes++; return { ok: false, message: '测试失败后可重试' }; },
    });
    root.querySelector('#sb-codex-credit-toggle').click();
    await tick();
    root.querySelector('[data-act="prepare"][data-credit-id="fake-a"]').click();
    root.querySelector('[data-act="prepare"][data-credit-id="fake-b"]').click();
    root.querySelector('[data-act="confirm"][data-credit-id="fake-a"]').click();
    await tick();
    assert(consumes === 1, '小弹窗重复核销');
    assert(root.querySelector('[data-act="prepare"][data-credit-id="fake-a"]'), '失败后未恢复按钮');
    results.push('小弹窗：原生 DOM 多卡交替确认仅核销一次，失败可重试');

    root.replaceChildren();
    let releaseOpen;
    let openStarted = false;
    let listFetches = 0;
    const openGate = new Promise(resolve => { releaseOpen = resolve; });
    const raceHandlers = {
      onOpenResetModal: () => {
        openStarted = true;
        return openGate;
      },
      onFetchResetCredits: async () => {
        listFetches++;
        return { connected: true, credits: cards };
      },
      onConsumeResetCredit: async () => ({ ok: false, message: '测试失败后可重试' }),
    };
    renderCodexQuotaCard(root, { connected: true, resetCredits: 2 }, raceHandlers);
    const firstModal = root.querySelector('#sb-codex-reset-modal');
    root.querySelector('#sb-codex-credit-toggle').click();
    await tick();
    assert(openStarted, '首次点击未进入弹窗打开流程');
    renderCodexQuotaCard(root, { connected: true, resetCredits: 2 }, raceHandlers);
    const currentModal = root.querySelector('#sb-codex-reset-modal');
    releaseOpen(false);
    await tick();
    await tick();
    assert(currentModal === firstModal, '重绘替换了仍在等待的弹窗节点');
    assert(currentModal.isConnected, '复用后的弹窗节点未留在 DOM');
    assert(currentModal.style.display === 'flex', '首次点击未打开重绘后的当前弹窗');
    assert(listFetches === 1, '首次点击未保持单次列表请求');
    results.push('小弹窗：等待打开判定期间重绘仍复用当前弹窗，首次点击生效');

    root.replaceChildren();
    consumes = 0;
    const modal = showResetCreditsModal({ container: root, fetchFn: async endpoint => {
      if (endpoint.includes('/consume')) { consumes++; return response({ ok: false, message: '测试失败' }); }
      return response({ connected: true, credits: cards });
    } });
    await tick();
    root.querySelector('[data-act="prepare"][data-credit-id="fake-a"]').click();
    root.querySelector('[data-act="prepare"][data-credit-id="fake-b"]').click();
    root.querySelector('[data-act="confirm"][data-credit-id="fake-a"]').click();
    await tick();
    assert(consumes === 1, '大弹窗重复核销');
    modal.close();
    assert(!root.querySelector('.sb-codex-modal-overlay'), '关闭未移除大弹窗');
    results.push('大弹窗：原生 DOM 多卡交替确认仅核销一次，可正常关闭');

    root.replaceChildren();
    let filters = { from: '2026-10-26', to: '2026-10-26' };
    const pending = [];
    const turns = createTurnsInspector({ container: root, getFilters: () => filters, fetchFn: url => new Promise(resolve => pending.push({ url, resolve })) });
    filters = { from: '2026-10-27', to: '2026-10-27' };
    turns.reload(true);
    const row = (id, count) => ({ rows: [{ requestId: id, at: '2026-10-27T01:00:00Z', total: count, input: 10, cacheRead: 90, output: 5, agent: id }], total: 1, sumTokens: count, totalPages: 1 });
    pending[1].resolve(response(row('new-request', 123)));
    await tick();
    pending[0].resolve(response(row('old-request', 456)));
    await tick();
    assert(root.querySelector('tr[data-request-id="new-request"]'), '新筛选结果丢失');
    assert(!root.querySelector('tr[data-request-id="old-request"]'), '旧筛选结果覆盖新结果');
    assert(root.querySelector('tr[data-request-id="new-request"] .col-hit').textContent.includes('90.0%'), '调用明细命中率口径错误');
    root.querySelector('tr[data-request-id="new-request"]').click();
    await tick();
    root.querySelector('tr[data-request-id="new-request"]').click();
    pending[2].resolve(response({ ok: true, calls: [], totals: {}, callCount: 0 }));
    await tick();
    assert(!root.querySelector('.turns-detail'), '关闭详情后被迟到响应重新打开');
    results.push('调用明细：原生 DOM 旧响应不可覆盖新筛选，关闭详情不可复活');

    for (const [name, create] of [['DeepSeek', createDeepSeekUsage], ['Lithos', createLithosSpend]]) {
      root.replaceChildren();
      filters = { from: '2026-10-26', to: '2026-10-26' };
      const requests = [];
      const bills = create({ container: root, getFilters: () => filters, fetchFn: url => {
        if (url.startsWith('/lithos-balance')) return Promise.resolve(response({ connected: true, display: '$1' }));
        return new Promise(resolve => requests.push({ url, resolve }));
      } });
      bills.ensure();
      filters = { from: '2026-10-27', to: '2026-10-27' };
      bills.reloadWithFilters();
      requests[0].resolve(response({ connected: true, start: '2026-10-26', end: '2026-10-26', days: [], models: [], totalUsd: 0 }));
      await tick();
      assert(requests.length === 2, name + ' 丢失加载中日期切换');
      assert(requests[1].url.includes('start=2026-10-27'), name + ' 未查询最新日期');
      requests[1].resolve(response({ connected: true, start: '2026-10-27', end: '2026-10-27', days: [], models: [], totalUsd: 0 }));
      await tick();
      bills.reloadWithFilters();
      assert(requests.length === 2, name + ' 稳定筛选产生额外查询');
      bills.destroy();
      results.push(name + '：加载中切换日期会合并到最新请求，稳定筛选无额外查询');
    }
  } finally {
    root.remove();
  }
  return { passed: results.length, results };
}
