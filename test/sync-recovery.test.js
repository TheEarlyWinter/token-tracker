import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import app from '../index.js';
import registerRoutes from '../server/dashboard.js';
import { createFakeRuntime } from './helpers/fake-runtime.mjs';

function fixture(dataDir) {
  let failure = null;
  const ctx = {dataDir, runtime:createFakeRuntime().api,logger:{info(){},warn(){}},bus:{
    request:async verb=>{
      if(verb==='usage:list') { if(failure)throw failure;return {entries:[{requestId:'one',status:'ok',startedAt:'2026-10-07T00:00:00Z',attribution:{agentId:'a',sessionId:'s'},model:{provider:'p',modelId:'unpriced'},usage:{input:{totalTokens:200000000},output:{totalTokens:20},totalTokens:200000020}}]}; }
      return {};
    },subscribe:()=>()=>{}
  }};
  return {ctx,fail:e=>{failure=e;}};
}
function routes(ctx) {
  const handlers={};registerRoutes({get:(p,f)=>{handlers[p]=f;},post(){}},ctx);
  return async p=>handlers[p]({req:{query:k=>k==='range'?'all':''},json:(body,status=200)=>({body,status})});
}
test('sync failure preserves exact previous snapshot, exposes stale data, recovers and survives reload',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tracker-sync-'));
  const f=fixture(dir);
  try{
    await app.apply(f.ctx);let shared=f.ctx._tokenCache;
    await shared.scan(false);const previous=shared.data;
    const statusBefore=shared.status();
    f.fail(Object.assign(new Error('sk-secret /private/path'),{code:'PERMISSION_DENIED'}));
    await assert.rejects(shared.scan(false),{code:'LEDGER_SYNC_FAILED'});
    assert.equal(shared.data,previous);
    assert.equal(shared.status().freshness.lastSuccessAt,statusBefore.freshness.lastSuccessAt);
    assert.equal(shared.status().freshness.syncFailed,true);
    assert.doesNotMatch(JSON.stringify(shared.status()),/sk-secret|private/);
    const get=routes(f.ctx);
    const res=await get('/data');assert.equal(res.status,200);
    assert.equal(res.body.summary.totalTokens,200000020);
    assert.equal(res.body._modelCosts[0].priced,false);
    assert.equal(res.body._modelCosts[0].callCount,1);
    assert.equal(res.body.models[0].assistantCount,1);
    await shared.dispose();
    await app.apply(f.ctx);shared=f.ctx._tokenCache;
    await assert.rejects(shared.scan(false),{code:'LEDGER_SYNC_FAILED'});
    assert.equal(shared.status().freshness.dataAvailable,true);
    assert.equal(Object.values(shared.data.sessions)[0].totalTokens,200000020);
    f.fail(null);await shared.scan(false);
    assert.equal(shared.status().freshness.syncFailed,false);
    assert.equal(shared.health.components.get('ledger').state,'ok');
    assert.equal(shared.health.components.get('scanner').state,'ok');
  }finally{await f.ctx._tokenCache?.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
test('first sync denied remains unknown data instead of zero usage and status is independently accessible',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tracker-first-'));const f=fixture(dir);
 f.fail(Object.assign(new Error('denied'),{code:'PERMISSION_DENIED'}));
 try{await app.apply(f.ctx);await assert.rejects(f.ctx._tokenCache.scan(false));
   const get=routes(f.ctx);const res=await get('/data');assert.equal(res.status,503);assert.equal(res.body.summary,undefined);
   const status=(await get('/status')).body;assert.equal(status.freshness.dataAvailable,false);assert.equal(status.freshness.lastSuccessAt,null);
   assert.equal(status.components.find(c=>c.id==='ledger').code,'permission_denied');
 }finally{await f.ctx._tokenCache?.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
