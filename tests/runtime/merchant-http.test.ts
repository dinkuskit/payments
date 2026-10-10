import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../../src/cloudflare/worker';

afterEach(() => vi.restoreAllMocks());

test('health is public, test-mode-only, and independent of provider configuration', async () => {
  const response = await worker.fetch(new Request('https://payments.example.invalid/health'), env);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', mode: 'test' });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('signed merchant connect accepts empty runtime streams and verifies return readiness', async () => {
  const issuer = 'https://accounts.example.invalid';
  const audience = 'payments-runtime-admin';
  const site = crypto.randomUUID();
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-http', alg: 'ES256', use: 'sig' };
  let ready = false, unavailable = false, creates = 0, links = 0, providerCalls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.href === issuer + '/jwks') return Response.json({ keys: [jwk] });
    expect(url.origin).toBe('https://api.stripe.com');
    providerCalls++;
    if (unavailable) throw new Error('synthetic_provider_unavailable');
    if (url.pathname === '/v1/account_links') {
      links++;
      return Response.json({ object: 'account_link', url: 'https://connect.stripe.com/setup/fixture', expires_at: Math.floor(Date.now() / 1000) + 600 });
    }
    if (url.pathname === '/v1/accounts') creates++;
    return Response.json({ object: 'account', id: 'acct_fixture', details_submitted: ready, charges_enabled: ready, payouts_enabled: ready, capabilities: { card_payments: ready ? 'active' : 'pending' }, requirements: {} });
  });
  const configured = { ...env, ACCOUNT_ISSUER: issuer, ACCOUNT_AUDIENCE: audience, ACCOUNT_JWKS_URL: issuer + '/jwks' };
  const issue = (subject = 'synthetic-merchant', claimSite = site, scope = 'payments:admin') => new SignJWT({ site_id: claimSite, scope })
    .setProtectedHeader({ alg: 'ES256', kid: 'synthetic-http' }).setIssuer(issuer).setAudience(audience)
    .setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const token = await issue();
  const call = async (path: string, options: { token?: string; site?: string; body?: string; emptyStream?: boolean } = {}) => {
    const method = path.startsWith('/v1/connect') ? 'POST' : 'GET';
    const headers = { authorization: `Bearer ${options.token ?? token}`, 'x-dinkus-site': options.site ?? site };
    const body = options.emptyStream ? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) : options.body;
    const request = new Request('https://payments.example.invalid' + path, { method, headers, body });
    if (options.emptyStream) expect(request.body).not.toBeNull();
    return worker.fetch(request, configured);
  };
  expect((await call('/v1/status')).status).toBe(200);
  expect(await (await call('/v1/status')).json()).toMatchObject({ state: 'disconnected', mode: 'test' });
  const deniedCalls = providerCalls;
  expect((await call('/v1/connect', { emptyStream: true, site: 'another-site' })).status).toBe(401);
  expect((await call('/v1/connect', { token: await issue('synthetic-merchant', site, 'payments:checkout') })).status).toBe(401);
  expect((await call('/v1/connect', { body: '{}' })).status).toBe(400);
  expect((await call('/v1/connect?return_url=https://attacker.invalid', { emptyStream: true })).status).toBe(400);
  expect(providerCalls).toBe(deniedCalls);
  const connected = await call('/v1/connect', { emptyStream: true });
  expect(connected.status).toBe(200);
  const snapshot = await connected.json<{ state: string; bindingRef: string; url: string }>();
  expect(snapshot).toMatchObject({ state: 'setup_required', mode: 'test', url: 'https://connect.stripe.com/setup/fixture' });
  expect(connected.headers.get('Cache-Control')).toBe('no-store');
  // The authenticated refresh operation resumes the same binding/account.
  expect(await (await call('/v1/connect', { emptyStream: true })).json()).toMatchObject({ bindingRef: snapshot.bindingRef, state: 'setup_required' });
  expect(creates).toBe(1);
  expect(links).toBe(2);
  expect((await call('/v1/status?success=true')).status).toBe(400);
  expect(await (await call('/v1/status')).json()).toMatchObject({ state: 'setup_required' });
  ready = true;
  expect(await (await call('/v1/status')).json()).toMatchObject({ state: 'ready', mode: 'test', bindingRef: snapshot.bindingRef });
  unavailable = true;
  expect(await (await call('/v1/status')).json()).toMatchObject({ state: 'checking', mode: 'test' });
  unavailable = false;
  const beforeOwnerDenial = providerCalls;
  expect((await call('/v1/status', { token: await issue('other-merchant') })).status).toBe(403);
  expect(providerCalls).toBe(beforeOwnerDenial);
});
