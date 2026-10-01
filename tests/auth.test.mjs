import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { createAccountAuthenticator } from '../src/hosted/auth.ts';

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
