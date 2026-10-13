import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { createConnectionService } from '../src/hosted/connection.ts';
import { creationFailure } from '../src/hosted/creation-failure.ts';
import { decodeDiagnostics } from '../src/connection-diagnostics.ts';
import { createHostedHandler } from '../src/hosted/http.ts';
const owner = { accountId: 'synthetic-owner', siteId: 'synthetic-site' };
const now = 1_800_000_000_000;
function fixture() {
  let saved = null, writes = 0, failure = new Error('synthetic-private-material'), time = now;
  const calls = [];
  const store = { transaction: fn => fn({ read: () => structuredClone(saved), write: value => { writes++; saved = structuredClone(value); } }) };
  const provider = {
    async createAccount(key) { calls.push(key); if (failure) throw failure; return 'acct_synthetic'; },
    async accountStatus(id) { return { id, ready: true, actionRequired: false }; },
    async createLink() { throw Error('unexpected'); },
  };
  const service = createConnectionService({ store, provider, mode: 'test', now: () => time, newId: () => 'fixed' });
  return { service, calls, saved: () => saved, writes: () => writes, seed: x => { saved = x; }, succeed: () => { failure = null; }, advance: ms => { time += ms; } };
}
test('closed category mapping never copies arbitrary provider material', () => {
  const cases = [
    ['StripeAuthenticationError', 'authentication'], ['StripePermissionError', 'permission'],
    ['StripeRateLimitError', 'rate_limited'], ['StripeConnectionError', 'transport_unknown'], ['StripeAPIError', 'provider_unavailable'],
    ['StripeInvalidRequestError', 'unknown'],
  ];
  for (const [kind, category] of cases) {
    const error = new Stripe.errors[kind]({ message: 'synthetic-private-material', statusCode: 401, requestId: 'synthetic-request', headers: { private: 'synthetic-private-material' } });
    assert.deepEqual(creationFailure(error, now), { category, at: now, status: 401 });
  }
  assert.deepEqual(creationFailure(new Stripe.errors.StripeInvalidRequestError({ code: 'platform_account_required', message: 'private' }), now), { category: 'platform_required', at: now });
  for (const error of ['private', new Error('private'), { type: 'StripeAuthenticationError', statusCode: 401, message: 'private' }, null]) assert.deepEqual(creationFailure(error, now), { category: 'unknown', at: now });
  assert.equal(JSON.stringify(creationFailure(new Stripe.errors.StripeAPIError({ statusCode: 599, message: 'private' }), now)).includes('599'), false);
});
test('failure keeps binding and retry window; diagnostics reads never call provider or write', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.connect(owner), { state: 'connecting', mode: 'test', bindingRef: 'stripe_fixed' });
  const record = f.saved(), writes = f.writes();
  for (let i = 0; i < 3; i++) assert.deepEqual(f.service.diagnostics(owner), { state: 'connecting', mode: 'test', processorAccountPresent: false, evidence: 'observed', lastFailure: { category: 'unknown', at: now } });
  assert.equal(f.writes(), writes); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(f.saved()).includes('synthetic-private-material'), false);
  await f.service.connect(owner); assert.deepEqual(f.calls, ['stripe_fixed', 'stripe_fixed']);
  assert.equal(f.saved().startedAt, record.startedAt); assert.equal(f.saved().bindingRef, record.bindingRef);
  f.advance(23 * 60 * 60 * 1000); await f.service.connect(owner);
  assert.equal(f.calls.length, 2); assert.equal(f.service.diagnostics(owner).state, 'recovery_required');
});
test('success clears failure and legacy reads remain unobserved without normalization', async () => {
  const f = fixture(); await f.service.connect(owner); f.succeed(); await f.service.connect(owner);
  assert.equal(f.saved().creationFailure, undefined); assert.equal(f.service.diagnostics(owner).processorAccountPresent, true);
  f.seed({ bindingRef: 'legacy', owner, mode: 'test', startedAt: now, stripeAccountId: null });
  const before = structuredClone(f.saved()), writes = f.writes();
  assert.equal(f.service.diagnostics(owner).evidence, 'unobserved');
  assert.deepEqual(f.saved(), before); assert.equal(f.writes(), writes);
  assert.throws(() => f.service.diagnostics({ ...owner, accountId: 'other' }), /owner_mismatch/);
});
test('diagnostics route uses admin authority, rejects input, and reveals no binding', async () => {
  const f = fixture(); await f.service.connect(owner); let scope;
  const handler = createHostedHandler({ authenticate: async (_, requested) => { scope = requested; return owner; }, service: () => f.service });
  const response = await handler(new Request('https://payments.invalid/v1/connect/diagnostics'));
  assert.equal(response.status, 200); assert.equal(scope, 'payments:admin'); assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text(); assert.equal(text.includes('stripe_fixed'), false); assert.equal(text.includes('synthetic-owner'), false);
  assert.equal((await handler(new Request('https://payments.invalid/v1/connect/diagnostics?x=1'))).status, 400);
  const denied = createHostedHandler({ authenticate: async () => ({ ...owner, siteId: 'other' }), service: () => f.service });
  assert.equal((await denied(new Request('https://payments.invalid/v1/connect/diagnostics'))).status, 403);
  assert.equal(f.calls.length, 1);
});
test('strict diagnostic decoder rejects added raw fields and invalid evidence', () => {
  const valid = { state: 'connecting', mode: 'test', processorAccountPresent: false, evidence: 'observed', lastFailure: { category: 'unknown', at: now } };
  assert.deepEqual(decodeDiagnostics(valid, now), valid);
  for (const value of [{ ...valid, message: 'private' }, { ...valid, lastFailure: { category: 'unknown', at: now, raw: 'private' } }, { ...valid, evidence: 'unobserved' }, { ...valid, lastFailure: { category: 'unknown', at: now + 1 } }]) assert.throws(() => decodeDiagnostics(value, now));
});
