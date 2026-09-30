import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
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
