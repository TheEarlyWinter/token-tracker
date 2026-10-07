import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createLedgerEngine } from '../runtime/engine/ledger-engine.mjs';

const source = fs.readFileSync(new URL('../server/dashboard.js', import.meta.url), 'utf8');
const context = vm.createContext({ fs, path, Intl, Date, DEFAULT_PRICE_TABLE: {} });
vm.runInContext(source.slice(source.indexOf('function pickPrice('), source.indexOf('// 缓存汇率')), context);
vm.runInContext(source.slice(source.indexOf('function build(cache,')), context);
const build = context.build;
const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'}).format(new Date());
const records = [
  ['a', 'desktop', 'p1', 'shared', 10, today, '08'],
  ['a', 'desktop', 'p1', 'other', 30, today, '08'],
  ['a', 'desktop', 'p2', 'shared', 50, today, '09'],
  ['b', 'desktop', 'p1', 'shared', 70, today, '10'],
  ['a', 'channel', 'p1', 'shared', 90, today, '11'],
  ['a', 'desktop', 'p1', 'shared', 110, '2020-01-02', '12'],
];

test('hourly trend, daily trend, model detail and overview use the same filter intersection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-filters-'));
  const engine = createLedgerEngine({ dataDir:dir, log:{info(){},warn(){},error(){}} });
  t.after(()=>{engine.close();fs.rmSync(dir,{recursive:true,force:true});});
  await engine.scan(records.map(([agent,kind,provider,model,total,day,hour],i)=>({
    requestId:`filter-${i}`,startedAt:`${day}T${hour}:00:00+08:00`,status:'ok',
    source:{subsystem:'session'},attribution:{agentId:agent,sessionId:`session-${i}`,kind:kind==='channel'?'phone':'session',conversationType:kind},
    model:{provider,modelId:model},usage:{input:{totalTokens:total,uncachedTokens:total-2},output:{totalTokens:0},cache:{readTokens:2,writeTokens:0},totalTokens:total},
  })),{});
  const snapshot = engine.getData();
  const cases = [
    [{},250,5], [{model:'shared'},220,4], [{provider:'p1'},200,4],
    [{agent:'a'},180,4], [{type:'desktop'},160,4],
    [{agent:'a',model:'shared',provider:'p1',type:'desktop'},10,1],
    [{model:'absent'},0,0], [{provider:'absent',model:'shared'},0,0],
  ];
  for (const [filters,tokens,calls] of cases) {
    const d=build(snapshot,'today',filters);
    const sum=(rows,key)=>rows.reduce((s,r)=>s+(r[key]||0),0);
    assert.equal(d.summary.totalTokens,tokens,JSON.stringify(filters));
    for(const rows of [d.hourly,d.daily,d.models]){
      assert.equal(sum(rows,'totalTokens'),tokens,JSON.stringify(filters));
      assert.equal(sum(rows,'assistantCount'),calls,JSON.stringify(filters));
      assert.equal(sum(rows,'cacheRead'),calls*2,JSON.stringify(filters));
    }
    assert.equal(sum(d.hourly,'desktop')+sum(d.hourly,'channel'),tokens);
  }
  const historical=build(snapshot,'all',{from:'2020-01-02',to:'2020-01-02',model:'shared'});
  assert.equal(historical.hourly.reduce((s,h)=>s+h.totalTokens,0),110);
  assert.equal(historical.hourly.find(h=>h.hour==='12').totalTokens,110);
  const excluded=build(snapshot,'today',{to:'2020-01-02'});
  assert.equal(excluded.summary.totalTokens,0);
  assert.equal(excluded.hourly.reduce((s,h)=>s+h.totalTokens,0),0);
});
