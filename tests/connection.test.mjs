import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionService } from "../src/hosted/connection.ts";
import { createHostedHandler } from "../src/hosted/http.ts";

const owner = { accountId: 'issuer:merchant-a', siteId: 'store-a' };
function fixture() {
  let saved = null, time = 1_800_000_000_000, ready = false, down = false;
  const calls = [];
  const store = { transaction: fn => fn({ read: () => structuredClone(saved), write: value => { saved = structuredClone(value); } }) };
  const provider = {
    async createAccount(key) { calls.push(['create', key]); if (down) throw Error('offline'); return 'acct_one'; },
    async accountStatus(id) { calls.push(['status', id]); if (down) throw Error('offline'); return { id, ready, actionRequired: !ready }; },
    async createLink(id) { calls.push(['link', id]); return { url: 'https://connect.stripe.com/setup/test', expiresAt: time + 60000 }; },
  };
  const service = () => createConnectionService({ store, provider, mode: 'test', now: () => time, newId: () => 'binding-one' });
  return { service, store, calls, provider, setReady: value => { ready = value; }, setDown: value => { down = value; }, advance: ms => { time += ms; }, saved: () => saved };
}

test('persists intent before account creation and resumes one account after process restart', async () => {
  const f = fixture();
  const create = f.provider.createAccount;
  f.provider.createAccount = async key => { assert.equal(f.saved().bindingRef, key); return create(key); };
  assert.equal((await f.service().status(owner)).state, 'disconnected');
  assert.equal((await f.service().connect(owner)).url, 'https://connect.stripe.com/setup/test');
  await f.service().connect(owner);
  assert.equal(f.calls.filter(x => x[0] === 'create').length, 1);
  assert.equal(f.calls.filter(x => x[0] === 'link').length, 2);
  assert.equal(f.saved().stripeAccountId, 'acct_one');
});

test('unknown account creation outcome retries the frozen idempotency identity', async () => {
  const f = fixture(); f.setDown(true);
  assert.equal((await f.service().connect(owner)).state, 'connecting');
  f.setDown(false); await f.service().connect(owner);
  assert.deepEqual(f.calls.filter(x => x[0] === 'create'), [['create', 'stripe_binding-one'], ['create', 'stripe_binding-one']]);
});

test('an old unknown creation cannot create a duplicate after Stripe idempotency expiry', async () => {
  const f = fixture(); f.setDown(true); await f.service().connect(owner);
  f.advance(23 * 3600000); f.setDown(false);
  assert.equal((await f.service().connect(owner)).state, 'recovery_required');
  assert.equal(f.calls.filter(x => x[0] === 'create').length, 1);
});

test('simultaneous starts reuse one durable identity', async () => {
  const f = fixture(); await Promise.all([f.service().connect(owner), f.service().connect(owner)]);
  assert.equal(new Set(f.calls.filter(x => x[0] === 'create').map(x => x[1])).size, 1);
  assert.equal(f.saved().stripeAccountId, 'acct_one');
});

test('existing bindings cannot change merchant, site, or mode', async () => {
  const f = fixture(); await f.service().connect(owner); const n = f.calls.length;
  await assert.rejects(f.service().connect({ ...owner, accountId: 'issuer:merchant-b' }), /owner_mismatch/);
  await assert.rejects(f.service().status({ ...owner, siteId: 'store-b' }), /owner_mismatch/);
  const live = createConnectionService({ store: f.store, provider: f.provider, mode: 'live' });
  await assert.rejects(live.status(owner), /owner_mismatch/);
  assert.equal(f.calls.length, n);
});

test('existing bindings remain readable after readiness regresses', async () => {
  const f = fixture(); await f.service().connect(owner); f.setReady(true);
  assert.ok(await f.service().checkoutBinding(owner, 'stripe_binding-one'));
  f.setReady(false);
  assert.equal(await f.service().checkoutBinding(owner, 'stripe_binding-one'), null);
  assert.deepEqual(await f.service().existingBinding(owner, 'stripe_binding-one'), { bindingRef: 'stripe_binding-one', stripeAccountId: 'acct_one', mode: 'test', providerId: 'stripe' });
  assert.equal(await f.service().existingBinding(owner, 'stripe_replacement'), null);
});

test('checkout requires current provider readiness and the exact original binding', async () => {
  const f = fixture(); await f.service().connect(owner);
  assert.equal(await f.service().checkoutBinding(owner, 'stripe_binding-one'), null);
  f.setReady(true);
  assert.deepEqual(await f.service().checkoutBinding(owner, 'stripe_binding-one'), { bindingRef: 'stripe_binding-one', stripeAccountId: 'acct_one', mode: 'test', providerId: 'stripe' });
  assert.equal(await f.service().checkoutBinding(owner, 'stripe_replacement'), null);
  f.setReady(false);
  assert.equal(await f.service().checkoutBinding(owner, 'stripe_binding-one'), null);
  f.setReady(true); f.setDown(true);
  assert.equal((await f.service().status(owner)).state, 'checking');
  assert.equal(await f.service().checkoutBinding(owner, 'stripe_binding-one'), null);
});

test('another provider account response and a hostile onboarding URL fail closed', async () => {
  const f = fixture(); await f.service().connect(owner);
  f.provider.createLink = async () => ({ url: 'https://connect.stripe.com.attacker.invalid/setup', expiresAt: 9e15 });
  assert.equal((await f.service().connect(owner)).state, 'checking');
  f.provider.accountStatus = async () => ({ id: 'acct_other', ready: true, actionRequired: false });
  assert.equal(await f.service().checkoutBinding(owner, 'stripe_binding-one'), null);
});

test('Authorize.net bindings use authorizeNetMerchantId and never a Stripe account sentinel', async () => {
  const f = fixture();
  const service = () => createConnectionService({
    store: f.store, provider: f.provider, mode: 'test', providerId: 'authorize_net',
    authorizeNetMerchantId: 'merchant-one', newId: () => 'binding-one',
  });
  assert.equal((await service().connect(owner)).state, 'ready');
  assert.deepEqual(await service().checkoutBinding(owner, 'authorize_net_binding-one'), {
    bindingRef: 'authorize_net_binding-one', providerId: 'authorize_net',
    authorizeNetMerchantId: 'merchant-one', mode: 'test',
  });
  assert.equal(f.saved().stripeAccountId, null);
  assert.equal(f.saved().authorizeNetMerchantId, 'merchant-one');
});

test('cross-provider connection fields and the authorize sentinel fail closed', async () => {
  const f = fixture();
  f.store.transaction(tx => tx.write({
    bindingRef: 'stripe_binding-one', owner, mode: 'test', startedAt: 1,
    stripeAccountId: 'authorize_net', authorizeNetMerchantId: null, providerId: 'stripe',
  }));
  await assert.rejects(f.service().status(owner), /binding_invalid_stripe_account/);
  f.store.transaction(tx => tx.write({
    bindingRef: 'authorize_net_binding-one', owner, mode: 'test', startedAt: 1,
    stripeAccountId: 'acct_wrong', authorizeNetMerchantId: 'merchant-one', providerId: 'authorize_net',
  }));
  const authorize = createConnectionService({
    store: f.store, provider: f.provider, mode: 'test', providerId: 'authorize_net',
    authorizeNetMerchantId: 'merchant-one',
  });
  await assert.rejects(authorize.status(owner), /binding_cross_provider_fields/);
});

test('HTTP surface requires auth, separates checkout scope, and rejects caller configuration', async () => {
  const f = fixture(), scopes = [];
  const handle = createHostedHandler({ authenticate: async (request, scope) => {
    if (request.headers.get('authorization') !== 'Bearer synthetic') throw Error('unauthorized');
    scopes.push(scope); return owner;
  }, service: () => f.service() });
  const headers = { authorization: 'Bearer synthetic' };
  assert.equal((await handle(new Request('https://service.invalid/v1/connect', { method: 'POST' }))).status, 401);
  assert.equal((await handle(new Request('https://service.invalid/v1/connect', { method: 'POST', headers, body: '{"account":"acct_attacker"}' }))).status, 400);
  const response = await handle(new Request('https://service.invalid/v1/connect', { method: 'POST', headers }));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.status, 200);
  assert.equal((await handle(new Request('https://service.invalid/v1/checkout-binding?bindingRef=stripe_binding-one', { headers }))).status, 409);
  assert.equal(scopes.at(-1), 'payments:checkout');
  assert.equal((await handle(new Request('https://service.invalid/v1/connect?success=true', { headers }))).status, 405);
  assert.notEqual((await f.service().status(owner)).state, 'ready');
});
