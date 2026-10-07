import assert from "node:assert/strict";
import test from "node:test";
import { CREATION_RETRY_WINDOW_MS, createCheckoutSessionService, requestFingerprint } from "../src/checkout/sessions.ts";
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
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
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
        created: input.expiresAtSeconds - 1860,
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
  assert.equal(recovered.session.expiresAt, recovered.session.createdAt + 1860);
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
  assert.equal(expired.session.expiresAt, expired.session.createdAt + 1860);
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
  assert.equal(created.session.createdAt, created.session.expiresAt - 1860);
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
  mapped.status = "expired"; mapped.paymentStatus = "unpaid"; mapped.url = null;
  mapped.paymentIntentId = "pi_pending";
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
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
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

function makeSyntheticProvider(initialEpoch = 1_800_000_000) {
  let providerEpoch = initialEpoch;
  let operations = 0;
  const cache = new Map();
  const calls = [];
  return {
    calls,
    get operations() { return operations; },
    getEpoch() { return providerEpoch; },
    setEpoch(epoch) { providerEpoch = epoch; },
    advance(seconds) { providerEpoch += seconds; },
    async createSession(input) {
      calls.push(["create", structuredClone(input)]);
      const cached = cache.get(input.idempotencyKey);
      if (cached) {
        if (cached.body !== JSON.stringify(input)) throw Error("synthetic_parameter_mismatch");
        return structuredClone(cached.session);
      }
      const remaining = input.expiresAtSeconds - providerEpoch;
      if (remaining < 1800 || remaining > 86400) {
        throw Error(`synthetic_invalid_expiry: remaining ${remaining}`);
      }
      operations++;
      const session = {
        id: `cs_test_${input.attemptId.replace(/[^A-Za-z0-9]/g, "")}`,
        url: `https://checkout.stripe.com/c/pay/cs_${input.attemptId}`,
        status: "open",
        paymentStatus: "unpaid",
        amountTotal: Number(input.total.minor),
        currency: "usd",
        created: providerEpoch,
        expiresAt: input.expiresAtSeconds,
        livemode: false,
        paymentIntentId: null,
        metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
        paymentMethodTypes: ["card"],
      };
      cache.set(input.idempotencyKey, { body: JSON.stringify(input), session });
      return structuredClone(session);
    },
    async retrieveSession(id) {
      calls.push(["retrieve", id]);
      const found = [...cache.values()].find(c => c.session.id === id)?.session;
      if (!found) throw Error("missing");
      return structuredClone(found);
    },
    async retrievePaymentIntent(id) {
      calls.push(["pi", id]);
      return { id, status: "canceled", amount: 1200, currency: "usd", latestCharge: { state: "absent" } };
    },
  };
}

test("independent provider clock delays 0/1/10/30/59/60 inclusive are valid and 61 is invalid", async () => {
  const delays = [
    { delay: 0, expectedDuration: 1860 },
    { delay: 1, expectedDuration: 1859 },
    { delay: 10, expectedDuration: 1850 },
    { delay: 30, expectedDuration: 1830 },
    { delay: 59, expectedDuration: 1801 },
    { delay: 60, expectedDuration: 1800 },
  ];

  for (const { delay, expectedDuration } of delays) {
    const f = fixture(); await f.ready();
    const providerEpoch = 1_800_000_000 + delay;
    const synth = makeSyntheticProvider(providerEpoch);
    f.provider.createSession = synth.createSession;
    f.provider.retrieveSession = synth.retrieveSession;

    const req = request({ attemptId: `attempt-delay-${delay}` });
    const res = await f.checkout().ensureSessionFor(owner, req);
    assert.equal(res.outcome, "open");
    assert.equal(res.session.createdAt, providerEpoch);
    assert.equal(res.session.expiresAt - res.session.createdAt, expectedDuration);
    assert.equal(synth.operations, 1);

    const looked = await f.checkout().lookupFor(owner, req);
    assert.equal(looked.outcome, "open");
    assert.deepEqual(looked.session, res.session);
  }

  // Delay 61 yields unknown, unmapped claim, zero successful operations; later retry unchanged tuple/key/deadline and still unknown
  {
    const f61 = fixture(); await f61.ready();
    const providerEpoch61 = 1_800_000_000 + 61;
    const synth61 = makeSyntheticProvider(providerEpoch61);
    f61.provider.createSession = synth61.createSession;
    f61.provider.retrieveSession = synth61.retrieveSession;

    const req61 = request({ attemptId: "attempt-delay-61" });
    const res61 = await f61.checkout().ensureSessionFor(owner, req61);
    assert.equal(res61.outcome, "unknown");
    assert.equal(synth61.operations, 0);

    // unmapped claim
    const record61 = f61.attempts.get(req61.attemptId);
    assert.ok(record61);
    assert.equal(record61.stripeSessionId, null);
    assert.equal(record61.redirectUrl, null);
    assert.equal(record61.providerCreatedAtSeconds, null);
    assert.equal(record61.providerExpiresAtSeconds, null);

    // later retry unchanged tuple/key/deadline and still unknown
    f61.advance(10_000);
    synth61.advance(10);
    const retry61 = await f61.checkout().ensureSessionFor(owner, req61);
    assert.equal(retry61.outcome, "unknown");
    assert.equal(synth61.operations, 0);
    assert.equal((await f61.checkout().lookupFor(owner, req61)).outcome, "unknown");
    assert.equal(f61.attempts.get(req61.attemptId).stripeSessionId, null);
    assert.equal(f61.attempts.get(req61.attemptId).requestedExpiresAtSeconds, 1_800_001_860);
  }
});

test("delayed lost-response at provider+1 then retry+180 recovers cached session with remaining 1680", async () => {
  const f = fixture(); await f.ready();
  const synth = makeSyntheticProvider(1_800_000_000 + 1); // provider+1
  let shouldDropResponse = true;

  f.provider.createSession = async input => {
    const session = await synth.createSession(input);
    if (shouldDropResponse) {
      shouldDropResponse = false;
      throw Error("lost_response_after_execution");
    }
    return session;
  };
  f.provider.retrieveSession = synth.retrieveSession;

  const req = request({ attemptId: "attempt-delayed-lost" });
  const firstRes = await f.checkout().ensureSessionFor(owner, req);
  assert.equal(firstRes.outcome, "unknown");
  assert.equal(synth.operations, 1);
  const initialRecord = f.attempts.get(req.attemptId);
  assert.equal(initialRecord.stripeSessionId, null);
  assert.equal(initialRecord.requestedExpiresAtSeconds, 1_800_001_860);

  // retry at +180: Payments client advances 180s, provider clock advances 180s
  // new-create remaining would be 1800001860 - 1800000180 = 1680 < 1800
  // But cached result replay happens before validating remaining
  f.advance(180_000);
  synth.setEpoch(1_800_000_000 + 180);
  const retryRes = await f.checkout().ensureSessionFor(owner, req);
  assert.equal(retryRes.outcome, "open");
  assert.equal(synth.operations, 1); // exactly one successful operation
  assert.equal(retryRes.session.createdAt, 1_800_000_001); // original provider timestamp unchanged
  assert.equal(retryRes.session.expiresAt, 1_800_001_860); // original deadline unchanged
  assert.equal(retryRes.session.sessionId, "cs_test_attemptdelayedlost");

  const finalRecord = f.attempts.get(req.attemptId);
  assert.equal(finalRecord.stripeAccountId, "acct_one"); // account unchanged
  assert.equal(finalRecord.idempotencyKey, "dinkus-checkout:attempt-delayed-lost"); // key unchanged
  assert.equal(finalRecord.requestedExpiresAtSeconds, 1_800_001_860); // params/deadline unchanged
  assert.equal(finalRecord.providerCreatedAtSeconds, 1_800_000_001);
  assert.equal(finalRecord.providerExpiresAtSeconds, 1_800_001_860);

  const looked = await f.checkout().lookupFor(owner, req);
  assert.equal(looked.outcome, "open");
  assert.deepEqual(looked.session, retryRes.session);
});

test("separate upper duration 1861 returned-time defense uses independent clock base-1 and stays unknown", async () => {
  const f = fixture(); await f.ready();
  const providerEpoch = 1_800_000_000 - 1; // base - 1
  f.provider.createSession = async input => {
    const created = {
      id: "cs_test_skew1861",
      url: "https://checkout.stripe.com/c/pay/cs_test_skew1861",
      status: "open",
      paymentStatus: "unpaid",
      amountTotal: 1200,
      currency: "usd",
      created: providerEpoch, // independent variable, 1799999999
      expiresAt: input.expiresAtSeconds, // 1800001860, duration = 1861
      livemode: false,
      paymentIntentId: null,
      metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
      paymentMethodTypes: ["card"],
    };
    f.sessions.set(input.idempotencyKey, created);
    return structuredClone(created);
  };
  const req = request({ attemptId: "attempt-skew-1861" });
  const res = await f.checkout().ensureSessionFor(owner, req);
  assert.equal(res.outcome, "unknown");
  assert.equal((await f.checkout().lookupFor(owner, req)).outcome, "unknown");
  assert.equal(f.attempts.get(req.attemptId).stripeSessionId, "cs_test_skew1861");
});

test("provider returned duration 1799 defense stays unknown", async () => {
  const f = fixture(); await f.ready();
  const providerEpoch = 1_800_000_000 + 61; // duration = 1860 - 61 = 1799
  f.provider.createSession = async input => {
    const created = {
      id: "cs_test_submin1799",
      url: "https://checkout.stripe.com/c/pay/cs_test_submin1799",
      status: "open",
      paymentStatus: "unpaid",
      amountTotal: 1200,
      currency: "usd",
      created: providerEpoch,
      expiresAt: input.expiresAtSeconds,
      livemode: false,
      paymentIntentId: null,
      metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
      paymentMethodTypes: ["card"],
    };
    f.sessions.set(input.idempotencyKey, created);
    return structuredClone(created);
  };
  const req = request({ attemptId: "attempt-submin-1799" });
  const res = await f.checkout().ensureSessionFor(owner, req);
  assert.equal(res.outcome, "unknown");
  assert.equal((await f.checkout().lookupFor(owner, req)).outcome, "unknown");
});

test("exact requested expiry drift is rejected even within duration bounds", async () => {
  const f = fixture(); await f.ready();
  f.provider.createSession = async input => ({
    id: "cs_test_drift",
    url: "https://checkout.stripe.com/c/pay/cs_test_drift",
    status: "open",
    paymentStatus: "unpaid",
    amountTotal: 1200,
    currency: "usd",
    created: input.expiresAtSeconds - 1860,
    expiresAt: input.expiresAtSeconds + 5,
    livemode: false,
    paymentIntentId: null,
    metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
    paymentMethodTypes: ["card"],
  });
  await assert.rejects(f.checkout().ensureSessionFor(owner, request()), /window_mismatch/);
});

test("missing, noninteger, or unsafe provider timestamps fail closed", async () => {
  for (const bad of [
    { created: null, expiresAt: 1800001860 },
    { created: "1800000000", expiresAt: 1800001860 },
    { created: 1800000000.5, expiresAt: 1800001860 },
    { created: Number.MAX_SAFE_INTEGER + 100, expiresAt: 1800001860 },
    { created: 1800000000, expiresAt: null },
    { created: 1800000000, expiresAt: 1800001860.7 },
  ]) {
    const f = fixture(); await f.ready();
    f.provider.createSession = async input => ({
      id: "cs_test_badts",
      url: "https://checkout.stripe.com/c/pay/cs_test_badts",
      status: "open",
      paymentStatus: "unpaid",
      amountTotal: 1200,
      currency: "usd",
      ...bad,
      livemode: false,
      paymentIntentId: null,
      metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
      paymentMethodTypes: ["card"],
    });
    await assert.rejects(f.checkout().ensureSessionFor(owner, request()), /window_mismatch/);
  }
});

test("unclaimed legacy request conservatively remains unknown with no provider contact", async () => {
  const f = fixture(); await f.ready();
  const legacy = {
    attemptId: "attempt-unclaimed-legacy",
    bindingRef: "stripe_binding-one",
    lines: [{ catalogItemId: "sku-1", quantity: 2, name: "Hat", unitPrice: { currency: "USD", minor: "600" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
  };
  const result = await f.checkout().ensureSessionFor(owner, legacy);
  assert.equal(result.outcome, "unknown");
  assert.equal(f.calls.filter(c => c[0] === "create").length, 0);
  assert.equal(f.attempts.has("attempt-unclaimed-legacy"), false);
});

test("assert legacy JSON fingerprint exact old byte ordering", () => {
  const legacyReq = {
    attemptId: "attempt-legacy-fp",
    bindingRef: "stripe_binding-one",
    lines: [{ catalogItemId: "sku-1", quantity: 2, name: "Hat", unitPrice: { currency: "USD", minor: "600" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
  };
  const expectedOrdering = JSON.stringify({
    attemptId: "attempt-legacy-fp",
    bindingRef: "stripe_binding-one",
    lines: [{ catalogItemId: "sku-1", quantity: 2, name: "Hat", unitPrice: { currency: "USD", minor: "600" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
  });
  assert.equal(requestFingerprint(legacyReq), expectedOrdering);
});

test("two independently seeded historical cases accept exact 1800 and reject 1859 without reset", async () => {
  const f = fixture(); await f.ready();
  const claimBase = Math.floor(f.time() / 1000);

  // Case 1: Seeded historical legacy claim with exact 1800
  const req1800 = {
    attemptId: "attempt-legacy-case-1800",
    bindingRef: "stripe_binding-one",
    lines: [{ catalogItemId: "sku-1", quantity: 1, name: "Hat", unitPrice: { currency: "USD", minor: "1200" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
  };
  const fp1800 = requestFingerprint(req1800);
  const deadline1800 = claimBase + 1800;
  const key1800 = "dinkus-checkout:attempt-legacy-case-1800";

  f.attempts.set(req1800.attemptId, {
    attemptId: req1800.attemptId,
    bindingRef: req1800.bindingRef,
    stripeAccountId: "acct_one",
    mode: "test",
    siteId: owner.siteId,
    requestFingerprint: fp1800,
    lines: req1800.lines,
    amountMinor: "1200",
    currency: "USD",
    claimedAtMs: f.time(),
    requestedExpiresAtSeconds: deadline1800,
    providerCreatedAtSeconds: null,
    providerExpiresAtSeconds: null,
    idempotencyKey: key1800,
    successUrl,
    cancelUrl,
    stripeSessionId: null,
    redirectUrl: null,
    // policyKind is deliberately absent
  });

  // Case 2: Independently seeded historical legacy claim for 1859
  const req1859 = {
    attemptId: "attempt-legacy-case-1859",
    bindingRef: "stripe_binding-one",
    lines: [{ catalogItemId: "sku-2", quantity: 1, name: "Cap", unitPrice: { currency: "USD", minor: "1200" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
  };
  const fp1859 = requestFingerprint(req1859);
  const deadline1859 = claimBase + 1800;
  const key1859 = "dinkus-checkout:attempt-legacy-case-1859";

  f.attempts.set(req1859.attemptId, {
    attemptId: req1859.attemptId,
    bindingRef: req1859.bindingRef,
    stripeAccountId: "acct_one",
    mode: "test",
    siteId: owner.siteId,
    requestFingerprint: fp1859,
    lines: req1859.lines,
    amountMinor: "1200",
    currency: "USD",
    claimedAtMs: f.time(),
    requestedExpiresAtSeconds: deadline1859,
    providerCreatedAtSeconds: null,
    providerExpiresAtSeconds: null,
    idempotencyKey: key1859,
    successUrl,
    cancelUrl,
    stripeSessionId: null,
    redirectUrl: null,
    // policyKind is deliberately absent
  });

  // Provider handler serving both without any store/mapping reset
  f.provider.createSession = async input => {
    const is1800 = input.attemptId === req1800.attemptId;
    const duration = is1800 ? 1800 : 1859;
    const session = {
      id: `cs_test_${input.attemptId.replace(/[^A-Za-z0-9]/g, "")}`,
      url: `https://checkout.stripe.com/c/pay/cs_${input.attemptId}`,
      status: "open",
      paymentStatus: "unpaid",
      amountTotal: 1200,
      currency: "usd",
      created: input.expiresAtSeconds - duration,
      expiresAt: input.expiresAtSeconds,
      livemode: false,
      paymentIntentId: null,
      metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
      paymentMethodTypes: ["card"],
    };
    f.sessions.set(input.idempotencyKey, session);
    return structuredClone(session);
  };

  // Case 1: exact 1800 accepts
  const res1800 = await f.checkout().ensureSessionFor(owner, req1800);
  assert.equal(res1800.outcome, "open");
  assert.equal(res1800.session.expiresAt - res1800.session.createdAt, 1800);

  // Original pinned deadline, key, fingerprint unchanged; policyKind absent stays absent
  const record1800 = f.attempts.get(req1800.attemptId);
  assert.equal(record1800.requestedExpiresAtSeconds, deadline1800);
  assert.equal(record1800.idempotencyKey, key1800);
  assert.equal(record1800.requestFingerprint, fp1800);
  assert.equal(record1800.policyKind, undefined);
  assert.equal("policyKind" in record1800, false);

  // Later ensure and lookup agree on same timestamp and session
  const looked1800 = await f.checkout().lookupFor(owner, req1800);
  assert.equal(looked1800.outcome, "open");
  assert.deepEqual(looked1800.session, res1800.session);

  const ensuredAgain1800 = await f.checkout().ensureSessionFor(owner, req1800);
  assert.equal(ensuredAgain1800.outcome, "open");
  assert.deepEqual(ensuredAgain1800.session, res1800.session);

  // Case 2: 1859 remains unknown
  const res1859 = await f.checkout().ensureSessionFor(owner, req1859);
  assert.equal(res1859.outcome, "unknown");
  assert.equal((await f.checkout().lookupFor(owner, req1859)).outcome, "unknown");

  const record1859 = f.attempts.get(req1859.attemptId);
  assert.equal(record1859.stripeSessionId, "cs_test_attemptlegacycase1859");
  assert.equal(record1859.requestedExpiresAtSeconds, deadline1859);
  assert.equal(record1859.idempotencyKey, key1859);
  assert.equal(record1859.requestFingerprint, fp1859);
  assert.equal(record1859.policyKind, undefined);
  assert.equal("policyKind" in record1859, false);
});

test("request mutation between current and legacy shapes is rejected in both directions", async () => {
  const f = fixture(); await f.ready();

  // Direction 1: Current created -> Legacy mutation rejected
  const cur = request({ attemptId: "attempt-cur-to-leg" });
  await f.checkout().ensureSessionFor(owner, cur);
  const curToLeg = {
    attemptId: cur.attemptId,
    bindingRef: cur.bindingRef,
    lines: cur.lines,
    total: cur.total,
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
  };
  await assert.rejects(f.checkout().ensureSessionFor(owner, curToLeg), /request_mutation/);
  await assert.rejects(f.checkout().lookupFor(owner, curToLeg), /request_mutation/);

  // Direction 2: Legacy seeded -> Current mutation rejected
  const leg = {
    attemptId: "attempt-leg-to-cur",
    bindingRef: "stripe_binding-one",
    lines: [{ catalogItemId: "sku-1", quantity: 2, name: "Hat", unitPrice: { currency: "USD", minor: "600" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
  };
  const claimBase = Math.floor(f.time() / 1000);
  f.attempts.set(leg.attemptId, {
    attemptId: leg.attemptId,
    bindingRef: leg.bindingRef,
    stripeAccountId: "acct_one",
    mode: "test",
    siteId: owner.siteId,
    requestFingerprint: requestFingerprint(leg),
    lines: leg.lines,
    amountMinor: "1200",
    currency: "USD",
    claimedAtMs: f.time(),
    requestedExpiresAtSeconds: claimBase + 1800,
    providerCreatedAtSeconds: claimBase,
    providerExpiresAtSeconds: claimBase + 1800,
    idempotencyKey: `dinkus-checkout:${leg.attemptId}`,
    successUrl,
    cancelUrl,
    stripeSessionId: "cs_leg",
    redirectUrl: "https://checkout.stripe.com/c/pay/cs_leg",
  });
  const legToCur = {
    attemptId: leg.attemptId,
    bindingRef: leg.bindingRef,
    lines: leg.lines,
    total: leg.total,
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
    paymentMethods: ["card"],
  };
  await assert.rejects(f.checkout().ensureSessionFor(owner, legToCur), /request_mutation/);
  await assert.rejects(f.checkout().lookupFor(owner, legToCur), /request_mutation/);
});

test("paymentWindow validation rejects both, neither, altered window bounds, extra policykey, and both own fields even undefined", async () => {
  const f = fixture(); await f.ready();
  // both valid shapes
  await assert.rejects(f.checkout().ensureSessionFor(owner, {
    ...request(),
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
    paymentWindowSeconds: 1800,
  }), /invalid_request/);

  // neither field present
  const neither = request();
  delete neither.paymentWindow;
  await assert.rejects(f.checkout().ensureSessionFor(owner, neither), /invalid_request/);

  // altered bounds
  await assert.rejects(f.checkout().ensureSessionFor(owner, request({
    paymentWindow: { minSeconds: 1799, maxSeconds: 1860 },
  })), /invalid_request/);
  await assert.rejects(f.checkout().ensureSessionFor(owner, request({
    paymentWindow: { minSeconds: 1800, maxSeconds: 1859 },
  })), /invalid_request/);
  await assert.rejects(f.checkout().ensureSessionFor(owner, request({
    paymentWindow: { minSeconds: 1800, maxSeconds: 1861 },
  })), /invalid_request/);

  // legacy altered
  await assert.rejects(f.checkout().ensureSessionFor(owner, {
    ...request(),
    paymentWindow: undefined,
    paymentWindowSeconds: 1859,
  }), /invalid_request/);

  // extra policykey on paymentWindow
  await assert.rejects(f.checkout().ensureSessionFor(owner, request({
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860, policyKey: "current-bounded-1800-1860" },
  })), /invalid_request/);

  // both own fields present even if one or both are undefined
  // current request with own property paymentWindowSeconds: undefined
  const curWithUndefinedLegacy = {
    ...request(),
    paymentWindowSeconds: undefined,
  };
  assert.equal(Object.prototype.hasOwnProperty.call(curWithUndefinedLegacy, "paymentWindow"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(curWithUndefinedLegacy, "paymentWindowSeconds"), true);
  await assert.rejects(f.checkout().ensureSessionFor(owner, curWithUndefinedLegacy), /invalid_request/);

  // legacy request with own property paymentWindow: undefined
  const legWithUndefinedCurrent = {
    attemptId: "attempt-leg-undef",
    bindingRef: "stripe_binding-one",
    lines: [{ catalogItemId: "sku-1", quantity: 2, name: "Hat", unitPrice: { currency: "USD", minor: "600" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindowSeconds: 1800,
    paymentMethods: ["card"],
    paymentWindow: undefined,
  };
  assert.equal(Object.prototype.hasOwnProperty.call(legWithUndefinedCurrent, "paymentWindow"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(legWithUndefinedCurrent, "paymentWindowSeconds"), true);
  await assert.rejects(f.checkout().ensureSessionFor(owner, legWithUndefinedCurrent), /invalid_request/);

  // both own fields explicitly undefined
  const bothUndefined = {
    attemptId: "attempt-both-undef",
    bindingRef: "stripe_binding-one",
    lines: [{ catalogItemId: "sku-1", quantity: 2, name: "Hat", unitPrice: { currency: "USD", minor: "600" } }],
    total: { currency: "USD", minor: "1200" },
    paymentMethods: ["card"],
    paymentWindow: undefined,
    paymentWindowSeconds: undefined,
  };
  assert.equal(Object.prototype.hasOwnProperty.call(bothUndefined, "paymentWindow"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(bothUndefined, "paymentWindowSeconds"), true);
  await assert.rejects(f.checkout().ensureSessionFor(owner, bothUndefined), /invalid_request/);
});

function priced(overrides = {}) {
  return request({
    attemptId: "attempt-priced",
    lines: [{ catalogItemId: "sku-1", quantity: 2, name: "Hat", unitPrice: { currency: "USD", minor: "600" } }],
    total: { currency: "USD", minor: "1200" },
    pricing: {
      schema: "dinkuskit.commerce.checkout-pricing/v1",
      merchandiseSubtotal: { currency: "USD", minor: "1200" },
      couponDiscount: { currency: "USD", minor: "1200" },
      netMerchandise: { currency: "USD", minor: "0" },
      shipping: { configurationId: "ship-1", revision: 1, mode: "flat", charge: { currency: "USD", minor: "1200" } },
      finalTotal: { currency: "USD", minor: "1200" },
      lines: [{
        catalogItemId: "sku-1", quantity: 2,
        unitPrice: { currency: "USD", minor: "600" },
        lineSubtotal: { currency: "USD", minor: "1200" },
        discount: { currency: "USD", minor: "1200" },
        netAmount: { currency: "USD", minor: "0" },
      }],
      coupon: {
        code: "SAVE",
        quote: {
          quoteId: "quote-1", couponId: "coupon-1", ruleId: "rule-1", ruleVersion: 1,
          eligibleSubtotal: { currency: "USD", minor: "1200" },
          discount: { currency: "USD", minor: "1200" },
          payableMerchandiseTotal: { currency: "USD", minor: "0" },
          lines: [{ productId: "sku-1", quantity: 2, unitPrice: { currency: "USD", minor: "600" }, lineSubtotal: { currency: "USD", minor: "1200" }, eligible: true, discount: { currency: "USD", minor: "1200" } }],
          merchandiseTotal: { currency: "USD", minor: "1200" },
          overallPayableTotal: { currency: "USD", minor: "1200" },
        },
      },
    },
    ...overrides,
  });
}

test("pricing snapshot survives coupon offset and mutations reject before provider contact", async () => {
  const f = fixture(); await f.ready();
  const payment = priced();
  const result = await f.checkout().ensureSessionFor(owner, payment);
  assert.equal(result.outcome, "open");
  const record = f.attempts.get(payment.attemptId);
  assert.equal(record.pricing.coupon.quote.overallPayableTotal.minor, "1200");
  assert.equal(record.pricing.lines[0].netAmount.minor, "0");
  const fingerprint = record.requestFingerprint;
  assert.notEqual(fingerprint, requestFingerprint({ ...payment, pricing: { ...payment.pricing, finalTotal: { currency: "USD", minor: "1201" } } }));
  const calls = f.calls.length;
  await assert.rejects(f.checkout().lookupFor(owner, { ...payment, pricing: { ...payment.pricing, shipping: { ...payment.pricing.shipping, revision: 2 } } }), /request_mutation|invalid_pricing/);
  assert.equal(f.calls.length, calls);
});

test("pricing nullish, malformed arithmetic, and legacy pricing fail closed", async () => {
  const f = fixture(); await f.ready();
  await assert.rejects(f.checkout().ensureSessionFor(owner, { ...request({ attemptId: "null-pricing" }), pricing: undefined }), /invalid_pricing/);
  await assert.rejects(f.checkout().ensureSessionFor(owner, priced({ pricing: { schema: "unknown" } })), /invalid_pricing/);
  await assert.rejects(f.checkout().ensureSessionFor(owner, {
    ...request({ attemptId: "legacy-priced" }), paymentWindow: undefined, paymentWindowSeconds: 1800, pricing: undefined,
  }), /invalid_request/);
  assert.equal(f.calls.length, 0);
});

test("discounted and shipping-only pricing totals reach the provider unchanged", async () => {
  for (const shipping of ["100", "0"]) {
    const f = fixture(); await f.ready();
    const payment = priced();
    payment.total.minor = shipping === "100" ? "1100" : "1000";
    payment.pricing.couponDiscount.minor = "200";
    payment.pricing.netMerchandise.minor = "1000";
    payment.pricing.shipping = {configurationId:"ship-1",revision:1,mode:shipping === "0" ? "free" : "flat",charge:{currency:"USD",minor:shipping}};
    payment.pricing.finalTotal.minor = payment.total.minor;
    payment.pricing.lines[0].discount.minor = "200";
    payment.pricing.lines[0].netAmount.minor = "1000";
    payment.pricing.coupon.quote.discount.minor = "200";
    payment.pricing.coupon.quote.lines[0].discount.minor = "200";
    payment.pricing.coupon.quote.payableMerchandiseTotal.minor = "1000";
    payment.pricing.coupon.quote.overallPayableTotal.minor = payment.total.minor;
    assert.equal((await f.checkout().ensureSessionFor(owner,payment)).outcome,"open");
    assert.equal(f.calls[0][1].total.minor,payment.total.minor);
    assert.deepEqual(f.attempts.get(payment.attemptId).pricing,payment.pricing);
  }
  const f=fixture();await f.ready();const payment=priced();
  payment.total.minor="50";payment.pricing.shipping.charge.minor="50";payment.pricing.finalTotal.minor="50";payment.pricing.coupon.quote.overallPayableTotal.minor="50";
  assert.equal((await f.checkout().ensureSessionFor(owner,payment)).outcome,"open");
});

test("101 mapped items reject before any attempt or provider operation", async () => {
  const f=fixture();await f.ready();const payment=priced();const usd=minor=>({currency:"USD",minor});
  payment.lines=Array.from({length:100},(_,i)=>({catalogItemId:`sku-${i}`,quantity:1,name:"Item",unitPrice:usd("2")}));
  payment.total=usd("200");const p=payment.pricing;
  p.merchandiseSubtotal=usd("200");p.couponDiscount=usd("100");p.netMerchandise=usd("100");p.shipping.charge=usd("100");p.finalTotal=usd("200");
  p.lines=payment.lines.map(l=>({catalogItemId:l.catalogItemId,quantity:1,unitPrice:usd("2"),lineSubtotal:usd("2"),discount:usd("1"),netAmount:usd("1")}));
  p.coupon.quote={quoteId:"many-quote",couponId:"coupon-1",ruleId:"rule-1",ruleVersion:1,eligibleSubtotal:usd("200"),discount:usd("100"),payableMerchandiseTotal:usd("100"),merchandiseTotal:usd("200"),overallPayableTotal:usd("200"),lines:payment.lines.map(l=>({productId:l.catalogItemId,quantity:1,unitPrice:usd("2"),lineSubtotal:usd("2"),eligible:true,discount:usd("1")}))};
  await assert.rejects(f.checkout().ensureSessionFor(owner,payment),/invalid_pricing|line_item_limit/);
  assert.equal(f.attempts.size,0);assert.equal(f.calls.length,0);
});

test("coupon code, whitespace identities and ineligible discounts fail before contact", async () => {
  const mutations=[p=>{p.coupon.code="save";},p=>{p.shipping.configurationId=" ";},p=>{p.coupon.quote.ruleId=" ";},p=>{p.coupon.quote.lines[0].eligible=false;p.coupon.quote.eligibleSubtotal.minor="0";},p=>{p.coupon.quote.lines[0].unitPrice.currency="EUR";},p=>{p.coupon=undefined;}];
  for(const mutate of mutations){const f=fixture();await f.ready();const payment=priced();mutate(payment.pricing);await assert.rejects(f.checkout().ensureSessionFor(owner,payment),/invalid_pricing|invalid_amount/);assert.equal(f.attempts.size,0);assert.equal(f.calls.length,0);}
});

test("complete pricing rejects malformed schema, line, quote and money fields before writes", async () => {
  const mutations=[
    p=>{p.schema="unsupported";}, p=>{p.shipping.mode="free";}, p=>{p.shipping.revision=0;},
    p=>{p.lines[0].quantity=1;}, p=>{p.lines[0].catalogItemId="other";},
    p=>{p.lines[0].netAmount.minor="1";}, p=>{p.lines[0].unitPrice.extra=true;},
    p=>{p.couponDiscount.minor="01";}, p=>{p.coupon.quote.eligibleSubtotal.minor="1";},
    p=>{p.coupon.quote.lines[0].unitPrice=null;}, p=>{p.coupon.quote.ruleVersion=0;},
    p=>{p.coupon.quote.lines[0].discount.currency="EUR";},
    p=>{p.shipping.charge.minor="9007199254740992";}, p=>{p.coupon.quote.overallPayableTotal.minor="1201";},
    p=>{p.coupon.quote.lines[0].extra=true;}, p=>{p.coupon=null;}, p=>{p.lines=[];},
    p=>{p.finalTotal.currency="EUR";},p=>{p.shipping.charge.minor="-1";},p=>{p.extra=true;},
  ];
  for(const mutate of mutations){const f=fixture();await f.ready();const payment=priced();mutate(payment.pricing);await assert.rejects(f.checkout().ensureSessionFor(owner,payment),/invalid_pricing|invalid_amount/);assert.equal(f.attempts.size,0);assert.equal(f.calls.length,0);}
});

test("claim snapshots transport mapping before await and retries original after caller mutation", async () => {
  const f=fixture();await f.ready();f.setCreateDown(true);const payment=priced();const original=structuredClone(payment);
  const pending=f.checkout().ensureSessionFor(owner,payment);
  payment.pricing.shipping.revision=9;payment.pricing.coupon.quote.quoteId="changed";
  assert.equal((await pending).outcome,"unknown");
  const record=structuredClone(f.attempts.get(original.attemptId));
  assert.deepEqual(record.pricing,original.pricing);assert.equal(record.mappingVersion,"stripe-whole-line-v1");
  assert.deepEqual(record.chargeLines,[{quantity:1,amountMinor:"1200",name:"Shipping",description:"Flat shipping"}]);
  assert.deepEqual(f.calls[0][1].chargeLines,record.chargeLines);
  f.setCreateDown(false);
  const [first,second]=await Promise.all([f.checkout().ensureSessionFor(owner,original),f.checkout().ensureSessionFor(owner,original)]);
  assert.equal(first.outcome,"open");assert.equal(second.outcome,"open");
  for(const [,params] of f.calls.filter(([kind])=>kind==="create")) {
    assert.deepEqual(params.pricing,original.pricing);assert.deepEqual(params.chargeLines,record.chargeLines);
    assert.equal(params.idempotencyKey,record.idempotencyKey);assert.equal(params.expiresAtSeconds,record.requestedExpiresAtSeconds);
  }
  const final=f.attempts.get(original.attemptId);assert.equal(final.requestFingerprint,record.requestFingerprint);assert.equal(final.requestedExpiresAtSeconds,record.requestedExpiresAtSeconds);
});

test("partial or corrupted priced mapping stays unknown without a second create", async () => {
  for(const corrupt of [r=>{delete r.chargeLines;},r=>{r.mappingVersion="unsupported";},r=>{r.chargeLines[0].amountMinor="1";}]) {
    const f=fixture();await f.ready();f.setCreateDown(true);const payment=priced();assert.equal((await f.checkout().ensureSessionFor(owner,payment)).outcome,"unknown");
    corrupt(f.attempts.get(payment.attemptId));const calls=f.calls.length;f.setCreateDown(false);
    assert.equal((await f.checkout().ensureSessionFor(owner,payment)).outcome,"unknown");assert.equal(f.calls.length,calls);
  }
});
