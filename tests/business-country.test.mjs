import assert from 'node:assert/strict';
import test from 'node:test';
import { BUSINESS_COUNTRIES, businessCountry } from '../src/business-country.ts';
import { createConnectionService } from '../src/hosted/connection.ts';
import { createHostedHandler } from '../src/hosted/http.ts';
const owner={accountId:'synthetic-owner',siteId:'synthetic-site'};
function fixture(seed=null, mode='test') {
 let record=structuredClone(seed), calls=[];
 const provider={creationProtocol:'accounts_v2',async creationScope(){calls.push(['scope']);return 'acct_platform';},async createAccount(key,country){calls.push(['create',key,country]);return 'acct_recipient';},async accountStatus(id){return{id,ready:true,actionRequired:false};},async createLink(){throw Error('unused');}};
 const service=createConnectionService({store:{transaction:fn=>fn({read:()=>record,write:v=>record=v})},provider,mode,now:()=>3000,newId:()=> 'new'});
 return {service,record:()=>record,calls,provider};
}
test('only Stripe business countries are listed, with no default',()=>{
 assert.equal(Object.keys(BUSINESS_COUNTRIES).length,44);
 assert.equal(BUSINESS_COUNTRIES.US,'United States');
 for(const value of ['US','GB','JP']) assert.equal(businessCountry(value),true);
 for(const value of [undefined,'','us','USA','IN','NG','toString','__proto__',['US'],{country:'US'}]) assert.equal(businessCountry(value),false);
});
test('any store in TEST or LIVE needs the owner country before any state or provider call',async()=>{
 for(const mode of ['test','live']) for(const country of [undefined,'','XX','us']) {
  const f=fixture(null,mode);
  await assert.rejects(f.service.connect(owner,country),/merchant_country_required/);assert.equal(f.record(),null);assert.deepEqual(f.calls,[]);
 }
});
test('the owner country is saved before create and sent as the account country',async()=>{
 for(const mode of ['test','live']) {
  const f=fixture(null,mode);f.provider.createAccount=async(key,country)=>{f.calls.push(['create',key,country]);assert.equal(f.record().creationCountry,'CA');return 'acct_recipient';};
  assert.equal((await f.service.connect(owner,'CA')).state,'ready');assert.deepEqual(f.calls,[['scope'],['create','stripe_new','CA']]);assert.equal(f.record().creationCountry,'CA');
 }
});
test('a saved country cannot change on a retry',async()=>{
 const f=fixture();f.provider.createAccount=async(key,country)=>{f.calls.push(['create',key,country]);throw Error('unconfirmed');};
 assert.equal((await f.service.connect(owner,'GB')).state,'connecting');
 await f.service.connect(owner,'US');await f.service.connect(owner);
 assert.deepEqual(f.calls.filter(x=>x[0]==='create').map(x=>x[2]),['GB','GB','GB']);assert.equal(f.record().creationCountry,'GB');
});
test('an attempt that may have reached Stripe without a country is never given one',async()=>{
 const seed={bindingRef:'stripe_old',owner,mode:'test',providerId:'stripe',startedAt:1000,stripeAccountId:null,authorizeNetMerchantId:null,creationProtocol:'accounts_v2',creationScope:'acct_platform',creationFailure:{category:'unknown',status:400,at:2000}};
 const f=fixture(seed);assert.equal((await f.service.connect(owner,'US')).state,'recovery_required');assert.deepEqual(f.record(),seed);assert.deepEqual(f.calls,[]);
});
test('a saved account resumes without a country',async()=>{
 const f=fixture({bindingRef:'stripe_old',owner,mode:'test',providerId:'stripe',startedAt:1000,stripeAccountId:'acct_recipient',authorizeNetMerchantId:null,creationProtocol:'accounts_v2',creationScope:'acct_platform',creationCountry:'GB'});
 assert.equal((await f.service.connect(owner)).state,'ready');assert.deepEqual(f.calls,[]);
});
test('Authorize.net never asks for a country',async()=>{
 let record=null;
 const service=createConnectionService({store:{transaction:fn=>fn({read:()=>record,write:v=>record=v})},provider:{async createAccount(){throw Error('unused');},async accountStatus(){throw Error('unused');},async createLink(){throw Error('unused');}},mode:'test',providerId:'authorize_net',authorizeNetMerchantId:'merchant-1',newId:()=> 'new'});
 assert.equal((await service.connect(owner)).state,'ready');assert.equal(record.creationCountry,undefined);
});
test('Set up Stripe accepts only an empty body or {"country":"XX"} from the list',async()=>{
 const seen=[];
 const handler=createHostedHandler({authenticate:async()=>owner,service:()=>({async connect(_p,country){seen.push(country);return{state:'connecting',mode:'test'};},async status(){throw Error('unused');},async checkoutBinding(){return null;},async existingBinding(){return null;}})});
 const post=body=>handler(new Request('https://payments.example/v1/connect',{method:'POST',headers:{Authorization:'Bearer t'},...(body===undefined?{}:{body})}));
 assert.equal((await post()).status,200);assert.equal((await post(JSON.stringify({country:'US'}))).status,200);
 assert.deepEqual(seen,[undefined,'US']);
 for(const body of [JSON.stringify({country:'XX'}),JSON.stringify({country:'US',extra:1}),JSON.stringify({country:'us'}),JSON.stringify(['US']),'US','{"country":"US"'+' '.repeat(64)+'}']) {
  const response=await post(body);assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'unexpected_input'});
 }
 assert.equal(seen.length,2);
 assert.equal((await handler(new Request('https://payments.example/v1/connect?country=US',{method:'POST',headers:{Authorization:'Bearer t'}}))).status,400);
});
test('status names the business country only to a plugin that asks, and only for Stripe',async()=>{
 const f=fixture();
 assert.equal(f.service.businessCountry(owner),null);
 await f.service.connect(owner,'GB');assert.equal(f.service.businessCountry(owner),'GB');
 let record=null;
 const anet=createConnectionService({store:{transaction:fn=>fn({read:()=>record,write:v=>record=v})},provider:{async createAccount(){throw Error('unused');},async accountStatus(){throw Error('unused');},async createLink(){throw Error('unused');}},mode:'test',providerId:'authorize_net',authorizeNetMerchantId:'merchant-1',newId:()=> 'new'});
 assert.equal(anet.businessCountry(owner),undefined);
 const handlerFor=country=>createHostedHandler({authenticate:async()=>owner,service:()=>({async connect(){throw Error('unused');},async status(){return{state:'disconnected',mode:'test'};},businessCountry:()=>country,async checkoutBinding(){return null;},async existingBinding(){return null;}})});
 const read=(country,headers={})=>handlerFor(country)(new Request('https://payments.example/v1/status',{headers:{Authorization:'Bearer t',...headers}})).then(r=>r.json());
 const ask={'X-Dinkus-Payments-Include':'business-country'};
 assert.deepEqual(await read(null),{state:'disconnected',mode:'test'});
 assert.deepEqual(await read(null,{'X-Dinkus-Payments-Include':'other'}),{state:'disconnected',mode:'test'});
 assert.deepEqual(await read(null,ask),{state:'disconnected',mode:'test',businessCountry:null});
 assert.deepEqual(await read('GB',ask),{state:'disconnected',mode:'test',businessCountry:'GB'});
 assert.deepEqual(await read(undefined,ask),{state:'disconnected',mode:'test'});
});
