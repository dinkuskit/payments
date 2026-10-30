import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { readFile } from 'node:fs/promises';
import { createRegistryConnection, REGISTRY_CONNECT_URL, REGISTRY_ISSUER, REGISTRY_JWKS_URL, REGISTRY_SCOPE, STORE_PASSES_URL } from '../src/registry/connection.ts';
import { ACCEPTED_INSTALLED_PLUGIN_IDS } from '../src/registry/identity.ts';
import { PRODUCTION_STATUS_ENDPOINT } from '../src/plugin.ts';

function memory() {
  const values = new Map(); let revision = 0;
  const access = prefix => ({
    async get(key) { return values.get(prefix + key)?.value ?? null; },
    async getVersioned(key) { return values.get(prefix + key) ?? null; },
    async set(key, value) { values.set(prefix + key, { value: structuredClone(value), revision: String(++revision) }); },
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
const KEY = `dk_store_${'S'.repeat(43)}`;
// The plugin's own store key, as the Connect setting holds it.
const sessionKey = async store => { const raw = await store.settings.get('registry_session'); return raw ? JSON.parse(raw).storeKey : undefined; };
async function fixture({ testOnly, installedPluginId, pluginId, endpoint = { status: 'https://payments-proof.invalid/v1/status' }, storeKey = KEY } = {}) {
  const store = memory();
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'ES256' };
  const expectedPluginId = installedPluginId === 'dinkus-payments-beta' || pluginId === 'dinkus-payments-beta'
    ? 'r_sffx6l4z6mpqliki'
    : (installedPluginId ?? (pluginId === 'dinkus-payments' ? 'r_3brsc2on3bu673rn' : pluginId) ?? 'r_3brsc2on3bu673rn');
  const f = { storeKey, connectRefusal: null, now: 1_800_000_000_000, starts: 0, exchanges: 0, statuses: 0, approved: false, siteId: 'site', subject: 'org', error: null, calls: [], gate: null, claims: {}, setupReply: { state: 'setup_required', mode: 'test', bindingRef: 'synthetic-binding', url: 'https://connect.stripe.com/setup/synthetic', expiresAt: 1_800_000_300_000 }, setupStatus: 200, passes: 0, diagnosticScopes: [], passError: null, passClaims: {}, slept: [], statusReply: { state: 'disconnected', mode: 'test', bindingRef: 'synthetic-binding' } };
  const connection = createRegistryConnection({
    ...store,
    config: { endpoint, testOnly, ...(installedPluginId ? { installedPluginId } : {}) },
    ...(pluginId ? { plugin: { id: pluginId } } : {}),
    site: { url: testOnly?.storeOrigin ?? 'https://shop.example' },
    now: () => f.now,
    sleep: async ms => { f.slept.push(ms); f.now += ms; },
    http: { async fetch(url, init) {
      assert.equal(init.redirect, 'manual'); f.calls.push({ url, init });
      if (url === REGISTRY_CONNECT_URL) {
        f.starts++; const body = JSON.parse(init.body);
        if (f.connectRefusal) return json({ error: f.connectRefusal }, 409);
        assert.equal(body.protocol_version, 2); assert.equal(body.service, 'payments'); assert.equal('site_id' in body, false);
        assert.equal(body.callback_uri, `${testOnly?.storeOrigin ?? 'https://shop.example'}/_emdash/admin/plugins/${expectedPluginId}/status`);
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
          .setSubject(f.subject).setIssuedAt(Math.floor(f.now / 1000)).setExpirationTime(Math.floor(f.now / 1000) + 300).sign(privateKey);
        return json({ access_token: token, token_type: 'Bearer', site_id: f.siteId, expires_in: 300, ...(f.storeKey === null ? {} : { store_key: f.storeKey }) });
      }
      if (url.endsWith('/jwks.json')) return json({ keys: [jwk] });
      if (url === STORE_PASSES_URL) {
        f.passes++; assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, `Bearer ${await sessionKey(store)}`);
        assert.deepEqual(JSON.parse(init.body), { site_id: f.siteId, scope: 'payments:checkout', audience: 'dinkus-payments' });
        if (f.passError) return json({ error: f.passError.error }, f.passError.status);
        const pass = await new SignJWT({ site_id: f.siteId, scope: 'payments:checkout', ...f.passClaims })
          .setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setIssuer(REGISTRY_ISSUER).setAudience('dinkus-payments')
          .setSubject(f.subject).setIssuedAt(Math.floor(f.now / 1000)).setExpirationTime(Math.floor(f.now / 1000) + 300).sign(privateKey);
        return json({ access_token: pass, token_type: 'Bearer', expires_in: 300 });
      }
      if (url.endsWith('/v1/connect')) return json(f.setupReply, f.setupStatus);
      if (url.endsWith('/v1/connect/diagnostics')) {
        // The hosted route is admin-only: record which pass reached it.
        f.diagnosticScopes.push(JSON.parse(Buffer.from(init.headers.Authorization.split('.')[1], 'base64url')).scope);
        return json({ state: f.statusReply.state, mode: 'test', processorAccountPresent: false, evidence: 'observed', lastFailure: { category: 'unknown', status: 400, at: f.now - 1000 } });
      }
      f.statuses++; assert.equal(init.headers['X-Dinkus-Site'], f.siteId); assert.match(init.headers.Authorization, /^Bearer /);
      if (f.statusCode) return json({ error: 'unauthorized' }, f.statusCode);
      return json(f.statusReply);
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
  // Past the page's 5-minute sign-in, status is still read, with a fresh store pass.
  f.now += 301000;
  assert.equal((await connection.status({ id: 'admin' })).state, 'ready');
  assert.equal((await connection.status({ id: 'other-admin' })).state, 'ready');
  assert.equal((await f.connect()).state, 'ready');
  assert.equal((await connection.status({ id: 'admin' })).state, 'ready');
  // Each new grant reads status once with its own token; every other read trades the store key.
  assert.equal(f.statuses, 6);
  assert.equal(f.passes, 4);
});

test('connection accepts both stable (r_3brsc2on3bu673rn) and beta (r_sffx6l4z6mpqliki) Registry plugin IDs and rejects unknown IDs', async () => {
  assert.deepEqual(ACCEPTED_INSTALLED_PLUGIN_IDS, ['r_3brsc2on3bu673rn', 'r_sffx6l4z6mpqliki']);
  for (const pluginId of ACCEPTED_INSTALLED_PLUGIN_IDS) {
    const { f, connection } = await fixture({ pluginId });
    assert.equal(connection.installedPluginId, pluginId);
    assert.equal(connection.callbackPath, `/_emdash/admin/plugins/${pluginId}/status`);
    assert.equal(connection.proofPath, `/_emdash/api/plugins/${pluginId}/store-proof`);
    assert.equal((await connection.start({ id: 'admin' })).state, 'pending');
    const receipt = await connection.receipt('c1');
    assert.equal(receipt.callback_uri, `https://shop.example/_emdash/admin/plugins/${pluginId}/status`);
    f.now += 5000; f.approved = true;
    assert.equal((await connection.exchange({ id: 'admin' })).state, 'ready');
    assert.equal((await connection.status({ id: 'admin' })).state, 'ready');
  }
  const betaBySlug = await fixture({ pluginId: 'dinkus-payments-beta' });
  assert.equal(betaBySlug.connection.installedPluginId, 'r_sffx6l4z6mpqliki');
  assert.equal((await betaBySlug.f.connect()).state, 'ready');

  const untrusted = await fixture({ pluginId: 'r_untrustedpluginid' });
  assert.equal(untrusted.connection.installedPluginId, null);
  assert.equal((await untrusted.connection.start({ id: 'admin' })).state, 'unconfigured');
  assert.equal(untrusted.f.starts, 0);
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
    assert.equal((await connection.exchange({ id: 'admin' }, { wait: false })).state, 'pending'); assert.equal(f.exchanges, 0);
    f.now += 5000; f.error = error;
    assert.equal((await connection.exchange({ id: 'admin' })).state, error ? 'failed' : 'pending');
    f.now += 5000;
    await connection.exchange({ id: 'admin' }); assert.equal(f.exchanges, error ? 1 : 2);
    assert.equal(Boolean(await connection.receipt('c1')), !error);
  }
});

test('manual secret injection and another administrator do not acquire authority', async () => {
  const { f, connection, store } = await fixture(); await f.connect(); f.calls = [];
  // Another admin sees the store's status through the store key, never through the sign-in.
  assert.equal((await connection.status({ id: 'other' })).state, 'ready'); assert.equal(f.passes, 1);
  assert.equal((await connection.setupProcessor({ id: 'other' })).signIn, true);
  const entry = await store.settings.getVersioned('registry_session');
  await store.settings.compareAndSet('registry_session', entry.revision, JSON.stringify({ kind: 'session', token: 'injected', flowId: 'manual' }));
  assert.notEqual((await connection.setupProcessor({ id: 'admin' })).state, 'processor_setup');
  assert.equal(f.calls.some(call => call.url.endsWith('/v1/connect')), false);
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

test('the plugin may contact exactly the hosts of its server-owned endpoints', async () => {
  // EmDash refuses any host not listed exactly, so the status endpoint's host must be declared.
  const manifest = JSON.parse(await readFile(new URL('../emdash-plugin.jsonc', import.meta.url), 'utf8'));
  const hosts = new Set([REGISTRY_CONNECT_URL, REGISTRY_JWKS_URL, PRODUCTION_STATUS_ENDPOINT].map(url => new URL(url).hostname));
  assert.deepEqual([...manifest.allowedHosts].sort(), [...hosts].sort());
});


test('processor setup uses a verified bodyless session and never persists the link', async () => {
  const { f, connection, store } = await fixture();
  await f.connect();
  for (let i = 0; i < 2; i++) {
    const result = await connection.setupProcessor({ id: 'admin' });
    assert.equal(result.state, 'processor_setup');
    assert.equal(result.onboardingUrl, f.setupReply.url);
  }
  const requests = f.calls.filter(c => c.url.endsWith('/v1/connect'));
  assert.equal(requests.length, 2);
  for (const { init } of requests) { assert.equal(init.method, 'POST'); assert.equal(init.body, undefined); assert.match(init.headers.Authorization, /^Bearer /); }
  assert.equal(JSON.stringify([...store.values]).includes(f.setupReply.url), false);
  // Without this admin's live sign-in, setup shows the current status and asks for Sign in again.
  for (const shown of [await connection.setupProcessor({ id: 'other' }), (f.now += 301000, await connection.setupProcessor({ id: 'admin' }))]) {
    assert.equal(shown.state, 'ready'); assert.equal(shown.signIn, true);
  }
  assert.equal(f.calls.filter(c => c.url.endsWith('/v1/connect')).length, 2);
});

test('processor setup rejects unsafe links, malformed expiry, mismatched mode and errors', async () => {
  for (const change of [
    { url: 'https://connect.stripe.com.evil.invalid/setup/x' }, { url: 'http://connect.stripe.com/setup/x' },
    { url: 'https://user@connect.stripe.com/setup/x' }, { url: 'https://connect.stripe.com:444/setup/x' }, { url: 'https://connect.stripe.com:443/setup/x' },
    { url: 'https://connect.stripe.com/setup/x#fragment' }, { url: 'https://connect.stripe.com/other' },
    { expiresAt: 1 }, { expiresAt: 1_800_100_000_000 }, { expiresAt: 'later' }, { mode: 'live' }, { state: 'unknown' },
  ]) {
    const { f, connection } = await fixture(); await f.connect(); Object.assign(f.setupReply, change);
    assert.equal((await connection.setupProcessor({ id: 'admin' })).state, 'setup_unconfirmed');
  }
  for (const code of [401, 403, 500]) {
    const { f, connection } = await fixture(); await f.connect(); f.setupStatus = code;
    assert.equal((await connection.setupProcessor({ id: 'admin' })).state, code === 500 ? 'setup_unconfirmed' : 'action_required');
  }
});

test('Continue before the poll interval waits it out and polls instead of repeating the pending screen', async () => {
  const { f, connection } = await fixture(); await connection.start({ id: 'admin' }); f.approved = true;
  const result = await connection.exchange({ id: 'admin' });
  assert.equal(result.state, 'ready'); assert.equal(f.exchanges, 1); assert.deepEqual(f.slept, [5050]);
  assert.equal(result.status.status.state, 'disconnected');
});

test('a poll DinkusKit has not approved yet says so, and page load never waits', async () => {
  const { f, connection } = await fixture(); await connection.start({ id: 'admin' });
  assert.equal('checked' in await connection.exchange({ id: 'admin' }, { wait: false }), false);
  assert.equal(f.exchanges, 0); assert.deepEqual(f.slept, []);
  f.now += 5000;
  const result = await connection.exchange({ id: 'admin' }, { wait: false });
  assert.equal(result.state, 'pending'); assert.equal(result.checked, true); assert.equal(f.exchanges, 1);
});

test('a new grant reads status with its verified token, without diagnostics or a second JWKS fetch', async () => {
  const { f } = await fixture();
  f.statusReply = { state: 'ready', mode: 'test', bindingRef: 'synthetic-binding', connectionEvidence: { provider: 'stripe', mode: 'test', result: 'verified', accountRef: 'acct_one' } };
  const result = await f.connect();
  assert.equal(result.state, 'ready'); assert.equal(result.status.status.connectionEvidence.result, 'verified');
  assert.equal(f.calls.filter(c => c.url.endsWith('/jwks.json')).length, 1);
  assert.equal(f.calls.some(c => c.url.endsWith('/diagnostics')), false);
});

test('with no store key from Connect, the page shows the last status this admin read, never another admin', async () => {
  const { f, connection } = await fixture({ storeKey: null });
  f.statusReply = { state: 'ready', mode: 'test', bindingRef: 'synthetic-binding', connectionEvidence: { provider: 'stripe', mode: 'test', result: 'verified', accountRef: 'acct_one' } };
  // Approve, then nothing else: the status shown right after approval is kept.
  await f.connect(); const checkedAt = f.now;
  for (const result of [await connection.status({ id: 'admin' }), (f.now += 301000, await connection.exchange({ id: 'admin' }))]) {
    assert.equal(result.state, 'store_key_required');
    assert.deepEqual(result.lastChecked, { at: checkedAt, status: f.statusReply });
  }
  assert.deepEqual(await connection.status({ id: 'other' }), { state: 'store_key_required' });
  assert.equal(f.passes, 0);
});

test('DinkusKit.com refusals of the store key are named, and the key goes only to store-passes', async () => {
  const cases = [[401, 'invalid_store_key'], [403, 'site_mismatch'], [403, 'service_not_enabled'], [403, 'service_cut_off'], [403, 'store_suspended'], [429, 'anything']];
  for (const [status, error] of cases) {
    const { f, connection } = await fixture(); await f.connect(); f.passError = { status, error };
    assert.deepEqual(await connection.status({ id: 'admin' }), { state: 'pass_refused', refusal: status === 429 ? 'rate_limited' : error });
  }
  const unknown = await fixture(); await unknown.f.connect(); unknown.f.passError = { status: 503, error: 'raw-detail' };
  assert.deepEqual(await unknown.connection.status({ id: 'admin' }), { state: 'check_failed', checkFailure: { stage: 'fetch_pass', httpStatus: 503 } });
  // A malformed key from DinkusKit.com fails the Connect itself; nothing is saved.
  const malformed = await fixture({ storeKey: 'not-a-key' });
  assert.deepEqual(await malformed.f.connect(), { state: 'failed', message: 'restart_required' });
  assert.equal(await sessionKey(malformed.store), undefined); assert.equal(malformed.f.passes, 0);
  for (const claims of [{ scope: 'payments:admin' }, { site_id: 'other' }]) {
    const wrong = await fixture(); await wrong.f.connect(); wrong.f.passClaims = claims; const before = wrong.f.statuses;
    assert.deepEqual(await wrong.connection.status({ id: 'admin' }), { state: 'check_failed', checkFailure: { stage: 'decode_pass' } });
    assert.equal(wrong.f.statuses, before);
  }
  // Payments refusing the store's pass is named; it is not a lapsed sign-in.
  const payments = await fixture(); await payments.f.connect(); payments.f.statusCode = 401;
  assert.deepEqual(await payments.connection.status({ id: 'admin' }), { state: 'pass_refused', refusal: 'payments_refused' });
  // A store never connected on this page has no binding to read with.
  const never = await fixture(); await never.connection.start({ id: 'admin' }); never.f.now += 601000;
  assert.deepEqual(await never.connection.status({ id: 'admin' }), { state: 'action_required' }); assert.equal(never.f.passes, 0);
  const { f, connection } = await fixture(); await f.connect();
  await connection.status({ id: 'admin' });
  for (const call of f.calls) if (call.init.headers?.Authorization === `Bearer ${KEY}`) assert.equal(call.url, STORE_PASSES_URL);
});

test('setup failure detail uses only this admin\'s live sign-in, never the store pass', async () => {
  for (const state of ['connecting', 'recovery_required']) {
    const { f, connection } = await fixture(); await f.connect();
    f.statusReply = { state, mode: 'test', bindingRef: 'synthetic-binding' };
    const live = await connection.status({ id: 'admin' });
    assert.equal(live.state, 'ready'); assert.equal(live.diagnostics.lastFailure.category, 'unknown'); assert.equal(live.detailSignIn, undefined);
    assert.deepEqual(f.diagnosticScopes, [REGISTRY_SCOPE]);
    for (const shown of [await connection.status({ id: 'other' }), (f.now += 301000, await connection.status({ id: 'admin' }))]) {
      assert.equal(shown.state, 'ready'); assert.equal(shown.diagnostics, undefined); assert.equal(shown.detailSignIn, true);
    }
    assert.deepEqual(f.diagnosticScopes, [REGISTRY_SCOPE]);
  }
});

test('a refused setup carries only a known reason; any other refusal stays unconfirmed', async () => {
  for (const [error, expected] of [['merchant_country_required', 'setup_refused'], ['payments_service_unconfigured', 'setup_refused'], ['raw-provider-detail', 'setup_unconfirmed']]) {
    const { f, connection } = await fixture(); await f.connect(); f.setupStatus = 503; f.setupReply = { error };
    const result = await connection.setupProcessor({ id: 'admin' });
    assert.equal(result.state, expected);
    assert.equal(JSON.stringify(result).includes('raw-provider'), false);
    if (expected === 'setup_refused') assert.equal(result.refusal, error);
  }
});

test('the newest of the approval-time status and a later Check is shown while the plugin has no store key', async () => {
  const { f, connection, store } = await fixture();
  await f.connect();
  f.now += 60000; f.statusReply = { state: 'ready', mode: 'test', bindingRef: 'synthetic-binding', connectionEvidence: { provider: 'stripe', mode: 'test', result: 'verified', accountRef: 'acct_one' } };
  assert.equal((await connection.status({ id: 'admin' })).state, 'ready'); const checkedAt = f.now;
  // The store key is lost later: the newer Check is what the page shows.
  const session = JSON.parse(await store.settings.get('registry_session')); delete session.storeKey;
  await store.settings.set('registry_session', JSON.stringify(session)); f.now += 301000;
  assert.deepEqual((await connection.status({ id: 'admin' })).lastChecked, { at: checkedAt, status: f.statusReply });
  // A fresh approval is newer than the earlier Check.
  f.statusReply = { state: 'disconnected', mode: 'test', bindingRef: 'synthetic-binding' }; f.storeKey = null;
  await f.connect(); const approvedAt = f.now; f.now += 301000;
  assert.deepEqual((await connection.status({ id: 'admin' })).lastChecked, { at: approvedAt, status: f.statusReply });
});

test('Set up Stripe sends a listed business country and nothing else', async () => {
  for (const [country, body] of [['US', '{"country":"US"}'], ['', undefined], ['XX', undefined], [undefined, undefined], [{ country: 'US' }, undefined]]) {
    const { f, connection } = await fixture(); await f.connect(); f.calls.length = 0;
    f.setupStatus = 400; f.setupReply = { error: 'merchant_country_required' };
    assert.equal((await connection.setupProcessor({ id: 'admin' }, country)).state, 'setup_refused');
    const posts = f.calls.filter(call => call.url.endsWith('/v1/connect'));
    assert.equal(posts.length, 1); assert.equal(posts[0].init.body, body); assert.equal(new URL(posts[0].url).search, '');
  }
});

test('Connect saves the plugin\'s own store key in the encrypted Connect setting and keeps it across a new Connect', async () => {
  const { f, connection, store } = await fixture();
  f.statusReply = { state: 'ready', mode: 'test', bindingRef: 'synthetic-binding', connectionEvidence: { provider: 'stripe', mode: 'test', result: 'verified', accountRef: 'acct_one' } };
  await f.connect();
  assert.equal(await sessionKey(store), KEY);
  assert.equal(await store.settings.get('storeKey'), null, 'there is no store key box to paste into');
  f.now += 301000;
  assert.equal((await connection.status({ id: 'admin' })).state, 'ready', 'the status page reads with the key after the sign-in lapses');
  // Starting a new Connect keeps the key until DinkusKit.com hands over the next one.
  assert.equal((await connection.start({ id: 'admin' })).state, 'pending');
  assert.equal(await sessionKey(store), KEY);
  const next = `dk_store_${'N'.repeat(43)}`; f.storeKey = next; f.now += 5000;
  await connection.exchange({ id: 'admin' });
  assert.equal(await sessionKey(store), next, 'Connect again replaces the key');
  // An older DinkusKit.com that sends no key leaves the current one in place.
  f.storeKey = null; assert.equal((await f.connect()).state, 'ready'); assert.equal(await sessionKey(store), next);
});

test('a store whose Commerce is not connected yet is told to connect Commerce first', async () => {
  const { f, connection } = await fixture(); f.connectRefusal = 'connect_commerce_first';
  assert.deepEqual(await connection.start({ id: 'admin' }), { state: 'commerce_required' });
  f.connectRefusal = 'something_else';
  assert.deepEqual(await connection.start({ id: 'admin' }), { state: 'failed', message: 'restart_required' });
});
