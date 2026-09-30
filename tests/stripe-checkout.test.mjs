import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { createCheckoutSessionService, requestFingerprint, STRIPE_MIN_EXPIRES_AT_SECONDS } from "../src/checkout/sessions.ts";
import { createStripeCheckout } from "../src/stripe/checkout.ts";

test("official Stripe checkout transport pins idempotency, connected account, card, and expires_at", async () => {
  const calls = [];
  const httpClient = Stripe.createFetchHttpClient(async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: String(init.body ?? "") });
    const path = new URL(url).pathname;
    if (path === "/v1/checkout/sessions" && init.method === "POST") {
      return new Response(JSON.stringify({
        object: "checkout.session",
        id: "cs_fixture",
        url: "https://checkout.stripe.com/c/pay/cs_fixture",
        status: "open",
        payment_status: "unpaid",
        amount_total: 1200,
        currency: "usd",
        created: 1800000000,
        expires_at: 1800001800,
        livemode: false,
        payment_intent: null,
        metadata: { dinkus_attempt: "attempt-one", dinkus_binding: "bind-one", dinkus_site: "store-a" },
        payment_method_types: ["card"],
      }), { headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/checkout/sessions/cs_fixture") {
      return new Response(JSON.stringify({
        object: "checkout.session",
        id: "cs_fixture",
        url: null,
        status: "expired",
        payment_status: "unpaid",
        amount_total: 1200,
        currency: "usd",
        created: 1800000000,
        expires_at: 1800001800,
        livemode: false,
        payment_intent: "pi_fixture",
        metadata: { dinkus_attempt: "attempt-one", dinkus_binding: "bind-one", dinkus_site: "store-a" },
        payment_method_types: ["card"],
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      object: "payment_intent",
      id: "pi_fixture",
      status: "canceled",
      amount: 1200,
      currency: "usd",
      latest_charge: { object: "charge", id: "ch_fixture", status: "failed" },
    }), { headers: { "content-type": "application/json" } });
  });
  const provider = createStripeCheckout({ apiKey: "sk_test_synthetic_fixture", mode: "test", httpClient });
  const created = await provider.createSession({
    attemptId: "attempt-one",
    bindingRef: "bind-one",
    siteId: "store-a",
    stripeAccountId: "acct_one",
    lines: [{ catalogItemId: "sku-1", quantity: 1, name: "Hat", unitPrice: { currency: "USD", minor: "1200" } }],
    total: { currency: "USD", minor: "1200" },
    expiresAtSeconds: 1800001800,
    successUrl: "https://store.example.invalid/checkout/return",
    cancelUrl: "https://store.example.invalid/checkout/cancel",
    idempotencyKey: "dinkus-checkout:attempt-one",
  });
  assert.equal(created.id, "cs_fixture");
  assert.equal(calls[0].headers.get("idempotency-key"), "dinkus-checkout:attempt-one");
  assert.equal(calls[0].headers.get("stripe-account"), "acct_one");
  const params = new URLSearchParams(calls[0].body);
  assert.equal(params.get("mode"), "payment");
  assert.equal(params.get("expires_at"), "1800001800");
  assert.equal(params.get("payment_method_types[0]"), "card");
  assert.equal(params.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(params.get("line_items[0][price_data][unit_amount]"), "1200");
  assert.equal(params.get("metadata[dinkus_attempt]"), "attempt-one");
  const retrieved = await provider.retrieveSession("cs_fixture", "acct_one");
  assert.equal(retrieved.url, null);
  assert.equal(calls[1].headers.get("stripe-account"), "acct_one");
  const intent = await provider.retrievePaymentIntent("pi_fixture", "acct_one");
  assert.equal(intent.status, "canceled");
  assert.deepEqual(intent.latestCharge, { state: "known", status: "failed" });
});

test("unexpanded latest_charge is unknown and is not treated as absent", async () => {
  const httpClient = Stripe.createFetchHttpClient(async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/payment_intents/pi_unexpanded") {
      return new Response(JSON.stringify({
        object: "payment_intent",
        id: "pi_unexpanded",
        status: "canceled",
        amount: 1200,
        currency: "usd",
        latest_charge: "ch_unexpanded",
      }), { headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/payment_intents/pi_omitted") {
      return new Response(JSON.stringify({
        object: "payment_intent",
        id: "pi_omitted",
        status: "canceled",
        amount: 1200,
        currency: "usd",
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response("missing", { status: 404 });
  });
  const provider = createStripeCheckout({ apiKey: "sk_test_synthetic_fixture", mode: "test", httpClient });
  assert.deepEqual((await provider.retrievePaymentIntent("pi_unexpanded", "acct_one")).latestCharge, { state: "unknown" });
  assert.deepEqual((await provider.retrievePaymentIntent("pi_omitted", "acct_one")).latestCharge, { state: "unknown" });
});

test("mode mismatch fails before checkout transport", () => {
  assert.throws(() => createStripeCheckout({ apiKey: "sk_test_synthetic_fixture", mode: "live" }), /mode_mismatch/);
});

test("stored 1799-second remaining expiry is replayed on the official Stripe wire and never omitted or increased", async (t) => {
  const claimMs = 1_600_000_000_000;
  const claimBaseSeconds = Math.floor(claimMs / 1000);
  const pinnedExpires = claimBaseSeconds + STRIPE_MIN_EXPIRES_AT_SECONDS;
  const clocks = { provider: claimBaseSeconds + 1, service: claimMs + 5_000 };
  t.mock.method(Date, "now", () => clocks.provider * 1000);
  const payment = {
    attemptId: "attempt-short-deadline",
    bindingRef: "bind-short",
    lines: [{ catalogItemId: "sku-1", quantity: 1, name: "Hat", unitPrice: { currency: "USD", minor: "1200" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
  };
  const owner = { accountId: "issuer:merchant-a", siteId: "store-a" };
  const successUrl = "https://store.example.invalid/checkout/return";
  const cancelUrl = "https://store.example.invalid/checkout/cancel";
  const attempts = new Map();
  attempts.set(payment.attemptId, {
    attemptId: payment.attemptId,
    bindingRef: payment.bindingRef,
    stripeAccountId: "acct_short",
    mode: "test",
    siteId: owner.siteId,
    requestFingerprint: requestFingerprint(payment),
    lines: payment.lines.map(line => ({ ...line, unitPrice: { ...line.unitPrice } })),
    amountMinor: payment.total.minor,
    currency: "USD",
    claimedAtMs: claimMs,
    requestedExpiresAtSeconds: pinnedExpires,
    providerCreatedAtSeconds: null,
    providerExpiresAtSeconds: null,
    idempotencyKey: "dinkus-checkout:attempt-short-deadline",
    successUrl,
    cancelUrl,
    stripeSessionId: null,
    redirectUrl: null,
  });
  let omissionTrapTaken = false;
  const creates = [];
  const httpClient = Stripe.createFetchHttpClient(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/v1/checkout/sessions" && init.method === "POST") {
      const headers = new Headers(init.headers);
      const body = String(init.body ?? "");
      const params = new URLSearchParams(body);
      const requestedExpires = Number(params.get("expires_at"));
      const remaining = params.has("expires_at") ? requestedExpires - Math.floor(Date.now() / 1000) : null;
      creates.push({ body, headers, params, remaining });
      if (!params.has("expires_at")) {
        omissionTrapTaken = true;
        return new Response(JSON.stringify({
          object: "checkout.session",
          id: "cs_omission_trap",
          url: "https://checkout.stripe.com/c/pay/cs_omission_trap",
          status: "open",
          payment_status: "unpaid",
          amount_total: 1200,
          currency: "usd",
          created: clocks.provider,
          expires_at: clocks.provider + 86400,
          livemode: false,
          payment_intent: null,
          metadata: {
            dinkus_attempt: params.get("metadata[dinkus_attempt]"),
            dinkus_binding: params.get("metadata[dinkus_binding]"),
            dinkus_site: params.get("metadata[dinkus_site]"),
          },
          payment_method_types: ["card"],
        }), { headers: { "content-type": "application/json" } });
      }
      if (remaining < STRIPE_MIN_EXPIRES_AT_SECONDS || remaining > 86400) {
        return new Response(JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "parameter_invalid_integer",
            message: "Expires at must be between 30 minutes and 24 hours in the future.",
            param: "expires_at",
          },
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        object: "checkout.session",
        id: "cs_short_deadline",
        url: "https://checkout.stripe.com/c/pay/cs_short_deadline",
        status: "open",
        payment_status: "unpaid",
        amount_total: 1200,
        currency: "usd",
        created: clocks.provider,
        expires_at: requestedExpires,
        livemode: false,
        payment_intent: null,
        metadata: {
          dinkus_attempt: params.get("metadata[dinkus_attempt]"),
          dinkus_binding: params.get("metadata[dinkus_binding]"),
          dinkus_site: params.get("metadata[dinkus_site]"),
        },
        payment_method_types: ["card"],
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response("missing", { status: 404 });
  });
  const service = createCheckoutSessionService({
    store: { transaction: fn => fn({
      read: id => structuredClone(attempts.get(id) ?? null),
      write: value => { attempts.set(value.attemptId, structuredClone(value)); },
    }) },
    readyBinding: async () => { throw new Error("stored attempt must not reclaim readiness"); },
    existingBinding: () => ({ bindingRef: payment.bindingRef, providerId: "stripe", stripeAccountId: "acct_short", mode: "test" }),
    provider: createStripeCheckout({ apiKey: "sk_test_synthetic_short_deadline", mode: "test", httpClient }),
    mode: "test",
    successUrl,
    cancelUrl,
    now: () => clocks.service,
  });
  function assertPinnedCreate(call) {
    assert.equal(call.params.has("expires_at"), true);
    assert.equal(call.params.get("expires_at"), String(pinnedExpires));
    assert.equal(call.headers.get("idempotency-key"), "dinkus-checkout:attempt-short-deadline");
    assert.equal(call.headers.get("stripe-account"), "acct_short");
  }
  const first = await service.ensureSessionFor(owner, payment);
  assert.equal(first.outcome, "unknown");
  assert.equal(omissionTrapTaken, false);
  assert.equal(creates.length, 1);
  assertPinnedCreate(creates[0]);
  assert.equal(creates[0].remaining, 1799);
  const second = await service.ensureSessionFor(owner, payment);
  assert.equal(second.outcome, "unknown");
  assert.equal(creates.length, 2);
  assertPinnedCreate(creates[1]);
  assert.equal(creates[1].remaining, 1799);
  assert.equal(creates[1].body, creates[0].body);
  assert.equal(creates[1].headers.get("idempotency-key"), creates[0].headers.get("idempotency-key"));
  assert.equal(creates[1].headers.get("stripe-account"), creates[0].headers.get("stripe-account"));
  clocks.provider = claimBaseSeconds + 1800;
  clocks.service = claimMs + 1_800_000;
  const zero = await service.ensureSessionFor(owner, payment);
  assert.equal(zero.outcome, "unknown");
  assert.equal(creates.length, 3);
  assertPinnedCreate(creates[2]);
  assert.equal(creates[2].remaining, 0);
  assert.equal(creates[2].body, creates[0].body);
  assert.equal(omissionTrapTaken, false);
  assert.equal(attempts.get(payment.attemptId).requestedExpiresAtSeconds, pinnedExpires);
  assert.equal(attempts.get(payment.attemptId).stripeSessionId, null);
});
