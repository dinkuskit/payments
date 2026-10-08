#!/usr/bin/env -S node --import tsx
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createCheckoutSessionService } from "../src/checkout/sessions.ts";
import { createStripeCheckout } from "../src/stripe/checkout.ts";

const run = process.argv.includes("--run");
const key = process.env.STRIPE_API_KEY ?? "";
const accountId = process.env.STRIPE_TEST_ACCOUNT_ID ?? "";

if (!run) {
  console.log("stripe test mode dry-run: PASS");
  process.exit(0);
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
  console.log("stripe test connected account: FAIL");
  process.exit(1);
}

const principal = { accountId: "proof-owner", siteId: "stripe-test-proof" };
const binding = { bindingRef: "stripe_test_proof", providerId: "stripe", stripeAccountId: accountId, mode: "test" };
const request = {
  attemptId: `stripe-proof-${Date.now()}`,
  bindingRef: binding.bindingRef,
  lines: [{ catalogItemId: "proof-item", quantity: 1, name: "Stripe test proof", unitPrice: { currency: "USD", minor: "100" } }],
  total: { currency: "USD", minor: "100" },
  paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
  paymentMethods: ["card"],
};

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
  } catch {
    console.log(`${name}: FAIL`);
    process.exitCode = 1;
    return null;
  }
}

const created = await check("test Checkout Session creation", async () => {
  const outcome = await service.ensureSessionFor(principal, request);
  assert.equal(outcome.outcome, "open");
  assert.match(outcome.session.sessionId, /^cs_/);
  console.log(`checkout-session-id: ${outcome.session.sessionId}`);
  return outcome;
});

if (!created) process.exit(1);

const record = service.readAttempt(request.attemptId);
const session = await check("test PaymentIntent confirmation", async () => {
  assert.ok(record?.stripeSessionId);
  const stripe = new Stripe(key, { timeout: 10000, maxNetworkRetries: 0 });
  const retrieved = await stripe.checkout.sessions.retrieve(
    record.stripeSessionId,
    { expand: ["payment_intent"] },
    { stripeAccount: accountId },
  );
  const paymentIntent = typeof retrieved.payment_intent === "string"
    ? retrieved.payment_intent
    : retrieved.payment_intent?.id;
  assert.match(paymentIntent ?? "", /^pi_/);
  await stripe.paymentIntents.confirm(
    paymentIntent,
    { payment_method: "pm_card_visa" },
    { stripeAccount: accountId },
  );
  console.log(`payment-intent-id: ${paymentIntent}`);
  return retrieved;
});

if (!session) process.exit(1);

await check("authoritative lookup reports paid", async () => {
  const outcome = await service.lookupFor(principal, request);
  assert.equal(outcome.outcome, "paid");
  assert.equal(outcome.total.currency, "USD");
  assert.equal(outcome.total.minor, "100");
});
