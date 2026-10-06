import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import Stripe from 'stripe';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [archiveArgument, peerArgument] = process.argv.slice(2);
if (!archiveArgument || !peerArgument) throw new Error('Usage: node --import tsx scripts/verify-commerce-pricing-package.mjs <pinned-commerce.tgz> <emdash-1.0.1-package-directory>');
const archive = resolve(archiveArgument), peer = resolve(peerArgument);
assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), '38c1c6b59ad37db506986dc9de72fa53f601f7c66d5df53a1c39e9ca3c351730');
assert.equal(JSON.parse(readFileSync(`${peer}/package.json`, 'utf8')).version, '1.0.1');
const packageRoot = `${root}/.grilltrack/work/checkout-pricing-20261006/package-proof-${randomUUID()}`;
mkdirSync(packageRoot, {recursive:true});
// Extract only the hash-verified, source-owner-qualified public artifact.
execFileSync('tar', ['-xzf', archive, '-C', packageRoot]);
mkdirSync(`${packageRoot}/package/node_modules`, {recursive:true});
symlinkSync(peer, `${packageRoot}/package/node_modules/emdash`);
const {createCheckoutStore, startCheckout, reconcileCheckout, createTrustedTestPaymentPort} = await import(pathToFileURL(`${packageRoot}/package/dist/features/checkout/index.js`));
const {createCouponAdmin, createCouponAttemptOwner} = await import(pathToFileURL(`${packageRoot}/package/dist/features/coupons/index.js`));
globalThis.fetch = async () => { throw new Error('Unexpected non-intercepted transport'); };
const { createCheckoutSessionService } = await import(pathToFileURL(`${root}/src/checkout/sessions.ts`));
const { createStripeCheckout } = await import(pathToFileURL(`${root}/src/stripe/checkout.ts`));
const { createHostedHandler } = await import(pathToFileURL(`${root}/src/hosted/http.ts`));
const usd = minor => ({currency:'USD',minor:String(minor)});
const directory = `${root}/node_modules/.cache/dinkus-payments-pricing-proof/packaged-flow-${randomUUID()}`;
mkdirSync(directory, {recursive:true});
function collection(records=[]) {
  const values = new Map(records.map(record=>[record.itemId??record.recordId, {revision:'1', value:record}]));
  return {
    async get(id) {return structuredClone(values.get(id)?.value??null);},
    async getVersioned(id) {return structuredClone(values.get(id)??null);},
    async put(id,value) {values.set(id,{revision:'1',value:structuredClone(value)});},
    async query() {return {items:[...values].map(([id,r])=>({id,data:structuredClone(r.value)})),hasMore:false};},
    async compareAndSet(id,revision,value) {
      const existing=values.get(id);if((existing?.revision??null)!==revision)return {applied:false};
      values.set(id,{revision:String(Number(existing?.revision??0)+1),value:structuredClone(value)});return {applied:true};
    },
  };
}
const results=[];
for(const scenario of [
  {name:'flat-nondivisible',discount:101,shipping:50,total:199},
  {name:'free',discount:100,shipping:0,total:150},
  {name:'offset',discount:50,shipping:50,total:250},
  {name:'shipping-only',discount:250,shipping:50,total:50},
  {name:'zero-rejected',discount:250,shipping:0,total:0},
]) {
  let now=1791288000000, paid=false, stripeCreates=0, transportCalls=0, syntheticResolutions=0, stripeSession=null, parameters=null;
  const principal={accountId:'synthetic-package-owner',siteId:'synthetic-package-site'};
  const binding={bindingRef:'stripe_synthetic_package',providerId:'stripe',stripeAccountId:'acct_syntheticpackage',mode:'test'};
  const commerceDb=new DatabaseSync(`${directory}/${scenario.name}-commerce.sqlite`);
  commerceDb.exec('CREATE TABLE checkout(id TEXT PRIMARY KEY,revision TEXT,value TEXT)');
  const store=createCheckoutStore({
    async getVersioned(id) {const row=commerceDb.prepare('SELECT revision,value FROM checkout WHERE id=?').get(id);return row?{revision:row.revision,value:JSON.parse(row.value)}:null;},
    async compareAndSet(id,revision,value) {
      const result=revision===null?commerceDb.prepare('INSERT INTO checkout VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(id,randomUUID(),JSON.stringify(value)):commerceDb.prepare('UPDATE checkout SET revision=?,value=? WHERE id=? AND revision=?').run(randomUUID(),JSON.stringify(value),id,revision);return {applied:result.changes===1};
    },
  });
  const paymentPath=`${directory}/${scenario.name}-payments.sqlite`;
  let paymentDb=new DatabaseSync(paymentPath);paymentDb.exec('CREATE TABLE attempts(id TEXT PRIMARY KEY,value TEXT)');
  const attemptStore={transaction(fn) {
    paymentDb.exec('BEGIN IMMEDIATE');try {
      const result=fn({read(id){const row=paymentDb.prepare('SELECT value FROM attempts WHERE id=?').get(id);return row?JSON.parse(row.value):null;},write(value){paymentDb.prepare('INSERT INTO attempts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.attemptId,JSON.stringify(value));}});paymentDb.exec('COMMIT');return result;
    }catch(error){paymentDb.exec('ROLLBACK');throw error;}
  }};
  const provider=createStripeCheckout({apiKey:'sk_test_fixture',mode:'test',httpClient:Stripe.createFetchHttpClient(async(input,init)=>{
    const request=new Request(input,init);const url=new URL(request.url);
    if(request.method==='POST'&&url.pathname==='/v1/checkout/sessions') {
      stripeCreates++;parameters=new URLSearchParams(await request.text());assert.equal(request.headers.get('stripe-account'),binding.stripeAccountId);
      let amount=0;for(let i=0;parameters.has(`line_items[${i}][quantity]`);i++)amount+=Number(parameters.get(`line_items[${i}][quantity]`))*Number(parameters.get(`line_items[${i}][price_data][unit_amount]`));
      assert.equal(amount,scenario.total);assert.equal(parameters.get('payment_method_types[0]'),'card');
      stripeSession={id:'cs_test_packagefixture',url:'https://checkout.stripe.com/c/pay/cs_test_packagefixture',status:'open',payment_status:'unpaid',amount_total:amount,currency:'usd',created:Math.floor(now/1000),expires_at:Number(parameters.get('expires_at')),livemode:false,payment_intent:null,metadata:{dinkus_attempt:parameters.get('metadata[dinkus_attempt]'),dinkus_binding:binding.bindingRef,dinkus_site:principal.siteId},payment_method_types:['card']};
      return Response.json(stripeSession);
    }
    if(url.pathname==='/v1/checkout/sessions/cs_test_packagefixture')return Response.json({...stripeSession,...(paid?{status:'complete',payment_status:'paid',payment_intent:'pi_packagefixture'}:{})});
    if(url.pathname==='/v1/payment_intents/pi_packagefixture')return Response.json({id:'pi_packagefixture',status:'succeeded',amount:scenario.total,currency:'usd',latest_charge:{id:'ch_packagefixture',status:'succeeded'}});
    throw new Error(`Unexpected intercepted provider route: ${request.method} ${url.pathname}`);
  })});
  const service=()=>createCheckoutSessionService({store:attemptStore,readyBinding:async()=>binding,existingBinding:async()=>binding,provider,mode:'test',successUrl:'https://store.example.invalid/checkout/return',cancelUrl:'https://store.example.invalid/checkout/cancel',now:()=>now});
  const handler=createHostedHandler({authenticate:async request=>{assert.equal(request.headers.get('x-dinkus-site'),principal.siteId);assert.equal(request.headers.get('authorization'),'Bearer synthetic-package-proof');return principal;},service:()=>({checkoutBinding:async()=>binding,existingBinding:async()=>binding}),checkout:p=>service().forPrincipal(p)});
  const port=createTrustedTestPaymentPort({paymentsOrigin:'https://payments.example.invalid',commerceOrigin:'https://store.example.invalid',siteId:principal.siteId,...binding,pricingSchema:'dinkuskit.commerce.checkout-pricing/v1',credentialResolver:async()=>{syntheticResolutions++;return 'synthetic-package-proof';},fetch:async(input,init)=>{transportCalls++;return handler(new Request(input,init));}});
  const coupons=collection();await createCouponAdmin(coupons).create({code:'SAVE',globalCap:1,rule:{ruleId:'synthetic-package-rule',version:1,discount:{kind:'fixed',amount:usd(scenario.discount)},appliesTo:'all-merchandise',selectedProductIds:[],includeSaleItems:true,minimumEligibleMerchandise:usd(0),startsAt:'2026-01-01T00:00:00Z',endsAt:'2027-01-01T00:00:00Z',timeZone:'UTC'}});
  const execution={store,catalog:{catalog:collection(['one','two'].map(itemId=>({recordKind:'catalog-item',itemId,name:itemId,stockManagement:{mode:'unmanaged'}}))),prices:collection([{recordKind:'catalog-price',recordId:'one',catalogItemId:'one',regular:usd(75)},{recordKind:'catalog-price',recordId:'two',catalogItemId:'two',regular:usd(100)}]),backorderPolicies:collection(),settings:collection(),manualAvailability:collection(),configurations:collection()},availability:{resolveProvider:async()=>{throw Error('unmanaged basket must not resolve inventory');}},resolvePayments:async()=>port,paymentBindingRef:binding.bindingRef,now:()=>now/1000,pricing:{coupons,paymentPricingSchema:'dinkuskit.commerce.checkout-pricing/v1',resolveShippingConfiguration:async()=>({configurationId:'synthetic-package-shipping',revision:1,mode:scenario.shipping?'flat':'free',amount:usd(scenario.shipping)})}};
  const input={lines:[{catalogItemId:'one',quantity:2},{catalogItemId:'two',quantity:1}],couponCode:'SAVE'};
  if(scenario.total===0) {
    await assert.rejects(()=>startCheckout(execution,scenario.name,input));assert.equal(stripeCreates,0);assert.equal(transportCalls,0);assert.equal(paymentDb.prepare('SELECT count(*) AS n FROM attempts').get().n,0);
    results.push({scenario:scenario.name,rejected:true,providerCreates:0,transportCalls:0});
  }else {
    const first=await startCheckout(execution,scenario.name,input);assert.ok(first.session);assert.equal(first.payment.total.minor,String(scenario.total));
    const stored=JSON.parse(paymentDb.prepare('SELECT value FROM attempts WHERE id=?').get(first.attemptId).value);assert.deepEqual(stored.pricing,first.payment.pricing);assert.equal(stripeCreates,1);
    if(scenario.name==='flat-nondivisible')assert.ok(first.payment.pricing.lines.some(l=>BigInt(l.netAmount.minor)%BigInt(l.quantity)!==0n));
    paymentDb.close();paymentDb=new DatabaseSync(paymentPath);now+=2000;
    execution.pricing.resolveShippingConfiguration=async()=>({configurationId:'changed-later',revision:2,mode:'flat',amount:usd(999)});
    const replay=await startCheckout(execution,scenario.name,input);assert.equal(replay.payment.total.minor,String(scenario.total));assert.equal(stripeCreates,1);
    paid=true;const settled=await reconcileCheckout(execution,scenario.name,first.attemptId);assert.equal(settled.phase,'paid');assert.equal(settled.coupon.status,'consumed');assert.deepEqual(settled.order.pricing,first.payment.pricing);assert.equal(settled.order.total.minor,String(scenario.total));
    const repeated=await reconcileCheckout(execution,scenario.name,first.attemptId);assert.equal(repeated.order.orderId,settled.order.orderId);const aggregate=await store.read(scenario.name);assert.equal(aggregate.record.attempts.filter(a=>a.order).length,1);
    const couponRecord=(await createCouponAdmin(coupons).list())[0];const counts=await createCouponAttemptOwner(coupons).getCounts(couponRecord.couponId);assert.equal(counts.consumed,1);
    results.push({scenario:scenario.name,total:scenario.total,originalQuantity:first.payment.lines[0].quantity,snapshotRetained:true,sqliteReopen:true,replayFrozen:true,providerCreates:stripeCreates,canonicalOrders:1,couponConsumed:1,transportCalls,syntheticResolutions});
  }
  paymentDb.close();commerceDb.close();
}
const report={source:'70419ae55c4f73354e3f0eda08b09bbc85368000',npmSha256:'38c1c6b59ad37db506986dc9de72fa53f601f7c66d5df53a1c39e9ca3c351730',renderer:'Pinned compiled Commerce package -> trusted TEST HTTP adapter -> Payments hosted handler/service -> official Stripe SDK with wholly intercepted fetch -> authoritative lookup -> canonical Commerce order/coupon settlement; SQLite reopen',results,limits:['Synthetic principal and TEST token; JWT cryptography remains separate existing test proof','No actual host PluginContext/guest UI/Registry install/scheduler/wake delivery','No actual Stripe, credentials, real account/site or activation'],actualNetworkCalls:0,credentialStoreReads:0,proofDirectory:directory};
writeFileSync(`${directory}/RESULT.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
