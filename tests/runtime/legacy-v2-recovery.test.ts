import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { legacyStateFingerprint } from '../../src/hosted/legacy-recovery';
import type { Connection } from '../../src/hosted/connection';

afterEach(() => vi.restoreAllMocks());

test('real Durable Object prepares only its configured legacy binding with one identity GET and no create', async () => {
  const issuer = 'https://identity.example.invalid';
  const owner = { accountId: JSON.stringify([issuer, 'synthetic-operator']), siteId: 'synthetic-recovery-site' };
  const now = Date.now();
  const original: Connection = { owner, mode: 'test', bindingRef: 'stripe_synthetic_recovery', providerId: 'stripe',
    startedAt: now - 172_800_000, stripeAccountId: null, authorizeNetMerchantId: null,
    creationFailure: { category: 'unknown', status: 400, at: now - 86_400_000 } };
  const policy = { operationId: 'synthetic-recovery-operation', siteId: owner.siteId, bindingRef: original.bindingRef,
    expectedStartedAt: original.startedAt, failureAt: original.creationFailure!.at,
    expectedFingerprint: await legacyStateFingerprint(original), evidenceSha256: 'a'.repeat(64),
    rejection: 'accounts_v1_unsupported', rejectedRequestCount: 6, country: 'US', expiresAt: now + 300_000 };
  let calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls++; expect(String(url)).toBe('https://api.stripe.com/v1/account'); expect(init?.method).toBe('GET');
    return Response.json({ object: 'account', id: 'acct_syntheticplatform', email: 'PRIVATE_CANARY' });
  });
  const stub = env.PAYMENT_CONNECTIONS.getByName('synthetic-legacy-recovery');
  await runInDurableObject(stub, async (instance, state) => {
    const runtime = (instance as unknown as { env: Record<string, unknown> }).env;
    const config = { ACCOUNT_ISSUER: issuer, PAYMENT_PROVIDER: 'stripe', STRIPE_API_KEY: 'sk_test_synthetic',
      STRIPE_DIAGNOSTIC_OPERATOR_ACCOUNT: owner.accountId, STRIPE_DIAGNOSTIC_OPERATOR_SITE: owner.siteId,
      STRIPE_DIAGNOSTIC_EXPECTED_ACCOUNT: 'acct_syntheticplatform', STRIPE_TEST_LEGACY_V2_RECOVERY: JSON.stringify(policy),
      STRIPE_TEST_MERCHANT_COUNTRY_CONFIG: undefined,
      STRIPE_TEST_MERCHANT_COUNTRY_SITES: JSON.stringify([{ siteId: owner.siteId, country: 'US' }]) };
    const saved = { ...runtime };
    try {
      Object.assign(runtime, config);
      state.storage.sql.exec('INSERT INTO connection_state (id,value) VALUES (1,?)', JSON.stringify(original));
      const before = state.storage.sql.exec('SELECT value FROM connection_state WHERE id=1').toArray();
      await expect(instance.prepareRejectedLegacyV2({ ...owner, accountId: 'other' })).rejects.toThrow('legacy_recovery_forbidden');
      await expect(instance.prepareRejectedLegacyV2({ ...owner, siteId: 'sibling-site' })).rejects.toThrow('legacy_recovery_forbidden');
      expect(calls).toBe(0);
      expect(state.storage.sql.exec('SELECT value FROM connection_state WHERE id=1').toArray()).toEqual(before);
      const receipt = await instance.prepareRejectedLegacyV2(owner);
      expect(receipt).toMatchObject({ state: 'prepared', mode: 'test', bindingRef: original.bindingRef, operationId: policy.operationId });
      expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_CANARY|acct_synthetic|synthetic-operator|expectedFingerprint/);
      expect(calls).toBe(1);
      const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM connection_state WHERE id=1').one();
      const prepared = JSON.parse(row.value);
      expect(prepared.legacyRecovery.previous).toEqual(original);
      expect(prepared.stripeAccountId).toBe(null);
      expect(prepared.creationProtocol).toBe('accounts_v2');
      expect(await instance.prepareRejectedLegacyV2(owner)).toEqual(receipt);
      expect(calls).toBe(1);
      expect(state.storage.sql.exec('SELECT value FROM connection_state WHERE id=1').one()).toEqual(row);
    } finally {
      for (const key of Object.keys(config)) runtime[key] = saved[key];
    }
  });
});
