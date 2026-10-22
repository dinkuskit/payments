import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { createAccountAuthenticator } from '../src/hosted/auth.ts';
import { hostedHttpRoutes } from '../src/hosted/manifest.ts';

test('shared issuer identity is verified with audience, expiry, site, and separate permissions', async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const issuer = 'https://accounts.example.invalid';
  const verify = createAccountAuthenticator({ issuer, audience: 'dinkus-payments', jwksUrl: issuer + '/jwks' }, async () => publicKey);
  const issue = overrides => new SignJWT({ site_id: 'site-a', scope: 'payments:admin', ...overrides })
    .setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience('dinkus-payments').setSubject('merchant-a')
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const request = (token, site = 'site-a') => new Request('https://payments.example.invalid/v1/status', { headers: { authorization: `Bearer ${token}`, 'x-dinkus-site': site } });
  const token = await issue({});
  assert.deepEqual(await verify(request(token), 'payments:admin'), { accountId: JSON.stringify([issuer, 'merchant-a']), siteId: 'site-a' });
  await assert.rejects(verify(request(token, 'site-b'), 'payments:admin'));
  await assert.rejects(verify(request(token), 'payments:checkout'));
  // The status read takes either pass; each other route still names exactly one.
  const both = ['payments:admin', 'payments:checkout'];
  assert.equal((await verify(request(token), both)).siteId, 'site-a');
  assert.equal((await verify(request(await issue({ scope: 'payments:checkout' })), both)).siteId, 'site-a');
  await assert.rejects(verify(request(await issue({ scope: 'ship:admin' })), both));
  // Composed with the hosted routes: the store's checkout pass reads status, never diagnostics.
  const checkoutPass = await issue({ scope: 'payments:checkout' });
  assert.equal((await verify(request(checkoutPass), hostedHttpRoutes['/v1/status'].scope)).siteId, 'site-a');
  for (const path of ['/v1/connect', '/v1/connect/diagnostics', '/v1/connect/provider-identity', '/v1/connect/reconcile-legacy-rejection']) {
    await assert.rejects(verify(request(checkoutPass), hostedHttpRoutes[path].scope));
  }
  await assert.rejects(verify(request(await issue({ site_id: '' })), 'payments:admin'));
  const otherKey = await generateKeyPair('ES256');
  const wrong = await new SignJWT({ site_id: 'site-a', scope: 'payments:admin' }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience('dinkus-payments').setSubject('merchant-a').setIssuedAt().setExpirationTime('5m').sign(otherKey.privateKey);
  await assert.rejects(verify(request(wrong), 'payments:admin'));
  for (const invalid of [
    { audience: 'other-service', expiration: '5m', issued: Math.floor(Date.now()/1000) },
    { audience: 'dinkus-payments', expiration: '-1m', issued: Math.floor(Date.now()/1000) },
    { audience: 'dinkus-payments', expiration: '10m', issued: Math.floor(Date.now()/1000) + 300 },
  ]) {
    const invalidToken = await new SignJWT({ site_id: 'site-a', scope: 'payments:admin' }).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience(invalid.audience).setSubject('merchant-a').setIssuedAt(invalid.issued).setExpirationTime(invalid.expiration).sign(privateKey);
    await assert.rejects(verify(request(invalidToken), 'payments:admin'));
  }
});

test('a store pass carries the web address DinkusKit.com checked, and a malformed one fails closed', async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const issuer = 'https://accounts.example.invalid';
  const verify = createAccountAuthenticator({ issuer, audience: 'dinkus-payments', jwksUrl: issuer + '/jwks' }, async () => publicKey);
  const issue = siteOrigin => new SignJWT({ site_id: 'site-a', scope: 'payments:checkout', site_origin: siteOrigin })
    .setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience('dinkus-payments').setSubject('merchant-a')
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const request = token => new Request('https://payments.example.invalid/v1/checkout/session', { headers: { authorization: `Bearer ${token}`, 'x-dinkus-site': 'site-a' } });
  for (const origin of ['https://shop.example.test', 'https://shop.example.test:8443']) {
    assert.deepEqual(await verify(request(await issue(origin)), 'payments:checkout'),
      { accountId: JSON.stringify([issuer, 'merchant-a']), siteId: 'site-a', siteOrigin: origin });
  }
  for (const malformed of ['', 'http://shop.example.test', 'https://shop.example.test/', 'https://shop.example.test/cart',
    'https://shop.example.test?next=1', 'https://buyer@shop.example.test', 'https://SHOP.example.test', 'https://shop.example.test:443',
    'javascript:alert(1)', `https://${'a'.repeat(2050)}.example`, 42, ['https://shop.example.test'], null]) {
    await assert.rejects(verify(request(await issue(malformed)), 'payments:checkout'), /unauthorized/, JSON.stringify(malformed));
  }
});
