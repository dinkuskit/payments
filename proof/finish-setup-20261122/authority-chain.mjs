// Authority-chain run for Finish setup, uninstall and Disconnect.
//
// The installed Payments plugin entry points (the admin route, the store-proof
// route and the plugin:uninstall hook from src/plugin.ts) run against DinkusKit.com's
// own built Worker from dinkuskit/dinkuskit (the branch of dinkuskit/dinkuskit#145),
// started under that repository's merchant test harness with local D1 and KV.
// Nothing here is a fake of DinkusKit.com: lookup, finish, token, store passes, the
// connected-to read, key cancel, Approve, Disconnect and Revoke are its real routes.
//
// Three things stand in for the parts that are not on this machine:
//  1. Transport: the plugin's https://dinkuskit.com requests go to the local Worker,
//     and that Worker's own address is written back as https://dinkuskit.com in
//     replies, so the plugin's exact address checks still run.
//  2. The store's address: DinkusKit.com reads a store's proof receipt from the
//     plugin's store-proof route at that address. Here the bridge asks the
//     installation that really owns the address (its real store-proof route) and
//     hands the answer to the Worker's proof-receipt simulation. An installation
//     claiming someone else's address gets nothing from the real owner's route.
//  3. The Payments Worker's status read: a stand-in that answers only after
//     verifying the store pass with DinkusKit.com's published keys.
//
// Run from this repository:
//   DINKUSKIT_DIR=/path/to/dinkuskit (built with `npm run build`) \
//   PAYMENTS_BASE_DIR=/path/to/a/checkout/of/main \
//   node --import tsx proof/finish-setup-20261122/authority-chain.mjs > trace.md
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const DK = process.env.DINKUSKIT_DIR;
const BASE = process.env.PAYMENTS_BASE_DIR;
if (!DK) throw new Error('Set DINKUSKIT_DIR to a built dinkuskit/dinkuskit checkout.');
const { createPaymentsPlugin } = await import(new URL('../../src/plugin.ts', import.meta.url).href);
const harness = await import(pathToFileURL(`${DK}/tests/helpers/merchant-harness.mjs`).href);
process.chdir(DK);

const PROD = 'https://dinkuskit.com';
const STATUS = 'https://payments-proof.invalid/v1/status';
const lines = [];
const say = text => { lines.push(text); };
let runtime;
const redact = value => String(value)
  .replaceAll(runtime?.origin ?? '\u0000', PROD)
  .replace(/dk_store_[A-Za-z0-9_-]{43}/g, 'dk_store_[redacted]')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[pass redacted]');
const check = (label, ok, seen) => { say(`- ${ok ? 'PASS' : 'FAIL'}: ${label}${seen === undefined ? '' : ` (${redact(typeof seen === 'string' ? seen : JSON.stringify(seen))})`}`); assert.ok(ok, label); };

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
  return { kv: access('kv:'), settings: access('settings:'), values };
}

// Which installation really answers at each store address.
const owners = new Map();
const receiptDelay = { ms: 0 };
async function bridgeReceipt(connectionId, siteOrigin) {
  const owner = owners.get(siteOrigin);
  if (!owner) return false;
  const answer = await owner.proof(connectionId);
  if (answer.status !== 200) return false;
  const receipt = JSON.parse(answer.body.value);
  const posted = await harness.request(runtime, new Map(), '/__proof/receipt', { method: 'POST',
    body: JSON.stringify({ ...receipt, ...(receiptDelay.ms ? { delay_ms: receiptDelay.ms } : {}) }) });
  return posted.status === 200;
}

let jwks;
async function statusStandIn(init) {
  const auth = new Headers(init.headers).get('authorization') ?? '';
  try {
    const { payload } = await jwtVerify(auth.replace(/^Bearer /, ''), jwks, { issuer: `${PROD}/account`, audience: 'dinkus-payments' });
    if (payload.site_id !== new Headers(init.headers).get('x-dinkus-site')) throw new Error('site');
    return Response.json({ state: 'disconnected', mode: 'test', bindingRef: 'proof-binding' });
  } catch { return Response.json({ error: 'unauthorized' }, { status: 401 }); }
}

function transport(install) {
  return { async fetch(url, init = {}) {
    if (url.startsWith(STATUS)) return statusStandIn(init);
    assert.ok(url.startsWith(`${PROD}/`), `unexpected address ${url}`);
    const path = url.slice(PROD.length);
    if (path === '/api/store-connections/finish') {
      const body = JSON.parse(init.body);
      install.bridged = await bridgeReceipt(body.connection_id, install.origin);
    }
    const response = await fetch(new URL(path, runtime.origin), { ...init, redirect: 'manual' });
    const text = (await response.text()).replaceAll(runtime.origin, PROD);
    if (process.env.DEBUG_AC) console.error(path, response.status, text.slice(0, 200));
    return new Response(response.status === 204 ? null : text, { status: response.status, headers: response.headers });
  } };
}

// One installed copy of the plugin at a store address, with its own storage.
function install(origin, { plugin = createPaymentsPlugin({ endpoint: { status: STATUS } }), store = memory(), servesAddress = true } = {}) {
  const self = { origin, store, plugin };
  const ctx = () => ({ kv: store.kv, settings: store.settings, http: transport(self), site: { url: origin }, plugin: { id: 'r_3brsc2on3bu673rn' } });
  self.page = async (input, user = { id: 'admin-1' }) => screen(await plugin.routes.admin.handler({ user, input }, ctx()));
  self.proof = connectionId => plugin.routes['store-proof'].handler({ input: { connection_id: connectionId } }, ctx());
  self.uninstall = () => plugin.hooks['plugin:uninstall']({}, ctx());
  self.key = async () => { const raw = await store.settings.get('registry_session'); return raw ? JSON.parse(raw).storeKey : undefined; };
  if (servesAddress) owners.set(origin, self);
  return self;
}

function screen(result) {
  const texts = [], buttons = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button') buttons.push(node.label);
    else for (const field of ['text', 'title', 'description']) if (typeof node[field] === 'string') texts.push(node[field]);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(result);
  const link = JSON.stringify(result).match(/connection_id=([A-Za-z0-9_-]+)/)?.[1];
  return { text: texts.join(' | '), buttons, link };
}

const step = page => page.text.match(/Connect payments: [^|]*/)?.[0]?.trim() ?? page.text.slice(0, 160);
const onStripe = page => page.buttons.some(label => /Stripe/.test(label));
const finishPress = { type: 'block_action', action_id: 'finish_setup' };
const continuePress = { type: 'block_action', action_id: 'continue' };

try {
  runtime = await harness.startMerchantTestRuntime();
  jwks = createRemoteJWKSet(new URL('/account/.well-known/jwks.json', runtime.origin));
  const owner = new Map(), outsider = new Map();
  await harness.signup(runtime, 'acme-owner@example.test', owner);
  await harness.signup(runtime, 'other-owner@example.test', outsider);
  const rename = async (jar, name) => harness.request(runtime, jar, '/api/account/organizations', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: await harness.accountForm(runtime, jar, new URLSearchParams({ action: 'rename', name }).toString()) });
  assert.equal((await rename(owner, 'Acme Goods')).status, 303);
  assert.equal((await rename(outsider, 'Other Shop')).status, 303);
  const form = async (jar, fields) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: await harness.accountForm(runtime, jar, new URLSearchParams(fields).toString()) });
  const approveLink = async (jar, connectionId, origin) => {
    await bridgeReceipt(connectionId, origin);
    return harness.request(runtime, jar, `/account/connect?connection_id=${connectionId}`, await form(jar, { action: 'approve' }));
  };
  const trade = (key, siteId, scope, audience) => harness.request(runtime, new Map(), '/api/store-passes', { method: 'POST',
    headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ site_id: siteId, scope, audience }) });
  const tradeError = async (...args) => { const r = await trade(...args); return r.status === 200 ? 200 : (await r.json()).error; };

  // Commerce connects each store with its owner's Approve (Commerce is not under test here).
  async function connectCommerce(origin, jar) {
    const verifier = randomBytes(32).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url');
    const callback = `${origin}/_emdash/admin/plugins/r_gshdrqaldna3r7sn/settings`;
    const started = await (await harness.request(runtime, new Map(), '/api/store-connections', { method: 'POST', body: JSON.stringify({ protocol_version: 2,
      client_id: 'dinkus-commerce-emdash', service: 'commerce', site_origin: origin, callback_uri: callback, code_challenge: challenge, code_challenge_method: 'S256' }) })).json();
    await harness.request(runtime, new Map(), '/__proof/receipt', { method: 'POST', body: JSON.stringify({ version: 2, connection_id: started.connection_id,
      challenge: started.challenge, client_id: 'dinkus-commerce-emdash', service: 'commerce', site_id: started.site_id, site_origin: origin, callback_uri: callback,
      code_challenge: challenge, expires_at: started.expires_at }) });
    await harness.request(runtime, jar, `/account/connect?connection_id=${started.connection_id}`, await form(jar, { action: 'approve' }));
    const token = await (await harness.request(runtime, new Map(), '/api/store-connections/token', { method: 'POST',
      body: JSON.stringify({ client_id: 'dinkus-commerce-emdash', connection_id: started.connection_id, code_verifier: verifier }) })).json();
    return { siteId: token.site_id, key: token.store_key };
  }

  const ACME = 'https://acme-goods.example', OTHER = 'https://other-shop.example';
  say('# Finish setup authority chain: Payments plugin against DinkusKit.com');
  say('');
  const rev = dir => execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  say(`Run ${new Date().toISOString().slice(0, 10)}. Payments plugin: this branch at ${rev(new URL('../..', import.meta.url).pathname)}. DinkusKit.com: built Worker from dinkuskit/dinkuskit#145 at ${rev(DK)}, local D1 and KV.` +
    (BASE ? ` Released plugin for the upgrade check: main at ${rev(BASE)}.` : '') + ' Keys and passes are redacted.');
  say('');
  say('## 1. A store its business already connected joins with Finish setup');
  const commerce = await connectCommerce(ACME, owner);
  const other = await connectCommerce(OTHER, outsider);
  const acme = install(ACME);
  let page = await acme.page(undefined);
  check('the Payment settings page offers Finish setup, not Connect', page.buttons.includes('Finish setup') && !page.buttons.includes('Connect'), page.buttons);
  page = await acme.page(finishPress);
  const acmeKey = await acme.key();
  check('pressing Finish setup goes straight to the business country and Set up Stripe', onStripe(page) && !page.link, page.buttons);
  check('Payments saved its own key, different from Commerce\'s', /^dk_store_/.test(acmeKey ?? '') && acmeKey !== commerce.key, acmeKey);
  check('DinkusKit.com read the receipt from the store\'s own proof route', acme.bridged === true);
  check('the key trades for a checkout pass for this store', await tradeError(acmeKey, commerce.siteId, 'payments:checkout', 'dinkus-payments') === 200);
  page = await acme.page(undefined);
  check('the next load names the business and the plugins on the store', /Connected to Acme Goods on DinkusKit\. DinkusKit plugins on this store: Commerce and Payments\./.test(page.text),
    page.text.match(/Connected to [^|]*/)?.[0]);
  const mail = await (await harness.request(runtime, new Map(), '/__proof/notice/take', { method: 'POST', body: JSON.stringify({ email: 'acme-owner@example.test' }) })).json();
  check('the owner got the "joined your store" email', mail.length === 1 && mail[0].subject === 'Dinkus Payments joined your store on DinkusKit', mail.map(m => m.subject));

  say('');
  say('## 2. Another business, or another address, gets nothing');
  const impostor = install(ACME, { servesAddress: false });
  page = await impostor.page(finishPress);
  check('an installation claiming Acme\'s address, but not answering there, gets no key', !(await impostor.key()) && impostor.bridged === false, step(page));
  check('it was not shown a way past the owner either', !onStripe(page), page.buttons);
  const otherShop = install(OTHER);
  page = await otherShop.page(finishPress);
  page = await otherShop.page(undefined);
  check('Payments on Other Shop joins Other Shop\'s own business', /Connected to Other Shop on DinkusKit/.test(page.text), page.text.match(/Connected to [^|]*/)?.[0]);
  const otherKey = await otherShop.key();
  check('Acme\'s Payments key cannot trade passes for Other Shop', await tradeError(acmeKey, other.siteId, 'payments:checkout', 'dinkus-payments') === 'site_mismatch');
  check('Other Shop\'s key cannot read Acme\'s connection', await tradeError(otherKey, commerce.siteId, 'store:connection', 'dinkuskit') === 'site_mismatch');
  const stranger = install('https://never-connected.example');
  page = await stranger.page(undefined);
  check('a store no business connected shows Connect, not Finish setup', page.buttons.includes('Connect') && !page.buttons.includes('Finish setup'), page.buttons);
  page = await stranger.page(finishPress);
  check('pressing Finish setup there anyway asks for Commerce first and saves nothing', !(await stranger.key()) && /Commerce/.test(page.text), step(page));

  say('');
  say('## 3. A Finish setup in progress cannot be taken over by another page load');
  const slow = install('https://slow-shop.example');
  await connectCommerce('https://slow-shop.example', owner);
  receiptDelay.ms = 1500;
  const pressing = slow.page(finishPress);
  await new Promise(resolve => setTimeout(resolve, 600));
  const meanwhile = await slow.page(undefined);
  const pressedContinue = await slow.page(continuePress);
  page = await pressing; receiptDelay.ms = 0;
  check('a page load while DinkusKit.com reads the receipt says setup is still finishing', /still finishing/.test(meanwhile.text) && !meanwhile.link, step(meanwhile));
  check('a Continue press then cannot take the connection over', /still finishing/.test(pressedContinue.text) && !pressedContinue.link, step(pressedContinue));
  check('and the Finish setup still completes with its key', onStripe(page) && /^dk_store_/.test(await slow.key() ?? ''));

  say('');
  say('## 4. Uninstall cancels only Payments\' key');
  await acme.uninstall();
  check('Payments\' key no longer trades any pass', await tradeError(acmeKey, commerce.siteId, 'payments:checkout', 'dinkus-payments') === 'invalid_store_key');
  check('nor reads the connected-to details', await tradeError(acmeKey, commerce.siteId, 'store:connection', 'dinkuskit') === 'invalid_store_key');
  check('Commerce\'s key still works', await tradeError(commerce.key, commerce.siteId, 'commerce:settings', 'dinkuskit') === 200);
  check('Other Shop\'s Payments key still works', await tradeError(otherKey, other.siteId, 'payments:checkout', 'dinkus-payments') === 200);
  const again = install(ACME);
  page = await again.page(undefined);
  check('a reinstall shows Finish setup again (an uninstall is not a Disconnect)', page.buttons.includes('Finish setup'), page.buttons);
  page = await again.page(finishPress);
  const secondKey = await again.key();
  check('and joins with a new key', onStripe(page) && /^dk_store_/.test(secondKey ?? '') && secondKey !== acmeKey);

  say('');
  say('## 5. After the owner\'s Disconnect or Revoke, only the owner\'s Approve brings Payments back');
  assert.equal((await harness.request(runtime, owner, '/account/sites', await form(owner, { action: 'disconnect_plugin', site_id: commerce.siteId, plugin: 'payments' }))).status, 303);
  check('Disconnect ended the key', await tradeError(secondKey, commerce.siteId, 'payments:checkout', 'dinkus-payments') === 'invalid_store_key');
  const back = install(ACME);
  page = await back.page(undefined);
  check('the page shows Connect, not Finish setup', page.buttons.includes('Connect') && !page.buttons.includes('Finish setup'), page.buttons);
  page = await back.page(finishPress);
  check('a Finish setup press (an old page) gets the owner\'s Approve link, and no key', !!page.link && !(await back.key()), page.buttons);
  const firstLink = page.link;
  const unapproved = await back.page(continuePress);
  check('Continue before the owner approves keeps waiting', !!unapproved.link && !(await back.key()), unapproved.buttons);
  const approved = await approveLink(owner, firstLink, ACME);
  check('the owner\'s Approve sends them back to the plugin page', approved.headers.get('location') === `${ACME}/_emdash/admin/plugins/r_3brsc2on3bu673rn/status`, approved.headers.get('location'));
  page = await back.page(continuePress);
  check('after the owner\'s Approve, Continue finishes with a key', onStripe(page) && /^dk_store_/.test(await back.key() ?? ''), page.buttons);
  assert.equal((await harness.request(runtime, owner, '/account/sites', await form(owner, { action: 'revoke', site_id: commerce.siteId, service: 'payments' }))).status, 303);
  const afterRevoke = install(ACME);
  page = await afterRevoke.page(finishPress);
  check('after a Revoke, Finish setup again needs the owner\'s Approve', !!page.link && !(await afterRevoke.key()), page.buttons);
  page = await afterRevoke.page(undefined);
  check('a waiting Finish setup keeps its Approve link on reload', !!page.link, page.buttons);
  const outsiderTry = await approveLink(outsider, page.link, ACME);
  page = await afterRevoke.page(continuePress);
  check('another business\'s owner cannot approve it: Continue still waits, no key', !(await afterRevoke.key()) && !!page.link,
    `${outsiderTry.status} ${outsiderTry.headers.get('location') ?? ''}`.trim());

  if (BASE) {
    say('');
    say('## 6. Upgrade: a store connected with the released plugin keeps working');
    const { createPaymentsPlugin: released } = await import(pathToFileURL(`${BASE}/src/plugin.ts`).href);
    const upgrade = await connectCommerce('https://upgrade-shop.example', owner);
    const store = memory();
    const old = install('https://upgrade-shop.example', { plugin: released({ endpoint: { status: STATUS } }), store });
    page = await old.page({ type: 'block_action', action_id: 'connect' });
    assert.ok(page.link, 'the released plugin connects with Approve');
    assert.equal((await approveLink(owner, page.link, 'https://upgrade-shop.example')).headers.get('location'), 'https://upgrade-shop.example/_emdash/admin/plugins/r_3brsc2on3bu673rn/status');
    page = await old.page(continuePress);
    const oldKey = await old.key();
    check('the released plugin (main) connected with the owner\'s Approve', /^dk_store_/.test(oldKey ?? '') && onStripe(page));
    const upgraded = install('https://upgrade-shop.example', { store });
    page = await upgraded.page(undefined);
    check('after the upgrade the same storage loads ready, with the same key', onStripe(page) && await upgraded.key() === oldKey, page.buttons);
    check('the upgraded page shows the connected-to line and no Finish setup', /Connected to Acme Goods on DinkusKit/.test(page.text) && !page.buttons.includes('Finish setup'));
    await upgraded.uninstall();
    check('uninstalling the upgraded plugin cancels the key the released plugin saved', await tradeError(oldKey, upgrade.siteId, 'payments:checkout', 'dinkus-payments') === 'invalid_store_key');
    check('and leaves that store\'s Commerce key working', await tradeError(upgrade.key, upgrade.siteId, 'commerce:settings', 'dinkuskit') === 200);
  }
  say('');
  say('All checks passed.');
} finally {
  if (runtime) await harness.stopRuntime(runtime);
  process.stdout.write(`${lines.join('\n')}\n`);
}
