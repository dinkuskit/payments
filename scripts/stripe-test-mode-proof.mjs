#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import { createCheckoutSessionService, requestFingerprint } from "../src/checkout/sessions.ts";
import { createStripeCheckout } from "../src/stripe/checkout.ts";
import {
  createProofRequest,
  lookupProofRequest,
  STRIPE_PROOF_AMOUNT_MINOR,
} from "./stripe-test-mode-proof-logic.mjs";

const run = process.argv.includes("--run");
const lookupIndex = process.argv.indexOf("--lookup");
const hasLookupFlag = lookupIndex >= 0;
const lookupSessionId = lookupIndex >= 0 ? process.argv[lookupIndex + 1] : null;
const key = process.env.STRIPE_API_KEY ?? "";
const accountId = process.env.STRIPE_TEST_ACCOUNT_ID ?? "";

function redact(value) {
  return String(value)
    .replace(/sk_(?:test|live)_[A-Za-z0-9]+/g, "sk_[REDACTED]")
    .replace(/whsec_[A-Za-z0-9]+/g, "whsec_[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

if (!run && !hasLookupFlag) {
  console.log("stripe test mode dry-run: PASS");
  process.exit(0);
}

if (hasLookupFlag && !lookupSessionId) {
  console.log("lookup session id: FAIL (a cs_test_ id is required)");
  process.exit(1);
}

if (!key) {
  console.log("stripe test key: FAIL (blocked: Stripe test key not present)");
  process.exit(0);
}
if (!key.startsWith("sk_test_")) {
  console.log("stripe test key: FAIL");
  process.exit(1);
}
if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) {
  console.log("stripe test connected account: FAIL (STRIPE_TEST_ACCOUNT_ID is required)");
  process.exit(1);
}
if (run && lookupSessionId) {
  console.log("proof mode: FAIL (choose --run or --lookup)");
  process.exit(1);
}
if (lookupSessionId && !/^cs_test_[A-Za-z0-9]+$/.test(lookupSessionId)) {
  console.log("lookup session id: FAIL (expected a cs_test_ id)");
  process.exit(1);
}

const principal = { accountId: "proof-owner", siteId: "stripe-test-proof" };
const binding = { bindingRef: "stripe_test_proof", providerId: "stripe", stripeAccountId: accountId, mode: "test" };
const request = createProofRequest(`stripe-proof-${Date.now()}`, binding.bindingRef);

const attempts = new Map();
const store = {
  transaction(fn) {
    return fn({
      read: id => structuredClone(attempts.get(id) ?? null),
      write: value => attempts.set(value.attemptId, structuredClone(value)),
    });
  },
};
const provider = createStripeCheckout({ apiKey: key, mode: "test" });
const service = createCheckoutSessionService({
  store,
  readyBinding: async () => binding,
  existingBinding: async () => binding,
  provider,
  mode: "test",
  successUrl: "https://demo.dinkuskit.com/checkout/success",
  cancelUrl: "https://demo.dinkuskit.com/checkout/cancel",
});

async function check(name, action) {
  try {
    const value = await action();
    console.log(`${name}: PASS`);
    return value;
  } catch (error) {
    console.log(`${name}: FAIL (${redact(error instanceof Error ? error.message : error)})`);
    process.exitCode = 1;
    return null;
  }
}

if (lookupSessionId) {
  const session = await check("retrieve test Checkout Session", () => provider.retrieveSession(lookupSessionId, accountId));
  if (!session) process.exit(1);
  let lookup;
  try {
    lookup = lookupProofRequest(session);
  } catch (error) {
    console.log(`lookup session fields: FAIL (${redact(error.message)})`);
    process.exit(1);
  }
  const { attemptId, bindingRef, siteId, request: lookupRequest } = lookup;
  attempts.set(attemptId, {
    attemptId,
    bindingRef,
    stripeAccountId: accountId,
    mode: "test",
    siteId,
    requestFingerprint: requestFingerprint(lookupRequest),
    lines: lookupRequest.lines,
    amountMinor: STRIPE_PROOF_AMOUNT_MINOR,
    currency: "USD",
    claimedAtMs: session.created * 1000,
    requestedExpiresAtSeconds: session.expiresAt,
    providerCreatedAtSeconds: session.created,
    providerExpiresAtSeconds: session.expiresAt,
    idempotencyKey: `dinkus-checkout:${attemptId}`,
    successUrl: "https://demo.dinkuskit.com/checkout/success",
    cancelUrl: "https://demo.dinkuskit.com/checkout/cancel",
    stripeSessionId: session.id,
    // Stripe removes Session.url after completion. The original run printed
    // and durably retained this URL; lookup-only reconstructs the documented
    // hosted URL only for this proof's transient record.
    redirectUrl: session.url ?? `https://checkout.stripe.com/c/pay/${session.id}`,
    policyKind: "current-bounded-1800-1860",
  });
  console.log(`checkout-session-id: ${session.id}`);
  await check("authoritative lookup reports paid", async () => {
    const outcome = await service.lookupFor({ accountId: "proof-owner", siteId }, lookupRequest);
    assert.equal(outcome.outcome, "paid");
    assert.equal(outcome.total.currency, "USD");
    assert.equal(outcome.total.minor, STRIPE_PROOF_AMOUNT_MINOR);
    console.log(`payment-intent-id: ${outcome.paymentId}`);
  });
  process.exit();
}

const created = await check("test Checkout Session creation", async () => {
  const outcome = await service.ensureSessionFor(principal, request);
  assert.equal(outcome.outcome, "open");
  assert.match(outcome.session.sessionId, /^cs_/);
  console.log(`checkout-session-id: ${outcome.session.sessionId}`);
  console.log(`checkout-url: ${outcome.session.redirectUrl}`);
  return outcome;
});

if (!created) process.exit(1);

await check("pre-payment lookup reports open/unpaid", async () => {
  const outcome = await service.lookupFor(principal, request);
  assert.equal(outcome.outcome, "open");
  assert.equal(outcome.total.currency, "USD");
  assert.equal(outcome.total.minor, STRIPE_PROOF_AMOUNT_MINOR);
});

console.log("next-step: pay the hosted URL, then rerun with --lookup <checkout-session-id>");
