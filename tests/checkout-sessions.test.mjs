import assert from "node:assert/strict";
import test from "node:test";
import { CREATION_RETRY_WINDOW_MS, createCheckoutSessionService } from "../src/checkout/sessions.ts";
import { createConnectionService } from "../src/hosted/connection.ts";
import { createHostedHandler } from "../src/hosted/http.ts";

const owner = { accountId: "issuer:merchant-a", siteId: "store-a" };
const successUrl = "https://store.example.invalid/checkout/return";
const cancelUrl = "https://store.example.invalid/checkout/cancel";

function request(overrides = {}) {
  return {
    attemptId: "attempt-one",
    bindingRef: "stripe_binding-one",
    lines: [{ catalogItemId: "sku-1", quantity: 2, name: "Hat", unitPrice: { currency: "USD", minor: "600" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
    ...overrides,
  };
}

function fixture() {
  let connection = null, time = 1_800_000_000_000, ready = true, down = false, createDown = false;
  const attempts = new Map();
  const sessions = new Map();
  const calls = [];
  const store = { transaction: fn => fn({ read: () => structuredClone(connection), write: value => { connection = structuredClone(value); } }) };
  const attemptStore = { transaction: fn => fn({
    read: id => structuredClone(attempts.get(id) ?? null),
    write: value => { attempts.set(value.attemptId, structuredClone(value)); },
  }) };
  const onboarding = {
    async createAccount() { return "acct_one"; },
    async accountStatus(id) { if (down) throw Error("offline"); return { id, ready, actionRequired: !ready }; },
    async createLink() { return { url: "https://connect.stripe.com/setup/test", expiresAt: time + 60000 }; },
  };
  const connectionService = () => createConnectionService({ store, provider: onboarding, mode: "test", now: () => time, newId: () => "binding-one" });
  const provider = {
    async createSession(input) {
      calls.push(["create", structuredClone(input)]);
      if (createDown) throw Error("offline");
      if (sessions.has(input.idempotencyKey)) return structuredClone(sessions.get(input.idempotencyKey));
      const created = {
        id: "cs_one",
        url: "https://checkout.stripe.com/c/pay/cs_one",
        status: "open",
        paymentStatus: "unpaid",
        amountTotal: Number(input.total.minor),
        currency: "usd",
        created: input.expiresAtSeconds - 1800,
        expiresAt: input.expiresAtSeconds,
        livemode: false,
        paymentIntentId: null,
        metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
        paymentMethodTypes: ["card"],
      };
      sessions.set(input.idempotencyKey, created);
      return structuredClone(created);
    },
    async retrieveSession(id) {
      calls.push(["retrieve", id]);
      const found = [...sessions.values()].find(session => session.id === id) ?? [...sessions.values()][0];
      if (!found) throw Error("missing");
      return structuredClone(found);
    },
    async retrievePaymentIntent(id) {
      calls.push(["pi", id]);
      return { id, status: "canceled", amount: 1200, currency: "usd", latestCharge: { state: "absent" } };
    },
  };
  const checkout = () => createCheckoutSessionService({
    store: attemptStore,
    readyBinding: (principal, ref) => connectionService().checkoutBinding(principal, ref),
    existingBinding: async (principal, ref) => connectionService().existingBinding(principal, ref),
    provider, mode: "test", successUrl, cancelUrl, now: () => time,
  });
  return {
    connectionService, checkout, provider, calls, sessions, attempts,
    setReady: value => { ready = value; },
    setDown: value => { down = value; },
    setCreateDown: value => { createDown = value; },
    advance: ms => { time += ms; },
    time: () => time,
    async ready() {
      await connectionService().connect(owner);
      ready = true;
    },
  };
}

test("lost creation response recovers the original session and window", async () => {
  const f = await (async () => { const x = fixture(); await x.ready(); return x; })();
  const first = f.provider.createSession;
  f.provider.createSession = async input => { await first(input); throw Error("lost"); };
  assert.equal((await f.checkout().ensureSessionFor(owner, request())).outcome, "unknown");
  assert.equal(f.attempts.get("attempt-one").stripeSessionId, null);
  f.provider.createSession = first;
  const recovered = await f.checkout().ensureSessionFor(owner, request());
  assert.equal(recovered.outcome, "open");
  assert.equal(recovered.session.sessionId, "cs_one");
  assert.equal(recovered.session.redirectUrl, "https://checkout.stripe.com/c/pay/cs_one");
  assert.equal(recovered.session.expiresAt, recovered.session.createdAt + 1800);
  assert.equal(f.calls.filter(call => call[0] === "create").length, 2);
  assert.equal(f.calls[0][1].idempotencyKey, "dinkus-checkout:attempt-one");
  assert.equal(f.calls[0][1].expiresAtSeconds, recovered.session.expiresAt);
});

test("an aged unknown create does not mint a second session after Stripe key retention", async () => {
  const f = fixture(); await f.ready(); f.setCreateDown(true);
  assert.equal((await f.checkout().ensureSessionFor(owner, request())).outcome, "unknown");
  f.advance(CREATION_RETRY_WINDOW_MS); f.setCreateDown(false);
  assert.equal((await f.checkout().ensureSessionFor(owner, request())).outcome, "unknown");
  assert.equal(f.calls.filter(call => call[0] === "create").length, 1);
  assert.equal(f.attempts.get("attempt-one").stripeSessionId, null);
});

test("lookup never creates and absence is unknown, not a terminal fence", async () => {
  const f = fixture(); await f.ready();
  assert.deepEqual(await f.checkout().lookupFor(owner, request()), { outcome: "unknown" });
  assert.equal(f.calls.length, 0);
  f.setCreateDown(true);
  assert.equal((await f.checkout().ensureSessionFor(owner, request())).outcome, "unknown");
  assert.equal((await f.checkout().lookupFor(owner, request())).outcome, "unknown");
  assert.equal(f.calls.filter(call => call[0] === "create").length, 1);
  assert.equal(f.calls.filter(call => call[0] === "retrieve").length, 0);
});

test("readiness regression still serves an existing mapping", async () => {
  const f = fixture(); await f.ready();
  const created = await f.checkout().ensureSessionFor(owner, request());
  f.setReady(false);
  assert.equal(await f.connectionService().checkoutBinding(owner, "stripe_binding-one"), null);
  const looked = await f.checkout().lookupFor(owner, request());
  assert.equal(looked.outcome, "open");
  assert.deepEqual(looked.session, created.session);
});

test("immutable request mutation is rejected", async () => {
  const f = fixture(); await f.ready();
  await f.checkout().ensureSessionFor(owner, request());
  await assert.rejects(f.checkout().ensureSessionFor(owner, request({ total: { currency: "USD", minor: "1300" }, lines: [{ ...request().lines[0], unitPrice: { currency: "USD", minor: "650" } }] })), /request_mutation/);
  await assert.rejects(f.checkout().lookupFor(owner, request({ bindingRef: "stripe_other" })), /binding_mismatch|request_mutation/);
});

test("wrong account amount currency and mode fail closed", async () => {
  const f = fixture(); await f.ready();
  await f.checkout().ensureSessionFor(owner, request());
  const mapped = f.sessions.get("dinkus-checkout:attempt-one");
  mapped.amountTotal = 9999;
  await assert.rejects(f.checkout().lookupFor(owner, request()), /amount_mismatch/);
  mapped.amountTotal = 1200; mapped.currency = "eur";
  await assert.rejects(f.checkout().lookupFor(owner, request()), /currency_mismatch/);
  mapped.currency = "usd"; mapped.livemode = true;
  await assert.rejects(f.checkout().lookupFor(owner, request()), /mode_mismatch/);
  mapped.livemode = false; mapped.id = "cs_other";
  await assert.rejects(f.checkout().lookupFor(owner, request()), /session_mismatch/);
});

test("expired unpaid without a canceled PaymentIntent stays unknown", async () => {
  const f = fixture(); await f.ready();
  await f.checkout().ensureSessionFor(owner, request());
  const mapped = f.sessions.get("dinkus-checkout:attempt-one");
  mapped.status = "expired"; mapped.paymentStatus = "unpaid"; mapped.url = null;
  mapped.paymentIntentId = "pi_open";
  f.provider.retrievePaymentIntent = async id => ({ id, status: "processing", amount: 1200, currency: "usd", latestCharge: { state: "absent" } });
  assert.equal((await f.checkout().lookupFor(owner, request())).outcome, "unknown");
  mapped.paymentIntentId = null;
  assert.equal((await f.checkout().lookupFor(owner, request())).outcome, "unknown");
  mapped.paymentIntentId = "pi_canceled";
  f.provider.retrievePaymentIntent = async id => ({ id, status: "canceled", amount: 1200, currency: "usd", latestCharge: { state: "absent" } });
  const expired = await f.checkout().lookupFor(owner, request());
  assert.equal(expired.outcome, "expired-unpaid");
  assert.equal(expired.session.redirectUrl, "https://checkout.stripe.com/c/pay/cs_one");
  assert.equal(expired.session.expiresAt, expired.session.createdAt + 1800);
});

test("paid requires a succeeded PaymentIntent and keeps the original session fields", async () => {
  const f = fixture(); await f.ready();
  const created = await f.checkout().ensureSessionFor(owner, request());
  const mapped = f.sessions.get("dinkus-checkout:attempt-one");
  mapped.status = "complete"; mapped.paymentStatus = "paid"; mapped.url = null; mapped.paymentIntentId = "pi_paid";
  f.provider.retrievePaymentIntent = async id => ({ id, status: "succeeded", amount: 1200, currency: "usd", latestCharge: { state: "known", status: "succeeded" } });
  const paid = await f.checkout().lookupFor(owner, request());
  assert.equal(paid.outcome, "paid");
  assert.equal(paid.paymentId, "pi_paid");
  assert.deepEqual(paid.session, created.session);
  mapped.paymentStatus = "paid";
  f.provider.retrievePaymentIntent = async id => ({ id, status: "processing", amount: 1200, currency: "usd", latestCharge: { state: "absent" } });
  assert.equal((await f.checkout().lookupFor(owner, request())).outcome, "unknown");
});

test("concurrent ensureSession writers share one durable claim", async () => {
  const f = fixture(); await f.ready();
  const [a, b] = await Promise.all([f.checkout().ensureSessionFor(owner, request()), f.checkout().ensureSessionFor(owner, request())]);
  assert.equal(a.session.sessionId, b.session.sessionId);
  assert.equal(new Set(f.calls.filter(call => call[0] === "create").map(call => call[1].idempotencyKey)).size, 1);
});

test("new checkout without readiness stays unknown and never contacts Stripe", async () => {
  const f = fixture(); await f.connectionService().connect(owner); f.setReady(false);
  assert.deepEqual(await f.checkout().ensureSessionFor(owner, request()), { outcome: "unknown" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.attempts.size, 0);
});

test("lookup absence then ensureSession cannot invent a terminal not-created fence", async () => {
  const f = fixture(); await f.ready();
  let releaseReady;
  const held = new Promise(resolve => { releaseReady = resolve; });
  const originalReady = (principal, ref) => f.connectionService().checkoutBinding(principal, ref);
  const service = createCheckoutSessionService({
    store: { transaction: fn => fn({
      read: id => structuredClone(f.attempts.get(id) ?? null),
      write: value => { f.attempts.set(value.attemptId, structuredClone(value)); },
    }) },
    readyBinding: async (principal, ref) => { await held; return originalReady(principal, ref); },
    existingBinding: (principal, ref) => f.connectionService().existingBinding(principal, ref),
    provider: f.provider, mode: "test", successUrl, cancelUrl, now: () => f.time(),
  });
  const lookupDuringReady = service.lookupFor(owner, request());
  const ensureDuringReady = service.ensureSessionFor(owner, request());
  assert.deepEqual(await lookupDuringReady, { outcome: "unknown" });
  assert.equal(f.attempts.size, 0);
  assert.equal(f.calls.length, 0);
  releaseReady();
  const created = await ensureDuringReady;
  assert.equal(created.outcome, "open");
  assert.equal((await service.lookupFor(owner, request())).outcome, "open");
  assert.notEqual(created.outcome, "not-created");
});

test("provider created and expires_at are authoritative and an inconsistent window stays unknown", async () => {
  const f = fixture(); await f.ready();
  const firstCreate = f.provider.createSession;
  f.provider.createSession = async input => {
    const session = await firstCreate(input);
    session.created = input.expiresAtSeconds - 1798;
    f.sessions.get(input.idempotencyKey).created = session.created;
    return session;
  };
  const created = await f.checkout().ensureSessionFor(owner, request());
  assert.equal(created.outcome, "unknown");
  assert.equal(created.session, undefined);
  assert.equal(f.attempts.get("attempt-one").stripeSessionId, "cs_one");
  assert.equal(f.attempts.get("attempt-one").redirectUrl, "https://checkout.stripe.com/c/pay/cs_one");
  assert.equal(f.attempts.get("attempt-one").providerCreatedAtSeconds, f.attempts.get("attempt-one").requestedExpiresAtSeconds - 1798);
  assert.equal((await f.checkout().lookupFor(owner, request())).outcome, "unknown");
  assert.equal(f.calls.filter(call => call[0] === "create").length, 1);
  const mapped = f.sessions.get("dinkus-checkout:attempt-one");
  mapped.created += 1;
  await assert.rejects(f.checkout().lookupFor(owner, request()), /window_mismatch/);
});

test("exact provider window is returned and later reads must agree", async () => {
  const f = fixture(); await f.ready();
  const created = await f.checkout().ensureSessionFor(owner, request());
  assert.equal(created.outcome, "open");
  assert.equal(created.session.createdAt, created.session.expiresAt - 1800);
  assert.equal(created.session.createdAt, f.sessions.get("dinkus-checkout:attempt-one").created);
  assert.equal(created.session.expiresAt, f.sessions.get("dinkus-checkout:attempt-one").expiresAt);
  const looked = await f.checkout().lookupFor(owner, request());
  assert.deepEqual(looked.session, created.session);
});

test("documented Stripe session ID and hosted URL fragment survive reconciliation", async () => {
  const f = fixture(); await f.ready();
  const first = f.provider.createSession;
  f.provider.createSession = async input => {
    const session = await first(input);
    session.id = "cs_test_fixture123";
    session.url = "https://checkout.stripe.com/c/pay/cs_test_fixture123#fid_synthetic";
    f.sessions.set(input.idempotencyKey, structuredClone(session));
    return session;
  };
  const created = await f.checkout().ensureSessionFor(owner, request());
  assert.equal(created.outcome, "open");
  assert.equal(created.session.sessionId, "cs_test_fixture123");
  assert.equal(created.session.redirectUrl, "https://checkout.stripe.com/c/pay/cs_test_fixture123#fid_synthetic");
  assert.deepEqual((await f.checkout().lookupFor(owner, request())).session, created.session);
});

test("provider cannot shift the requested expiry while preserving a 30-minute pair", async () => {
  const f = fixture(); await f.ready();
  const first = f.provider.createSession;
  f.provider.createSession = async input => {
    const session = await first(input);
    session.created += 2; session.expiresAt += 2;
    f.sessions.set(input.idempotencyKey, structuredClone(session));
    return session;
  };
  await assert.rejects(f.checkout().ensureSessionFor(owner, request()), /window_mismatch/);
  assert.equal(f.attempts.get("attempt-one").stripeSessionId, "cs_one");
  await assert.rejects(f.checkout().lookupFor(owner, request()), /window_mismatch/);
  assert.equal(f.calls.filter(call => call[0] === "create").length, 1);
});

test("numeric line minor units fail before provider contact", async () => {
  const f = fixture(); await f.ready();
  const invalid = request(); invalid.lines[0].unitPrice.minor = 600;
  await assert.rejects(f.checkout().ensureSessionFor(owner, invalid), /invalid_amount/);
  assert.equal(f.calls.length, 0);
});

test("pending charge cannot establish terminal unpaid even with canceled intent", async () => {
  const f = fixture(); await f.ready();
  await f.checkout().ensureSessionFor(owner, request());
  const mapped = f.sessions.get("dinkus-checkout:attempt-one");
  mapped.status = "expired"; mapped.paymentStatus = "unpaid"; mapped.paymentIntentId = "pi_pending";
  f.provider.retrievePaymentIntent = async id => ({ id, status: "canceled", amount: 1200, currency: "usd", latestCharge: { state: "known", status: "pending" } });
  assert.equal((await f.checkout().lookupFor(owner, request())).outcome, "unknown");
});

test("malformed session id and credentialed or non-Stripe URLs fail closed after durable id persist", async () => {
  const f = fixture(); await f.ready();
  const first = f.provider.createSession;
  f.provider.createSession = async input => ({ ...(await first(input)), id: "not-a-session" });
  await assert.rejects(f.checkout().ensureSessionFor(owner, request()), /invalid_session_id/);
  assert.equal(f.attempts.get("attempt-one").stripeSessionId, null);
  f.provider.createSession = async input => ({ ...(await first(input)), url: "https://user:secret@checkout.stripe.com/c/pay/cs_one" });
  await assert.rejects(f.checkout().ensureSessionFor(owner, request()), /invalid_session_url/);
  assert.equal(f.attempts.get("attempt-one").stripeSessionId, "cs_one");
  f.provider.createSession = first;
  assert.equal((await f.checkout().ensureSessionFor(owner, request())).outcome, "open");
  assert.equal(f.calls.filter(call => call[0] === "create").length, 2);
  assert.equal(f.calls.filter(call => call[0] === "retrieve").length, 1);
  const other = fixture(); await other.ready();
  const otherFirst = other.provider.createSession;
  other.provider.createSession = async input => ({ ...(await otherFirst(input)), url: "https://checkout.stripe.com.attacker.invalid/c/pay/cs_one" });
  await assert.rejects(other.checkout().ensureSessionFor(owner, request()), /invalid_session_url/);
});

test("create transport params are detached before await and replayed from the record", async () => {
  const f = fixture(); await f.ready();
  const mutable = request();
  let releaseReady;
  const held = new Promise(resolve => { releaseReady = resolve; });
  const config = { successUrl, cancelUrl };
  const service = createCheckoutSessionService({
    store: { transaction: fn => fn({
      read: id => structuredClone(f.attempts.get(id) ?? null),
      write: value => { f.attempts.set(value.attemptId, structuredClone(value)); },
    }) },
    readyBinding: async (principal, ref) => { await held; return f.connectionService().checkoutBinding(principal, ref); },
    existingBinding: (principal, ref) => f.connectionService().existingBinding(principal, ref),
    provider: f.provider, mode: "test",
    get successUrl() { return config.successUrl; },
    get cancelUrl() { return config.cancelUrl; },
    now: () => f.time(),
  });
  const pending = service.ensureSessionFor(owner, mutable);
  mutable.lines[0].name = "Mutated";
  mutable.total.minor = "9999";
  mutable.lines[0].unitPrice.minor = "9999";
  config.successUrl = "https://attacker.example.invalid/return";
  config.cancelUrl = "https://attacker.example.invalid/cancel";
  releaseReady();
  const created = await pending;
  assert.equal(created.outcome, "open");
  assert.deepEqual(f.calls[0][1].lines[0].name, "Hat");
  assert.equal(f.calls[0][1].total.minor, "1200");
  assert.equal(f.calls[0][1].successUrl, successUrl);
  assert.equal(f.calls[0][1].cancelUrl, cancelUrl);
  const restarted = createCheckoutSessionService({
    store: { transaction: fn => fn({
      read: id => structuredClone(f.attempts.get(id) ?? null),
      write: value => { f.attempts.set(value.attemptId, structuredClone(value)); },
    }) },
    readyBinding: (principal, ref) => f.connectionService().checkoutBinding(principal, ref),
    existingBinding: (principal, ref) => f.connectionService().existingBinding(principal, ref),
    provider: f.provider, mode: "test",
    successUrl: "https://other.example.invalid/return",
    cancelUrl: "https://other.example.invalid/cancel",
    now: () => f.time(),
  });
  f.attempts.get("attempt-one").stripeSessionId = null;
  f.attempts.get("attempt-one").redirectUrl = null;
  f.attempts.get("attempt-one").providerCreatedAtSeconds = null;
  f.attempts.get("attempt-one").providerExpiresAtSeconds = null;
  const replayed = await restarted.ensureSessionFor(owner, request());
  assert.equal(replayed.outcome, "open");
  assert.equal(f.calls[1][1].successUrl, successUrl);
  assert.equal(f.calls[1][1].siteId, owner.siteId);
  assert.equal(f.calls[1][1].stripeAccountId, "acct_one");
  assert.equal(f.calls[1][1].expiresAtSeconds, f.attempts.get("attempt-one").requestedExpiresAtSeconds);
});

test("fingerprint compares canonical values and preserves Commerce line order", async () => {
  const f = fixture(); await f.ready();
  await f.checkout().ensureSessionFor(owner, request());
  const reorderedProps = {
    paymentMethods: ["card"],
    paymentWindowSeconds: 1800,
    total: { minor: "1200", currency: "USD" },
    lines: [{ unitPrice: { minor: "600", currency: "USD" }, name: "Hat", quantity: 2, catalogItemId: "sku-1" }],
    bindingRef: "stripe_binding-one",
    attemptId: "attempt-one",
  };
  assert.equal((await f.checkout().lookupFor(owner, reorderedProps)).outcome, "open");
  await assert.rejects(f.checkout().lookupFor(owner, request({
    lines: [
      { catalogItemId: "sku-2", quantity: 1, name: "Cap", unitPrice: { currency: "USD", minor: "1200" } },
      { catalogItemId: "sku-1", quantity: 2, name: "Hat", unitPrice: { currency: "USD", minor: "600" } },
    ],
    total: { currency: "USD", minor: "2400" },
  })), /request_mutation/);
});

test("unexpanded latest charge cannot prove expired-unpaid", async () => {
  const f = fixture(); await f.ready();
  await f.checkout().ensureSessionFor(owner, request());
  const mapped = f.sessions.get("dinkus-checkout:attempt-one");
  mapped.status = "expired"; mapped.paymentStatus = "unpaid"; mapped.url = null;
  mapped.paymentIntentId = "pi_canceled";
  f.provider.retrievePaymentIntent = async id => ({ id, status: "canceled", amount: 1200, currency: "usd", latestCharge: { state: "unknown" } });
  assert.equal((await f.checkout().lookupFor(owner, request())).outcome, "unknown");
  f.provider.retrievePaymentIntent = async id => ({ id, status: "canceled", amount: 1200, currency: "usd", latestCharge: { state: "known", status: "succeeded" } });
  assert.equal((await f.checkout().lookupFor(owner, request())).outcome, "unknown");
  f.provider.retrievePaymentIntent = async id => ({ id, status: "canceled", amount: 1200, currency: "usd", latestCharge: { state: "known", status: "failed" } });
  assert.equal((await f.checkout().lookupFor(owner, request())).outcome, "expired-unpaid");
});

test("HTTP existing-binding bypasses readiness while checkout-binding does not", async () => {
  const f = fixture(); await f.ready(); f.setReady(false);
  const handle = createHostedHandler({
    authenticate: async (req, scope) => {
      if (req.headers.get("authorization") !== "Bearer synthetic") throw Error("unauthorized");
      if (scope !== "payments:checkout") throw Error("unauthorized");
      return owner;
    },
    service: () => f.connectionService(),
  });
  const headers = { authorization: "Bearer synthetic" };
  assert.equal((await handle(new Request("https://service.invalid/v1/checkout-binding?bindingRef=stripe_binding-one", { headers }))).status, 409);
  const existing = await handle(new Request("https://service.invalid/v1/existing-binding?bindingRef=stripe_binding-one", { headers }));
  assert.equal(existing.status, 200);
  assert.deepEqual(await existing.json(), { bindingRef: "stripe_binding-one", stripeAccountId: "acct_one", mode: "test", providerId: "stripe" });
});
