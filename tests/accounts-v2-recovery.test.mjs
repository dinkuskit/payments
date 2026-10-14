import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectionService } from '../src/hosted/connection.ts';
const owner={accountId:'synthetic-owner',siteId:'synthetic-site'};
function fixture(seed=null) {
  let saved=seed, scope='acct_platformA', fail=true, scopes=0, creates=0, statuses=0;
  const provider={creationProtocol:'accounts_v2',async creationScope(){scopes++;return scope;},async createAccount(){creates++;if(fail)throw Error('synthetic-private');return 'acct_recipient';},async accountStatus(id){statuses++;return{id,ready:true,actionRequired:false};},async createLink(){throw Error('unexpected');}};
  const service=createConnectionService({store:{transaction(fn){return fn({read:()=>saved,write:v=>{saved=v;}});}},provider,merchantCountry:siteId=>({siteId,country:'GB'}),mode:'test',newId:()=> 'binding',now:()=>10000});
  return {service,saved:()=>saved,scope:v=>scope=v,succeed:()=>fail=false,calls:()=>({scopes,creates,statuses})};
}
test('legacy unresolved creation cannot become a v2 operation',async()=>{
 const seed={owner,mode:'test',bindingRef:'stripe_old',startedAt:9990,stripeAccountId:null,authorizeNetMerchantId:null,providerId:'stripe',creationFailure:{category:'unknown',status:400,at:9995}};
 const f=fixture(seed);assert.equal((await f.service.connect(owner)).state,'recovery_required');assert.equal((await f.service.status(owner)).state,'recovery_required');assert.equal(f.service.diagnostics(owner).state,'recovery_required');assert.deepEqual(f.calls(),{scopes:0,creates:0,statuses:0});assert.deepEqual(f.saved(),seed);
});
test('explicit v2 retries keep platform scope and cannot cross to a new platform',async()=>{
 const f=fixture();assert.equal((await f.service.connect(owner)).state,'connecting');assert.equal(f.calls().creates,1);assert.equal(f.saved().creationProtocol,'accounts_v2');assert.equal(f.saved().creationScope,'acct_platformA');
 const before=structuredClone(f.saved());f.scope('acct_platformB');f.succeed();assert.equal((await f.service.connect(owner)).state,'recovery_required');assert.equal(f.calls().creates,1);assert.deepEqual(f.saved(),before);
 f.scope('acct_platformA');assert.equal((await f.service.connect(owner)).state,'ready');assert.equal(f.calls().creates,2);assert.equal(f.saved().stripeAccountId,'acct_recipient');assert.equal(f.saved().creationFailure,undefined);
});
test('saved legacy account remains readable without recreation',async()=>{
 const f=fixture({owner,mode:'test',bindingRef:'stripe_old',startedAt:1,stripeAccountId:'acct_recipient',authorizeNetMerchantId:null,providerId:'stripe'});
 assert.equal((await f.service.connect(owner)).state,'ready');assert.deepEqual(f.calls(),{scopes:0,creates:0,statuses:1});assert.equal(f.saved().stripeAccountId,'acct_recipient');
});

test('owner replacement during platform lookup prevents creation',async()=>{
 let saved=null,creates=0;
 const provider={creationProtocol:'accounts_v2',async creationScope(){saved={...saved,owner:{...owner,accountId:'other-owner'}};return 'acct_platform';},async createAccount(){creates++;return 'acct_recipient';},async accountStatus(id){return{id,ready:true,actionRequired:false};},async createLink(){throw Error('unexpected');}};
 const service=createConnectionService({store:{transaction:fn=>fn({read:()=>saved,write:v=>saved=v})},provider,merchantCountry:siteId=>({siteId,country:'GB'}),mode:'test',now:()=>10000});
 assert.equal((await service.connect(owner)).state,'recovery_required');assert.equal(creates,0);assert.equal(saved.owner.accountId,'other-owner');assert.equal(saved.stripeAccountId,null);
});

test('owner replacement after a create response cannot acquire the returned account',async()=>{
 let saved=null;
 const provider={creationProtocol:'accounts_v2',async creationScope(){return 'acct_platform';},async createAccount(){saved={...saved,owner:{...owner,accountId:'other-owner'}};return 'acct_recipient';},async accountStatus(id){return{id,ready:true,actionRequired:false};},async createLink(){throw Error('unexpected');}};
 const service=createConnectionService({store:{transaction:fn=>fn({read:()=>saved,write:v=>saved=v})},provider,merchantCountry:siteId=>({siteId,country:'GB'}),mode:'test',now:()=>10000});
 await assert.rejects(service.connect(owner),/connection_conflict/);assert.equal(saved.owner.accountId,'other-owner');assert.equal(saved.stripeAccountId,null);
});
