import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHORIZE_NET_HOSTED_PRODUCTION_URL,
  AUTHORIZE_NET_HOSTED_SANDBOX_URL,
  AUTHORIZE_NET_PRODUCTION_URL,
  AUTHORIZE_NET_SANDBOX_URL,
  authorizeNetEndpoints,
  createAuthorizeNetGateway,
  createAuthorizeNetFetchTransport,
  createAuthorizeNetPaymentPort,
  transactionOutcome,
} from "../src/authorize-net/checkout.ts";
import {
  createAuthorizeNetWebhookHandler,
  verifyAuthorizeNetReturn,
} from "../src/authorize-net/webhook.ts";

const credentials = { apiLoginId: "synthetic-login", transactionKey: "synthetic-transaction-key", merchantCurrency: "USD", mode: "test" };
const payment = {
  attemptId: "attempt-one", bindingRef: "bind-one",
  lines: [{ catalogItemId: "sku", quantity: 1, name: "Item", unitPrice: { currency: "USD", minor: "1200" } }],
  total: { currency: "USD", minor: "1200" },
  paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
  paymentMethods: ["card"],
};

async function signedAuthorizeNetWebhook(body, key = "signature-key") {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const digest = [...new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, payload))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { payload, signature: `sha512=${digest}`, key };
}

test("mode pins API and hosted endpoints and unknown mode fails closed", () => {
  assert.deepEqual(authorizeNetEndpoints("test"), {
    api: AUTHORIZE_NET_SANDBOX_URL,
    hosted: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
  });
  assert.deepEqual(authorizeNetEndpoints("live"), {
    api: AUTHORIZE_NET_PRODUCTION_URL,
    hosted: AUTHORIZE_NET_HOSTED_PRODUCTION_URL,
  });
  assert.throws(() => authorizeNetEndpoints("production"), /invalid_mode/);
  assert.throws(() => createAuthorizeNetGateway({ ...credentials, mode: "production" }), /invalid_mode/);
});

test("Accept Hosted creation uses the official request shape and converts USD minor units only at transport", async () => {
  let request;
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => {
      request = body;
      return { token: "hosted-token", messages: { resultCode: "Ok" } };
    } },
  });
  const created = await gateway.createHostedPayment({
    attemptId: "attempt-one",
    total: { currency: "USD", minor: "1200" },
    returnUrl: "https://store.example/return",
    cancelUrl: "https://store.example/cancel",
  });
  assert.deepEqual(created, { token: "hosted-token", identity: "attempt-one" });
  const hosted = request.getHostedPaymentPageRequest;
  assert.equal(hosted.transactionRequest.amount, "12.00");
  assert.equal(hosted.transactionRequest.transactionType, "authCaptureTransaction");
  assert.equal(hosted.refId, "attempt-one");
  assert.equal(hosted.transactionRequest.order.invoiceNumber, "attempt-one");
  assert.deepEqual(JSON.parse(hosted.hostedPaymentSettings.setting[0].settingValue), {
    url: "https://store.example/return",
    urlText: "Return",
    cancelUrl: "https://store.example/cancel",
    cancelUrlText: "Cancel",
    showReceipt: false,
  });
});

test("transaction lookup is authoritative and unknown is distinct from unpaid", async () => {
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async () => ({
      messages: { resultCode: "Ok" },
      transaction: {
        transId: "123",
        responseCode: 1,
        transactionStatus: "settledSuccessfully",
        authAmount: "12.00",
        settleAmount: "12.00",
      },
    }) },
  });
  assert.deepEqual(await gateway.getTransaction("123"), {
    id: "123",
    status: "settledSuccessfully",
    responseCode: 1,
    amountMinor: 1200,
    authAmountMinor: 1200,
    settleAmountMinor: 1200,
    currency: "USD",
    invoiceNumber: null,
    refId: null,
  });
  const paid = transactionOutcome({
    id: "123", responseCode: 1, status: "settledSuccessfully",
    amountMinor: 1200, authAmountMinor: 1200, settleAmountMinor: 1200,
    currency: "USD", invoiceNumber: "attempt-one", refId: null,
  }, { minor: "1200", currency: "USD" });
  const unpaid = transactionOutcome({
    id: "124", responseCode: 2, status: "declined",
    amountMinor: 1200, authAmountMinor: 1200, settleAmountMinor: 1200,
    currency: "USD", invoiceNumber: "attempt-one", refId: null,
  }, { minor: "1200", currency: "USD" });
  const pending = transactionOutcome({
    id: "125", responseCode: 1, status: "pendingSettlement",
    amountMinor: 1200, authAmountMinor: 1200, settleAmountMinor: 1200,
    currency: "USD", invoiceNumber: "attempt-one", refId: null,
  }, { minor: "1200", currency: "USD" });
  assert.equal(paid, "paid");
  assert.equal(unpaid, "unpaid");
  assert.equal(pending, "unknown");
  await assert.rejects(gateway.getTransaction("not-a-transaction"), /invalid_transaction_id/);
  assert.throws(() => transactionOutcome({
    id: "126", responseCode: 1, status: "settledSuccessfully",
    amountMinor: 999, authAmountMinor: 999, settleAmountMinor: 999,
    currency: "USD", invoiceNumber: null, refId: null,
  }, { minor: "1200", currency: "USD" }), /amount_or_currency_mismatch/);
});

test("a lost creation response remains retryable unknown and never fabricates a session", async () => {
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async () => { throw new Error("connection_lost"); } },
  });
  await assert.rejects(gateway.createHostedPayment({
    attemptId: "attempt-lost",
    total: { currency: "USD", minor: "1200" },
    returnUrl: "https://store.example/return",
    cancelUrl: "https://store.example/cancel",
  }), /connection_lost/);
});

test("webhooks verify raw bytes, reject tampering and replay, and wake only once", async () => {
  const { payload, signature, key } = await signedAuthorizeNetWebhook({
    notificationId: "n-1",
    eventType: "net.authorize.payment.authcapture.created",
  });
  const seen = new Set();
  const wakes = [];
  const handle = createAuthorizeNetWebhookHandler({ signatureKey: key, seenEventIds: seen, wake: async event => wakes.push(event.id) });
  await handle(payload, signature, "n-1");
  assert.deepEqual(wakes, ["n-1"]);
  await assert.rejects(handle(payload, signature, "n-1"), /replayed_event/);
  await assert.rejects(handle(payload, `sha512=${"0".repeat(128)}`, "n-2"), /invalid_signature/);
});

test("a failed wake stays retryable and a later success is replay-fenced", async () => {
  const { payload, signature, key } = await signedAuthorizeNetWebhook({
    notificationId: "n-retry",
    eventType: "net.authorize.payment.authcapture.created",
  });
  const seen = new Set();
  const wakes = [];
  let fail = true;
  const handle = createAuthorizeNetWebhookHandler({
    signatureKey: key,
    seenEventIds: seen,
    wake: async event => {
      if (fail) throw new Error("commerce_down");
      wakes.push(event.id);
    },
  });
  await assert.rejects(handle(payload, signature, "n-retry"), /commerce_down/);
  assert.deepEqual(wakes, []);
  fail = false;
  await handle(payload, signature, "n-retry");
  assert.deepEqual(wakes, ["n-retry"]);
  await assert.rejects(handle(payload, signature, "n-retry"), /replayed_event/);
  assert.deepEqual(wakes, ["n-retry"]);
});

test("a signed notification cannot wake under a different caller event ID", async () => {
  const { payload, signature, key } = await signedAuthorizeNetWebhook({
    notificationId: "n-signed",
    eventType: "net.authorize.payment.authcapture.created",
  });
  const seen = new Set();
  const wakes = [];
  const handle = createAuthorizeNetWebhookHandler({
    signatureKey: key,
    seenEventIds: seen,
    wake: async event => wakes.push(event.id),
  });
  await assert.rejects(handle(payload, signature, "n-other"), /notification_id_mismatch/);
  assert.deepEqual(wakes, []);
  await handle(payload, signature, "n-signed");
  assert.deepEqual(wakes, ["n-signed"]);
  await assert.rejects(handle(payload, signature, "n-other"), /notification_id_mismatch/);
  await assert.rejects(handle(payload, signature, "n-signed"), /replayed_event/);
  assert.deepEqual(wakes, ["n-signed"]);
});

test("browser return is only a validated lookup hint and forged URLs fail closed", () => {
  assert.deepEqual(verifyAuthorizeNetReturn({
    requestUrl: "https://store.example/return?transId=123",
    configuredUrl: "https://store.example/return",
    transactionId: "123",
    amount: "12.00",
    currency: "USD",
  }), { transactionId: "123", amount: "12.00", currency: "USD" });
  assert.throws(() => verifyAuthorizeNetReturn({
    requestUrl: "https://evil.example/return",
    configuredUrl: "https://store.example/return",
    transactionId: "123",
    amount: "12.00",
    currency: "USD",
  }), /forged_return_url/);
  assert.throws(() => verifyAuthorizeNetReturn({
    requestUrl: "https://store.example/return",
    configuredUrl: "https://store.example/return",
    transactionId: "123",
    amount: "12.00",
    currency: "EUR",
  }), /invalid_return/);
});

test("wired payment port persists hosted session and reports authoritative paid, unpaid, and pending outcomes", async () => {
  const records = new Map();
  let response = { transId: "123", responseCode: 1, transactionStatus: "settledSuccessfully", authAmount: "12.00", settleAmount: "12.00" };
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => body.getTransactionDetailsRequest
      ? { messages: { resultCode: "Ok" }, transaction: response }
      : { messages: { resultCode: "Ok" }, token: "hosted-token" } },
  });
  const port = createAuthorizeNetPaymentPort({
    gateway, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/return", cancelUrl: "https://store.example/cancel",
    now: () => 1_800_000_000_000,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  const open = await port.ensureSession(payment);
  assert.equal(open.outcome, "open");
  assert.match(open.session.redirectUrl, /test\.authorize\.net\/payment\/payment\?token=/);
  assert.deepEqual(await port.lookup(payment), { outcome: "unknown" });
  port.recordTransaction(payment.attemptId, "123");
  assert.equal((await port.lookup(payment)).outcome, "paid");
  response = { ...response, transId: "123", responseCode: 2, transactionStatus: "declined" };
  records.get(payment.attemptId).transactionId = "123";
  assert.equal((await port.lookup(payment)).outcome, "expired-unpaid");
  response = { ...response, transId: "123", responseCode: 1, transactionStatus: "pendingSettlement" };
  records.get(payment.attemptId).transactionId = "123";
  assert.equal((await port.lookup(payment)).outcome, "unknown");
  response = { ...response, transId: "123", authAmount: "9.00", settleAmount: "9.00" };
  records.get(payment.attemptId).transactionId = "123";
  await assert.rejects(port.lookup(payment), /amount_or_currency_mismatch/);
});

test("wired creation remains unknown after a lost response and can recover durably", async () => {
  const records = new Map();
  let lose = true;
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => {
      if (lose) { lose = false; throw new Error("connection_lost"); }
      return { messages: { resultCode: "Ok" }, token: "hosted-token" };
    } },
  });
  const port = createAuthorizeNetPaymentPort({
    gateway, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/return", cancelUrl: "https://store.example/cancel",
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  assert.deepEqual(await port.ensureSession({ ...payment, attemptId: "attempt-lost" }), { outcome: "unknown" });
  assert.equal((await port.ensureSession({ ...payment, attemptId: "attempt-lost" })).outcome, "open");
  assert.equal(records.get("attempt-lost").token, "hosted-token");
});

test("fetch transport deadline covers a late response body without AbortSignal RPC", async () => {
  const transport = createAuthorizeNetFetchTransport({ endpoint: "https://apitest.authorize.net/xml/v1/request.api", timeoutMs: 10 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }, 30); },
  }), { status: 200 });
  try { await assert.rejects(transport.request({}), /authorize_net_timeout/); }
  finally { globalThis.fetch = originalFetch; }
});
