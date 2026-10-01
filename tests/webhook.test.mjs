import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { createStripeWebhookVerifier, createWebhookHandler } from "../src/checkout/webhook.ts";
import { createHostedHandler } from "../src/hosted/http.ts";

const secret = "whsec_synthetic_fixture";
const record = {
  attemptId: "attempt-one",
  bindingRef: "bind-one",
  stripeAccountId: "acct_one",
  mode: "test",
  siteId: "store-a",
  requestFingerprint: "{}",
  amountMinor: "1200",
  currency: "USD",
  claimedAtMs: 1,
  createdAtSeconds: 10,
  expiresAtSeconds: 1810,
  idempotencyKey: "dinkus-checkout:attempt-one",
  stripeSessionId: "cs_one",
  redirectUrl: "https://checkout.stripe.com/c/pay/cs_one",
};

function eventBody(overrides = {}) {
  return JSON.stringify({
    id: "evt_one",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    account: "acct_one",
    data: {
      object: {
        object: "checkout.session",
        id: "cs_one",
        livemode: false,
        metadata: { dinkus_attempt: "attempt-one", dinkus_binding: "bind-one", dinkus_site: "store-a" },
        ...overrides.session,
      },
    },
    ...overrides.event,
  });
}

function signed(body) {
  const payload = new TextEncoder().encode(body);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  return { payload, signature };
}

test("signature is verified from original bytes before any event field is used", async () => {
  const verifier = createStripeWebhookVerifier({ apiKey: "sk_test_synthetic_fixture", webhookSecret: secret });
  const order = [];
  const { payload, signature } = signed(eventBody());
  const wrapped = async (bytes, header) => {
    order.push("verify");
    assert.ok(bytes instanceof Uint8Array);
    const event = await verifier.verify(bytes, header);
    order.push("fields");
    return event;
  };
  const wakes = [];
  await createWebhookHandler({
    verify: wrapped,
    readAttempt: id => { order.push("read"); return { ...record, attemptId: id }; },
    retrieveAndMatch: async () => { order.push("retrieve"); },
    wake: { async wake(context) { order.push("wake"); wakes.push(context); } },
    mode: "test",
  })(payload, signature, "acct_one");
  assert.deepEqual(order, ["verify", "fields", "read", "retrieve", "wake"]);
  assert.deepEqual(wakes, [{
    eventId: "evt_one",
    attemptId: "attempt-one",
    siteId: "store-a",
    bindingRef: "bind-one",
    stripeAccountId: "acct_one",
    mode: "test",
  }]);
  await assert.rejects(createWebhookHandler({
    verify: wrapped,
    readAttempt: () => record,
    retrieveAndMatch: async () => {},
    wake: { async wake() {} },
    mode: "test",
  })(payload, "t=1,v1=deadbeef", "acct_one"));
});

test("replay and out-of-order events only wake, never mark paid", async () => {
  const verifier = createStripeWebhookVerifier({ apiKey: "sk_test_synthetic_fixture", webhookSecret: secret });
  const wakes = [];
  let retrieveCount = 0;
  const handle = createWebhookHandler({
    verify: (bytes, header) => verifier.verify(bytes, header),
    readAttempt: () => record,
    retrieveAndMatch: async () => { retrieveCount++; },
    wake: { async wake(context) { wakes.push(context.eventId); } },
    mode: "test",
  });
  const completed = signed(eventBody());
  const expired = signed(eventBody({ event: { id: "evt_two", type: "checkout.session.expired" } }));
  await handle(expired.payload, expired.signature, "acct_one");
  await handle(completed.payload, completed.signature, "acct_one");
  await handle(completed.payload, completed.signature, "acct_one");
  assert.deepEqual(wakes, ["evt_two", "evt_one", "evt_one"]);
  assert.equal(retrieveCount, 3);
});

test("signed event.account is required and the Stripe-Account header cannot substitute", async () => {
  const verifier = createStripeWebhookVerifier({ apiKey: "sk_test_synthetic_fixture", webhookSecret: secret });
  const handle = (body, header) => {
    const signedBody = signed(body);
    return createWebhookHandler({
      verify: (bytes, sig) => verifier.verify(bytes, sig),
      readAttempt: () => record,
      retrieveAndMatch: async () => {},
      wake: { async wake() {} },
      mode: "test",
    })(signedBody.payload, signedBody.signature, header);
  };
  await assert.rejects(handle(eventBody({ event: { account: undefined } }), "acct_one"), /account_unsigned/);
  await assert.rejects(handle(eventBody({ event: { account: null } }), "acct_one"), /account_unsigned/);
  await handle(eventBody(), null);
});

test("wrong session account or mode fail closed and a failed wake is not success", async () => {
  const verifier = createStripeWebhookVerifier({ apiKey: "sk_test_synthetic_fixture", webhookSecret: secret });
  const handle = (wake = async () => {}, rec = record, header = "acct_one", body = eventBody()) => {
    const signedBody = signed(body);
    return createWebhookHandler({
      verify: (bytes, sig) => verifier.verify(bytes, sig),
      readAttempt: () => rec,
      retrieveAndMatch: async () => {},
      wake: { wake },
      mode: "test",
    })(signedBody.payload, signedBody.signature, header);
  };
  await assert.rejects(handle(async () => {}, record, "acct_other"), /account_mismatch/);
  await assert.rejects(handle(async () => {}, { ...record, stripeSessionId: "cs_other" }), /session_mismatch/);
  await assert.rejects(handle(async () => {}, record, "acct_one", eventBody({ event: { livemode: true }, session: { livemode: true } })), /mode_mismatch/);
  await assert.rejects(handle(async () => { throw new Error("commerce_down"); }), /commerce_down/);
});

test("HTTP webhook returns 500 when durable wake fails and 400 before fields on bad signatures", async () => {
  const verifier = createStripeWebhookVerifier({ apiKey: "sk_test_synthetic_fixture", webhookSecret: secret });
  let wakeOk = false;
  const handle = createHostedHandler({
    authenticate: async () => { throw new Error("unused"); },
    service: () => { throw new Error("unused"); },
    webhook: async (payload, signature, account) => createWebhookHandler({
      verify: (bytes, header) => verifier.verify(bytes, header),
      readAttempt: () => record,
      retrieveAndMatch: async () => {},
      wake: { async wake() { if (!wakeOk) throw new Error("wake_down"); } },
      mode: "test",
    })(payload, signature, account),
  });
  const { payload, signature } = signed(eventBody());
  const bad = await handle(new Request("https://service.invalid/v1/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=nope", "stripe-account": "acct_one" },
    body: payload,
  }));
  assert.equal(bad.status, 400);
  const failed = await handle(new Request("https://service.invalid/v1/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature, "stripe-account": "acct_one" },
    body: payload,
  }));
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "wake_failed" });
  wakeOk = true;
  const ok = await handle(new Request("https://service.invalid/v1/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature, "stripe-account": "acct_one" },
    body: payload,
  }));
  assert.equal(ok.status, 200);
});
