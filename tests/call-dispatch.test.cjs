const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function compile(path,deps){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:n=>{if(n in deps)return deps[n];throw Error(n)},console,Date,URL,process});return exports;}
function harness(jobs,max=2,enabled=true){
 let tail=Promise.resolve();const matches=(j,w)=>Object.entries(w).every(([k,v])=>j[k]===v);
 const tx={ $queryRaw:async()=>[],checkout:{findUnique:async()=>({status:'ABANDONED',abandonedAt:new Date()})},settings:{findUnique:async()=>({maxAttempts:max,enabled})},callJob:{
 findFirst:async({where})=>jobs.find(j=>matches(j,where)),findMany:async({where})=>jobs.filter(j=>matches(j,where)),
 create:async({data})=>{const row={...data,id:`new-${jobs.length}`,providerCallId:null};jobs.push(row);return row;},
 update:async({where,data})=>Object.assign(jobs.find(j=>matches(j,where)),data),
 updateMany:async({where,data})=>{const found=jobs.filter(j=>matches(j,where));for(const j of found){j.status=data.status;j.outcome=data.outcome;j.attempts+=data.attempts.increment;}return {count:found.length};}
 }};
 const db={$transaction:fn=>{const run=tail.then(()=>fn(tx));tail=run.catch(()=>{});return run;}};
 return compile('app/lib/callDispatch.server.ts',{'../db.server':{default:db}});
}
const job=(id,attempts,status='COMPLETED',shop='shop',checkoutId='cart')=>({id,shop,checkoutId,attempts,status,providerCallId:null});
test('max attempts totals retries across jobs and survives reopening the cart',async()=>{const jobs=[job('old',2),job('next',0,'QUEUED')];assert.equal(await harness(jobs).claimCallJob('shop','next'),false);assert.equal(jobs[1].outcome,'MAX_ATTEMPTS_REACHED');assert.equal(jobs[1].attempts,0);});
test('two concurrent dispatchers cannot both start the last attempt',async()=>{const jobs=[job('old',1),job('a',0,'QUEUED'),job('b',0,'QUEUED')];const h=harness(jobs);const results=await Promise.all([h.claimCallJob('shop','a'),h.claimCallJob('shop','b')]);assert.equal(results.filter(Boolean).length,1);assert.equal(jobs.reduce((n,j)=>n+j.attempts,0),2);});
test('same job can only be claimed once',async()=>{const jobs=[job('a',0,'QUEUED')];const h=harness(jobs);assert.deepEqual(await Promise.all([h.claimCallJob('shop','a'),h.claimCallJob('shop','a')]),[true,false]);});
test('lowering the setting blocks already queued jobs',async()=>{const jobs=[job('old',1),job('next',0,'QUEUED')];assert.equal(await harness(jobs,1).claimCallJob('shop','next'),false);});
test('limits are isolated by store and checkout',async()=>{const jobs=[job('foreign',10,'COMPLETED','other'),job('other-cart',10,'COMPLETED','shop','other'),job('next',0,'QUEUED')];assert.equal(await harness(jobs,1).claimCallJob('shop','next'),true);});
test('paused automation consumes no attempt',async()=>{const jobs=[job('next',0,'QUEUED')];assert.equal(await harness(jobs,2,false).claimCallJob('shop','next'),false);assert.equal(jobs[0].attempts,0);});
test('legacy provider calls with zero counter still count',async()=>{const jobs=[{...job('old',0),providerCallId:'provider'},job('next',0,'QUEUED')];assert.equal(await harness(jobs,1).claimCallJob('shop','next'),false);});
function dashboard(){let starts=0;const jobs=[];const tx={$queryRaw:async()=>[],checkout:{upsert:async()=>({id:'test-cart'})},callJob:{findFirst:async({where})=>jobs.find(j=>j.id===where.id),create:async({data})=>jobs.push(data),updateMany:async()=>({count:1})}};const db={...tx,$transaction:fn=>fn(tx)};const route=compile('app/routes/app.dashboard.tsx',{'react':{},'react/jsx-runtime':{},'react-router':require('react-router'),'@shopify/shopify-app-react-router/server':{},'../shopify.server':{authenticate:{admin:async()=>({session:{shop:'shop'}})}},'../db.server':{default:db},'node:crypto':require('node:crypto'),'../lib/testCatalog.server':{},'../lib/testCall.shared':compile('app/lib/testCall.shared.ts',{}),'../callProvider.server':{startVapiCallForJob:async()=>{starts++}},'../lib/billing.server':{getAttemptAvailability:async()=>({allowed:true})},'../lib/billingPlans.shared':compile('app/lib/billingPlans.shared.ts',{}),'../lib/checkoutData.shared':{waitingReason:()=>null},'../callRecovery.server':{},'../components/dashboard/DashboardView':{}});return {route,jobs,starts:()=>starts};}
const request=(phone='+306900000000',intent='create_test_call')=>({formData:async()=>new Map(Object.entries({phone,intent,customerName:'Maria',currency:'EUR',items:JSON.stringify([{title:'Linen shirt',quantity:2,price:25}]),testCallId:'c8c7dce0-b2d4-4f4c-a464-26cc8f8fce75'}))});
test('dashboard POST starts test on explicit number and rejects replay',async()=>{const h=dashboard();assert.equal((await h.route.action({request:request()})).ok,true);assert.equal(h.jobs[0].phone,'+306900000000');assert.equal(h.jobs[0].shop,'shop');assert.equal((await h.route.action({request:request()})).ok,false);assert.equal(h.starts(),1);});
test('invalid number never creates or starts a call',async()=>{const h=dashboard();assert.equal((await h.route.action({request:request('bad')})).ok,false);assert.equal(h.jobs.length,0);assert.equal(h.starts(),0);});
test('Refresh POST works without starting a call',async()=>{const h=dashboard();assert.equal((await h.route.action({request:request('','sync_now')})).ok,true);assert.equal(h.starts(),0);});
test('test carts are excluded from automatic abandonment',async()=>{let filter;const mod=compile('app/callRecovery.server.ts',{'./db.server':{default:{checkout:{updateMany:async({where})=>{filter=where;return {count:0}}}}},'./lib/privacy.server':{},'./lib/checkoutData.shared':{}});await mod.markAbandonedByDelay('shop',30);assert.equal(filter.checkoutId.not.startsWith,'test-');});

test('manual call can exceed the limit while automation is paused',async()=>{const jobs=[job('old',3),job('next',0,'QUEUED')];assert.equal(await harness(jobs,1,false).claimManualCallJob('shop','next'),'next');assert.equal(jobs[1].attempts,1);});
test('manual retry of a completed call gets a new billing identity',async()=>{const jobs=[{...job('old',3),providerCallId:'previous-provider'}];const h=harness(jobs,1);const id=await h.claimManualCallJob('shop','old');assert.notEqual(id,'old');assert.equal(jobs[1].status,'CALLING');assert.equal(jobs[0].providerCallId,'previous-provider');assert.equal(await h.claimManualCallJob('shop','old'),null);});
test('manual call does not bypass shop isolation',async()=>{const jobs=[job('old',3,'COMPLETED','other')];assert.equal(await harness(jobs).claimManualCallJob('shop','old'),null);});

test('old phone-only dashboard submission opens the full test form without calling',async()=>{
 const h=dashboard();const req={url:'https://app.example/app/dashboard?shop=shop',formData:async()=>new Map([['intent','create_test_call'],['phone','+306900000000']])};
 const result=await h.route.action({request:req});assert.equal(result.status,302);assert.equal(result.headers.get('Location'),'/app/test-call?shop=shop');assert.equal(result.headers.get('X-Remix-Reload-Document'),'true');assert.equal(h.starts(),0);
});
