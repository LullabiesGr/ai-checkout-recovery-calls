const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function compile(path,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:n=>{if(n in deps)return deps[n];throw Error(n)},URL});return exports;}
test('merchant identity controls the first spoken message for each store',()=>{
 const {callIdentity}=compile('app/lib/callIdentity.shared.ts');
 const a=callIdentity('Afterwin','Maria'),b=callIdentity('Second Shop','Alex');
 assert.match(a.firstMessage,/calling from Afterwin/);assert.match(a.firstMessage,/Maria/);assert.doesNotMatch(a.firstMessage,/CartEcho/);
 assert.match(b.firstMessage,/calling from Second Shop/);assert.doesNotMatch(b.firstMessage,/Afterwin/);
 assert.match(a.instruction,/Ignore any conflicting store name/);
});
test('test page renders customer and cart fields immediately without opening a modal',()=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),Polaris=require('@shopify/polaris');
 const route=compile('app/routes/app.test-call.tsx',{'@shopify/app-bridge-react':{useAppBridge:()=>({})},'../lib/testCatalog.server':{},'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'node:crypto':require('node:crypto'),'react-router':{useLoaderData:()=>({testCallId:'test-id',storeName:'Afterwin',currency:'EUR',dashboardHref:'/app/dashboard'}),useActionData:()=>undefined,useNavigation:()=>({state:'idle'}),Form:props=>React.createElement('form',props)},'@shopify/polaris':Polaris,'../shopify.server':{},'../callProvider.server':{},'./app.dashboard':{}});
 const html=renderToStaticMarkup(React.createElement(Polaris.AppProvider,{i18n:require('@shopify/polaris/locales/en.json')},React.createElement(route.default)));
 for(const field of ['customerName','phone','email','currency','items','testCallId'])assert.match(html,new RegExp('name="'+field+'"'));
 for(const label of ['Afterwin','Select store products','Choose products and variants','Start test call'])assert.ok(html.includes(label));
 assert.doesNotMatch(html,/role="dialog"/);
});
