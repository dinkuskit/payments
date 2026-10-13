import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { createStripeOnboarding, accountReadiness } from '../src/stripe/onboarding.ts';
import { validOnboardingUrl } from '../src/onboarding-url.ts';
import { stripeV2Account, stripeV2Link } from './helpers/stripe-v2.ts';
const config = { apiKey:'sk_test_synthetic_fixture', mode:'test', returnUrl:'https://accounts.example.invalid/return', refreshUrl:'https://accounts.example.invalid/refresh' };

test('v2 account lifecycle uses Endive JSON and stable scope without changing payment ownership', async () => {
  const calls=[];
  const httpClient=Stripe.createFetchHttpClient(async (url,init)=>{
    const path=new URL(url).pathname; calls.push({url,init});
    return Response.json(path==='/v1/account' ? {object:'account',id:'acct_platform'} : path==='/v2/core/account_links' ? stripeV2Link() : stripeV2Account());
  });
  const p=createStripeOnboarding({...config,httpClient});
  assert.equal(p.creationProtocol,'accounts_v2'); assert.equal(await p.creationScope(),'acct_platform');
  assert.equal(await p.createAccount('binding-one'),'acct_fixture');
  const request=calls.at(-1);const params=JSON.parse(request.init.body);
  assert.equal(new URL(request.url).pathname,'/v2/core/accounts'); assert.equal(new Headers(request.init.headers).get('stripe-version'),'2026-09-30.endive');
  assert.equal(new Headers(request.init.headers).get('content-type'),'application/json');
  assert.deepEqual(params,{dashboard:'full',configuration:{merchant:{capabilities:{card_payments:{requested:true}}}},defaults:{currency:'usd',responsibilities:{fees_collector:'stripe',losses_collector:'stripe'}},metadata:{dinkus_binding:'binding-one'}});
  assert.equal(new Headers(request.init.headers).get('idempotency-key'),'dinkus-connect:v2:binding-one');
  assert.equal(new Headers(request.init.headers).has('stripe-account'),false);
  assert.equal((await p.accountStatus('acct_fixture')).ready,true);
  const read=new URL(calls.at(-1).url);assert.equal(read.pathname,'/v2/core/accounts/acct_fixture');assert.deepEqual(read.searchParams.getAll('include[0]').concat(read.searchParams.getAll('include[1]')),['configuration.merchant','requirements']);
  const link=await p.createLink('acct_fixture');assert.match(link.url,/^https:\/\/accounts.stripe.com\/r\/acct_fixture#alu_test_/);assert.ok(link.expiresAt>Date.now());
  assert.deepEqual(JSON.parse(calls.at(-1).init.body),{account:'acct_fixture',use_case:{type:'account_onboarding',account_onboarding:{return_url:config.returnUrl,refresh_url:config.refreshUrl}}});
});

test('v2 readiness refuses omitted and mismatched facts and maps capability/requirements states', () => {
  const good=stripeV2Account();assert.equal(accountReadiness(good,'acct_fixture','test').ready,true);
  for(const patch of [{id:'acct_other'},{livemode:true}]) assert.throws(()=>accountReadiness({...good,...patch},'acct_fixture','test'));
  for(const patch of [{requirements:null},{configuration:{}},{applied_configurations:[]}]) assert.equal(accountReadiness({...good,...patch},'acct_fixture','test').ready,false);
  for(const status of ['restricted','rejected','unsupported']) {
    const value=stripeV2Account();value.configuration.merchant.capabilities.card_payments.status=status;
    assert.deepEqual(accountReadiness(value,'acct_fixture','test'),{id:'acct_fixture',ready:false,actionRequired:true});
  }
  assert.equal(accountReadiness(stripeV2Account('acct_fixture',false),'acct_fixture','test').ready,false);
  const due=stripeV2Account();due.requirements.entries.push({awaiting_action_from:'user',minimum_deadline:{status:'currently_due'}});
  assert.equal(accountReadiness(due,'acct_fixture','test').actionRequired,true);
  due.requirements.entries[0].minimum_deadline.status='unknown';assert.throws(()=>accountReadiness(due,'acct_fixture','test'));
});

test('v2 link rejects wrong account/mode, expired or malformed dates and unsafe URLs', async () => {
  for(const patch of [{account:'acct_other'},{livemode:true},{expires_at:'not-a-date'},{expires_at:new Date(Date.now()-1).toISOString()},{url:'https://accounts.stripe.com.evil/r/acct_fixture#alu_test_bad'},{url:'https://accounts.stripe.com/r/acct_other#alu_test_bad'},{url:'https://accounts.stripe.com/r/acct_fixture#alu_live_bad'}]) {
    const p=createStripeOnboarding({...config,httpClient:Stripe.createFetchHttpClient(async()=>Response.json({...stripeV2Link(),...patch}))});
    await assert.rejects(p.createLink('acct_fixture'));
  }
  assert.equal(validOnboardingUrl('https://connect.stripe.com/setup/legacy','test'),true);
  assert.equal(validOnboardingUrl('https://accounts.stripe.com/r/acct_fixture#alu_test_synthetic','test','acct_fixture'),true);
  for(const url of ['http://accounts.stripe.com/r/acct_fixture#alu_test_x','https://accounts.stripe.com/r/acct_fixture?redirect=bad#alu_test_x','https://user@accounts.stripe.com/r/acct_fixture#alu_test_x','https://accounts.stripe.com/r/acct_fixture#other']) assert.equal(validOnboardingUrl(url,'test'),false);
});

test('v2 creation has no hidden connection-reset retry', async () => {
  for(const code of ['ECONNRESET','EPIPE']) {
    let calls=0;const p=createStripeOnboarding({...config,httpClient:Stripe.createFetchHttpClient(async()=>{calls++;throw Object.assign(Error('synthetic-private'),{code});})});
    await assert.rejects(p.createAccount('binding-one'));assert.equal(calls,1);
  }
});

test('mode mismatch and unsafe callback configuration fail before transport', () => {
  assert.throws(()=>createStripeOnboarding({...config,mode:'live'}),/mode_mismatch/);
  assert.throws(()=>createStripeOnboarding({...config,returnUrl:'http://attacker.invalid'}),/return_configuration/);
});
