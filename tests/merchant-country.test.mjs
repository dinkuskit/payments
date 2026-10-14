import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { testMerchantCountry } from '../src/hosted/merchant-country.ts';
import { createConnectionService } from '../src/hosted/connection.ts';
const owner={accountId:'synthetic-owner',siteId:'synthetic-site'};
const rejected={bindingRef:'stripe_existing',owner,mode:'test',providerId:'stripe',startedAt:1000,stripeAccountId:null,authorizeNetMerchantId:null,creationProtocol:'accounts_v2',creationScope:'acct_platform',creationFailure:{category:'unknown',status:400,at:2000}};
function fixture(seed=null, config={siteId:owner.siteId,country:'GB'}) {
 let record=structuredClone(seed), configured=config, calls=[],scope='acct_platform';
 const provider={creationProtocol:'accounts_v2',async creationScope(){calls.push(['scope']);return scope;},async createAccount(key,country){calls.push(['create',key,country]);return 'acct_recipient';},async accountStatus(id){return{id,ready:true,actionRequired:false};},async createLink(){throw Error('unused');}};
 const service=createConnectionService({store:{transaction:fn=>fn({read:()=>record,write:v=>record=v})},provider,mode:'test',now:()=>3000,newId:()=> 'new',merchantCountry:()=>configured});
 return {service,record:()=>record,calls,config:v=>configured=v,scope:v=>scope=v,provider};
}
test('country config is explicit, site-scoped, closed and has no inferred default',()=>{
 assert.equal(testMerchantCountry(undefined,owner.siteId),undefined);
 assert.equal(testMerchantCountry(JSON.stringify({siteId:'other',country:'US'}),owner.siteId),undefined);
 assert.equal(testMerchantCountry(JSON.stringify({siteId:owner.siteId,country:'GB'}),owner.siteId).country,'GB');
 for(const value of ['{}','null','[]','broken',JSON.stringify({siteId:owner.siteId,country:'USA'}),JSON.stringify({siteId:owner.siteId,country:'us'}),JSON.stringify({siteId:owner.siteId,country:'US',inferred:true}),JSON.stringify({siteId:owner.siteId,country:'US',rejectedCreation:{bindingRef:'stripe_existing',failureAt:2000,code:'anything'}})]) assert.throws(()=>testMerchantCountry(value,owner.siteId));
});
test('new v2 binding requires configured country before state or provider mutation',async()=>{
 const f=fixture(null,undefined);f.config(undefined);
 await assert.rejects(f.service.connect(owner),/merchant_country_required/);assert.equal(f.record(),null);assert.deepEqual(f.calls,[]);
});
test('country is persisted before create and cannot change on an unknown-outcome retry',async()=>{
 const f=fixture();f.provider.createAccount=async(key,country)=>{f.calls.push(['create',key,country]);assert.equal(f.record().creationCountry,'GB');throw Error('unconfirmed');};
 assert.equal((await f.service.connect(owner)).state,'connecting');const before=structuredClone(f.record());
 f.config({siteId:owner.siteId,country:'US'});assert.equal((await f.service.connect(owner)).state,'recovery_required');assert.deepEqual(f.record(),before);assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
 f.config(undefined);await f.service.connect(owner);assert.equal(f.calls.filter(x=>x[0]==='create').length,2);assert.equal(f.calls.at(-1)[2],'GB');
});
test('known country-validation repair preserves binding, key, scope and retry window',async()=>{
 const f=fixture(rejected,{siteId:owner.siteId,country:'US',rejectedCreation:{bindingRef:rejected.bindingRef,failureAt:2000,code:'identity_country_required'}});
 assert.equal((await f.service.connect(owner)).state,'ready');assert.deepEqual(f.calls,[['scope'],['create','stripe_existing','US']]);
 assert.equal(f.record().bindingRef,rejected.bindingRef);assert.equal(f.record().startedAt,1000);assert.equal(f.record().creationScope,'acct_platform');assert.deepEqual(f.record().creationCountryRepair,{code:'identity_country_required',failureAt:2000});assert.equal(f.record().creationFailure,undefined);
});
test('unknown, mismatched or cross-platform country repairs do not create or alter the record',async()=>{
 const approval={siteId:owner.siteId,country:'US',rejectedCreation:{bindingRef:rejected.bindingRef,failureAt:2000,code:'identity_country_required'}};
 for(const [seed,config,scope] of [[rejected,{siteId:owner.siteId,country:'US'}], [rejected,{...approval,rejectedCreation:{...approval.rejectedCreation,bindingRef:'stripe_other'}}], [rejected,{...approval,rejectedCreation:{...approval.rejectedCreation,failureAt:2001}}], [{...rejected,creationFailure:{category:'transport_unknown',at:2000}},approval], [rejected,approval,'acct_other']]) {
  const f=fixture(seed,config);if(scope)f.scope(scope);assert.equal((await f.service.connect(owner)).state,'recovery_required');assert.deepEqual(f.record(),seed);assert.equal(f.calls.filter(x=>x[0]==='create').length,0);
 }
});
test('saved account resumes without reading new country configuration',async()=>{
 const f=fixture({...rejected,stripeAccountId:'acct_recipient'});f.config(undefined);assert.equal((await f.service.connect(owner)).state,'ready');assert.deepEqual(f.calls,[]);
});

test('a refused changed-payload replay preserves operation identity and the corrected country',async()=>{
 const f=fixture(rejected,{siteId:owner.siteId,country:'US',rejectedCreation:{bindingRef:rejected.bindingRef,failureAt:2000,code:'identity_country_required'}});
 f.provider.createAccount=async(key,country)=>{f.calls.push(['create',key,country]);throw new Stripe.errors.StripeIdempotencyError({message:'synthetic refusal',statusCode:409});};
 assert.equal((await f.service.connect(owner)).state,'connecting');assert.deepEqual(f.calls,[['scope'],['create','stripe_existing','US']]);
 assert.equal(f.record().bindingRef,rejected.bindingRef);assert.equal(f.record().startedAt,1000);assert.equal(f.record().creationCountry,'US');assert.equal(f.record().stripeAccountId,null);assert.equal(f.record().creationFailure.status,409);
});
