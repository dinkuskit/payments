import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHORIZE_NET_ATTEMPT_ID_MAX_LENGTH,
  AUTHORIZE_NET_HOSTED_PRODUCTION_URL,
  AUTHORIZE_NET_HOSTED_SANDBOX_URL,
  AUTHORIZE_NET_INVOICE_MAX_LENGTH,
  AUTHORIZE_NET_PRODUCTION_URL,
  AUTHORIZE_NET_SANDBOX_URL,
  AUTHORIZE_NET_STORE_TAG_LENGTH,
  AUTHORIZE_NET_TRANSACTIONS_PER_ATTEMPT,
  authorizeNetEndpoints,
  authorizeNetStoreTag,
  buildAuthorizeNetInvoiceReference,
  createAuthorizeNetGateway,
  createAuthorizeNetFetchTransport,
  createAuthorizeNetPaymentPort,
  parseAuthorizeNetInvoiceReference,
  payPageAttemptId,
  transactionOutcome,
} from "../src/authorize-net/checkout.ts";
import { createHostedHandler } from "../src/hosted/http.ts";
import { authorizeNetPayPagePath, matchAuthorizeNetPaySession } from "../src/hosted/manifest.ts";
import {
  createAuthorizeNetWebhookHandler,
  verifyAuthorizeNetReturn,
} from "../src/authorize-net/webhook.ts";

const credentials = { apiLoginId: "synthetic-login", transactionKey: "synthetic-transaction-key", merchantCurrency: "USD", mode: "test" };
const siteId = "store-a";
const payPageUrl = "https://payments.example/v1/pay/authorize-net/store-a";
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

test("store-bound invoice references fit the 20-char budget and reject overflow or malformed input", async () => {
  assert.equal(AUTHORIZE_NET_INVOICE_MAX_LENGTH, 20);
  assert.equal(AUTHORIZE_NET_STORE_TAG_LENGTH, 8);
  assert.equal(AUTHORIZE_NET_ATTEMPT_ID_MAX_LENGTH, 11);
  const tag = await authorizeNetStoreTag(siteId);
  assert.match(tag, /^[0-9a-f]{8}$/);
  const identity = await buildAuthorizeNetInvoiceReference(siteId, "attempt-one");
  assert.equal(identity, `${tag}.attempt-one`);
  assert.equal(identity.length, 20);
  assert.deepEqual(parseAuthorizeNetInvoiceReference(identity), { storeTag: tag, attemptId: "attempt-one" });
  assert.equal(parseAuthorizeNetInvoiceReference("attempt-one"), null);
  assert.equal(parseAuthorizeNetInvoiceReference(`${tag}attempt-one`), null);
  assert.equal(parseAuthorizeNetInvoiceReference("abcd.attempt-one"), null);
  const otherTag = await authorizeNetStoreTag("store-b");
  assert.notEqual(tag, otherTag);
  await assert.rejects(buildAuthorizeNetInvoiceReference(siteId, "a".repeat(12)), /invalid_attempt_id/);
  await assert.rejects(buildAuthorizeNetInvoiceReference(siteId, "bad attempt"), /invalid_attempt_id/);
  await assert.rejects(buildAuthorizeNetInvoiceReference("", "attempt-one"), /invalid_site_id/);
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
  const identity = await buildAuthorizeNetInvoiceReference(siteId, "attempt-one");
  const created = await gateway.createHostedPayment({
    attemptId: "attempt-one",
    siteId,
    total: { currency: "USD", minor: "1200" },
    returnUrl: "https://store.example/return",
    cancelUrl: "https://store.example/cancel",
  });
  assert.deepEqual(created, { token: "hosted-token", identity });
  const hosted = request.getHostedPaymentPageRequest;
  assert.equal(hosted.transactionRequest.amount, "12.00");
  assert.equal(hosted.transactionRequest.transactionType, "authCaptureTransaction");
  assert.equal(hosted.refId, identity);
  assert.equal(hosted.transactionRequest.order.invoiceNumber, identity);
  // A declined shopper's corrected retry must not be refused as a duplicate. Authorize.net checks element
  // order, so the setting follows order.
  assert.deepEqual(hosted.transactionRequest.transactionSettings, { setting: [{ settingName: "duplicateWindow", settingValue: "0" }] });
  assert.deepEqual(Object.keys(hosted.transactionRequest), ["transactionType", "amount", "order", "transactionSettings"]);
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
    attemptId: "att-lost",
    siteId,
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

test("signed Authorize.net transaction hints can wake a durable attempt without deciding payment", async () => {
  const invoiceReference = await buildAuthorizeNetInvoiceReference(siteId, "attempt-one");
  const { payload, signature, key } = await signedAuthorizeNetWebhook({
    notificationId: "n-transaction",
    payload: { transaction: { transId: "123", order: { invoiceNumber: invoiceReference } } },
  });
  let event;
  await createAuthorizeNetWebhookHandler({
    signatureKey: key,
    seenEventIds: new Set(),
    wake: async value => { event = value; },
  })(payload, signature, "n-transaction");
  assert.equal(event.invoiceReference, invoiceReference);
  assert.equal(event.transactionId, "123");
  assert.equal(event.transaction, null);
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
  let clock = 1_800_000_000_000;
  const identity = await buildAuthorizeNetInvoiceReference(siteId, payment.attemptId);
  let response = { transId: "123", responseCode: 1, transactionStatus: "settledSuccessfully", authAmount: "12.00", settleAmount: "12.00", order: { invoiceNumber: identity } };
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => body.getTransactionDetailsRequest
      ? { messages: { resultCode: "Ok" }, transaction: response }
      : { messages: { resultCode: "Ok" }, token: "hosted-token" } },
  });
  const port = createAuthorizeNetPaymentPort({
    gateway, siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/return", cancelUrl: "https://store.example/cancel", payPageUrl,
    now: () => clock,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  const open = await port.ensureSession(payment);
  assert.equal(open.outcome, "open");
  assert.match(open.session.sessionId, /^[0-9a-f]{32}\.attempt-one$/);
  assert.equal(open.session.redirectUrl, `${payPageUrl}/${open.session.sessionId}`);
  assert.doesNotMatch(open.session.redirectUrl, /hosted-token/);
  assert.deepEqual(await port.lookup(payment), { outcome: "unknown" });
  port.recordTransaction(payment.attemptId, "123");
  assert.equal((await port.lookup(payment)).outcome, "paid");
  response = { ...response, transId: "123", responseCode: 2, transactionStatus: "declined" };
  records.get(payment.attemptId).transactionId = "123";
  // A declined shopper can still try again until the checkout ends.
  assert.equal((await port.lookup(payment)).outcome, "open");
  clock += 1861_000;
  assert.deepEqual(await port.lookup(payment), { outcome: "unknown" });
  clock += 300_000;
  assert.equal((await port.lookup(payment)).outcome, "expired-unpaid");
  response = { ...response, transId: "123", responseCode: 1, transactionStatus: "pendingSettlement" };
  records.get(payment.attemptId).transactionId = "123";
  assert.equal((await port.lookup(payment)).outcome, "unknown");
  response = { ...response, transId: "123", authAmount: "9.00", settleAmount: "9.00" };
  records.get(payment.attemptId).transactionId = "123";
  await assert.rejects(port.lookup(payment), /amount_or_currency_mismatch/);
  await assert.rejects(port.ensureSession({ ...payment, total: { currency: "USD", minor: "1300" } }), /attempt_mismatch/);
  response = { transId: "123", responseCode: 1, transactionStatus: "settledSuccessfully", authAmount: "12.00", settleAmount: "12.00", order: { invoiceNumber: "other-att" } };
  records.get(payment.attemptId).transactionId = "123";
  await assert.rejects(port.lookup(payment), /identity_mismatch/);
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
    gateway, siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/return", cancelUrl: "https://store.example/cancel", payPageUrl,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  assert.deepEqual(await port.ensureSession({ ...payment, attemptId: "att-lost" }), { outcome: "unknown" });
  assert.equal((await port.ensureSession({ ...payment, attemptId: "att-lost" })).outcome, "open");
  assert.equal(records.get("att-lost").token, "hosted-token");
});

test("a port without the store's return pages cannot start a hosted payment but still resumes one", async () => {
  const records = new Map();
  let requests = 0;
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async () => { requests++; return { messages: { resultCode: "Ok" }, token: "hosted-token" }; } },
  });
  const port = returnPages => createAuthorizeNetPaymentPort({
    gateway, siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL, ...returnPages,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  await assert.rejects(port({}).ensureSession(payment), /invalid_return_url/);
  assert.equal(requests, 0);
  assert.equal(records.size, 0);
  await assert.rejects(port({ returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout" }).ensureSession(payment), /invalid_pay_page_url/);
  assert.equal(requests, 0);
  assert.equal((await port({ returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout", payPageUrl }).ensureSession(payment)).outcome, "open");
  assert.equal((await port({}).ensureSession(payment)).outcome, "open");
  assert.equal(requests, 1);
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

for (const [label, overrides, secondSiteId] of [
  ["binding", { bindingRef: "bind-other" }, siteId],
  ["amount", { total: { currency: "USD", minor: "1300" } }, siteId],
  ["site", {}, "site-other"],
  ["matching details", {}, siteId],
]) {
  test(`concurrent session creation validates the winning record: ${label}`, async () => {
    const records = new Map();
    const pending = [];
    const makePort = portSiteId => createAuthorizeNetPaymentPort({
      gateway: {
        createHostedPayment: () => new Promise(resolve => pending.push(resolve)),
      },
      siteId: portSiteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
      returnUrl: "https://store.example/return", cancelUrl: "https://store.example/cancel", payPageUrl,
      store: { transaction: fn => fn({
        read: id => structuredClone(records.get(id) ?? null),
        write: (id, value) => records.set(id, structuredClone(value)),
      }) },
    });
    const first = makePort(siteId).ensureSession(payment);
    const second = makePort(secondSiteId).ensureSession({ ...payment, ...overrides });
    assert.equal(pending.length, 2);
    pending[0]({ token: "winning-token" });
    const winner = await first;
    assert.equal(winner.outcome, "open");
    assert.match(winner.session.sessionId, /^[0-9a-f]{32}\.attempt-one$/);
    assert.equal(records.get(payment.attemptId).sessionId, winner.session.sessionId);
    pending[1]({ token: "losing-token" });
    if (label === "matching details") {
      assert.deepEqual(await second, winner);
    } else {
      await assert.rejects(second, /attempt_mismatch/);
    }
    assert.equal(records.get(payment.attemptId).token, "winning-token");
    assert.equal(records.get(payment.attemptId).bindingRef, payment.bindingRef);
    assert.equal(records.get(payment.attemptId).siteId, siteId);
    assert.equal(records.get(payment.attemptId).amountMinor, payment.total.minor);
  });
}

// commerce#197 case B: a shopper whose first card is declined pays with a second one. Authorize.net
// does not promise its notices arrive in order, so the declined try's notice can land last.
test("a paid transaction stays paid when a declined try's notice for the same checkout arrives after it", async () => {
  const records = new Map();
  const identity = await buildAuthorizeNetInvoiceReference(siteId, payment.attemptId);
  const transactions = {
    111: { transId: "111", responseCode: 1, transactionStatus: "settledSuccessfully", authAmount: "12.00", settleAmount: "12.00", order: { invoiceNumber: identity } },
    222: { transId: "222", responseCode: 2, transactionStatus: "declined", authAmount: "12.00", settleAmount: "12.00", order: { invoiceNumber: identity } },
  };
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => body.getTransactionDetailsRequest
      ? { messages: { resultCode: "Ok" }, transaction: transactions[body.getTransactionDetailsRequest.transId] }
      : { messages: { resultCode: "Ok" }, token: "hosted-token" } },
  });
  const port = createAuthorizeNetPaymentPort({
    gateway, siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/return", cancelUrl: "https://store.example/cancel", payPageUrl,
    now: () => 1_800_000_000_000,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  assert.equal((await port.ensureSession(payment)).outcome, "open");
  port.recordTransaction(payment.attemptId, "111");
  port.recordTransaction(payment.attemptId, "222");
  const outcome = await port.lookup(payment);
  assert.equal(outcome.outcome, "paid");
  assert.equal(outcome.paymentId, "111");
});

test("a checkout reads unpaid only when every notified try is unpaid, and a try still pending keeps it open", async () => {
  const records = new Map();
  let clock = 1_800_000_000_000;
  const identity = await buildAuthorizeNetInvoiceReference(siteId, payment.attemptId);
  const declined = id => ({ transId: id, responseCode: 2, transactionStatus: "declined", authAmount: "12.00", settleAmount: "12.00", order: { invoiceNumber: identity } });
  const transactions = { 301: declined("301"), 302: declined("302"),
    303: { transId: "303", responseCode: 1, transactionStatus: "pendingSettlement", authAmount: "12.00", settleAmount: "12.00", order: { invoiceNumber: identity } } };
  const looked = [];
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => {
      if (!body.getTransactionDetailsRequest) return { messages: { resultCode: "Ok" }, token: "hosted-token" };
      looked.push(body.getTransactionDetailsRequest.transId);
      return { messages: { resultCode: "Ok" }, transaction: transactions[body.getTransactionDetailsRequest.transId] };
    } },
  });
  const port = createAuthorizeNetPaymentPort({
    gateway, siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/return", cancelUrl: "https://store.example/cancel", payPageUrl,
    now: () => clock,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  await port.ensureSession(payment);
  port.recordTransaction(payment.attemptId, "301");
  // The same notice delivered again is kept once.
  port.recordTransaction(payment.attemptId, "301");
  port.recordTransaction(payment.attemptId, "302");
  assert.deepEqual(records.get(payment.attemptId).transactionIds, ["301", "302"]);
  assert.equal((await port.lookup(payment)).outcome, "open");
  clock += 2161_000;
  assert.equal((await port.lookup(payment)).outcome, "expired-unpaid");
  port.recordTransaction(payment.attemptId, "303");
  assert.deepEqual(await port.lookup(payment), { outcome: "unknown" });
  assert.deepEqual(looked, ["301", "302", "301", "302", "301", "302", "303"]);
});

test("a try that can't be read now doesn't hide a later paid one, and the kept tries stay bounded", async () => {
  const records = new Map();
  const identity = await buildAuthorizeNetInvoiceReference(siteId, payment.attemptId);
  let reads = 0, down = false;
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => {
      if (!body.getTransactionDetailsRequest) return { messages: { resultCode: "Ok" }, token: "hosted-token" };
      const id = body.getTransactionDetailsRequest.transId;
      reads += 1;
      if (id === "401" || down) throw new Error("provider timeout");
      return { messages: { resultCode: "Ok" }, transaction: { transId: id, responseCode: 1, transactionStatus: "settledSuccessfully",
        authAmount: "12.00", settleAmount: "12.00", order: { invoiceNumber: identity } } };
    } },
  });
  const port = createAuthorizeNetPaymentPort({
    gateway, siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/return", cancelUrl: "https://store.example/cancel", payPageUrl,
    now: () => 1_800_000_000_000,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  await port.ensureSession(payment);
  port.recordTransaction(payment.attemptId, "401");
  port.recordTransaction(payment.attemptId, "402");
  const outcome = await port.lookup(payment);
  assert.equal(outcome.outcome, "paid");
  assert.equal(outcome.paymentId, "402");

  for (let id = 500; id < 530; id++) port.recordTransaction(payment.attemptId, String(id));
  const kept = records.get(payment.attemptId);
  assert.equal(kept.transactionIds.length, AUTHORIZE_NET_TRANSACTIONS_PER_ATTEMPT);
  assert.equal(kept.transactionIds.at(-1), "529");
  assert.equal(kept.transactionId, "529");
  // A record whose latest try sits outside a full list still reads at most the limit.
  records.set(payment.attemptId, { ...kept, transactionId: "999" });
  reads = 0;
  down = true;
  assert.deepEqual(await port.lookup(payment), { outcome: "unknown" });
  assert.equal(reads, AUTHORIZE_NET_TRANSACTIONS_PER_ATTEMPT);
});

function payPageHarness({ transactions = {}, mintFails = false, portSiteId = siteId, records = new Map() } = {}) {
  const state = { clock: 1_800_000_000_000, mints: 0, calls: 0, mintFails, onRead: null, onMint: null };
  const identity = buildAuthorizeNetInvoiceReference(siteId, payment.attemptId);
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => {
      state.calls += 1;
      if (body.getTransactionDetailsRequest) {
        state.onRead?.();
        const id = body.getTransactionDetailsRequest.transId;
        const found = transactions[id];
        if (!found) throw new Error("provider timeout");
        return { messages: { resultCode: "Ok" }, transaction: { authAmount: "12.00", order: { invoiceNumber: await identity }, ...found, transId: id } };
      }
      if (state.mintFails && state.mints > 0) throw new Error("connection_lost");
      state.onMint?.();
      state.mints += 1;
      return { messages: { resultCode: "Ok" }, token: `token-${state.mints}` };
    } },
  });
  const port = createAuthorizeNetPaymentPort({
    gateway, siteId: portSiteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout", payPageUrl,
    now: () => state.clock,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  return { records, state, port, transactions };
}

const post = token => ({ action: "post", hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL, token });

test("the pay page hands out a fresh card-form token while the Commerce session never changes", async () => {
  const { records, state, port } = payPageHarness();
  const open = await port.ensureSession(payment);
  const sessionId = open.session.sessionId;
  assert.equal(payPageAttemptId(sessionId), payment.attemptId);
  assert.deepEqual(await port.payPage(sessionId), post("token-1"));
  assert.equal(state.mints, 1);
  // A reload within 10 minutes reuses the token, which still has at least 5 minutes left.
  state.clock += 599_000;
  assert.deepEqual(await port.payPage(sessionId), post("token-1"));
  assert.equal(state.mints, 1);
  // Past that, the shopper gets a token minted now, for the same checkout.
  state.clock += 1_000;
  assert.deepEqual(await port.payPage(sessionId), post("token-2"));
  assert.equal(records.get(payment.attemptId).token, "token-2");
  assert.equal(records.get(payment.attemptId).tokenAt, 1_800_000_600);
  assert.deepEqual(await port.ensureSession(payment), open);
});

test("the pay page refuses anything but the checkout's own session, before any provider call", async () => {
  const { records, state, port } = payPageHarness();
  const { session } = await port.ensureSession(payment);
  port.recordTransaction(payment.attemptId, "801");
  state.clock += 600_000;
  state.calls = 0;
  const [secret] = session.sessionId.split(".");
  for (const sessionId of ["", "attempt-one", `${secret}.other`, `${"0".repeat(32)}.attempt-one`, `${secret.toUpperCase()}.attempt-one`,
    `${secret}.attempt-one/x`, `${secret}..`, "hosted-token"]) {
    assert.deepEqual(await port.payPage(sessionId), { action: "not_found" }, sessionId);
  }
  // Another store's pay page cannot open this checkout, even with its exact session.
  const otherStore = payPageHarness({ portSiteId: "store-b", records });
  assert.deepEqual(await otherStore.port.payPage(session.sessionId), { action: "not_found" });
  // An ended checkout sends the shopper back without reading or minting anything.
  state.clock = 1_800_000_000_000 + 1860_000;
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout" });
  assert.equal(state.calls + otherStore.state.calls, 0);
  state.clock = 1_800_000_000_000 + 600_000;
  // A checkout started before the pay page has no pay page session.
  const { sessionId: _sessionId, redirectUrl: _redirectUrl, ...legacy } = records.get(payment.attemptId);
  records.set(payment.attemptId, legacy);
  assert.deepEqual(await port.payPage(session.sessionId), { action: "not_found" });
  assert.equal((await port.ensureSession(payment)).session.redirectUrl, `${AUTHORIZE_NET_HOSTED_SANDBOX_URL}?token=token-1`);
});

test("the pay page sends a paid, undecided or ended checkout back to the store and retries a declined one", async () => {
  const { state, port, transactions } = payPageHarness();
  const { session } = await port.ensureSession(payment);
  port.recordTransaction(payment.attemptId, "601");
  transactions[601] = { responseCode: 2, transactionStatus: "declined" };
  assert.deepEqual(await port.payPage(session.sessionId), post("token-1"));
  transactions[601] = { responseCode: 4, transactionStatus: "FDSPendingReview" };
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout/success" });
  delete transactions[601];
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout/success" });
  transactions[601] = { responseCode: 1, transactionStatus: "capturedPendingSettlement" };
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout/success" });
  transactions[601] = { responseCode: 2, transactionStatus: "declined" };
  state.clock += 1860_000;
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout" });
  assert.equal(state.mints, 1);
});

test("a pay page that can't get a new token sends the shopper back to the store checkout", async () => {
  const { state, port } = payPageHarness({ mintFails: true });
  const { session } = await port.ensureSession(payment);
  state.clock += 600_000;
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout" });
});

test("unpaid is final only after the last card form can no longer be used, and a fraud hold never is", async () => {
  const { state, port, transactions } = payPageHarness();
  const { session } = await port.ensureSession(payment);
  port.recordTransaction(payment.attemptId, "701");
  transactions[701] = { responseCode: 2, transactionStatus: "declined" };
  // A token minted 10 seconds before the checkout ends can be used for 15 minutes after that.
  state.clock += 1850_000;
  assert.deepEqual(await port.payPage(session.sessionId), post("token-2"));
  assert.equal((await port.lookup(payment)).outcome, "open");
  state.clock += 10_000 + 300_000;
  assert.deepEqual(await port.lookup(payment), { outcome: "unknown" });
  state.clock += 890_000 - 300_000 + 299_000;
  assert.deepEqual(await port.lookup(payment), { outcome: "unknown" });
  state.clock += 1_000;
  assert.equal((await port.lookup(payment)).outcome, "expired-unpaid");
  for (const status of ["FDSPendingReview", "FDSAuthorizedPendingReview"]) {
    transactions[701] = { responseCode: 4, transactionStatus: status };
    assert.deepEqual(await port.lookup(payment), { outcome: "unknown" }, status);
  }
});

test("the pay page route posts the token without putting it in a URL", async () => {
  assert.equal(authorizeNetPayPagePath("store a/b"), "/v1/pay/authorize-net/store%20a%2Fb");
  assert.deepEqual(matchAuthorizeNetPaySession("/v1/pay/authorize-net/store%20a/abc.def"), { siteId: "store a", sessionId: "abc.def" });
  for (const path of ["/v1/pay/authorize-net/store", "/v1/pay/authorize-net/store/a/b", "/v1/pay/authorize-net//abc", "/v1/pay/authorize-net/%2F/abc", "/v1/pay/authorize-net/%E0/abc"]) {
    assert.equal(matchAuthorizeNetPaySession(path), null, path);
  }
  const seen = [];
  let page = post('tok"<en>');
  const handle = createHostedHandler({
    authenticate: async () => { throw new Error("no pass needed"); },
    service: () => { throw new Error("unused"); },
    authorizeNetPayPage: async (site, sessionId) => { seen.push([site, sessionId]); return page; },
  });
  const url = `https://payments.example${authorizeNetPayPagePath(siteId)}/abc.attempt-one`;
  const response = await handle(new Request(url));
  assert.deepEqual(seen, [[siteId, "abc.attempt-one"]]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-type"), /^text\/html/);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /form-action https:\/\/test\.authorize\.net https:\/\/accept\.authorize\.net/);
  assert.match(csp, /frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html, /<form method="post" action="https:\/\/test\.authorize\.net\/payment\/payment">/);
  assert.match(html, /name="token" value="tok&#34;&#60;en&#62;"/);
  page = { action: "redirect", url: "https://store.example/checkout/success" };
  const redirect = await handle(new Request(url));
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get("location"), "https://store.example/checkout/success");
  page = { action: "not_found" };
  assert.equal((await handle(new Request(url))).status, 404);
  assert.equal((await handle(new Request(url, { method: "POST" }))).status, 405);
  assert.equal((await handle(new Request(`${url}?token=x`))).status, 404);
  assert.equal(seen.length, 3);
});

test("a pay page visit that crosses the checkout's end never gets a token", async () => {
  const { records, state, port, transactions } = payPageHarness();
  const { session } = await port.ensureSession(payment);
  port.recordTransaction(payment.attemptId, "901");
  transactions[901] = { responseCode: 2, transactionStatus: "declined" };
  // The visit starts a second before the end and the provider read takes two seconds.
  state.clock += 1859_000;
  state.onRead = () => { state.clock += 2_000; };
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout" });
  assert.equal(state.mints, 1);
  // The same when the end passes while the new token is being minted: it is neither shown nor stored.
  state.clock = 1_800_000_000_000 + 1859_000;
  state.onRead = null;
  state.onMint = () => { state.clock += 2_000; };
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout" });
  assert.equal(records.get(payment.attemptId).token, "token-1");
  assert.equal(records.get(payment.attemptId).tokenAt, 1_800_000_000);
});

// Written by the adapter on main before the pay page (ac29a29); see proof/authorize-net-pay-page.
const preChangeRecord = {
  token: "hosted-token", transactionId: "123", createdAt: 1_800_000_000, expiresAt: 1_800_001_860,
  bindingRef: "bind-one", siteId: "store-a", amountMinor: "1200", currency: "USD", transactionIds: ["123"],
};

test("a checkout stored before the pay page keeps its session and still reconciles", async () => {
  const records = new Map([[payment.attemptId, structuredClone(preChangeRecord)]]);
  const identity = await buildAuthorizeNetInvoiceReference(siteId, payment.attemptId);
  let calls = 0;
  let status = { responseCode: 2, transactionStatus: "declined" };
  const port = createAuthorizeNetPaymentPort({
    gateway: createAuthorizeNetGateway({ ...credentials, transport: { request: async body => {
      calls += 1;
      return { messages: { resultCode: "Ok" }, transaction: { transId: body.getTransactionDetailsRequest.transId,
        authAmount: "12.00", order: { invoiceNumber: identity }, ...status } };
    } } }),
    siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL, payPageUrl,
    returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout",
    now: () => 1_800_000_100_000,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  const legacySession = {
    sessionId: "hosted-token", redirectUrl: `${AUTHORIZE_NET_HOSTED_SANDBOX_URL}?token=hosted-token`,
    createdAt: 1_800_000_000, expiresAt: 1_800_001_860,
  };
  assert.deepEqual(await port.ensureSession(payment), { outcome: "open", attemptId: payment.attemptId, total: payment.total, session: legacySession });
  assert.deepEqual(await port.lookup(payment), { outcome: "open", attemptId: payment.attemptId, total: payment.total, session: legacySession });
  port.recordTransaction(payment.attemptId, "124");
  status = { responseCode: 1, transactionStatus: "capturedPendingSettlement" };
  assert.deepEqual(await port.lookup(payment), { outcome: "paid", attemptId: payment.attemptId, total: payment.total, session: legacySession, paymentId: "123" });
  assert.deepEqual(await port.payPage(`${"0".repeat(32)}.${payment.attemptId}`), { action: "not_found" });
  assert.deepEqual(records.get(payment.attemptId), { ...preChangeRecord, transactionId: "124", transactionIds: ["123", "124"] });
  assert.equal(calls, 2);
});
