import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedHandler } from '../src/hosted/http.ts';
import { hostedHttpRoutes } from '../src/hosted/manifest.ts';
import { legacyRecoveryAdmission } from '../src/hosted/legacy-recovery.ts';

const path = '/v1/connect/reconcile-legacy-rejection';
const policy = { operationId: 'synthetic-recovery', siteId: 'synthetic-site', bindingRef: 'stripe_synthetic',
  failureAt: 2, evidenceSha256: 'b'.repeat(64),
  rejection: 'accounts_v1_unsupported', rejectedRequestCount: 6, country: 'US', expiresAt: 1000 };
const identity = { issuer: 'https://identity.example.invalid', operatorAccount: '["https://identity.example.invalid","operator"]',
  operatorSite: policy.siteId, expectedPlatform: 'acct_synthetic' };
test('operator policy is absent by default and rejects malformed or unscoped configuration', () => {
  assert.equal(legacyRecoveryAdmission(undefined, identity), undefined);
  assert.equal(legacyRecoveryAdmission('', identity), undefined);
  assert.deepEqual(legacyRecoveryAdmission(JSON.stringify(policy), identity).policy, policy);
  for (const [raw, ids] of [
    ['invalid', identity], [JSON.stringify({ ...policy, extra: true }), identity],
    [JSON.stringify({ ...policy, expectedStartedAt: 1 }), identity],
    [JSON.stringify({ ...policy, rejectedRequestCount: 5 }), identity],
    [JSON.stringify(policy), { ...identity, issuer: 'https://other.example.invalid' }],
    [JSON.stringify(policy), { ...identity, operatorAccount: undefined }],
    [JSON.stringify(policy), { ...identity, operatorSite: 'another-site' }],
    [JSON.stringify(policy), { ...identity, expectedPlatform: undefined }],
  ]) assert.throws(() => legacyRecoveryAdmission(raw, ids), /configuration_invalid/);
});

test('operator route uses admin auth, accepts no body or query, and does not fall through to connect', async () => {
  let calls = 0;
  const principal = { accountId: identity.operatorAccount, siteId: identity.operatorSite };
  const handler = createHostedHandler({
    authenticate: async (_request, scope) => { assert.equal(scope, 'payments:admin'); return principal; },
    service: () => ({ connect: () => assert.fail('connect must not run'),
      prepareRejectedLegacyV2: async p => { assert.deepEqual(p, principal); calls++; return { state: 'prepared' }; } }),
  });
  assert.deepEqual(hostedHttpRoutes[path], { method: 'POST', scope: 'payments:admin' });
  assert.equal((await handler(new Request('https://payments.example.invalid'+path))).status, 405);
  assert.equal((await handler(new Request('https://payments.example.invalid'+path+'?binding=other', { method: 'POST' }))).status, 400);
  assert.equal((await handler(new Request('https://payments.example.invalid'+path, { method: 'POST', body: '{}' }))).status, 400);
  assert.equal(calls, 0);
  const response = await handler(new Request('https://payments.example.invalid'+path, { method: 'POST' }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { state: 'prepared' });
  assert.equal(calls, 1);
});

test('operator route refuses anonymous and playground principals without dispatch', async () => {
  const denied = createHostedHandler({ authenticate: async () => { throw Error('denied'); }, service: () => assert.fail('dispatch') });
  assert.equal((await denied(new Request('https://payments.example.invalid'+path, { method: 'POST' }))).status, 401);
  const playground = createHostedHandler({ authenticate: async () => ({ accountId: 'any', siteId: 'playground' }), service: () => assert.fail('dispatch') });
  assert.equal((await playground(new Request('https://payments.example.invalid'+path, { method: 'POST' }))).status, 403);
});
