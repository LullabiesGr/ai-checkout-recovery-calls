const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function compile(path,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>deps[n]});return exports;}
const parser=compile('app/lib/testCall.shared.ts');
const {resolveTestCatalog}=compile('app/lib/testCatalog.server.ts',{'./testCall.shared':parser});
const id='gid://shopify/ProductVariant/123';
const fd=(items=[{variantId:id,quantity:2,title:'Forged title',price:0.01}])=>new Map(Object.entries({customerName:'Maria',currency:'USD',items:JSON.stringify(items)}));
const variant={id,title:'Blue / M',price:'29.50',product:{id:'gid://shopify/Product/456',title:'Shirt',status:'ACTIVE'}};
const admin=(nodes=[variant],errors)=>({graphql:async(q,{variables})=>{assert.deepEqual([...variables.ids],[id]);return {json:async()=>({errors,data:{shop:{currencyCode:'EUR'},nodes}})}}});
test('catalog items use store-owned title, price and currency rather than submitted values',async()=>{const cart=await resolveTestCatalog(admin(),fd());assert.equal(cart.value,59);assert.equal(cart.currency,'EUR');const item=JSON.parse(cart.itemsJson)[0];assert.equal(item.title,'Shirt — Blue / M');assert.equal(item.price,29.5);assert.equal(item.variantId,id);});
test('deleted or inaccessible variants and archived products cannot start tests',async()=>{await assert.rejects(resolveTestCatalog(admin([null]),fd()));await assert.rejects(resolveTestCatalog(admin([{...variant,product:{...variant.product,status:'ARCHIVED'}}]),fd()));});
test('missing product permissions are reported rather than accepting client data',async()=>{await assert.rejects(resolveTestCatalog(admin([], [{message:'Access denied'}]),fd()),/Product access/);});
test('bad quantities, duplicate selections, empty carts and excessive selections fail',async()=>{await assert.rejects(resolveTestCatalog(admin(),fd([{variantId:id,quantity:-1}])));for(const items of [[],[{variantId:id,quantity:1},{variantId:id,quantity:1}],Array(11).fill({variantId:id,quantity:1})])await assert.rejects(resolveTestCatalog(admin(),fd(items)));});
test('free products and shop currencies outside the old manual list are supported',async()=>{const api={graphql:async()=>({json:async()=>({data:{shop:{currencyCode:'JPY'},nodes:[{...variant,price:'0'}]}})})};const cart=await resolveTestCatalog(api,fd());assert.equal(cart.value,0);assert.equal(cart.currency,'JPY');});
