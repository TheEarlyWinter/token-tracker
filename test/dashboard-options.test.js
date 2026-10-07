import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDashboardOptions } from '../lib/dashboard-options.mjs';

test('current model choices exclude retired and unattributed IDs while retaining historical totals',()=>{
 const result={summary:{totalTokens:200000000},models:[{id:'qwen3.8-flash',totalTokens:200000000},{id:'unknown',totalTokens:0,assistantCount:6}],modelOptions:['active','qwen3.8-flash','unknown'],providerOptions:[{provider:'retired'}]};
 applyDashboardOptions(result,[{id:'current',models:['active','configured-without-usage']}],true);
 assert.deepEqual(result.modelOptions,['active','configured-without-usage']);assert.equal(result.modelStates['qwen3.8-flash'],'historical');assert.equal(result.modelStates.unknown,'unattributed');
 assert.equal(result.models[0].totalTokens,200000000);assert.equal(result.summary.totalTokens,200000000);
 assert.deepEqual(result.providerOptions,[{provider:'current',state:'current'},{provider:'retired',state:'historical'}]);assert.deepEqual(result.providers,[]);
});
test('unavailable configuration is not evidence that every model/provider has been deleted',()=>{
 const result={modelOptions:['archive','unknown'],providerOptions:[{provider:'archive-provider'}]};
 applyDashboardOptions(result,[],false);
 assert.deepEqual(result.modelOptions,['archive']);assert.equal(result.modelStates.archive,'unconfirmed');assert.equal(result.providerOptions[0].state,'unconfirmed');
});
