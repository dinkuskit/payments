import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { checkStripePlatformIdentity } from '../src/stripe/identity.ts';
import { decodeProviderIdentityDiagnostic } from '../src/provider-identity.ts';
import { createHostedHandler } from '../src/hosted/http.ts';

const options = { apiKey: 'sk_test_synthetic_fixture', expectedAccountId: 'acct_synthetic' };
const canary = 'PRIVATE_CANARY_DO_NOT_COPY';
test('identity performs one fixed read, reduces match/mismatch and drops provider details', async () => {
  for (const id of ['acct_synthetic', 'acct_different']) {
    const calls = [];
    const httpClient = Stripe.createFetchHttpClient(async (url, init) => {
      calls.push({ url, init });
      return Response.json({ object: 'account', id, email: canary, metadata: { private: canary } });
    });
    const result = await checkStripePlatformIdentity({ ...options, httpClient });
    assert.equal(result.result, id === options.expectedAccountId ? 'match' : 'mismatch');
    assert.equal(result.httpStatus, 200); assert.equal(result.validTestPrefix, true);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.stripe.com/v1/account');
    assert.equal(calls[0].init.method, 'GET');
    assert.ok(!Object.keys(calls[0].init.headers).some(k => ['stripe-account','stripe-context'].includes(k.toLowerCase())));
    assert.doesNotMatch(JSON.stringify(result), /acct_|PRIVATE_CANARY/);
    assert.deepEqual(decodeProviderIdentityDiagnostic(result), result);
  }
});
test('identity refuses invalid test configuration before any request', async () => {
  let calls = 0;
  const httpClient = Stripe.createFetchHttpClient(async () => { calls++; throw Error(canary); });
  for (const bad of [{ apiKey: 'sk_live_synthetic' }, { apiKey: 'sk_test_' }, { expectedAccountId: 'bad' }]) {
    assert.equal((await checkStripePlatformIdentity({ ...options, ...bad, httpClient })).result, 'unavailable');
  }
  assert.equal(calls, 0);
});
test('closed connections, error responses and malformed payloads remain one request with redaction', async () => {
  for (const behavior of ['ECONNRESET', 'EPIPE', 'error', 'malformed', 'wrongObject']) {
    let calls = 0;
    const httpClient = Stripe.createFetchHttpClient(async () => {
      calls++;
      if (behavior === 'ECONNRESET' || behavior === 'EPIPE') throw Object.assign(Error(canary), { code: behavior });
      if (behavior === 'error') return Response.json({ error: { type: 'invalid_request_error', message: canary } }, { status: 400, headers: { 'request-id': canary } });
      if (behavior === 'malformed') return new Response(canary);
      return Response.json({ object: 'customer', id: 'acct_synthetic' });
    });
    const result = await checkStripePlatformIdentity({ ...options, httpClient });
    assert.equal(result.result, 'unconfirmed'); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY|acct_|ECONNRESET|EPIPE/);
  }
});
test('diagnostic decoder rejects raw fields, false successful claims and nested private data', () => {
  const valid = { result: 'match', validTestPrefix: true, httpStatus: 200, at: Date.now() };
  for (const payload of [{ ...valid, id: canary }, { ...valid, validTestPrefix: false }, { ...valid, httpStatus: 400 }, { ...valid, diagnostics: { raw: canary } }]) {
    assert.throws(() => decodeProviderIdentityDiagnostic(payload));
  }
});
test('HTTP authentication and request envelope denial cause no service/provider access', async () => {
  let access = 0;
  const service = () => { access++; throw Error(canary); };
  const denied = createHostedHandler({ authenticate: async () => { throw Error(canary); }, service });
  assert.equal((await denied(new Request('https://payments.invalid/v1/connect/provider-identity'))).status, 401);
  const authorized = createHostedHandler({ authenticate: async (_, scope) => { assert.equal(scope,'payments:admin'); return { accountId:'synthetic',siteId:'synthetic' }; }, service });
  assert.equal((await authorized(new Request('https://payments.invalid/v1/connect/provider-identity?account=bad'))).status,400);
  assert.equal((await authorized(new Request('https://payments.invalid/v1/connect/provider-identity',{method:'POST'}))).status,405);
  assert.equal(access,0);
});
