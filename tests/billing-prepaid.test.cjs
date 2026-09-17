const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function compile(path, dependencies = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => { if (!(name in dependencies)) throw new Error(name); return dependencies[name]; }, process, Date, URL, console, fetch: (...args) => dependencies.fetch(...args) });
  return exports;
}
const plans = compile('app/lib/billingPlans.shared.ts');
function fixture(overrides = {}) {
  const end = new Date(Date.now() + 86400000);
  const row = { shop: 'test.myshopify.com', plan: 'STARTER', status: 'ACTIVE', includedSecondsUsed: 29, freeSecondsUsed: 0, extraAttempts: 0, currentPeriodEnd: end, ...overrides };
  const charges = new Map(), purchases = new Map(), smsDeliveries = new Map();
  const matches = (v, w) => v && Object.entries(w).every(([k, x]) => v[k] === x);
  const apply = (v, data) => { for (const [k, x] of Object.entries(data)) v[k] = x && typeof x === 'object' && !(x instanceof Date) ? (v[k] || 0) + (x.increment || 0) - (x.decrement || 0) : x; return {...v}; };
  const db = {
    $queryRaw: async () => [],
    shopBilling: { upsert: async () => ({...row}), findUniqueOrThrow: async () => ({...row}), update: async ({data}) => apply(row, data) },
    callJob: { findFirst: async ({where}) => where.shop === row.shop ? { id: where.id, providerCallId: null } : null },
    callCharge: {
      findUnique: async ({where}) => charges.get(where.callJobId),
      create: async ({data}) => { if (charges.has(data.callJobId)) throw new Error('unique'); charges.set(data.callJobId, {...data}); },
      delete: async ({where}) => charges.delete(where.callJobId),
      updateMany: async ({where, data}) => { const c = charges.get(where.callJobId); if (c?.shop === where.shop) apply(c, data); }
    },
    smsDelivery: {
      findUnique: async ({where}) => [...smsDeliveries.values()].find(r => r.idempotencyKey === where.idempotencyKey) || null,
      findFirst: async ({where}) => [...smsDeliveries.values()].find(r => r.id === where.id && r.shop === where.shop && r.status === where.status) || null,
      count: async ({where}) => [...smsDeliveries.values()].filter(r => r.shop === where.shop && r.customerKey === where.customerKey && where.status.in.includes(r.status)).length,
      create: async ({data}) => { const r={id:`sms-${smsDeliveries.size+1}`,...data};smsDeliveries.set(r.id,r);return {...r}; },
      update: async ({where,data}) => { const r=smsDeliveries.get(where.id);apply(r,data);return {...r}; },
      updateMany: async ({where,data}) => { const r=smsDeliveries.get(where.id);if(!r||r.status!==where.status)return {count:0};apply(r,data);return {count:1}; },
    },
    attemptPurchase: {
      findFirst: async ({where}) => [...purchases.values()].find(p => matches(p, where)),
      updateMany: async ({where, data}) => { const p = purchases.get(where.id); if (!matches(p, where)) return {count: 0}; apply(p, data); return {count: 1}; },
      create: async ({data}) => { const p = {id: 'purchase', creditedAt: null, ...data}; purchases.set(p.id, p); return p; },
      update: async ({where, data}) => apply(purchases.get(where.id), data),
    }
  };
  let queue = Promise.resolve();
  db.$transaction = fn => { const next = queue.then(() => fn(db)); queue = next.catch(() => {}); return next; };
  let remote = { id: 'gid://shopify/AppPurchaseOneTime/1', status: 'ACTIVE', test: true, price: {amount: '20.00', currencyCode: 'EUR'} };
  const requests = [];
  const graphql = async (query, variables) => {
    requests.push({query, variables});
    if (query.includes('query BillingState')) return {data: {currentAppInstallation: {activeSubscriptions: row.plan === 'FREE' ? [] : [{id: 'sub', name: `AI Checkout Calls - ${row.plan}`, status: row.status, currentPeriodEnd: row.currentPeriodEnd, lineItems: [{ id: 'line', plan: {pricingDetails: {__typename: 'AppRecurringPricing'}} }] }]}}};
    if (query.includes('VerifyAttemptPurchase')) return {data: {node: remote}};
    if (query.includes('BuyAttempts')) return {data: {appPurchaseOneTimeCreate: {appPurchaseOneTime: {id: remote.id}, confirmationUrl: 'https://test.myshopify.com/confirm', userErrors: []}}};
    if (query.includes('AppSubscriptionCreate')) return {data: {appSubscriptionCreate: {appSubscription: {id:'sub-new'}, confirmationUrl:'https://test.myshopify.com/confirm', userErrors:[]}}};
    throw new Error('Unexpected GraphQL operation');
  };
  const admin = { graphql: async (q, opts) => ({json: async () => graphql(q, opts?.variables)}) };
  const api = compile('app/lib/billing.server.ts', { '../db.server': {default: db}, '../shopify.server': {unauthenticated:{admin:async()=>({admin})},sessionStorage: {loadSession: async () => ({accessToken:'fake'})}}, './billingPlans.server': plans, fetch: async (_url, opts) => ({json: async () => {const {query, variables} = JSON.parse(opts.body); return graphql(query, variables);}}) });
  const purchase = () => purchases.set('p', {id:'p', shop:row.shop, shopifyPurchaseId:remote.id, amountCents:2000, attempts:25, test:true, creditedAt:null});
  return { api, row, charges, purchases, smsDeliveries, requests, admin, purchase, setRemote: r => {remote={...remote, ...r};} };
}
test('last included attempt is reserved; next call is blocked', async () => {
  const f=fixture(); await f.api.reserveAttempt(f.row.shop,'one'); assert.equal(f.row.includedSecondsUsed,30);
  await assert.rejects(f.api.reserveAttempt(f.row.shop,'two'), /ATTEMPT_LIMIT_REACHED/); assert.equal(f.charges.size,1);
});
test('concurrent calls cannot spend the last included attempt twice', async () => {
  const f=fixture(); const results=await Promise.allSettled([f.api.reserveAttempt(f.row.shop,'one'),f.api.reserveAttempt(f.row.shop,'two')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(f.row.includedSecondsUsed,30);
});
test('extra attempts are consumed after monthly allowance and duplicate starts are rejected', async () => {
  const f=fixture({includedSecondsUsed:30,extraAttempts:1}); await f.api.reserveAttempt(f.row.shop,'one');
  assert.equal(f.row.extraAttempts,0); assert.equal(f.row.includedSecondsUsed,30);
  await assert.rejects(f.api.reserveAttempt(f.row.shop,'one'), /ATTEMPT_ALREADY_RESERVED/);
});
test('provider rejection refunds once; repeated webhooks never consume another credit', async () => {
  const f=fixture({includedSecondsUsed:30,extraAttempts:1}); await f.api.reserveAttempt(f.row.shop,'one');
  await f.api.applyBillingForCall({shop:f.row.shop,callJobId:'one',connectedSeconds:42});
  await f.api.applyBillingForCall({shop:f.row.shop,callJobId:'one',connectedSeconds:42}); assert.equal(f.row.extraAttempts,0);
  await f.api.releaseAttempt(f.row.shop,'one'); await f.api.releaseAttempt(f.row.shop,'one'); assert.equal(f.row.extraAttempts,1);
});
test('approved purchase grants credits exactly once under concurrent callbacks', async () => {
  const f=fixture(); f.purchase(); await Promise.all([f.api.confirmAttemptPurchase(f.row.shop,f.admin,'p'), f.api.confirmAttemptPurchase(f.row.shop,f.admin,'p')]); assert.equal(f.row.extraAttempts,25);
});
test('declined, pending, wrong amount, wrong currency and wrong test mode never grant credits', async () => {
  for(const remote of [{status:'DECLINED'},{status:'PENDING'},{price:{amount:'1',currencyCode:'EUR'}},{price:{amount:'20',currencyCode:'USD'}},{test:false}]) {
    const f=fixture();f.purchase();f.setRemote(remote);await assert.rejects(f.api.confirmAttemptPurchase(f.row.shop,f.admin,'p'));assert.equal(f.row.extraAttempts,0);
  }
});
test('another shop cannot redeem a purchase', async () => {
  const f=fixture();f.purchase();await assert.rejects(f.api.confirmAttemptPurchase('other.myshopify.com',f.admin,'p'), /Purchase not found/);assert.equal(f.row.extraAttempts,0);
});
test('purchase price and quantity are server controlled; approval grants nothing yet', async () => {
  const f=fixture(); await f.api.createAttemptPurchase({shop:f.row.shop,admin:f.admin,returnUrl:'https://app.test/confirm',test:true});
  assert.equal(f.row.extraAttempts,0);assert.equal(f.purchases.get('purchase').attempts,25);
  assert.equal(f.requests.find(r=>r.query.includes('BuyAttempts')).variables.price.amount,20);
});
test('paid subscriptions have only recurring pricing and PAYG cannot be selected', async () => {
  const f=fixture();await f.api.createSubscriptionForPlan({shop:f.row.shop,admin:f.admin,plan:'PRO',returnUrl:'https://app.test/confirm'});
  const lines=f.requests.find(r=>r.query.includes('AppSubscriptionCreate')).variables.lineItems;
  assert.equal(lines.length,1);assert.equal(lines[0].plan.appRecurringPricingDetails.price.amount,49);
  assert.equal(f.row.status,'ACTIVE');assert.equal(f.row.plan,'STARTER');
  await assert.rejects(f.api.createSubscriptionForPlan({shop:f.row.shop,admin:f.admin,plan:'PAYG',returnUrl:'https://app.test/confirm'}));
});
test('Free, retired PAYG and inactive subscription cannot bypass attempt limits', async () => {
  for(const overrides of [{plan:'FREE',status:'NONE',freeSecondsUsed:10},{plan:'PAYG',extraAttempts:10},{status:'CANCELLED',extraAttempts:10}]) {
    const f=fixture(overrides);await assert.rejects(f.api.reserveAttempt(f.row.shop,'one'));assert.equal(f.charges.size,0);
  }
});
test('extra attempts survive a cycle renewal and remain more expensive than every paid plan', async () => {
  const f=fixture({extraAttempts:25});await f.api.syncBillingFromShopify({shop:f.row.shop,admin:f.admin});assert.equal(f.row.extraAttempts,25);
  for(const key of ['STARTER','PRO','SCALE'])assert.ok(plans.EXTRA_ATTEMPT_PACK.priceEUR/plans.EXTRA_ATTEMPT_PACK.attempts>plans.PLANS[key].recurringMonthlyEUR/plans.PLANS[key].includedAttempts);
});
test('SMS attempts share the prepaid balance and stop at two per customer', async () => {
  const f=fixture({includedSecondsUsed:28});
  const base={shop:f.row.shop,checkoutId:'cart',customerKey:'customer-hash',source:'MANUAL'};
  await f.api.reserveSmsAttempt({...base,idempotencyKey:'sms-1'});
  await f.api.reserveSmsAttempt({...base,idempotencyKey:'sms-2'});
  await assert.rejects(f.api.reserveSmsAttempt({...base,idempotencyKey:'sms-3'}),/SMS_CUSTOMER_LIMIT_REACHED/);
  assert.equal(f.row.includedSecondsUsed,30);
  assert.equal(f.smsDeliveries.size,2);
});
test('failed SMS refunds its attempt and can be retried idempotently', async () => {
  const f=fixture({includedSecondsUsed:29});
  const args={shop:f.row.shop,checkoutId:'cart',customerKey:'customer-hash',source:'AUTOMATIC',idempotencyKey:'sms-retry'};
  const first=await f.api.reserveSmsAttempt(args);
  await f.api.releaseSmsAttempt({shop:f.row.shop,deliveryId:first.delivery.id,error:'Brevo rejected'});
  assert.equal(f.row.includedSecondsUsed,29);
  const retry=await f.api.reserveSmsAttempt(args);
  assert.equal(retry.delivery.id,first.delivery.id);
  assert.equal(f.row.includedSecondsUsed,30);
});
