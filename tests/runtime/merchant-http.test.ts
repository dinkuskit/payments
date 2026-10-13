import { stripeV2Account, stripeV2Link } from "../helpers/stripe-v2.js";
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
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/account") return Response.json({ object: "account", id: "acct_platform" });
    if (url.href === issuer + '/jwks') return Response.json({ keys: [jwk] });
    expect(url.origin).toBe('https://api.stripe.com');
    providerCalls++;
    if (unavailable) throw new Error('synthetic_provider_unavailable');
    if (url.pathname === '/v2/core/account_links') {
      links++;
      return Response.json(stripeV2Link());
    }
    if (url.pathname === '/v2/core/accounts') creates++;
    return Response.json(stripeV2Account("acct_fixture", ready));
  });
  const configured = { ...env, ACCOUNT_ISSUER: issuer, ACCOUNT_AUDIENCE: audience, ACCOUNT_JWKS_URL: issuer + '/jwks' };
  const issue = (subject = 'synthetic-merchant', claimSite = site, scope = 'payments:admin') => new SignJWT({ site_id: claimSite, scope })
    .setProtectedHeader({ alg: 'ES256', kid: 'synthetic-http' }).setIssuer(issuer).setAudience(audience)
    .setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const token = await issue();
  const call = async (path: string, options: { token?: string; site?: string; body?: string; emptyStream?: boolean } = {}) => {
    const method = path.split('?')[0] === '/v1/connect' ? 'POST' : 'GET';
    const headers = { authorization: `Bearer ${options.token ?? token}`, 'x-dinkus-site': options.site ?? site };
    const body = options.emptyStream ? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) : options.body;
    const request = new Request('https://payments.example.invalid' + path, { method, headers, body });
    if (options.emptyStream) expect(request.body).not.toBeNull();
    return worker.fetch(request, configured);
  };
  expect((await call('/v1/status')).status).toBe(200);
  expect(await (await call('/v1/status')).json()).toMatchObject({ state: 'disconnected', mode: 'test' });
  const unobserved = await call('/v1/connect/diagnostics');
  expect(await unobserved.json()).toEqual({ state: 'disconnected', mode: 'test', processorAccountPresent: false, evidence: 'unobserved' });
  const deniedCalls = providerCalls;
  expect((await call('/v1/connect/diagnostics?raw=1')).status).toBe(400);
  expect((await call('/v1/connect/diagnostics', { token: await issue('synthetic-merchant', site, 'payments:checkout') })).status).toBe(401);
  expect((await call('/v1/connect', { emptyStream: true, site: 'another-site' })).status).toBe(401);
  expect((await call('/v1/connect', { token: await issue('synthetic-merchant', site, 'payments:checkout') })).status).toBe(401);
  expect((await call('/v1/connect', { body: '{}' })).status).toBe(400);
  expect((await call('/v1/connect?return_url=https://attacker.invalid', { emptyStream: true })).status).toBe(400);
  expect(providerCalls).toBe(deniedCalls);
  const connected = await call('/v1/connect', { emptyStream: true });
  expect(connected.status).toBe(200);
  const snapshot = await connected.json<{ state: string; bindingRef: string; url: string }>();
  expect(snapshot).toMatchObject({ state: 'setup_required', mode: 'test', url: 'https://accounts.stripe.com/r/acct_fixture#alu_test_synthetic' });
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
  expect((await call('/v1/connect/diagnostics', { token: await issue('other-merchant') })).status).toBe(403);
  const present = await call('/v1/connect/diagnostics');
  expect(await present.json()).toEqual({ state: 'account_present', mode: 'test', processorAccountPresent: true, evidence: 'unobserved' });
  expect(providerCalls).toBe(beforeOwnerDenial);
});

test('a checkout sends shoppers back to the store address signed into its pass, never a fixed page', async () => {
  const issuer = 'https://accounts.example.invalid';
  const audience = 'payments-runtime-checkout';
  const site = crypto.randomUUID();
  const origin = 'https://shop.example.invalid';
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-checkout', alg: 'ES256', use: 'sig' };
  const created: URLSearchParams[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/account") return Response.json({ object: "account", id: "acct_platform" });
    if (url.href === issuer + '/jwks') return Response.json({ keys: [jwk] });
    expect(url.origin).toBe('https://api.stripe.com');
    if (url.pathname === '/v2/core/account_links') {
      return Response.json(stripeV2Link());
    }
    if (url.pathname === '/v1/checkout/sessions' && init?.method === 'POST') {
      const params = new URLSearchParams(String(init.body));
      created.push(params);
      const expiresAt = Number(params.get('expires_at'));
      return Response.json({
        object: 'checkout.session', id: 'cs_returnpages', url: 'https://checkout.stripe.com/c/pay/cs_returnpages',
        status: 'open', payment_status: 'unpaid', amount_total: 1200, currency: 'usd', created: expiresAt - 1860, expires_at: expiresAt,
        livemode: false, payment_intent: null, payment_method_types: ['card'],
        metadata: { dinkus_attempt: params.get('metadata[dinkus_attempt]'), dinkus_binding: params.get('metadata[dinkus_binding]'), dinkus_site: params.get('metadata[dinkus_site]') },
      });
    }
    return Response.json(stripeV2Account("acct_fixture", true));
  });
  const configured = { ...env, ACCOUNT_ISSUER: issuer, ACCOUNT_AUDIENCE: audience, ACCOUNT_JWKS_URL: issuer + '/jwks' };
  const pass = (scope: string, claims: Record<string, unknown> = {}) => new SignJWT({ site_id: site, scope, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'synthetic-checkout' }).setIssuer(issuer).setAudience(audience)
    .setSubject('synthetic-merchant').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const call = async (path: string, token: string, body?: unknown) => worker.fetch(new Request('https://payments.example.invalid' + path, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-dinkus-site': site }, body: body === undefined ? undefined : JSON.stringify(body),
  }), configured);
  const connected = await (await call('/v1/connect', await pass('payments:admin'))).json<{ state: string; bindingRef: string }>();
  expect(connected.state).toBe('ready');
  const payment = {
    attemptId: 'attempt-return-pages', bindingRef: connected.bindingRef,
    lines: [{ catalogItemId: 'sku-return', quantity: 1, name: 'Hat', unitPrice: { currency: 'USD', minor: '1200' } }],
    total: { currency: 'USD', minor: '1200' },
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 }, paymentMethods: ['card'],
  };

  const missing = await call('/v1/checkout/session', await pass('payments:checkout'), payment);
  expect(missing.status).toBe(409);
  expect(await missing.json()).toEqual({ error: 'store_origin_missing' });
  const malformed = await call('/v1/checkout/session', await pass('payments:checkout', { site_origin: origin + '/elsewhere' }), payment);
  expect(malformed.status).toBe(401);
  expect(created).toHaveLength(0);

  const started = await call('/v1/checkout/session', await pass('payments:checkout', { site_origin: origin }), payment);
  expect(started.status).toBe(200);
  expect(await started.json()).toMatchObject({ outcome: 'open', session: { sessionId: 'cs_returnpages' } });
  expect(created).toHaveLength(1);
  expect(created[0].get('success_url')).toBe(`${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`);
  expect(created[0].get('cancel_url')).toBe(`${origin}/cart`);
});
