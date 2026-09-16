const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function compile(path, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Response, URL, require: n => {
    if (n in deps) return deps[n];
    throw Error(n);
  }});
  return exports;
}
const lang = compile('app/lib/callLanguage.shared.ts');
const resolve = lang.resolveCallLanguage;
test('fixed merchant language overrides locale, country and phone', () => {
  assert.equal(resolve('el', { customer_locale: 'es', shippingAddress: {countryCodeV2:'ES'} }, '+34912345678').code, 'el');
  assert.equal(resolve('es', {}, '+306900000000').source, 'merchant');
});
test('Shopify customer locale precedes country, supports REST and GraphQL shapes', () => {
  for (const raw of [{customer_locale:'el-GR'}, {customerLocale:'el_GR'}, {customer:{locale:'el'}}]) {
    assert.equal(resolve('auto', JSON.stringify({...raw,shippingAddress:{countryCodeV2:'US'}}), '+34912345678').code,'el');
  }
});
test('Shopify shipping, billing and customer address are used before phone', () => {
  for (const raw of [{shippingAddress:{countryCodeV2:'GR'}}, {shipping_address:{country_code:'GR'}},
    {billingAddress:{countryCode:'GR'}}, {customer:{default_address:{country_code:'GR'}}}]) {
    assert.equal(resolve('auto', raw, '+34912345678').code,'el');
  }
  assert.equal(resolve('auto',{shippingAddress:{countryCodeV2:'ES'},billingAddress:{countryCodeV2:'GR'}},'+306900000000').code,'es');
});
test('phone fallback handles Greece, Cyprus, Spain and international formatting', () => {
  for (const phone of ['+306900000000','00306900000000','+30 (690) 000-0000','+35799000000']) assert.equal(resolve('auto',null,phone).code,'el');
  assert.equal(resolve('auto','bad json','+34912345678').code,'es');
  assert.equal(resolve('auto',null,'6900000000').code,'en');
});
test('ambiguous, unsupported and missing data have explicit English fallback', () => {
  for (const raw of [null,{}, {shippingAddress:{countryCodeV2:'CH'}}, {customer_locale:'xx'}]) assert.equal(resolve('auto',raw,'+12025550100').code,'en');
  assert.equal(resolve('auto',{},'+77000000000').code,'en');
  assert.equal(lang.validCallLanguageSetting('__proto__'),false);
  assert.equal(lang.validCallLanguageSetting('multi'),false);
});
test('every selectable language pins transcription, greeting and instructions', () => {
  for (const code of Object.keys(lang.CALL_LANGUAGES)) {
    const config = lang.callLanguageConfig(code,'Afterwin');
    assert.equal(config.transcriber.language,code);
    assert.equal(config.transcriber.model,'nova-3');
    assert.match(config.firstMessage,/Afterwin/);
    assert.match(config.instruction,/Do not detect or switch/);
  }
  assert.match(lang.callLanguageConfig('el','Afterwin').firstMessage,/Γεια σας/);
});
test('settings persist authenticated-shop language and reject unsupported submissions', async () => {
  const updates=[];
  const db={settings:{update:async arg=>updates.push(arg)},$queryRaw:async()=>[], $executeRaw:async()=>1};
  const route=compile('app/routes/app.settings.tsx', {
    react:require('react'), 'react/jsx-runtime':require('react/jsx-runtime'), 'react-router':{},
    '@shopify/shopify-app-react-router/server':{}, '@shopify/polaris':{},
    '../shopify.server':{authenticate:{admin:async()=>({session:{shop:'test.myshopify.com'}})}},
    '../db.server':{default:db}, '../callRecovery.server':{ensureSettings:async()=>({callLanguage:'auto'})},
    '../lib/planFeatures.server':{getShopPlan:async()=> 'STARTER'}, '../lib/callLanguage.shared':lang,
  });
  const request=value=>({url:'https://example.com/app/settings',formData:async()=>new Map([['callLanguage',value]])});
  await route.action({request:request('el')});
  assert.equal(updates[0].where.shop,'test.myshopify.com');
  assert.equal(updates[0].data.callLanguage,'el');
  const rejected=await route.action({request:request('multi')});
  assert.equal(rejected.status,400); assert.equal(updates.length,1);
});
test('provider wiring uses resolved config and has no conflicting multilingual defaults', () => {
  const source=fs.readFileSync('app/callProvider.server.ts','utf8');
  assert.match(source,/resolveCallLanguage\(.*checkout.raw, customerNumber/);
  assert.match(source,/firstMessage: languageConfig.firstMessage/);
  assert.match(source,/transcriber: languageConfig.transcriber/);
  assert.doesNotMatch(source,/language: "multi"|Start the call now in English|I'll send that by text right now/);
});
