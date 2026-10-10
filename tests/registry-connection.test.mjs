import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRegistryConnection, REGISTRY_CONNECT_URL, REGISTRY_ISSUER, REGISTRY_SCOPE } from '../src/registry/connection.ts';

function memory() {
  const values = new Map(); let revision = 0;
  const access = prefix => ({
    async get(key) { return values.get(prefix + key)?.value ?? null; },
    async getVersioned(key) { return values.get(prefix + key) ?? null; },
    async compareAndSet(key, expected, value) {
      if ((values.get(prefix + key)?.revision ?? null) !== expected) return { applied: false };
      values.set(prefix + key, { value: structuredClone(value), revision: String(++revision) }); return { applied: true };
    },
    async compareAndDelete(key, expected) {
      if (values.get(prefix + key)?.revision !== expected) return { applied: false };
      values.delete(prefix + key); return { applied: true };
    },
  });
  return { kv: access('kv:'), settings: access('secret:'), values };
}
const json = (body, status = 200) => Response.json(body, { status });
async function fixture({ testOnly, endpoint = { status: 'https://payments-proof.invalid/v1/status' } } = {}) {
  const store = memory(); const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'ES256' };
  const f = { now: 1_800_000_000_000, starts: 0, exchanges: 0, statuses: 0, approved: false, siteId: 'site', subject: 'org', error: null, calls: [], gate: null, claims: {} };
  const connection = createRegistryConnection({ ...store, config: { endpoint, testOnly }, site: { url: testOnly?.storeOrigin ?? 'https://shop.example' }, now: () => f.now,
    http: { async fetch(url, init) {
      assert.equal(init.redirect, 'manual'); f.calls.push({ url, init });
      if (url === REGISTRY_CONNECT_URL) {
        f.starts++; const body = JSON.parse(init.body);
        assert.equal(body.protocol_version, 2); assert.equal(body.service, 'payments'); assert.equal('site_id' in body, false);
        f.challenge = body.code_challenge;
        return json({ protocol_version: 2, site_id: f.siteId, connection_id: 'c' + f.starts, challenge: 'public-challenge', expires_at: f.now + 600_000, expires_in: 600, interval: 5,
          verification_uri: `${testOnly?.verificationOrigin ?? 'https://dinkuskit.com'}/account/connect?connection_id=c${f.starts}` });
      }
      if (url.endsWith('/token')) {
        f.exchanges++; assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ['client_id', 'code_verifier', 'connection_id']);
        assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.parse(init.body).code_verifier))).toString('base64url'), f.challenge);
        if (f.gate) await f.gate;
        if (f.error === 'lost') throw new Error('response_lost');
        if (f.error) return json({ error: f.error }, 400);
        if (!f.approved) return json({ error: 'authorization_pending' }, 400);
        const token = await new SignJWT({ site_id: f.siteId, scope: REGISTRY_SCOPE, ...f.claims })
          .setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setIssuer(REGISTRY_ISSUER).setAudience('dinkus-payments')
          .setSubject(f.subject).setIssuedAt(f.now / 1000).setExpirationTime(f.now / 1000 + 300).sign(privateKey);
        return json({ access_token: token, token_type: 'Bearer', site_id: f.siteId, expires_in: 300 });
      }
      if (url.endsWith('/jwks.json')) return json({ keys: [jwk] });
      f.statuses++; assert.equal(init.headers['X-Dinkus-Site'], f.siteId); assert.match(init.headers.Authorization, /^Bearer /);
      return json({ state: 'disconnected', mode: 'test' });
    } },
  });
  f.connect = async () => { assert.equal((await connection.start({ id: 'admin' })).state, 'pending'); f.now += 5000; f.approved = true; return connection.exchange({ id: 'admin' }); };
  return { ...f, f, connection, store };
}

test('actual v2 response freezes raw public receipt; verifier remains only in secret setting', async () => {
  const { f, connection, store } = await fixture();
  assert.equal((await connection.start({ id: 'admin' })).state, 'pending');
  const receipt = await connection.receipt('c1');
  assert.deepEqual(Object.keys(receipt).sort(), ['version','site_id','connection_id','challenge','client_id','service','site_origin','callback_uri','code_challenge','expires_at'].sort());
  assert.equal(receipt.code_challenge, f.challenge);
  const privateState = JSON.parse(await store.settings.get('registry_session'));
  for (const [key, value] of store.values) if (key.startsWith('kv:')) assert.equal(JSON.stringify(value).includes(privateState.verifier), false);
  assert.equal(await connection.receipt('wrong'), null);
});

test('ES256 consent, status and reconnect use fresh tokens with stable canonical authority', async () => {
  const { f, connection } = await fixture();
  assert.equal((await f.connect()).state, 'ready');
  assert.equal((await connection.status({ id: 'admin' })).state, 'ready');
  assert.equal(await connection.receipt('c1'), null);
  f.now += 301000;
  assert.equal((await connection.status({ id: 'admin' })).state, 'action_required');
  assert.equal((await f.connect()).state, 'ready');
  assert.equal((await connection.status({ id: 'admin' })).state, 'ready');
  assert.equal(f.statuses, 2);
});

test('canonical site and organization remapping is refused', async () => {
  const { f, connection } = await fixture(); await f.connect(); f.now += 301000; f.siteId = 'other';
  assert.equal((await connection.start({ id: 'admin' })).state, 'failed');
  f.siteId = 'site'; f.subject = 'other-org';
  assert.equal((await f.connect()).state, 'failed');
});

test('concurrent starts and overlapping slow polls perform one request', async () => {
  const { f, connection } = await fixture();
  await Promise.all([connection.start({ id: 'admin' }), connection.start({ id: 'admin' })]); assert.equal(f.starts, 1);
  f.now += 5000; let release; f.gate = new Promise(resolve => { release = resolve; });
  const first = connection.exchange({ id: 'admin' });
  while (!f.exchanges) await new Promise(resolve => setTimeout(resolve, 1));
  f.now += 10000;
  assert.equal((await connection.exchange({ id: 'admin' })).state, 'connecting');
  release(); assert.equal((await first).state, 'pending'); assert.equal(f.exchanges, 1);
});

test('only pending can retry; unknown and lost responses require explicit fresh Connect', async () => {
  for (const error of [null, 'already_redeemed', 'unknown', 'lost']) {
    const { f, connection } = await fixture(); await connection.start({ id: 'admin' });
    assert.equal((await connection.exchange({ id: 'admin' })).state, 'pending'); assert.equal(f.exchanges, 0);
    f.now += 5000; f.error = error;
    assert.equal((await connection.exchange({ id: 'admin' })).state, error ? 'failed' : 'pending');
    f.now += 5000;
    await connection.exchange({ id: 'admin' }); assert.equal(f.exchanges, error ? 1 : 2);
    assert.equal(Boolean(await connection.receipt('c1')), !error);
  }
});

test('manual secret injection and another administrator do not acquire authority', async () => {
  const { f, connection, store } = await fixture(); await f.connect();
  assert.equal((await connection.status({ id: 'other' })).state, 'action_required');
  const entry = await store.settings.getVersioned('registry_session');
  await store.settings.compareAndSet('registry_session', entry.revision, JSON.stringify({ kind: 'session', token: 'injected', flowId: 'manual' }));
  assert.notEqual((await connection.status({ id: 'admin' })).state, 'ready'); assert.equal(f.statuses, 0);
});

test('stale successful exchange cannot overwrite a fresh explicit flow', async () => {
  const { f, connection } = await fixture(); await connection.start({ id: 'admin' }); f.now += 5000; f.approved = true;
  let release; f.gate = new Promise(resolve => { release = resolve; }); const first = connection.exchange({ id: 'admin' });
  while (!f.exchanges) await new Promise(resolve => setTimeout(resolve, 1));
  f.now += 601000; assert.equal((await connection.start({ id: 'admin' })).state, 'pending');
  release(); assert.equal((await first).state, 'failed'); assert.ok(await connection.receipt('c2'));
});

test('explicit local build keeps canonical account API and permits exact local store proof', async () => {
  const { connection, f } = await fixture({ testOnly: { storeOrigin: 'http://127.0.0.1:47731', verificationOrigin: 'http://127.0.0.1:47732' } });
  assert.equal((await f.connect()).state, 'ready'); assert.equal(f.calls[0].url, REGISTRY_CONNECT_URL);
  assert.equal((await connection.status({ id: 'admin' })).state, 'ready');
});

test('unconfigured production status never contacts a Payments host even after consent', async () => {
  const { connection, f } = await fixture({ endpoint: null });
  assert.equal((await connection.status({ id: 'admin' })).state, 'unconfigured');
  await f.connect(); assert.equal((await connection.status({ id: 'admin' })).state, 'unconfigured'); assert.equal(f.statuses, 0);
});

test('future not-before and wrong service scope fail closed', async () => {
  for (const claims of [{ nbf: 1_800_000_500 }, { scope: 'inventory:admin' }]) {
    const { f } = await fixture(); f.claims = claims; assert.equal((await f.connect()).state, 'failed');
  }
});
