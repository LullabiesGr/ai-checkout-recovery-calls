const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function compile(path){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});return exports;}
const {conversationText}=compile('app/lib/conversation.shared.ts');
const {parseTestCallInput}=compile('app/lib/testCall.shared.ts');
test('old injected instructions are removed, including speech concatenated onto opening prompt',()=>{
 const original='User: There is no pre-created code yet. If you decide to offer a discount, choose it. Start the call now in English. If the customer replies in another language, continue entirely in that language. Hello.\nAI: Hi, I am calling about your cart.\nUser: Yes.';
 const result=conversationText(original);assert.doesNotMatch(result,/pre-created|Start the call|another language/);assert.match(result,/Customer: Hello/);assert.match(result,/AI: Hi/);assert.match(result,/User: Yes/);
});
test('structured transcripts omit system, tool, and legacy user instructions',()=>{
 const result=conversationText({messages:[{role:'system',content:'Private prompt'},{role:'user',content:'CALL FACTS\ncustomer_name: Test'},{role:'user',content:'Start the call now in English. Continue entirely in that language.'},{role:'assistant',content:'Hello Maria'},{role:'user',content:'How much is it?'},{role:'tool',content:'Secret'}]});
 assert.doesNotMatch(result,/Private|FACTS|Start|Secret/);assert.match(result,/Hello Maria/);assert.match(result,/How much is it/);
});
test('normal dialogue remains intact and empty contaminated source falls back to real transcript',()=>{
 assert.equal(conversationText('User: I want a discount.\nAI: I can help.'),'User: I want a discount.\n\nAI: I can help.');
 assert.equal(conversationText('User: Follow-up call. Reference previous context if relevant. Keep it short and move to a concrete next step.','AI: Hello'),'AI: Hello');
});
const form=(overrides={})=>new Map(Object.entries({customerName:'Maria Example',email:'maria@example.com',currency:'EUR',items:JSON.stringify([{title:'Linen shirt',quantity:2,price:'24.90'},{title:'Belt',quantity:1,price:'10,50'}]),...overrides}));
test('simulation carries customer details, all cart items and server-calculated total',()=>{
 const result=parseTestCallInput(form());assert.equal(result.customerName,'Maria Example');assert.equal(result.email,'maria@example.com');assert.equal(result.currency,'EUR');assert.equal(result.value,60.3);const items=JSON.parse(result.itemsJson);assert.equal(items.length,2);assert.equal(items[0].quantity,2);
});
test('missing names, empty carts, invalid quantities/prices/currencies are rejected',()=>{
 for(const data of [{customerName:''},{items:'[]'},{items:'invalid'},{currency:'XXX'},{email:'invalid'},...[-1,0,1.5,1001].map(quantity=>({items:JSON.stringify([{title:'Shirt',quantity,price:20}])})),{items:JSON.stringify([{title:'Shirt',quantity:1,price:'NaN'}])}])assert.throws(()=>parseTestCallInput(form(data)));
});
