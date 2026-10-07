import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHealth, classifyError, metricReason } from '../lib/runtime-health.mjs';

test('health is unknown until evidence arrives; fixed components and safe diagnostics', () => {
  let now = 1000;
  const health = new RuntimeHealth({ clock: () => now, version: '6.4.10' });
  assert.ok(health.snapshot().components.every(c => c.state === 'unknown'));
  health.set('ledger', 'degraded', classifyError({ code: 'PERMISSION_DENIED', message: 'sk-secret /private/session.jsonl' }));
  health.set('arbitrary-secret', 'ok', 'sk-secret');
  const diagnostic = JSON.stringify(health.snapshot());
  assert.doesNotMatch(diagnostic, /sk-secret|private|arbitrary-secret/);
  assert.equal(health.snapshot().components.length, 5);
  now++;
  health.set('ledger', 'ok', 'ledger_ok');
  assert.equal(health.snapshot().components.find(c => c.id === 'ledger').code, 'ledger_ok');
  health.clear();
  assert.equal(health.snapshot().components.length, 0);
});

test('failure classification only emits allowed codes, and reasons distinguish pending from failure', () => {
  for (const [input, expected] of [[{status:429}, 'rate_limited'], [{status:502}, 'provider_error'], [{code:'ETIMEDOUT'}, 'timeout'], [{name:'AbortError'}, 'cancelled'], [{code:'FORBIDDEN'}, 'permission_denied'], [{code:'sk-secret'}, 'request_failed']]) {
    assert.equal(classifyError(input), expected);
  }
  assert.match(metricReason('pending'), /尚未完成/);
  assert.match(metricReason('request_failed'), /失败/);
  assert.match(metricReason('no_sample'), /尚无有效样本/);
});

import { trackerStatus } from '../lib/runtime-health.mjs';
import { FirstResponseTimer, registerFirstResponseHooks } from '../lib/first-response.mjs';
import { GenerationSpeedTimer } from '../lib/generation-speed.mjs';
import { SessionCacheStatus } from '../lib/session-cache.mjs';

test('freshness uses configured cadence and running task status',()=>{
  const shared={ready:true,data:{lastScan:new Date(1000).toISOString()},scanIntervalMs:300000};
  assert.equal(trackerStatus(shared,400000).freshness.stale,false);
  assert.equal(trackerStatus(shared,700000).freshness.stale,true);
  shared.scanning=true;assert.equal(trackerStatus(shared,700000).freshness.stale,false);
});
test('pending, timeout, cancellation and successful recovery produce independent reasons',()=>{
  let now=0;const session={sessionId:'s',sessionPath:'/private/session.jsonl'};
  const first=new FirstResponseTimer({clock:()=>now,staleMs:1000});
  const speed=new GenerationSpeedTimer({clock:()=>now,staleMs:1000});
  first.begin(session);speed.begin(session);
  assert.equal(first.latest(session).reason,'pending');assert.equal(speed.latest(session,'p/m').reason,'pending');
  now=1001;
  assert.equal(first.latest(session).reason,'timeout');assert.equal(speed.latest(session,'p/m').reason,'timeout');
  first.begin(session);speed.begin(session);
  first.fail(session,'cancelled');speed.fail(session,'cancelled');
  assert.equal(first.latest(session).reason,'cancelled');
  first.begin(session);speed.begin(session);now+=200;
  first.complete(session);speed.complete(session,{role:'assistant',provider:'p',model:'m',usage:{output:20}});
  assert.equal(first.latest(session).reason,'ok');assert.equal(speed.latest(session,'p/m').reason,'ok');
  first.begin(session);speed.begin(session);
  assert.equal(first.latest(session).historical,true);assert.equal(speed.latest(session,'p/m').historical,true);
});
test('registration without a receipt stays unknown; denial is evidence of degradation',async()=>{
  const statuses=[];
  const stop=await registerFirstResponseHooks({hooks:{onDecision:()=>null,on:()=>null},timer:new FirstResponseTimer(),onStatus:(...a)=>statuses.push(a)});
  assert.equal(statuses.length,0);await stop();
  const rejected=await registerFirstResponseHooks({hooks:{onDecision:()=>{throw Object.assign(new Error('sk-secret'),{code:'APP_CAPABILITY_DENIED'});},on:()=>()=>{}},timer:new FirstResponseTimer(),onStatus:(...a)=>statuses.push(a)});
  assert.deepEqual(statuses.at(-1),['degraded','permission_denied']);await rejected();
});
test('capsule publication captures actual host activation ambiguity and clears after success',async()=>{
  const health=new RuntimeHealth();let reject=true;
  const cache=new SessionCacheStatus({health,inputStatus:{set:async()=>{if(reject)throw new Error('App token-tracker needs app/input.status and activation in the target Agent');}}});
  await assert.rejects(cache.apply('s',{text:'速度：—'}));
  assert.equal(health.components.get('capsule').code,'activation_required');
  reject=false;await cache.apply('s',{text:'速度：10 tok/s'});
  assert.equal(health.components.get('capsule').state,'ok');await cache.dispose();
});
