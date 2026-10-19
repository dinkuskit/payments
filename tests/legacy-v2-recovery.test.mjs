import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createConnectionService } from '../src/hosted/connection.ts';

const initialTime = 1_800_000_000_000;
const owner = { accountId: '["https://identity.example.invalid","operator"]', siteId: 'synthetic-e2e' };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  let time = initialTime, writes = 0;
  let saved = { owner, mode: 'test', providerId: 'stripe', bindingRef: 'stripe_legacy',
    startedAt: initialTime - 172_800_000, stripeAccountId: null, authorizeNetMerchantId: null,
    creationFailure: { category: 'unknown', status: 400, at: initialTime - 86_400_000 } };
  const original = structuredClone(saved);
  const calls = { scopes: 0, creates: 0, links: 0, statuses: 0 };
  const admission = { operatorAccount: owner.accountId, operatorSite: owner.siteId, expectedPlatform: 'acct_platform',
    policy: { operationId: 'recovery_operation_1', siteId: owner.siteId, bindingRef: saved.bindingRef,
      expectedStartedAt: saved.startedAt, failureAt: saved.creationFailure.at,
      evidenceSha256: 'a'.repeat(64), rejection: 'accounts_v1_unsupported', rejectedRequestCount: 6, country: 'US', expiresAt: time + 300_000 } };
  const provider = { creationProtocol: 'accounts_v2', async creationScope() { calls.scopes++; return 'acct_platform'; },
    async createAccount() { calls.creates++; return 'acct_recipient'; },
    async accountStatus(id) { calls.statuses++; return { id, ready: true, actionRequired: false }; },
    async createLink() { calls.links++; throw Error('unexpected link'); } };
  const store = { transaction: fn => fn({ read: () => structuredClone(saved), write: value => { writes++; saved = structuredClone(value); } }) };
  const make = (options = {}) => createConnectionService({ store, provider, mode: 'test', now: () => time,
    merchantCountry: siteId => ({ siteId, country: 'US' }), legacyRecovery: () => admission, ...options });
  return { original, admission, provider, store, make, calls, saved: () => saved, writes: () => writes,
    replace: value => { saved = value; }, advance: ms => { time += ms; } };
}

test('prepares one v2 operation while preserving legacy evidence and creating no account or link', async () => {
  const f = fixture(), service = f.make();
  const receipt = await service.prepareRejectedLegacyV2(owner);
  assert.deepEqual(receipt, { state: 'prepared', mode: 'test', bindingRef: 'stripe_legacy',
    operationId: 'recovery_operation_1', preparedAt: initialTime });
  assert.deepEqual(f.saved().legacyRecovery.previous, f.original);
  assert.equal(f.saved().legacyRecovery.evidenceSha256, 'a'.repeat(64));
  assert.equal(f.saved().legacyRecovery.sourceFingerprint, fingerprint(f.original));
  assert.equal(f.saved().legacyRecovery.rejectedRequestCount, 6);
  assert.equal(f.saved().creationOperationId, receipt.operationId);
  assert.equal(f.saved().startedAt, initialTime);
  assert.equal(f.saved().creationProtocol, 'accounts_v2');
  assert.equal(f.saved().creationScope, 'acct_platform');
  assert.equal(f.saved().creationCountry, 'US');
  assert.equal(f.saved().creationFailure, undefined);
  assert.equal(f.saved().stripeAccountId, null);
  assert.deepEqual(f.calls, { scopes: 1, creates: 0, links: 0, statuses: 0 });
  assert.equal(f.writes(), 1);
  const snapshot = structuredClone(f.saved());
  f.advance(1000);
  assert.deepEqual(await f.make().prepareRejectedLegacyV2(owner), receipt);
  assert.deepEqual(f.saved(), snapshot);
  assert.equal(f.calls.scopes, 1);
  assert.equal(f.writes(), 1);
});

test('only a separate explicit connect uses the prepared operation', async () => {
  const f = fixture(), service = f.make();
  await service.prepareRejectedLegacyV2(owner);
  assert.equal(f.calls.creates, 0);
  assert.equal((await service.connect(owner)).state, 'ready');
  assert.equal(f.calls.creates, 1);
  assert.deepEqual(f.saved().legacyRecovery.previous, f.original);
  assert.equal(f.saved().creationOperationId, f.admission.policy.operationId);
  assert.equal(f.saved().stripeAccountId, 'acct_recipient');
});

test('absent admission, wrong principal, invalid evidence and stale snapshots refuse before provider I/O', async () => {
  const cases = [
    f => ({ options: { legacyRecovery: undefined } }),
    f => ({ options: { mode: 'live' } }),
    f => ({ options: { providerId: 'authorize_net' } }),
    f => ({ options: { provider: { ...f.provider, creationProtocol: undefined } } }),
    f => ({ principal: { ...owner, accountId: 'other' } }),
    f => ({ principal: { ...owner, siteId: 'other' } }),
    f => { f.admission.policy.rejectedRequestCount = 5; },
    f => { f.admission.policy.evidenceSha256 = 'invalid'; },
    f => { f.admission.policy.rejection = 'generic_400'; },
    f => { f.admission.policy.expectedFingerprint = 'b'.repeat(64); }, // obsolete external policy must fail closed
    f => { f.admission.policy.failureAt--; },
    f => { f.admission.policy.expectedStartedAt--; },
    f => { f.admission.policy.expiresAt = initialTime; },
    f => { f.admission.operatorSite = 'other'; },
    f => { f.admission.expectedPlatform = 'invalid'; },
    f => { f.replace({ ...f.saved(), stripeAccountId: 'acct_existing' }); },
    f => { f.replace({ ...f.saved(), authorizeNetMerchantId: 'existing' }); },
    f => { f.replace({ ...f.saved(), bindingRef: 'stripe_other' }); },
    f => { f.replace({ ...f.saved(), owner: { ...owner, accountId: 'other' } }); },
    f => { f.replace({ ...f.saved(), owner: { ...owner, siteId: 'other' } }); },
    f => { f.replace({ ...f.saved(), creationOperationId: 'already_prepared' }); },
    f => { f.replace({ ...f.saved(), creationCountryRepair: { code: 'identity_country_required', failureAt: 1 } }); },
    f => { f.replace({ ...f.saved(), creationFailure: { ...f.saved().creationFailure, status: 403 } }); },
    f => { f.replace({ ...f.saved(), creationFailure: { ...f.saved().creationFailure, category: 'permission' } }); },
    f => { f.replace({ ...f.saved(), creationProtocol: 'accounts_v2' }); },
    f => { f.replace({ ...f.saved(), creationScope: 'acct_old' }); },
    f => { f.replace({ ...f.saved(), mode: 'live' }); },
    f => { f.replace({ ...f.saved(), providerId: 'authorize_net' }); },
    f => ({ options: { merchantCountry: () => undefined } }),
    f => ({ options: { merchantCountry: siteId => ({ siteId, country: 'GB' }) } }),
  ];
  for (const arrange of cases) {
    const f = fixture(), configured = arrange(f) ?? {}, before = structuredClone(f.saved());
    await assert.rejects(f.make(configured.options).prepareRejectedLegacyV2(configured.principal ?? owner));
    assert.deepEqual(f.saved(), before);
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.calls, { scopes: 0, creates: 0, links: 0, statuses: 0 });
  }
});

test('platform mismatch, unavailable provider and state changes during its read never transition', async () => {
  for (const kind of ['mismatch', 'error', 'changed', 'expired']) {
    const f = fixture();
    f.provider.creationScope = async () => {
      f.calls.scopes++;
      if (kind === 'error') throw Error('private provider detail');
      if (kind === 'changed') f.replace({ ...f.saved(), owner: { ...owner, accountId: 'other' } });
      if (kind === 'expired') f.advance(300_000);
      return kind === 'mismatch' ? 'acct_other' : 'acct_platform';
    };
    await assert.rejects(f.make().prepareRejectedLegacyV2(owner));
    assert.equal(f.writes(), 0);
    assert.equal(f.calls.creates, 0);
    assert.equal(f.calls.links, 0);
    assert.equal(f.saved().creationProtocol, undefined);
  }
});

test('concurrent preparations commit once and a different operation cannot restart the window', async () => {
  const f = fixture(), waiting = [];
  f.provider.creationScope = () => new Promise(resolve => { f.calls.scopes++; waiting.push(resolve); });
  const service = f.make(), a = service.prepareRejectedLegacyV2(owner), b = service.prepareRejectedLegacyV2(owner);
  for (let i = 0; waiting.length < 2 && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiting.length, 2);
  waiting.forEach(resolve => resolve('acct_platform'));
  assert.deepEqual(await a, await b);
  assert.equal(f.writes(), 1);
  const before = structuredClone(f.saved());
  f.admission.policy.operationId = 'different_operation';
  await assert.rejects(service.prepareRejectedLegacyV2(owner));
  assert.deepEqual(f.saved(), before);
});

test('a late old-operation success or failure cannot overwrite the prepared v2 operation', async () => {
  for (const outcome of ['success', 'failure']) {
    const f = fixture();
    const young = { ...f.saved(), startedAt: initialTime - 1000, creationFailure: { category: 'unknown', status: 400, at: initialTime - 500 } };
    f.replace(young);
    let finish;
    const oldProvider = { ...f.provider, creationProtocol: undefined, creationScope: undefined,
      createAccount: () => new Promise((resolve, reject) => { finish = () => outcome === 'success' ? resolve('acct_late') : reject(Error('late failure')); }) };
    const pending = f.make({ provider: oldProvider }).connect(owner);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    f.advance(172_800_000);
    Object.assign(f.admission.policy, { expectedStartedAt: young.startedAt, failureAt: young.creationFailure.at,
      expiresAt: initialTime + 172_800_000 + 300_000 });
    await f.make().prepareRejectedLegacyV2(owner);
    const prepared = structuredClone(f.saved());
    finish();
    await pending.catch(error => assert.match(error.message, /connection_conflict/));
    assert.deepEqual(f.saved(), prepared);
  }
});

test('captures the matching state internally, accepts pre-call normalization, and rejects history tampering', async () => {
  const f = fixture();
  const beforeNormalization = { ...f.saved() }; delete beforeNormalization.providerId; delete beforeNormalization.authorizeNetMerchantId;
  f.replace(beforeNormalization);
  const normalized = { ...f.saved(), providerId: 'stripe', authorizeNetMerchantId: null, additionalLegacyNote: 'synthetic retained field' };
  f.replace(normalized);
  const receipt = await f.make().prepareRejectedLegacyV2(owner);
  assert.deepEqual(f.saved().legacyRecovery.previous, normalized);
  assert.equal(f.saved().legacyRecovery.sourceFingerprint, fingerprint(normalized));
  assert.equal(receipt.state, 'prepared');
  f.replace({ ...f.saved(), legacyRecovery: { ...f.saved().legacyRecovery,
    previous: { ...normalized, additionalLegacyNote: 'changed' } } });
  await assert.rejects(f.make().prepareRejectedLegacyV2(owner), /legacy_recovery_conflict/);
  assert.equal(f.writes(), 1);
});

test('rejects complete snapshot drift during platform I/O, including unrelated fields', async () => {
  const f = fixture();
  f.provider.creationScope = async () => {
    f.replace({ ...f.saved(), additionalLegacyNote: 'changed while awaiting identity' });
    return 'acct_platform';
  };
  await assert.rejects(f.make().prepareRejectedLegacyV2(owner), /legacy_recovery_conflict/);
  assert.equal(f.writes(), 0);
});
