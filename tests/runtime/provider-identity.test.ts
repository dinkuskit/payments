import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
const issuer = 'https://identity.example.invalid';
const owner = { accountId: JSON.stringify([issuer, 'synthetic-operator']), siteId: 'synthetic-diagnostic-site' };
const config = { ACCOUNT_ISSUER: issuer, STRIPE_API_KEY: 'sk_test_synthetic', STRIPE_DIAGNOSTIC_OPERATOR_ACCOUNT: owner.accountId, STRIPE_DIAGNOSTIC_OPERATOR_SITE: owner.siteId, STRIPE_DIAGNOSTIC_EXPECTED_ACCOUNT: 'acct_synthetic' };
const stored = { bindingRef:'stripe_synthetic', owner, mode:'test', providerId:'stripe', startedAt:Date.now(), stripeAccountId:null, authorizeNetMerchantId:null, creationFailure:{category:'unknown', at:Date.now()-1000, status:400} };

test('real Durable Object gates identity reads without writes and preserves historical diagnostics', async () => {
  const stub = env.PAYMENT_CONNECTIONS.getByName('identity-gates-synthetic');
  let calls = 0;
  vi.spyOn(globalThis,'fetch').mockImplementation(async (url, init) => {
    calls++; expect(String(url)).toBe('https://api.stripe.com/v1/account'); expect(init?.method).toBe('GET');
    return Response.json({object:'account',id:'acct_synthetic',email:'PRIVATE_CANARY'});
  });
  const variants = [
    { config:{ STRIPE_DIAGNOSTIC_OPERATOR_ACCOUNT: undefined } },
    { config:{ STRIPE_DIAGNOSTIC_OPERATOR_SITE: undefined } },
    { config:{ STRIPE_DIAGNOSTIC_EXPECTED_ACCOUNT: undefined } },
    { config:{ STRIPE_DIAGNOSTIC_OPERATOR_ACCOUNT: '["wrong","subject"]' } },
    { config:{ STRIPE_DIAGNOSTIC_OPERATOR_SITE: 'other-site' } },
    { config:{ STRIPE_DIAGNOSTIC_EXPECTED_ACCOUNT: 'invalid' } },
    { config:{ STRIPE_API_KEY:'sk_live_synthetic' } },
    { config:{ STRIPE_API_KEY:'sk_test_' } },
    { record:{ ...stored, owner:{...owner,accountId:'other'} } },
    { record:{ ...stored, mode:'live' } },
    { record:{ ...stored, providerId:'authorize_net' } },
    { record:null },
  ];
  await runInDurableObject(stub, async (instance, state) => {
    const runtime = (instance as unknown as {env:Record<string,unknown>}).env;
    const saved = {...runtime};
    try {
      for (const variant of variants) {
        Object.assign(runtime, config, variant.config ?? {});
        state.storage.sql.exec('DELETE FROM connection_state');
        if (variant.record !== null) state.storage.sql.exec('INSERT INTO connection_state (id,value) VALUES (1,?)', JSON.stringify(variant.record ?? stored));
        const before = state.storage.sql.exec('SELECT value FROM connection_state').toArray();
        let rejected = false;
        try { await instance.providerIdentityDiagnostic(owner); } catch { rejected = true; }
        expect(rejected).toBe(true); expect(calls).toBe(0);
        expect(state.storage.sql.exec('SELECT value FROM connection_state').toArray()).toEqual(before);
      }
      Object.assign(runtime, config);
      state.storage.sql.exec('INSERT INTO connection_state (id,value) VALUES (1,?)', JSON.stringify(stored));
      const before = state.storage.sql.exec('SELECT value FROM connection_state').toArray();
      const result = await instance.providerIdentityDiagnostic(owner);
      expect(result).toMatchObject({result:'match',validTestPrefix:true,httpStatus:200,diagnostics:{lastFailure:stored.creationFailure}});
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CANARY|acct_synthetic|synthetic-operator/);
      expect(calls).toBe(1);
      expect(state.storage.sql.exec('SELECT value FROM connection_state').toArray()).toEqual(before);
    } finally {
      for (const key of Object.keys(config)) runtime[key] = saved[key];
    }
  });
});
