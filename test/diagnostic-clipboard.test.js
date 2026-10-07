import test from 'node:test';
import assert from 'node:assert/strict';
import { copyDiagnostic } from '../ui/diagnostic-clipboard.js';

test('native App copy uses SDK even when browser clipboard is unavailable',async()=>{
 const preview='Token Tracker 诊断摘要\n插件版本：6.4.12';let copied;
 assert.deepEqual(await copyDiagnostic(preview,{sdk:{clipboard:{writeText:async text=>{copied=text}}}}),{ok:true,method:'host'});
 assert.equal(copied,preview);
});
test('SDK denial does not claim success or bypass host permission with browser fallback',async()=>{
 let fallback=false;
 const result=await copyDiagnostic('summary',{sdk:{clipboard:{writeText:async()=>{throw Object.assign(Error('secret /private/path'),{code:'CAPABILITY_DENIED'})}}},browserClipboard:{writeText:async()=>{fallback=true}}});
 assert.deepEqual(result,{ok:false,reason:'permission_denied'});assert.equal(fallback,false);assert.doesNotMatch(JSON.stringify(result),/secret|private/);
});
test('standalone copy uses browser clipboard and reports missing capability',async()=>{
 let copied;
 assert.equal((await copyDiagnostic('summary',{browserClipboard:{writeText:async t=>{copied=t}}})).ok,true);assert.equal(copied,'summary');
 assert.deepEqual(await copyDiagnostic('summary'),{ok:false,reason:'unavailable'});
});
