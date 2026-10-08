import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import registerRoutes from '../server/dashboard.js';
import { saveTurnsExport } from '../lib/turns-export.mjs';
import { createTurnsInspector } from '../ui/modules/turns-inspector.js';

function routeHarness(ctx) {
  const routes = {};
  registerRoutes({ get: (p, fn) => { routes['GET ' + p] = fn; }, post: (p, fn) => { routes['POST ' + p] = fn; } }, ctx);
  return (method, route, query = {}) => routes[method + ' ' + route]({
    req: { query: key => query[key] },
    json: (body, status = 200) => ({ body, status }),
    text: (body, status = 200) => ({ body, status }),
  });
}

test('export writes all 23,075 rows with BOM to unique files and returns disk receipts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turns-export-'));
  try {
    const conversations = Array.from({ length: 23075 }, (_, i) => ({ time: '2026-10-08T01:00:00Z', model: '测试模型' + i, totalTokens: 123, inTokens: 100 }));
    const dispatch = routeHarness({ dataDir, _tokenCache: { ready: true, turnsStore: {}, data: { sessions: { s: { agent: '测试', conversations } } } } });
    const expected = await dispatch('GET', '/turns/csv');
    const [first, second] = await Promise.all([dispatch('POST', '/turns/export'), dispatch('POST', '/dashboard/turns/export')]);
    assert.equal(first.status, 200);
    assert.equal(first.body.saved, true);
    assert.equal(first.body.rowCount, 23075);
    assert.ok(first.body.bytes > 1024 * 1024);
    assert.notEqual(first.body.path, second.body.path);
    assert.equal(path.dirname(first.body.path), path.join(dataDir, 'exports'));
    const actual = await fs.readFile(first.body.path, 'utf8');
    assert.equal(actual, expected.body);
    assert.equal(actual.charCodeAt(0), 0xfeff);
    assert.equal(actual.split('\r\n').length, 23076);
    assert.equal((await fs.stat(first.body.path)).size, first.body.bytes);
    assert.equal((await fs.readdir(path.join(dataDir, 'exports'))).length, 2);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('export preserves filters and sorting without pagination or accepting a destination', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turns-export-'));
  try {
    const data = { sessions: { a: { agent: 'a', type: 'desktop', conversations: [
      { time: '2026-10-08T01:00:00Z', model: 'm', provider: 'p', totalTokens: 10 },
      { time: '2026-10-08T02:00:00Z', model: 'm', provider: 'p', totalTokens: 30 },
      { time: '2026-10-07T01:00:00Z', model: 'm', provider: 'p', totalTokens: 50 },
      { time: '2026-10-08T01:00:00Z', model: 'other', provider: 'p', totalTokens: 40 },
    ] } } };
    const dispatch = routeHarness({ dataDir, _tokenCache: { ready: true, turnsStore: {}, data } });
    const result = await dispatch('POST', '/turns/export', { from: '2026-10-08', to: '2026-10-08', agent: 'a', model: 'm', provider: 'p', type: 'desktop', minTokens: '15', sortKey: 'tokens', pageSize: '1', path: '/tmp/unauthorized.csv' });
    assert.equal(result.status, 200);
    assert.equal(result.body.rowCount, 1);
    assert.equal(path.dirname(result.body.path), path.join(dataDir, 'exports'));
    assert.match(await fs.readFile(result.body.path, 'utf8'), /"30"/);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('export reports not-ready and filesystem failures without claiming success', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turns-export-'));
  try {
    const ctx = { dataDir, _tokenCache: { ready: false, turnsStore: {} } };
    const dispatch = routeHarness(ctx);
    assert.equal((await dispatch('POST', '/turns/export')).status, 503);
    assert.deepEqual(await fs.readdir(dataDir), []);
    ctx._tokenCache.ready = true;
    await fs.writeFile(path.join(dataDir, 'exports'), 'blocked');
    const failed = await dispatch('POST', '/turns/export');
    assert.equal(failed.status, 500);
    assert.match(failed.body.error, /保存 CSV 失败/);
    assert.equal(failed.body.saved, undefined);
    await assert.rejects(saveTurnsExport({ dataDir: '', csv: '', rowCount: 0 }), /目录不可用/);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

class Element {
  children = [];
  selectors = new Map();
  appendChild(child) { this.children.push(child); }
  setAttribute() {}
  style = {};
  set innerHTML(value) { this.children = []; this.html = value; }
  querySelector(selector) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector);
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('card export uses POST only, keeps busy state across reloads and requires a confirmed save', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  try {
    const container = new Element();
    let finish;
    let requests = 0;
    const inspector = createTurnsInspector({ container, fetchFn: async (url, options) => {
      if (url.startsWith('/turns?')) return { ok: true, json: async () => ({ rows: [], total: 0, sumTokens: 0, totalPages: 1 }) };
      assert.ok(url.startsWith('/turns/export?'));
      assert.equal(options.method, 'POST');
      requests++;
      return await new Promise(resolve => { finish = resolve; });
    } });
    await flush();
    const button = () => container.children[0].children[0].querySelector('.turns-export-btn');
    const pending = button().onclick();
    inspector.reload();
    await flush();
    assert.equal(button().disabled, true);
    await button().onclick();
    assert.equal(requests, 1);
    finish({ ok: true, json: async () => ({ saved: true, path: '/app-data/exports/test.csv', rowCount: 23075 }) });
    await pending;
    assert.equal(button().disabled, false);
    const result = container.children[0].children[1];
    assert.match(result.children[0].textContent, /已保存/);
    assert.equal(result.children[1].value, '/app-data/exports/test.csv');
    const unconfirmed = button().onclick();
    finish({ ok: true, json: async () => ({}) });
    await unconfirmed;
    assert.match(container.children[0].children[1].children[0].textContent, /导出失败/);
    const denied = button().onclick();
    finish({ ok: false, json: async () => ({ error: '磁盘写入被拒绝' }) });
    await denied;
    assert.match(container.children[0].children[1].children[0].textContent, /磁盘写入被拒绝/);
  } finally { globalThis.document = previous; }
});
