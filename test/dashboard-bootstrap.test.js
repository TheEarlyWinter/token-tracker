import test from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../ui/bootstrap.js';

test('Hana iframe initializes the official SDK before loading dashboard code', async()=>{
  const trace=[];const targetWindow={parent:{},location:{pathname:'/api/apps/token-tracker/ui/dashboard-v6.4.11.html'},document:{getElementById(){}}};
  const sdk={ready(){trace.push('ready')}};
  const ok=await startDashboard({targetWindow,sdk,load:async()=>{assert.equal(targetWindow.hana,sdk);trace.push('load')}});
  assert.equal(ok,true);assert.deepEqual(trace,['ready','load']);
});
test('standalone preview does not attempt a host handshake',async()=>{
  const targetWindow={document:{getElementById(){}}};targetWindow.parent=targetWindow;
  assert.equal(await startDashboard({targetWindow,sdk:{ready(){throw Error('must not run')}},load:async()=>{}}),true);
  assert.equal(targetWindow.hana,undefined);
});
test('legacy backend HTML can load without claiming a static App surface',async()=>{
  const targetWindow={parent:{},location:{pathname:'/api/apps/token-tracker/routes/dashboard'},document:{getElementById(){}}};
  assert.equal(await startDashboard({targetWindow,sdk:{ready(){throw Error('invalid surface')}},load:async()=>{}}),true);
});
test('startup failure leaves a visible explanation without exposing raw errors',async()=>{
  const app={textContent:''};const targetWindow={document:{getElementById:()=>app}};targetWindow.parent=targetWindow;
  assert.equal(await startDashboard({targetWindow,load:async()=>{throw Error('secret-token /private/path')}}),false);
  assert.match(app.textContent,/启动失败/);assert.doesNotMatch(app.textContent,/secret|private/);
});
