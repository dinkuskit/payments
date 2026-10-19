import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, test, vi } from 'vitest';
import { createPaymentsPlugin } from '../../src/plugin';
import { createAccountAuthenticator } from '../../src/hosted/auth';
import { createHostedHandler } from '../../src/hosted/http';
import { REGISTRY_CONNECT_URL, REGISTRY_ISSUER, REGISTRY_JWKS_URL } from '../../src/registry/connection';

// Compose the production plugin route, signed hosted boundary and real Durable
// Object. The separately compiled plugin-test case proves EmDash's dispatcher.
test('confirmed plugin preparation reaches the signed Worker boundary and real DO without account creation', async () => {
  const siteId = 'synthetic-dispatch-site', subject = 'synthetic-dispatch-owner';
  const principal = { accountId: JSON.stringify([REGISTRY_ISSUER, subject]), siteId };
  const now = Date.now();
  const original = { owner: principal, bindingRef: 'stripe_dispatch_legacy', mode: 'test', providerId: 'stripe',
    startedAt: now - 172800000, stripeAccountId: null, authorizeNetMerchantId: null,
    creationFailure: { category: 'unknown', status: 400, at: now - 86400000 } };
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(['test', siteId]));
  const config = { ACCOUNT_ISSUER: REGISTRY_ISSUER, PAYMENT_PROVIDER: 'stripe', STRIPE_API_KEY: 'sk_test_synthetic',
    STRIPE_DIAGNOSTIC_OPERATOR_ACCOUNT: principal.accountId, STRIPE_DIAGNOSTIC_OPERATOR_SITE: siteId,
    STRIPE_DIAGNOSTIC_EXPECTED_ACCOUNT: 'acct_dispatchplatform', STRIPE_TEST_MERCHANT_COUNTRY_CONFIG: undefined,
    STRIPE_TEST_MERCHANT_COUNTRY_SITES: JSON.stringify([{ siteId, country: 'US' }]),
    STRIPE_TEST_LEGACY_V2_RECOVERY: JSON.stringify({ operationId: 'synthetic-dispatch-operation', siteId,
      bindingRef: original.bindingRef, expectedStartedAt: original.startedAt, failureAt: original.creationFailure.at,
      evidenceSha256: 'a'.repeat(64), rejection: 'accounts_v1_unsupported', rejectedRequestCount: 6, country: 'US', expiresAt: now + 300000 }) };
  let previous: Record<string, unknown>;
  await runInDurableObject(stub, (instance, state) => {
    const runtime = (instance as any).env;
    previous = Object.fromEntries(Object.keys(config).map(k => [k, runtime[k]]));
    Object.assign(runtime, config);
    state.storage.sql.exec('INSERT INTO connection_state (id,value) VALUES (1,?)', JSON.stringify(original));
  });
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://api.stripe.com/v1/account'); expect(init?.method).toBe('GET');
    return Response.json({ id: 'acct_dispatchplatform', object: 'account' });
  });
  try {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-dispatch-key', alg: 'ES256' };
    const token = await new SignJWT({ site_id: siteId, scope: 'payments:admin' }).setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
      .setIssuer(REGISTRY_ISSUER).setAudience('dinkus-payments').setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const hosted = createHostedHandler({
      authenticate: createAccountAuthenticator({ issuer: REGISTRY_ISSUER, audience: 'dinkus-payments', jwksUrl: REGISTRY_JWKS_URL }, async () => publicKey),
      service: p => ({ status: () => stub.status(p), diagnostics: () => stub.connectionDiagnostics(p),
        prepareRejectedLegacyV2: () => stub.prepareRejectedLegacyV2(p) }) as any,
    });
    const values = new Map<string, { value: any; revision: string }>(); let revision = 0;
    const memory = (prefix: string) => ({
      async get(key: string) { return values.get(prefix + key)?.value ?? null; },
      async getVersioned(key: string) { return values.get(prefix + key) ?? null; },
      async set(key: string, value: unknown) { values.set(prefix + key, { value: structuredClone(value), revision: String(++revision) }); },
      async compareAndSet(key: string, expected: string | null, value: unknown) {
        if ((values.get(prefix + key)?.revision ?? null) !== expected) return { applied: false };
        values.set(prefix + key, { value: structuredClone(value), revision: String(++revision) }); return { applied: true };
      },
      async compareAndDelete(key: string, expected: string) {
        if (values.get(prefix + key)?.revision !== expected) return { applied: false };
        values.delete(prefix + key); return { applied: true };
      },
    });
    const requests: { url: string; method: string; body: boolean }[] = [];
    let challenge = '';
    const context = { site: { url: 'https://store.example.invalid' }, plugin: { id: 'r_sffx6l4z6mpqliki' },
      kv: memory('kv:'), settings: memory('setting:'), http: { async fetch(url: string, init: RequestInit) {
        if (url === REGISTRY_CONNECT_URL) {
          challenge = JSON.parse(init.body as string).code_challenge;
          return Response.json({ protocol_version: 2, site_id: siteId, connection_id: 'synthetic-connection', challenge: 'public-challenge',
            expires_at: Date.now() + 590000, interval: 1, verification_uri: `${REGISTRY_ISSUER}/connect?connection_id=synthetic-connection` });
        }
        if (url === `${REGISTRY_CONNECT_URL}/token`) {
          const { code_verifier } = JSON.parse(init.body as string);
          const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code_verifier)));
          const actual = btoa(String.fromCharCode(...hash)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
          expect(actual).toBe(challenge);
          return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 300, site_id: siteId });
        }
        if (url === REGISTRY_JWKS_URL) return Response.json({ keys: [jwk] });
        requests.push({ url, method: init.method ?? 'GET', body: init.body != null });
        return hosted(new Request(url, init));
      } } };
    const plugin = createPaymentsPlugin({ endpoint: { status: 'https://payments.example.invalid/v1/status' } });
    const action = (action_id: string, id = 'synthetic-admin') => (plugin.routes!.admin as any).handler({ user: { id }, input: { type: 'block_action', action_id } }, context);
    await action('connect');
    const key = 'kv:state:registry-v2-control';
    values.get(key)!.value.nextPollAt = Date.now() - 1;
    await action('continue'); requests.length = 0;
    const confirmation = JSON.stringify(await action('review_legacy_v2'));
    expect(confirmation).toContain('Confirm recovery preparation'); expect(requests).toEqual([]); expect(provider).not.toHaveBeenCalled();
    const result = JSON.stringify(await action('prepare_legacy_v2'));
    expect(result).toContain('Recovery preparation saved'); expect(result.includes(token)).toBe(false);
    expect(result).not.toContain('setup_processor');
    expect(requests).toEqual([{ url: 'https://payments.example.invalid/v1/connect/reconcile-legacy-rejection', method: 'POST', body: false }]);
    expect(provider).toHaveBeenCalledTimes(1);
    const first = await runInDurableObject(stub, (_instance, state) => JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM connection_state WHERE id=1').one().value));
    expect(first.legacyRecovery.previous).toEqual(original); expect(first.stripeAccountId).toBeNull();
    await action('prepare_legacy_v2'); expect(provider).toHaveBeenCalledTimes(1);
    const replay = await runInDurableObject(stub, (_instance, state) => JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM connection_state WHERE id=1').one().value));
    expect(replay).toEqual(first);
    requests.length = 0;
    expect(JSON.stringify(await action('prepare_legacy_v2', 'another-admin'))).toContain('Sign in again'); expect(requests).toEqual([]);
    values.get(key)!.value.expiresAt = Date.now() - 1;
    expect(JSON.stringify(await action('prepare_legacy_v2'))).toContain('Sign in again'); expect(requests).toEqual([]);
  } finally {
    provider.mockRestore();
    await runInDurableObject(stub, instance => Object.assign((instance as any).env, previous!));
  }
});
