import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { testMerchantCountry, resolveMerchantCountry } from '../src/hosted/merchant-country.ts';
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
 assert.equal((await f.service.connect(owner)).state,'recovery_required');assert.deepEqual(f.calls,[['scope'],['create','stripe_existing','US']]);
 assert.equal(f.record().bindingRef,rejected.bindingRef);assert.equal(f.record().startedAt,1000);assert.equal(f.record().creationCountry,'US');assert.equal(f.record().stripeAccountId,null);assert.equal(f.record().creationFailure.status,409);
 const before=structuredClone(f.record());assert.equal((await f.service.connect(owner)).state,'recovery_required');assert.deepEqual(f.record(),before);assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
});

test('a consumed country repair cannot replay after an interrupted or unknown outcome',async()=>{
 const seed={...rejected,creationCountry:'US',creationCountryRepair:{code:'identity_country_required',failureAt:2000}};
 for(const creationFailure of [seed.creationFailure,{category:'transport_unknown',at:3000}]) {
  const f=fixture({...seed,creationFailure},{siteId:owner.siteId,country:'US',rejectedCreation:{bindingRef:rejected.bindingRef,failureAt:2000,code:'identity_country_required'}});
  assert.equal((await f.service.connect(owner)).state,'recovery_required');assert.equal((await f.service.status(owner)).state,'recovery_required');assert.deepEqual(f.calls,[]);
 }
});
test('concurrent Setup cannot duplicate the admitted country repair',async()=>{
 const f=fixture(rejected,{siteId:owner.siteId,country:'US',rejectedCreation:{bindingRef:rejected.bindingRef,failureAt:2000,code:'identity_country_required'}});
 let release;const pending=new Promise(resolve=>{release=resolve;});let started;const entered=new Promise(resolve=>{started=resolve;});
 f.provider.createAccount=async(key,country)=>{f.calls.push(['create',key,country]);started();await pending;return 'acct_recipient';};
 const first=f.service.connect(owner);await entered;
 try { assert.equal((await f.service.connect(owner)).state,'recovery_required');assert.equal(f.calls.filter(x=>x[0]==='create').length,1); }
 finally { release();await first; }
});

test('multi-site additive binding resolves configured sites and preserves legacy singleton fallback', () => {
  const legacy = JSON.stringify({ siteId: 'site-legacy', country: 'GB', rejectedCreation: { bindingRef: 'stripe_legacy', failureAt: 2000, code: 'identity_country_required' } });
  const sites = JSON.stringify([
    { siteId: 'site-alpha', country: 'FR' },
    { siteId: 'site-beta', country: 'DE' },
  ]);
  // Absent/empty sites binding -> EXACT old resolver semantics
  assert.equal(resolveMerchantCountry(legacy, undefined, 'site-legacy').country, 'GB');
  assert.equal(resolveMerchantCountry(legacy, '', 'site-legacy').rejectedCreation.bindingRef, 'stripe_legacy');
  assert.equal(resolveMerchantCountry(legacy, undefined, 'site-alpha'), undefined);
  assert.equal(resolveMerchantCountry(undefined, undefined, 'site-legacy'), undefined);

  // Matching new site -> country only
  const alpha = resolveMerchantCountry(legacy, sites, 'site-alpha');
  assert.deepEqual(alpha, { siteId: 'site-alpha', country: 'FR' });
  assert.equal(alpha.rejectedCreation, undefined);

  const beta = resolveMerchantCountry(legacy, sites, 'site-beta');
  assert.deepEqual(beta, { siteId: 'site-beta', country: 'DE' });

  // Valid nonmatching site -> legacy fallback including rejectedCreation
  const fromLegacy = resolveMerchantCountry(legacy, sites, 'site-legacy');
  assert.equal(fromLegacy.country, 'GB');
  assert.equal(fromLegacy.rejectedCreation.bindingRef, 'stripe_legacy');

  // Site unknown to both configs -> undefined
  assert.equal(resolveMerchantCountry(legacy, sites, 'site-unknown'), undefined);
});

test('multi-site binding rejects ambiguity with legacy singleton even if country matches', () => {
  const legacy = JSON.stringify({ siteId: 'site-shared', country: 'US' });
  const sites = JSON.stringify([{ siteId: 'site-shared', country: 'US' }]);
  assert.throws(() => resolveMerchantCountry(legacy, sites, 'site-shared'), /merchant_country_configuration_invalid/);

  const legacyDifferentCountry = JSON.stringify({ siteId: 'site-shared', country: 'CA' });
  assert.throws(() => resolveMerchantCountry(legacyDifferentCountry, sites, 'site-shared'), /merchant_country_configuration_invalid/);

  const legacyWithRejected = JSON.stringify({ siteId: 'site-shared', country: 'US', rejectedCreation: { bindingRef: 'stripe_shared', failureAt: 2000, code: 'identity_country_required' } });
  assert.throws(() => resolveMerchantCountry(legacyWithRejected, sites, 'site-shared'), /merchant_country_configuration_invalid/);
});

test('multi-site binding fails closed on malformed configuration or invalid entries', () => {
  const validLegacy = JSON.stringify({ siteId: 'site-legacy', country: 'US' });
  const malformedCases = [
    'not-json',
    '{}',
    '123',
    '"string"',
    'null',
    'true',
    JSON.stringify(Array.from({ length: 17 }, (_, i) => ({ siteId: `site-${i}`, country: 'US' }))),
    JSON.stringify([{ siteId: 'site-1', country: 'US' }, { siteId: 'site-1', country: 'GB' }]),
    JSON.stringify([{ siteId: 'site-1', country: 'US' }, { siteId: 'site-1', country: 'US' }]),
    JSON.stringify([{ siteId: 'site-1', country: 'USA' }]),
    JSON.stringify([{ siteId: 'site-1', country: 'us' }]),
    JSON.stringify([{ siteId: 'site-1', country: '12' }]),
    JSON.stringify([{ siteId: 'site with spaces', country: 'US' }]),
    JSON.stringify([{ siteId: 'site-1' }]),
    JSON.stringify([{ country: 'US' }]),
    JSON.stringify([{ siteId: 'site-1', country: 'US', extra: 'forbidden' }]),
    JSON.stringify([{ siteId: 'site-1', country: 'US', rejectedCreation: { bindingRef: 'stripe_x', failureAt: 1000, code: 'identity_country_required' } }]),
    JSON.stringify([{ siteId: '', country: 'US' }]),
    JSON.stringify([{ siteId: 'x'.repeat(201), country: 'US' }]),
    '[' + '{"siteId":"s","country":"US"},'.repeat(500) + '{"siteId":"end","country":"US"}]',
  ];
  for (const bad of malformedCases) {
    assert.throws(() => resolveMerchantCountry(validLegacy, bad, 'site-legacy'), /merchant_country_configuration_invalid/);
    assert.throws(() => resolveMerchantCountry(validLegacy, bad, 'any-site'), /merchant_country_configuration_invalid/);
  }
  // Malformed legacy configuration also fails closed when sites config is present
  const badLegacy = '{not-json}';
  const validSites = JSON.stringify([{ siteId: 'site-alpha', country: 'FR' }]);
  assert.throws(() => resolveMerchantCountry(badLegacy, validSites, 'site-alpha'), /merchant_country_configuration_invalid/);
});

test('additive admission refuses unknown, malformed and live creation before state or provider I/O', async () => {
  const sites = JSON.stringify([{siteId:owner.siteId,country:'US'}]);
  for (const [mode, config] of [['test',JSON.stringify([{siteId:'other-site',country:'US'}])], ['test','broken'], ['live',sites]]) {
    let saved=null, calls=0;
    const service=createConnectionService({
      store:{transaction:fn=>fn({read:()=>saved,write:value=>{saved=value;}})},
      provider:{creationProtocol:'accounts_v2',async creationScope(){calls++;return 'acct_platform';},async createAccount(){calls++;return 'acct_recipient';},async accountStatus(id){calls++;return {id,ready:true,actionRequired:false};},async createLink(){calls++;throw Error('unused');}},
      mode,newId:()=> 'synthetic',merchantCountry:siteId=>resolveMerchantCountry(undefined,config,siteId),
    });
    await assert.rejects(service.connect(owner),/merchant_country_(required|configuration_invalid)/);
    assert.equal(saved,null);assert.equal(calls,0);
  }
});
