const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function compile(path, deps = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Response, URL, console, require: n => {
    if (n in deps) return deps[n];
    throw Error(n);
  }, ...globals });
  return exports;
}
const voices = compile('app/lib/callVoice.shared.ts');
const languages = compile('app/lib/callLanguage.shared.ts');
test('default preserves the existing assistant voice and forged IDs are rejected', () => {
  assert.equal(JSON.stringify(voices.callVoiceOverrides('default','el')), '{}');
  assert.equal(JSON.stringify(voices.callVoiceOverrides(undefined,'el')), '{}');
  for (const id of ['invalid','__proto__','https://example.com','']) {
    assert.equal(voices.validCallVoice(id), false);
    assert.throws(()=>voices.callVoiceOverrides(id,'el'));
  }
});
test('all four voices use real IDs, language enforcement and a supported multilingual model', () => {
  assert.equal(new Set(voices.CALL_VOICES.map(v=>v.id)).size,4);
  for (const v of voices.CALL_VOICES) for (const language of Object.keys(languages.CALL_LANGUAGES)) {
    const output = voices.callVoiceOverrides(v.id,language).voice;
    assert.equal(output.voiceId,v.id); assert.equal(output.provider,'11labs');
    assert.equal(output.model,'eleven_flash_v2_5'); assert.equal(output.language,language);
    assert.ok(v.previewUrl.startsWith('https://storage.googleapis.com/eleven-public-prod/premade/voices/'+v.id+'/'));
  }
});
function providerHarness(selectedByShop) {
  const requests=[],updates=[],charges=[];
  const db={
    settings:{findUnique:async({where})=>({callLanguage:'el',callVoice:selectedByShop[where.shop]})},
    checkout:{findFirst:async({where})=>({shop:where.shop,checkoutId:'cart',phone:'+306900000000',customerName:'Maria',value:10,currency:'EUR',raw:'{}',itemsJson:'[]'})},
    callJob:{findFirst:async({where})=>({id:where.id,shop:where.shop,checkoutId:'cart'}),count:async()=>0,update:async(arg)=>updates.push(arg)},
    $queryRaw:async()=>[],
  };
  const provider=compile('app/callProvider.server.ts',{
    './lib/callIdentity.shared':compile('app/lib/callIdentity.shared.ts'),
    './lib/callLanguage.shared':languages, './lib/callVoice.shared':voices,
    './lib/privacy.server':{isPrivacySuppressed:async()=>false},
    './lib/billing.server':{reserveAttempt:async(shop,id)=>charges.push({shop,id}),releaseAttempt:async()=>{}},
    './db.server':{default:db}, 'node:crypto':require('node:crypto'),
    './shopify.server':{sessionStorage:{findSessionsByShop:async()=>[]}},
    './lib/planFeatures.server':{getShopPlan:async()=>'STARTER',hasSmsFeature:()=>true},
  },{
    process:{env:{VAPI_API_KEY:'test-only-key',VAPI_SERVER_URL:'https://example.com/webhooks/vapi',VAPI_ASSISTANT_ID:'assistant',VAPI_PHONE_NUMBER_ID:'phone'}},
    fetch:async(url,options)=>{assert.equal(url,'https://api.vapi.ai/call/phone');requests.push({url,options,body:JSON.parse(options.body)});return {ok:true,json:async()=>({id:'mock-call'})};},
  });
  return {provider,requests,updates,charges};
}
test('real call dispatcher sends different saved voices for different shops to Vapi', async () => {
  const [a,b]=voices.CALL_VOICES;
  const h=providerHarness({'one.myshopify.com':a.id,'two.myshopify.com':b.id});
  for (const shop of ['one.myshopify.com','two.myshopify.com']) await h.provider.startVapiCallForJob({shop,callJobId:shop+'-job'});
  assert.equal(h.requests[0].body.assistantOverrides.voice.voiceId,a.id);
  assert.equal(h.requests[1].body.assistantOverrides.voice.voiceId,b.id);
  assert.equal(h.requests[0].body.assistantOverrides.voice.language,'el');
  assert.equal(h.requests[0].body.assistantOverrides.transcriber.language,'el');
  assert.equal(h.requests[0].options.method,'POST');
  assert.equal(h.charges.length,2);
  const analysis=JSON.parse(h.updates[0].data.analysisJson);
  assert.equal(analysis.call_voice.voiceId,a.id);
});
test('default omits the Vapi voice override; invalid saved voice fails before charging', async () => {
  const h=providerHarness({default:'default',invalid:'forged'});
  await h.provider.startVapiCallForJob({shop:'default',callJobId:'job'});
  assert.equal(Object.hasOwn(h.requests[0].body.assistantOverrides,'voice'),false);
  await assert.rejects(h.provider.startVapiCallForJob({shop:'invalid',callJobId:'job2'}),/Saved call voice/);
  assert.equal(h.requests.length,1);assert.equal(h.charges.length,1);
});
test('settings save selection for authenticated shop, retain old-form value and reject tampering', async()=>{
  const writes=[];
  const route=compile('app/routes/app.settings.tsx',{
    react:require('react'),'react/jsx-runtime':require('react/jsx-runtime'),'react-router':{},
    '@shopify/shopify-app-react-router/server':{},'@shopify/polaris':{},
    '../shopify.server':{authenticate:{admin:async()=>({session:{shop:'authenticated-shop'}})}},
    '../db.server':{default:{settings:{update:async arg=>writes.push(arg)},$queryRaw:async()=>[],$executeRaw:async()=>1}},
    '../callRecovery.server':{ensureSettings:async()=>({callVoice:voices.CALL_VOICES[0].id})},
    '../lib/planFeatures.server':{getShopPlan:async()=>'STARTER'},
    '../lib/callLanguage.shared':languages,'../lib/callVoice.shared':voices,'../components/CallVoicePicker':{},
  });
  const request=entries=>({url:'https://example.com/app/settings',formData:async()=>new Map(entries)});
  await route.action({request:request([['callVoice',voices.CALL_VOICES[1].id],['shop','forged-shop']])});
  assert.equal(writes[0].where.shop,'authenticated-shop');assert.equal(writes[0].data.callVoice,voices.CALL_VOICES[1].id);
  await route.action({request:request([])});assert.equal(writes[1].data.callVoice,voices.CALL_VOICES[0].id);
  const r=await route.action({request:request([['callVoice','forged']])});assert.equal(r.status,400);assert.equal(writes.length,2);
});
test('Polaris voice selector previews exact selected voice with no autoplay or call action',()=>{
  const React=require('react'),Polaris=require('@shopify/polaris'),{renderToStaticMarkup}=require('react-dom/server');
  const {CallVoicePicker}=compile('app/components/CallVoicePicker.tsx',{
    react:React,'react/jsx-runtime':require('react/jsx-runtime'),'@shopify/polaris':Polaris,'../lib/callVoice.shared':voices,
  });
  const render=value=>renderToStaticMarkup(React.createElement(Polaris.AppProvider,{i18n:require('@shopify/polaris/locales/en.json')},React.createElement(CallVoicePicker,{value,onChange:()=>{}})));
  const html=render(voices.CALL_VOICES[0].id);
  assert.match(html,/name="callVoice"/);assert.ok(html.includes(voices.CALL_VOICES[0].previewUrl));
  assert.match(html,/preload="none"/);assert.match(html,/controls/);assert.doesNotMatch(html,/autoplay/i);
  assert.match(html,/Listening uses no attempts/);assert.doesNotMatch(render('default'),/<audio/);
});
