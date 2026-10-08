import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../ui/model-filter-options.js';
const source = fs.readFileSync(new URL('../ui/dashboard-app.js', import.meta.url), 'utf8');
function extract(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0);
  const lineEnd = source.indexOf('\n', start);
  if(source.slice(start,lineEnd).endsWith('}')) return source.slice(start,lineEnd);
  return source.slice(start, source.indexOf('\n}',start)+2);
}
function env(data) {
  const elements = {'cs-section': {style:{}, innerHTML:''}};
  const ctx = vm.createContext({D:data,_fxRate:null,_dispCur:'CNY',document:{getElementById:id=>elements[id]},console});
  for(const name of ['$', 'fmt', 'fmtAxis', 'cny', 'dual', 'toUsd', 'dualByCur', 'escHTML', 'modelLabel', 'renderConsumption']) vm.runInContext(extract(name),ctx);
  return {ctx,elements};
}
test('USD rows and totals fall back to USD with no exchange rate, including zero', () => {
  const {ctx}=env({});
  assert.equal(vm.runInContext('dualByCur(0.0083,"USD")',ctx),'$0.0083');
  assert.equal(vm.runInContext('dual(0.0083)',ctx),'$0.0083');
  assert.equal(vm.runInContext('dual(0)',ctx),'$0');
  assert.equal(vm.runInContext('toUsd(20,"CNY")',ctx),null);
});
test('unpriced 200 million token model remains visible even when all costs are unknown', () => {
  const {ctx,elements}=env({_modelCosts:[{model:'unpriced',totalTokens:200000000,cost:0,priced:false}],models:[{id:'unpriced',input:200000000,totalTokens:200000000}]});
  vm.runInContext('renderConsumption()',ctx);
  assert.equal(elements['cs-section'].style.display,'');
  assert.match(elements['cs-section'].innerHTML,/unpriced/);
  assert.match(elements['cs-section'].innerHTML,/200,000,000/);
  assert.match(elements['cs-section'].innerHTML,/未定价/);
});

test('CNY amount stays native and unknown conversion is omitted from totals without FX',()=>{
 const {ctx,elements}=env({_modelCosts:[{model:'cny',totalTokens:100,cost:20,currency:'CNY',priced:true}],models:[{id:'cny',input:100,totalTokens:100}]});
 vm.runInContext('renderConsumption()',ctx);
 assert.match(elements['cs-section'].innerHTML,/¥20.00/);
 assert.doesNotMatch(elements['cs-section'].innerHTML,/\$20/);
 assert.match(elements['cs-section'].innerHTML,/部分费用/);
 assert.match(elements['cs-section'].innerHTML,/缺少汇率/);
});
test('model ranking renders real calls and omits cost columns and notes',()=>{
 const {ctx}=env({models:[{id:'unpriced',totalTokens:200000000,assistantCount:23}],_modelCosts:[{model:'unpriced',cost:0,priced:false}]});
 const title={textContent:''};const list={style:{},innerHTML:'',addEventListener(){}};
 const canvas={style:{},parentElement:{querySelector:()=>title}};
 Object.assign(ctx,{chartColors:()=>({agent:['gray'],doughnut:['gray']}),mc:null,_selAgent:'',_selModel:'',_showDeleted:false,_provRowHtml:'',_modelProv:'',$:id=>id==='mc'?canvas:id==='mc-list'?list:null});
 vm.runInContext(extract('renderModel'),ctx);vm.runInContext('renderModel()',ctx);
 assert.match(list.innerHTML,/23 次/);assert.doesNotMatch(list.innerHTML,/无数据/);
 assert.doesNotMatch(list.innerHTML,/费用/);
});
test('a stale UI version is visible and diagnostic preview identifies both versions',()=>{
 const {ctx}=env({});
 const nodes=Object.fromEntries(['health-summary','runtime-health','lu','health-details','coverage-help','diagnostic-text'].map(id=>[id,{textContent:'',innerHTML:'',classList:{toggle(){}}}]));
 ctx.document.body={dataset:{uiVersion:'6.4.10'}};
 Object.assign(ctx,{$:id=>nodes[id],_status:{pluginVersion:'6.4.11',hostVersion:'未知',components:[],metrics:{},freshness:{intervalMs:60000}},_viewError:false});
 for(const name of ['localTime','diagnosticText','renderStatus'])vm.runInContext(extract(name),ctx);
 vm.runInContext('renderStatus()',ctx);
 assert.match(nodes['health-summary'].textContent,/界面版本已过期/);
 assert.match(nodes['diagnostic-text'].textContent,/插件版本：6.4.11/);
 assert.match(nodes['diagnostic-text'].textContent,/界面版本：6.4.10/);
});
test('supplier dropdown uses stable catalog and models use current configuration rather than archived IDs',()=>{
 const {ctx}=env({agentNames:{},providerOptions:[{provider:'live',state:'current'},{provider:'past',state:'historical'}],modelOptions:['active'],modelStates:{'qwen3.8-flash':'historical',unknown:'unattributed'}});
 const widgets=Object.fromEntries(['sa','sp','sm'].map(id=>[id,{list:{innerHTML:''},text:{textContent:''},querySelector(selector){return selector==='.cs-list'?this.list:this.text}}]));
 Object.assign(ctx,{$:id=>widgets[id],_selAgent:'',_selProvider:'',_selModel:'',_allAgents:[],_allProviders:ctx.D.providerOptions,_allModels:[{id:'qwen3.8-flash'},{id:'unknown'}],_pn:id=>id,window:{TokenTrackerModelOptions:globalThis.TokenTrackerModelOptions}});
 vm.runInContext(extract('updateFilterOpts'),ctx);vm.runInContext('updateFilterOpts()',ctx);
 assert.match(widgets.sp.list.innerHTML,/data-v="live"/);assert.doesNotMatch(widgets.sp.list.innerHTML,/data-v="past"/);assert.doesNotMatch(widgets.sp.list.innerHTML,/历史配置/);
 assert.match(widgets.sm.list.innerHTML,/active/);assert.doesNotMatch(widgets.sm.list.innerHTML,/qwen3.8-flash|unknown/);
});
test('historical token detail remains visible with an explicit label and zero-token unknown is not a model row',()=>{
 const {ctx,elements}=env({_modelCosts:[{model:'qwen3.8-flash',totalTokens:200000000,cost:0,priced:false},{model:'unknown',totalTokens:0,cost:0,priced:false,callCount:6}],models:[{id:'qwen3.8-flash',totalTokens:200000000,input:200000000},{id:'unknown',totalTokens:0,assistantCount:6}],modelStates:{'qwen3.8-flash':'historical',unknown:'unattributed'}});
 vm.runInContext('renderConsumption()',ctx);
 assert.match(elements['cs-section'].innerHTML,/历史，当前未配置/);assert.match(elements['cs-section'].innerHTML,/200,000,000/);assert.doesNotMatch(elements['cs-section'].innerHTML,/unknown/);
});
