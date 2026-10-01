import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { createStripeOnboarding } from '../src/stripe/onboarding.ts';

test('official Stripe adapter freezes creation key and checks all readiness conditions', async () => {
  const calls = []; let blocked = false;
  const httpClient = Stripe.createFetchHttpClient(async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: String(init.body ?? '') });
    const path = new URL(url).pathname;
    const response = path === '/v1/account_links'
      ? { object: 'account_link', url: 'https://connect.stripe.com/test', expires_at: 1800000600 }
      : { object: 'account', id: 'acct_fixture', details_submitted: true, charges_enabled: !blocked, payouts_enabled: true, capabilities: { card_payments: 'active' }, requirements: {} };
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  });
  const provider = createStripeOnboarding({ apiKey: 'sk_test_synthetic_fixture', mode: 'test', returnUrl: 'https://accounts.example.invalid/stripe/return', refreshUrl: 'https://accounts.example.invalid/stripe/refresh', httpClient });
  assert.equal(await provider.createAccount('binding-one'), 'acct_fixture');
  assert.equal(calls[0].headers.get('idempotency-key'), 'dinkus-connect:binding-one');
  const params = new URLSearchParams(calls[0].body);
  assert.equal(params.get('type'), 'standard');
  assert.equal(params.get('metadata[dinkus_binding]'), 'binding-one');
  assert.equal((await provider.accountStatus('acct_fixture')).ready, true);
  blocked = true;
  assert.equal((await provider.accountStatus('acct_fixture')).ready, false);
  const link = await provider.createLink('acct_fixture');
  assert.equal(link.expiresAt, 1800000600000);
  const linkParams = new URLSearchParams(calls.at(-1).body);
  assert.equal(linkParams.get('account'), 'acct_fixture');
  assert.equal(linkParams.get('return_url'), 'https://accounts.example.invalid/stripe/return');
});

test('mode mismatch and unsafe callback configuration fail before transport', () => {
  const config = { apiKey: 'sk_test_synthetic_fixture', mode: 'test', returnUrl: 'https://accounts.example.invalid/return', refreshUrl: 'https://accounts.example.invalid/refresh' };
  assert.throws(() => createStripeOnboarding({ ...config, mode: 'live' }), /mode_mismatch/);
  assert.throws(() => createStripeOnboarding({ ...config, returnUrl: 'http://attacker.invalid' }), /return_configuration/);
});
