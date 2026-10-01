// Synthetic decision evidence only. This file does not implement a provider
// adapter or contact Stripe. Provider time is independent of request expiry.
import assert from "node:assert/strict";
import test from "node:test";
import { createCheckoutSessionService } from "../../../src/checkout/sessions.ts";

const claimSeconds = 1_800_000_000;
const principal = { accountId: "synthetic-owner", siteId: "synthetic-store" };
const binding = { bindingRef: "synthetic-binding", stripeAccountId: "acct_synthetic", mode: "test", providerId: "stripe" };
const request = {
  attemptId: "synthetic-attempt", bindingRef: binding.bindingRef,
  lines: [{ catalogItemId: "synthetic-item", name: "Synthetic item", quantity: 1, unitPrice: { currency: "USD", minor: "100" } }],
  total: { currency: "USD", minor: "100" }, paymentWindowSeconds: 1800, paymentMethods: ["card"],
};

// Models the documented absolute-expiry limits and same-key/same-params replay.
// A validation failure is deliberately NOT cached. All clocks are synthetic.
function processor() {
  let time = claimSeconds;
  let operations = 0;
  const cache = new Map(), calls = [];
  return {
    calls, setTime(value) { time = value; }, operations() { return operations; },
    async createSession(input) {
      calls.push(structuredClone(input));
      const body = JSON.stringify(input), prior = cache.get(input.idempotencyKey);
      if (prior) {
        if (prior.body !== body) throw Error("synthetic_parameter_mismatch");
        return structuredClone(prior.session);
      }
      const duration = input.expiresAtSeconds - time;
      if (duration < 1800 || duration > 86400) throw Error("synthetic_invalid_expiry");
      operations++;
      const session = {
        id: "cs_test_synthetic", url: "https://checkout.stripe.com/c/pay/cs_test_synthetic",
        status: "open", paymentStatus: "unpaid", amountTotal: 100, currency: "usd",
        created: time, expiresAt: input.expiresAtSeconds, livemode: false, paymentIntentId: null,
        metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
        paymentMethodTypes: ["card"],
      };
      cache.set(input.idempotencyKey, { body, session });
      return structuredClone(session);
    },
    async retrieveSession() { return structuredClone([...cache.values()][0]?.session); },
    async retrievePaymentIntent() { throw Error("not_used"); },
  };
}

function currentService(provider) {
  let clientTime = claimSeconds * 1000;
  const attempts = new Map();
  const service = createCheckoutSessionService({
    store: { transaction: fn => fn({
      read: id => structuredClone(attempts.get(id) ?? null),
      write: value => attempts.set(value.attemptId, structuredClone(value)),
    }) },
    readyBinding: async () => binding, existingBinding: async () => binding,
    provider, mode: "test", now: () => clientTime,
    successUrl: "https://store.example.invalid/return", cancelUrl: "https://store.example.invalid/cancel",
  });
  return { service, attempts, advance(seconds) { clientTime += seconds * 1000; } };
}

// Proposed protocol tuple, isolated from the production service. Not approved.
function proposedClaim() {
  return {
    attemptId: request.attemptId, bindingRef: binding.bindingRef, siteId: principal.siteId,
    stripeAccountId: binding.stripeAccountId, lines: structuredClone(request.lines), total: request.total,
    expiresAtSeconds: claimSeconds + 1860,
    successUrl: "https://store.example.invalid/return", cancelUrl: "https://store.example.invalid/cancel",
    idempotencyKey: `dinkus-checkout:${request.attemptId}`,
  };
}
const proposedPortAccepts = session => Number.isSafeInteger(session.created) && Number.isSafeInteger(session.expiresAt) &&
  session.expiresAt - session.created >= 1800 && session.expiresAt - session.created <= 1860;
const currentPortAccepts = session => session.expiresAt === session.created + 1800;

test("current source can return open with an independently aligned provider clock", async () => {
  const p = processor(), f = currentService(p);
  assert.equal((await f.service.ensureSessionFor(principal, request)).outcome, "open");
  assert.equal(p.operations(), 1);
});

test("accepted P1 reproduces in current source after one second and remains stale on retry", async () => {
  const p = processor(), f = currentService(p);
  p.setTime(claimSeconds + 1);
  assert.deepEqual(await f.service.ensureSessionFor(principal, request), { outcome: "unknown" });
  f.advance(10); p.setTime(claimSeconds + 11);
  assert.deepEqual(await f.service.ensureSessionFor(principal, request), { outcome: "unknown" });
  assert.equal(p.operations(), 0);
  assert.equal(p.calls.length, 2);
  assert.deepEqual(p.calls[0], p.calls[1]);
  assert.equal(p.calls[0].expiresAtSeconds, claimSeconds + 1800);
  assert.equal(f.attempts.get(request.attemptId).stripeSessionId, null);
});

test("one proposed 1860-second claim is usable across bounded provider delays, but violates current Commerce", async t => {
  const rows = [];
  for (const delay of [0, 1, 10, 30, 59, 60]) {
    const p = processor(); p.setTime(claimSeconds + delay);
    const session = await p.createSession(proposedClaim());
    assert.equal(session.created, claimSeconds + delay);
    assert.equal(session.expiresAt, claimSeconds + 1860);
    assert.equal(proposedPortAccepts(session), true);
    assert.equal(currentPortAccepts(session), delay === 60);
    rows.push({ delaySeconds: delay, durationSeconds: session.expiresAt - session.created, proposedPortAccepts: true, currentPortAccepts: currentPortAccepts(session) });
  }
  t.diagnostic(JSON.stringify(rows));
});

test("delay beyond headroom cannot first-create and a retry must not move the deadline", async () => {
  const p = processor(), claim = proposedClaim();
  p.setTime(claimSeconds + 61);
  await assert.rejects(p.createSession(claim), /synthetic_invalid_expiry/);
  p.setTime(claimSeconds + 90);
  await assert.rejects(p.createSession(claim), /synthetic_invalid_expiry/);
  assert.equal(p.operations(), 0);
  assert.deepEqual(p.calls[0], p.calls[1]);
  assert.equal(claim.expiresAtSeconds, claimSeconds + 1860);
});

test("lost response followed by delayed recovery replays one original successful operation", async () => {
  const p = processor(), claim = proposedClaim(); p.setTime(claimSeconds + 1);
  let original;
  await assert.rejects((async () => { original = await p.createSession(claim); throw Error("synthetic_response_lost"); })(), /synthetic_response_lost/);
  p.setTime(claimSeconds + 180);
  const recovered = await p.createSession(claim);
  assert.deepEqual(recovered, original);
  assert.equal(p.operations(), 1);
  assert.deepEqual(p.calls[0], p.calls[1]);
  assert.equal(proposedPortAccepts(recovered), true);
});

test("extending a successfully executed create under the same key is not a repair", async () => {
  const p = processor(), claim = proposedClaim(); await p.createSession(claim);
  await assert.rejects(p.createSession({ ...claim, expiresAtSeconds: claim.expiresAtSeconds + 1 }), /synthetic_parameter_mismatch/);
  assert.equal(p.operations(), 1);
});

test("the proposed port refuses excessive duration and clocks are not rewritten", async () => {
  const p = processor(); p.setTime(claimSeconds - 1);
  const session = await p.createSession(proposedClaim());
  assert.equal(session.created, claimSeconds - 1);
  assert.equal(session.expiresAt - session.created, 1861);
  assert.equal(proposedPortAccepts(session), false);
  assert.equal(proposedPortAccepts({ ...session, created: session.expiresAt - 1799 }), false);
  assert.equal(proposedPortAccepts({ ...session, created: 1.5 }), false);
});
