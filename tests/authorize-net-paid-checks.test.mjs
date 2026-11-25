import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHORIZE_NET_HOSTED_SANDBOX_URL,
  buildAuthorizeNetInvoiceReference,
  createAuthorizeNetGateway,
  createAuthorizeNetPaymentPort,
} from "../src/authorize-net/checkout.ts";
import { createHostedHandler } from "../src/hosted/http.ts";
import { PAID_TWICE_HEADER } from "../src/paid-twice.ts";
import { decodeStatus } from "../src/registry/status.ts";
import { renderSetupScreen } from "../src/registry/setup.ts";

// Deepsec audit findings G1-03, G1-04, G1-06, G1-14 and G1-16, and the paid-twice line
// (payments-authorize-net-paid-twice-044).

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
const identity = await buildAuthorizeNetInvoiceReference(siteId, payment.attemptId);
const paidTry = { responseCode: 1, transactionStatus: "settledSuccessfully", authAmount: "12.00", settleAmount: "12.00" };
const declinedTry = { responseCode: 2, transactionStatus: "declined", authAmount: "12.00", settleAmount: "12.00" };

function harness() {
  const records = new Map();
  const state = { clock: 1_800_000_000_000, reads: [], mints: 0, paidTwice: [], onRead: null, mintGate: null };
  const transactions = {};
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => {
      if (body.getTransactionDetailsRequest) {
        const id = body.getTransactionDetailsRequest.transId;
        state.reads.push(id);
        state.onRead?.(id);
        const found = transactions[id];
        if (!found) throw new Error("provider timeout");
        return { messages: { resultCode: "Ok" }, transaction: { order: { invoiceNumber: identity }, ...found, transId: id } };
      }
      state.mints += 1;
      const token = `token-${state.mints}`;
      if (state.mintGate) await state.mintGate;
      return { messages: { resultCode: "Ok" }, token };
    } },
  });
  const port = createAuthorizeNetPaymentPort({
    gateway, siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout",
    payPageUrl: "https://payments.example/v1/pay/authorize-net/store-a",
    now: () => state.clock,
    paidTwice: (attemptId, record) => state.paidTwice.push([attemptId, record.paidId, [...record.alsoPaid]]),
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  return { records, state, transactions, port };
}

test("G1-03: a try for another amount or checkout never hides the paid one, whichever order they arrive in", async () => {
  const { state, transactions, port } = harness();
  await port.ensureSession(payment);
  // A partial refund made by hand carries the checkout's reference and a different amount.
  transactions[101] = { ...paidTry, authAmount: "4.00", settleAmount: "4.00" };
  transactions[102] = { ...paidTry, order: { invoiceNumber: "0badc0de.other" } };
  transactions[103] = paidTry;
  for (const id of ["101", "102", "103"]) port.recordTransaction(payment.attemptId, id);
  const outcome = await port.lookup(payment);
  assert.equal(outcome.outcome, "paid");
  assert.equal(outcome.paymentId, "103");
  assert.deepEqual(state.reads, ["101", "102", "103"]);
});

test("G1-03: a mismatched try refuses the checkout only when no other try decides it", async () => {
  const { transactions, port } = harness();
  await port.ensureSession(payment);
  transactions[201] = { ...declinedTry, authAmount: "4.00", settleAmount: "4.00" };
  port.recordTransaction(payment.attemptId, "201");
  await assert.rejects(port.lookup(payment), /amount_or_currency_mismatch/);
  // A try that can't be read yet might still be the payment: the checkout is undecided, not refused.
  port.recordTransaction(payment.attemptId, "202");
  assert.deepEqual(await port.lookup(payment), { outcome: "unknown" });
  transactions[202] = declinedTry;
  await assert.rejects(port.lookup(payment), /amount_or_currency_mismatch/);
  transactions[202] = paidTry;
  assert.equal((await port.lookup(payment)).paymentId, "202");
});

test("G1-14: the first proven paid try is kept for good, however many tries come after it", async () => {
  const { records, state, transactions, port } = harness();
  await port.ensureSession(payment);
  transactions[301] = paidTry;
  port.recordTransaction(payment.attemptId, "301");
  assert.equal((await port.lookup(payment)).paymentId, "301");
  for (let id = 400; id < 430; id++) {
    transactions[id] = declinedTry;
    port.recordTransaction(payment.attemptId, String(id));
  }
  assert.equal(records.get(payment.attemptId).transactionIds.includes("301"), false);
  state.reads = [];
  state.clock += 3_600_000;
  // Paid, not expired-unpaid, and without asking Authorize.net again.
  const outcome = await port.lookup(payment);
  assert.equal(outcome.outcome, "paid");
  assert.equal(outcome.paymentId, "301");
  assert.deepEqual(state.reads, []);
});

test("paid twice: both paid tries stay recorded, the order is made from the first, and the owner is told once", async () => {
  const { records, state, transactions, port } = harness();
  await port.ensureSession(payment);
  transactions[501] = declinedTry;
  transactions[502] = paidTry;
  transactions[503] = paidTry;
  for (const id of ["501", "502", "503"]) port.recordTransaction(payment.attemptId, id);
  const outcome = await port.lookup(payment);
  assert.equal(outcome.paymentId, "502");
  assert.equal(records.get(payment.attemptId).paidId, "502");
  assert.deepEqual(records.get(payment.attemptId).alsoPaid, ["503"]);
  assert.deepEqual(state.paidTwice, [["attempt-one", "502", ["503"]]]);
  // Asking again answers the same order and tells the owner nothing new.
  assert.equal((await port.lookup(payment)).paymentId, "502");
  assert.equal(state.paidTwice.length, 1);
});

test("paid twice: a payment notified after the checkout was paid is read and reaches the owner", async () => {
  const { records, state, transactions, port } = harness();
  await port.ensureSession(payment);
  transactions[601] = paidTry;
  port.recordTransaction(payment.attemptId, "601");
  assert.equal((await port.lookup(payment)).paymentId, "601");
  state.reads = [];
  // A later decline, a refund for another amount, and another checkout's payment are not a second payment.
  transactions[602] = declinedTry;
  transactions[603] = { ...paidTry, authAmount: "12.00", settleAmount: "5.00" };
  transactions[604] = { ...paidTry, order: { invoiceNumber: "0badc0de.other" } };
  for (const id of ["602", "603", "604"]) {
    port.recordTransaction(payment.attemptId, id);
    await port.checkLateTry(payment.attemptId, id);
  }
  assert.equal(records.get(payment.attemptId).alsoPaid, undefined);
  assert.deepEqual(state.paidTwice, []);
  // A try Authorize.net can't show yet throws, so its notice is delivered again later.
  port.recordTransaction(payment.attemptId, "605");
  await assert.rejects(port.checkLateTry(payment.attemptId, "605"), /provider timeout/);
  transactions[605] = paidTry;
  await port.checkLateTry(payment.attemptId, "605");
  assert.deepEqual(records.get(payment.attemptId).alsoPaid, ["605"]);
  assert.deepEqual(state.paidTwice, [["attempt-one", "601", ["605"]]]);
  // The order stays with the first payment.
  assert.equal((await port.lookup(payment)).paymentId, "601");
  assert.deepEqual(state.reads, ["602", "603", "604", "605", "605"]);
});

test("paid twice: a payment notified while the first one was being read is not missed", async () => {
  const { records, state, transactions, port } = harness();
  await port.ensureSession(payment);
  transactions[701] = paidTry;
  transactions[702] = paidTry;
  port.recordTransaction(payment.attemptId, "701");
  // The second payment's notice lands while lookup is reading the first, before the checkout is known paid.
  state.onRead = id => { if (id === "701") port.recordTransaction(payment.attemptId, "702"); };
  assert.equal((await port.lookup(payment)).paymentId, "701");
  assert.deepEqual(records.get(payment.attemptId).alsoPaid, ["702"]);
  assert.deepEqual(state.reads, ["701", "702"]);
});

test("a checkout not yet paid reads nothing for a late try: the next lookup reads every try", async () => {
  const { state, transactions, port } = harness();
  await port.ensureSession(payment);
  transactions[801] = paidTry;
  port.recordTransaction(payment.attemptId, "801");
  await port.checkLateTry(payment.attemptId, "801");
  assert.deepEqual(state.reads, []);
});

test("G1-06 + G1-16: a lookup must name the checkout exactly as it was opened, and answers the saved amount", async () => {
  const { state, transactions, port } = harness();
  await port.ensureSession(payment);
  transactions[901] = paidTry;
  port.recordTransaction(payment.attemptId, "901");
  state.reads = [];
  await assert.rejects(port.lookup({ ...payment, bindingRef: "bind-other" }), /attempt_mismatch/);
  await assert.rejects(port.lookup({ ...payment, total: { currency: "USD", minor: "1300" },
    lines: [{ ...payment.lines[0], unitPrice: { currency: "USD", minor: "1300" } }] }), /attempt_mismatch/);
  // Same total, different cart: refused like the Stripe path does.
  const changedCart = { ...payment, lines: [{ ...payment.lines[0], catalogItemId: "other-sku", name: "Other" }] };
  await assert.rejects(port.lookup(changedCart), /request_mutation/);
  await assert.rejects(port.ensureSession(changedCart), /request_mutation/);
  // Refused before asking Authorize.net anything.
  assert.deepEqual(state.reads, []);
  const outcome = await port.lookup(structuredClone(payment));
  assert.equal(outcome.outcome, "paid");
  assert.deepEqual(outcome.total, { currency: "USD", minor: "1200" });
});

test("G1-04: two tabs opening the card form at once get the same one, and only one is ever stored", async () => {
  const { records, state, port } = harness();
  const { session } = await port.ensureSession(payment);
  assert.equal(state.mints, 1);
  state.clock += 900_000;
  let release;
  state.mintGate = new Promise(resolve => { release = resolve; });
  const first = port.payPage(session.sessionId);
  const second = port.payPage(session.sessionId);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(state.mints, 3);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.action, "post");
  assert.equal(a.token, b.token);
  assert.equal(records.get(payment.attemptId).token, a.token);
  // A later visit in a third tab gets that same form too.
  state.clock += 899_000;
  assert.equal((await port.payPage(session.sessionId)).token, a.token);
  assert.equal(state.mints, 3);
});

test("a paid checkout sends every pay page visit back to the store without asking Authorize.net", async () => {
  const { state, transactions, port } = harness();
  const { session } = await port.ensureSession(payment);
  transactions[1001] = paidTry;
  port.recordTransaction(payment.attemptId, "1001");
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout/success" });
  state.reads = [];
  assert.deepEqual(await port.payPage(session.sessionId), { action: "redirect", url: "https://store.example/checkout/success" });
  assert.deepEqual(state.reads, []);
});

const notice = { transactionIds: ["60020981676", "60020981677"], total: { currency: "USD", minor: "4500" }, at: Date.UTC(2026, 10, 23, 15, 4) };

test("Payments status lists paid-twice checkouts only to a plugin that asks", async () => {
  const owner = { accountId: "synthetic-owner", siteId: "synthetic-site" };
  let asked = 0;
  const handler = createHostedHandler({ authenticate: async () => owner, service: () => ({
    async connect() { throw Error("unused"); },
    async status() { return { state: "ready", mode: "test" }; },
    businessCountry: () => undefined,
    paidTwice: () => { asked++; return [notice]; },
    async checkoutBinding() { return null; },
    async existingBinding() { return null; },
  }) });
  const read = headers => handler(new Request("https://payments.example/v1/status", { headers: { Authorization: "Bearer t", ...headers } })).then(r => r.json());
  assert.deepEqual(await read({}), { state: "ready", mode: "test" });
  assert.equal(asked, 0);
  assert.deepEqual(await read({ [PAID_TWICE_HEADER.name]: PAID_TWICE_HEADER.value }), { state: "ready", mode: "test", paidTwice: [notice] });
  // Both asks together, as the plugin sends them.
  assert.deepEqual(await read({ [PAID_TWICE_HEADER.name]: PAID_TWICE_HEADER.value, "X-Dinkus-Payments-Include": "business-country" }),
    { state: "ready", mode: "test", paidTwice: [notice] });
});

test("the plugin reads a paid-twice list strictly and shows the owner each checkout to refund by hand", () => {
  const status = { state: "ready", mode: "test", bindingRef: "bind-one", connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported" } };
  assert.deepEqual(decodeStatus({ ...status, paidTwice: [notice] }).paidTwice, [notice]);
  for (const bad of [
    [], [{ ...notice, transactionIds: ["1"] }], [{ ...notice, transactionIds: ["1", "1"] }], [{ ...notice, transactionIds: ["1", "x"] }],
    [{ ...notice, extra: 1 }], [{ ...notice, total: { currency: "EUR", minor: "4500" } }], [{ ...notice, at: 0 }], Array(11).fill(notice), notice,
  ]) assert.throws(() => decodeStatus({ ...status, paidTwice: bad }), /invalid_status/, JSON.stringify(bad));
  // Stripe can't take a second payment for one checkout, so a Stripe status never carries the list.
  assert.throws(() => decodeStatus({ ...status, connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_1" }, paidTwice: [notice] }), /invalid_status/);
  const rendered = renderSetupScreen({ state: "ready", status: { availability: "available", status: decodeStatus({ ...status, paidTwice: [notice] }), message: "Payments status checked." } });
  const banner = rendered.blocks.find(block => block.title === "This checkout was paid twice");
  assert.deepEqual(banner, {
    type: "banner", title: "This checkout was paid twice", variant: "alert",
    description: "Authorize.net took $45.00 more than once for one checkout: transactions 60020981676 and 60020981677, found Nov 23, 2026 at 3:04 PM UTC. " +
      "Payments counts 60020981676 as this checkout's payment. Refund 60020981677 in Authorize.net by hand; Payments never refunds on its own.",
  });
  assert.equal(rendered.blocks.indexOf(banner), 2);
  const without = renderSetupScreen({ state: "ready", status: { availability: "available", status: decodeStatus(status), message: "Payments status checked." } });
  assert.equal(JSON.stringify(without).includes("paid twice"), false);
});

test("paid twice: a try Authorize.net could not answer for stays open after the checkout is paid, and is read again", async () => {
  const { records, state, transactions, port } = harness();
  await port.ensureSession(payment);
  // Both notices came before the first lookup; 102 can't be read yet.
  transactions[101] = paidTry;
  for (const id of ["101", "102"]) port.recordTransaction(payment.attemptId, id);
  const outcome = await port.lookup(payment);
  assert.equal(outcome.paymentId, "101");
  assert.deepEqual(port.openTries(payment.attemptId), ["102"], "102 is not counted as read");
  assert.deepEqual(state.paidTwice, []);
  // Still down: it stays open.
  assert.equal(await port.recheck(payment.attemptId), false);
  transactions[102] = paidTry;
  assert.equal(await port.recheck(payment.attemptId), true);
  assert.deepEqual(state.paidTwice, [[payment.attemptId, "101", ["102"]]]);
  assert.equal(records.get(payment.attemptId).paidId, "101", "the checkout's payment stays the first");
  // A try read and found not to be a payment is not read again.
  transactions[103] = declinedTry;
  port.recordTransaction(payment.attemptId, "103");
  assert.equal(await port.recheck(payment.attemptId), true);
  const reads = state.reads.length;
  assert.equal(await port.recheck(payment.attemptId), true);
  assert.equal(state.reads.length, reads);
  assert.deepEqual(port.openTries(payment.attemptId), []);
});

test("paid twice: a try read after the try list is full is kept as read, not read again", async () => {
  const { state, transactions, port } = harness();
  await port.ensureSession(payment);
  transactions[101] = paidTry;
  port.recordTransaction(payment.attemptId, "101");
  assert.equal((await port.lookup(payment)).paymentId, "101");
  // Twenty declined tries fill the list; each is read once and kept as read.
  for (let id = 201; id <= 220; id++) { transactions[id] = declinedTry; port.recordTransaction(payment.attemptId, String(id)); }
  assert.equal(await port.recheck(payment.attemptId), true);
  assert.deepEqual(port.openTries(payment.attemptId), []);
  // One more pushes the oldest off the list, so the read list keeps its length but changes.
  transactions[221] = declinedTry;
  port.recordTransaction(payment.attemptId, "221");
  assert.equal(await port.recheck(payment.attemptId), true);
  assert.deepEqual(port.openTries(payment.attemptId), [], "221 is kept as read");
  const reads = state.reads.length;
  assert.equal(await port.recheck(payment.attemptId), true);
  assert.equal(state.reads.length, reads, "and is not read again");
});

test("concurrency guards: lookup never reports expired-unpaid or open over a mid-flight settlement, late try, or extended token", async () => {
  const identity = await buildAuthorizeNetInvoiceReference(siteId, payment.attemptId);
  let clock = 1_800_000_000_000 + 2_200_000; // past expiresAt (1860s) and initial settle margin (900+300=1200s)
  const records = new Map();
  const transactions = {
    101: { responseCode: 2, transactionStatus: "declined" },
    102: { responseCode: 1, transactionStatus: "settledSuccessfully" },
  };
  let onGetTx = null;
  const gateway = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => {
      if (body.getHostedPaymentPageRequest) return { messages: { resultCode: "Ok" }, token: "tok-1" };
      const id = body.getTransactionDetailsRequest.transId;
      await onGetTx?.(id);
      const tx = transactions[id];
      return { messages: { resultCode: "Ok" }, transaction: { transId: id, authAmount: "12.00", order: { invoiceNumber: identity }, ...tx } };
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

  clock = 1_800_000_000_000;
  await port.ensureSession(payment);
  port.recordTransaction(payment.attemptId, "101");

  // Case 1: Late paid transaction arrives while lookup is fetching unpaid try 101 past expiry.
  clock = 1_800_000_000_000 + 2_200_000;
  let injected = false;
  onGetTx = () => {
    if (!injected) {
      injected = true;
      port.recordTransaction(payment.attemptId, "102");
    }
  };
  const first = await port.lookup(payment);
  assert.equal(first.outcome, "unknown", "mid-flight new transaction fails closed as unknown instead of expired-unpaid");
  onGetTx = null;
  const second = await port.lookup(payment);
  assert.equal(second.outcome, "paid");
  assert.equal(second.paymentId, "102");

  // Case 2: Concurrent tokenAt refresh while lookup fetches unpaid try 101 extends settlesAt -> unknown, not expired-unpaid.
  const attemptB = { ...payment, attemptId: "attempt-b" };
  const identityB = await buildAuthorizeNetInvoiceReference(siteId, attemptB.attemptId);
  const gatewayB = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => {
      if (body.getHostedPaymentPageRequest) return { messages: { resultCode: "Ok" }, token: "tok-b" };
      const id = body.getTransactionDetailsRequest.transId;
      await onGetTx?.(id);
      return { messages: { resultCode: "Ok" }, transaction: { transId: id, authAmount: "12.00", order: { invoiceNumber: identityB }, responseCode: 2, transactionStatus: "declined" } };
    } },
  });
  const portB = createAuthorizeNetPaymentPort({
    gateway: gatewayB, siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/return", cancelUrl: "https://store.example/cancel", payPageUrl,
    now: () => clock,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  clock = 1_800_000_000_000;
  await portB.ensureSession(attemptB);
  portB.recordTransaction(attemptB.attemptId, "101");
  clock = 1_800_000_000_000 + 1_900_000; // past expiresAt (1860) and initial settlesAt (1860+300? max(1860,900)+300=2160) -> test past 2160:
  clock = 1_800_000_000_000 + 2_200_000;
  onGetTx = () => {
    const rec = records.get(attemptB.attemptId);
    if (rec && rec.tokenAt === 1_800_000_000) {
      records.set(attemptB.attemptId, { ...rec, tokenAt: 1_800_000_000 + 1_800 });
    }
  };
  assert.equal((await portB.lookup(attemptB)).outcome, "unknown", "refreshed tokenAt settlesAt window prevents premature expired-unpaid");
});

test("concurrency guards: payPage redirects back and never renders a card form when a payment arrives mid-fetch or mid-mint", async () => {
  const { records, state, transactions, port } = harness();
  const { session } = await port.ensureSession(payment);
  transactions[101] = declinedTry;
  transactions[102] = paidTry;
  port.recordTransaction(payment.attemptId, "101");

  // Case 1: New transaction arrives while payPage is fetching unpaid try 101 -> redirect back, never post.
  const origLookup = await port.lookup(payment);
  assert.equal(origLookup.outcome, "open");
  let once = false;
  const gwWait = createAuthorizeNetGateway({
    ...credentials,
    transport: { request: async body => {
      if (body.getHostedPaymentPageRequest) {
        if (!once && body.getHostedPaymentPageRequest.refId.endsWith("att-mint")) {
          once = true;
          portMint.recordTransaction("att-mint", "102");
        }
        return { messages: { resultCode: "Ok" }, token: "tok-fresh" };
      }
      if (!once) {
        once = true;
        portFetch.recordTransaction(payment.attemptId, "102");
      }
      return { messages: { resultCode: "Ok" }, transaction: {
        transId: body.getTransactionDetailsRequest.transId, authAmount: "12.00",
        order: { invoiceNumber: await buildAuthorizeNetInvoiceReference(siteId, payment.attemptId) }, ...declinedTry,
      } };
    } },
  });
  const portFetch = createAuthorizeNetPaymentPort({
    gateway: gwWait, siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout", payPageUrl,
    now: () => state.clock,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  assert.deepEqual(await portFetch.payPage(session.sessionId), {
    action: "redirect",
    url: "https://store.example/checkout/success",
  });

  // Case 2: New transaction arrives while payPage is minting a fresh token after 15 minutes -> redirect back, never post.
  const attemptMint = { ...payment, attemptId: "att-mint" };
  let mintClock = 1_800_000_000_000;
  let mintGatewayCalls = 0;
  const portMint = createAuthorizeNetPaymentPort({
    gateway: createAuthorizeNetGateway({
      ...credentials,
      transport: { request: async body => {
        mintGatewayCalls += 1;
        if (body.getHostedPaymentPageRequest) {
          if (mintGatewayCalls === 2) {
            // Second mint happens inside payPage after 900s: webhook arrives mid-mint!
            portMint.recordTransaction("att-mint", "102");
          }
          return { messages: { resultCode: "Ok" }, token: `tok-mint-${mintGatewayCalls}` };
        }
        return { messages: { resultCode: "Ok" }, transaction: { transId: "102", authAmount: "12.00", order: { invoiceNumber: await buildAuthorizeNetInvoiceReference(siteId, "att-mint") }, ...paidTry } };
      } },
    }),
    siteId, hostedUrl: AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout", payPageUrl,
    now: () => mintClock,
    store: { transaction: fn => fn({
      read: id => structuredClone(records.get(id) ?? null),
      write: (id, value) => records.set(id, structuredClone(value)),
    }) },
  });
  const openedMint = await portMint.ensureSession(attemptMint);
  mintClock += 900_000;
  assert.deepEqual(await portMint.payPage(openedMint.session.sessionId), {
    action: "redirect",
    url: "https://store.example/checkout/success",
  });
});

test("concurrency guards: recordTransaction evicts resolved tries before dropping an unread try", async () => {
  const { records, transactions, port } = harness();
  await port.ensureSession(payment);
  transactions[101] = paidTry;
  port.recordTransaction(payment.attemptId, "101");
  assert.equal((await port.lookup(payment)).paymentId, "101");

  // Record unread paid try "999" FIRST (index 0) and 19 declined tries "201".."219" behind it.
  // Make "999" throw transiently on the first recheck so "999" stays open/unread at index 0
  // while "201".."219" settle; then record "220" (21st entry -> cap eviction).
  // FIFO would evict index 0 ("999"), whereas resolved-first evicts settled "201" and keeps "999".
  port.recordTransaction(payment.attemptId, "999");
  for (let id = 201; id <= 219; id++) {
    transactions[id] = declinedTry;
    port.recordTransaction(payment.attemptId, String(id));
  }
  assert.equal(await port.recheck(payment.attemptId), false);
  transactions[999] = paidTry;
  transactions[220] = declinedTry;
  port.recordTransaction(payment.attemptId, "220");

  const stored = records.get(payment.attemptId);
  assert.equal(stored.transactionIds.length, 20);
  assert.equal(stored.transactionIds[0], "999", "index-0 unread try 999 is preserved");
  assert.equal(stored.transactionIds.includes("201"), false, "oldest settled try 201 is evicted first");
  assert.equal(await port.recheck(payment.attemptId), true);
  assert.deepEqual(records.get(payment.attemptId).alsoPaid, ["999"]);
});
