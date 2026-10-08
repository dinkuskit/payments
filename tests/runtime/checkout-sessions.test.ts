import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import Stripe from "stripe";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

function sessionBody(readyUrl: string | null, extras: Record<string, unknown> = {}) {
  const expiresAt = typeof extras.expires_at === "number" ? extras.expires_at : Math.floor(Date.now() / 1000) + 1860;
  const created = typeof extras.created === "number" ? extras.created : expiresAt - 1860;
  return {
    object: "checkout.session",
    id: "cs_fixture",
    url: readyUrl,
    status: extras.status ?? "open",
    payment_status: extras.payment_status ?? "unpaid",
    amount_total: 1200,
    currency: "usd",
    created,
    expires_at: expiresAt,
    livemode: false,
    payment_intent: extras.payment_intent ?? null,
    metadata: { dinkus_attempt: "attempt-one", dinkus_binding: "ignored", dinkus_site: "ignored" },
    payment_method_types: ["card"],
    ...extras,
    created,
    expires_at: expiresAt,
  };
}

test.each(["historical-unpriced", "priced-v1"])("SQLite mapping survives eviction and lookup continues after readiness regression (%s)", async kind => {
  let ready = false;
  const created = { expires_at: 0, count: 0 };
  const operations = new Map<string, { params: string; body: unknown }>();
  let loseCreationResponse = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/accounts" && init?.method === "POST") {
      return new Response(JSON.stringify({ object: "account", id: "acct_fixture", details_submitted: true, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: "active" }, requirements: {} }), { headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/account_links") {
      return new Response(JSON.stringify({ object: "account_link", url: "https://connect.stripe.com/setup/fixture", expires_at: Math.floor(Date.now() / 1000) + 600 }), { headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/accounts/acct_fixture") {
      return new Response(JSON.stringify({ object: "account", id: "acct_fixture", details_submitted: ready, charges_enabled: ready, payouts_enabled: ready, capabilities: { card_payments: ready ? "active" : "pending" }, requirements: {} }), { headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/checkout/sessions" && init?.method === "POST") {
      created.count++;
      const key = new Headers(init.headers).get("idempotency-key")!;
      const previous = operations.get(key);
      if (previous) {
        expect(String(init.body)).toBe(previous.params);
        return Response.json(previous.body);
      }
      const params = new URLSearchParams(String(init.body ?? ""));
      created.expires_at = Number(params.get("expires_at"));
      const body = sessionBody("https://checkout.stripe.com/c/pay/cs_fixture", { expires_at: created.expires_at, metadata: { dinkus_attempt: params.get("metadata[dinkus_attempt]"), dinkus_binding: params.get("metadata[dinkus_binding]"), dinkus_site: params.get("metadata[dinkus_site]") } });
      operations.set(key, { params: String(init.body), body });
      if (loseCreationResponse) {
        loseCreationResponse = false;
        throw new Error("synthetic lost creation response");
      }
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/checkout/sessions/cs_fixture") {
      const original = [...operations.values()][0]?.body as Record<string, unknown>;
      return Response.json({ ...original, url: null });
    }
    return new Response("missing", { status: 404 });
  });
  const principal = { accountId: "synthetic-owner", siteId: crypto.randomUUID() };
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  const connected = await stub.startOnboarding(principal);
  ready = true;
  const binding = await stub.checkoutBinding(principal, connected.bindingRef!);
  expect(binding?.stripeAccountId).toBe("acct_fixture");
  const payment = {
    attemptId: "attempt-one",
    bindingRef: connected.bindingRef!,
    lines: [{ catalogItemId: "sku-1", quantity: kind === "priced-v1" ? 2 : 1, name: "Hat", unitPrice: { currency: "USD" as const, minor: "1200" } }],
    total: { currency: "USD" as const, minor: "1200" },
    ...(kind === "priced-v1" ? { pricing: {
      schema: "dinkuskit.commerce.checkout-pricing/v1" as const,
      merchandiseSubtotal: { currency: "USD" as const, minor: "2400" },
      couponDiscount: { currency: "USD" as const, minor: "1251" },
      netMerchandise: { currency: "USD" as const, minor: "1149" },
      shipping: { configurationId: "ship-runtime", revision: 1, mode: "flat" as const, charge: { currency: "USD" as const, minor: "51" } },
      finalTotal: { currency: "USD" as const, minor: "1200" },
      lines: [{
        catalogItemId: "sku-1", quantity: 2,
        unitPrice: { currency: "USD" as const, minor: "1200" },
        lineSubtotal: { currency: "USD" as const, minor: "2400" },
        discount: { currency: "USD" as const, minor: "1251" },
        netAmount: { currency: "USD" as const, minor: "1149" },
      }],
      coupon: { code: "SAVE", quote: {
        quoteId: "runtime-quote", couponId: "runtime-coupon", ruleId: "runtime-rule", ruleVersion: 1,
        eligibleSubtotal: {currency:"USD" as const,minor:"2400"}, discount: {currency:"USD" as const,minor:"1251"},
        payableMerchandiseTotal: {currency:"USD" as const,minor:"1149"}, merchandiseTotal: {currency:"USD" as const,minor:"2400"}, overallPayableTotal: {currency:"USD" as const,minor:"1200"},
        lines: [{productId:"sku-1",quantity:2,unitPrice:{currency:"USD" as const,minor:"1200"},lineSubtotal:{currency:"USD" as const,minor:"2400"},eligible:true,discount:{currency:"USD" as const,minor:"1251"}}],
      } },
    } } : {}),
    paymentWindow: { minSeconds: 1800 as const, maxSeconds: 1860 as const },
    paymentMethods: ["card"] as const,
  };
  expect((await stub.ensureSession(principal, payment)).outcome).toBe("unknown");
  if (kind === "priced-v1") {
    await runInDurableObject(stub, instance => {
      const row=instance.ctx.storage.sql.exec<{value:string}>("SELECT value FROM checkout_attempts WHERE attempt_id=?",payment.attemptId).one();
      const record=JSON.parse(row.value);
      expect(record.pricing).toEqual(payment.pricing);
      expect(record.mappingVersion).toBe("stripe-whole-line-v1");
      expect(record.chargeLines.map((line:{amountMinor:string})=>line.amountMinor)).toEqual(["1149","51"]);
    });
    const params=new URLSearchParams([...operations.values()][0].params);
    expect(params.get("line_items[0][quantity]")).toBe("1");
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("1149");
    expect(params.get("line_items[1][price_data][unit_amount]")).toBe("51");
  }
  await evictDurableObject(stub);
  const [first, concurrent] = await Promise.all([
    stub.ensureSession(principal, payment), stub.ensureSession(principal, payment),
  ]);
  expect(concurrent).toEqual(first);
  expect(operations.size).toBe(1);
  expect(first.outcome).toBe("open");
  if (first.outcome === "open") {
    expect(first.session.redirectUrl).toBe("https://checkout.stripe.com/c/pay/cs_fixture");
    expect(first.session.expiresAt).toBe(first.session.createdAt + 1860);
  }
  await evictDurableObject(stub);
  const again = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  ready = false;
  expect(await again.checkoutBinding(principal, connected.bindingRef!)).toBeNull();
  expect(await again.existingBinding(principal, connected.bindingRef!)).toMatchObject({ stripeAccountId: "acct_fixture", bindingRef: connected.bindingRef });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/accounts/acct_fixture") {
      return new Response(JSON.stringify({ object: "account", id: "acct_fixture", details_submitted: false, charges_enabled: false, payouts_enabled: false, capabilities: { card_payments: "pending" }, requirements: {} }), { headers: { "content-type": "application/json" } });
    }
    if (path === "/v1/checkout/sessions/cs_fixture") {
      return new Response(JSON.stringify(sessionBody(null, {
        created: first.outcome === "open" ? first.session.createdAt : created.expires_at - 1860,
        expires_at: first.outcome === "open" ? first.session.expiresAt : created.expires_at,
        metadata: { dinkus_attempt: "attempt-one", dinkus_binding: connected.bindingRef!, dinkus_site: principal.siteId },
      })), { headers: { "content-type": "application/json" } });
    }
    return new Response("missing", { status: 404 });
  });
  const looked = await again.lookup(principal, payment);
  expect(looked.outcome).toBe("open");
  if (looked.outcome === "open" && first.outcome === "open") expect(looked.session).toEqual(first.session);
  const createRequestsBeforeLookup = created.count;
  await again.lookup(principal, payment);
  expect(created.count).toBe(createRequestsBeforeLookup);
  expect(operations.size).toBe(1);

  await runInDurableObject(again, instance => instance.ctx.storage.sql.exec(
    "INSERT INTO checkout_wakes (attempt_id,woke_at) VALUES (?,?)",
    "historical-attempt-only",
    123,
  ));
  let enqueueNow = 1700000000100;
  vi.spyOn(Date, "now").mockImplementation(() => enqueueNow);
  for (const [id, type] of [["evt_old", "checkout.session.expired"], ["evt_new", "checkout.session.completed"], ["evt_new", "checkout.session.completed"]] as const) {
    const payload = JSON.stringify({
      id, object: "event", type, livemode: false, account: "acct_fixture",
      data: { object: sessionBody(null, {
        created: first.outcome === "open" ? first.session.createdAt : created.expires_at - 1860,
        expires_at: created.expires_at,
        metadata: { dinkus_attempt: "attempt-one", dinkus_binding: connected.bindingRef!, dinkus_site: principal.siteId },
      }) },
    });
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload, secret: "whsec_synthetic_fixture", cryptoProvider: Stripe.createSubtleCryptoProvider(),
    });
    await again.receiveWebhook(new TextEncoder().encode(payload).buffer as ArrayBuffer, signature, null);
    if (id === "evt_old") enqueueNow = 1700000000200;
    if (id === "evt_new") enqueueNow = 1700000000300;
  }
  await evictDurableObject(again);
  const resumed = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  const pending = await runInDurableObject(resumed, instance => instance.ctx.storage.sql.exec<{ attempt_id: string; woke_at: number }>(
    "SELECT attempt_id, woke_at FROM checkout_wakes ORDER BY attempt_id",
  ).toArray());
  expect(pending).toEqual([
    { attempt_id: "attempt-one", woke_at: 1700000000200 },
    { attempt_id: "historical-attempt-only", woke_at: 123 },
  ]);
  const events = await runInDurableObject(resumed, instance => instance.ctx.storage.sql.exec<{ event_id: string; received_at: number; acknowledged_at: number | null }>(
    "SELECT event_id, received_at, acknowledged_at FROM checkout_wake_events ORDER BY event_id",
  ).toArray());
  expect(events).toEqual([
    { event_id: "evt_new", received_at: 1700000000200, acknowledged_at: null },
    { event_id: "evt_old", received_at: 1700000000100, acknowledged_at: null },
  ]);

  const retained = await resumed.consumeWakes(async context => {
    expect(context.attemptId).toBe("attempt-one");
    return context.eventId === "evt_old" ? "pending" : false;
  });
  expect(retained).toEqual({ inspected: 2, acknowledged: 0 });
  const acknowledged = await resumed.consumeWakes(async context => context.eventId === "evt_old");
  expect(acknowledged).toEqual({ inspected: 2, acknowledged: 1 });
  const afterAck = await resumed.consumeWakes(async () => true);
  expect(afterAck).toEqual({ inspected: 1, acknowledged: 1 });
  const replayPayload = JSON.stringify({
    id: "evt_old", object: "event", type: "checkout.session.expired", livemode: false, account: "acct_fixture",
    data: { object: sessionBody(null, {
      created: first.outcome === "open" ? first.session.createdAt : created.expires_at - 1860,
      expires_at: first.outcome === "open" ? first.session.expiresAt : created.expires_at,
      metadata: { dinkus_attempt: "attempt-one", dinkus_binding: connected.bindingRef!, dinkus_site: principal.siteId },
    }) },
  });
  const replaySignature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload: replayPayload, secret: "whsec_synthetic_fixture", cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  await resumed.receiveWebhook(new TextEncoder().encode(replayPayload).buffer as ArrayBuffer, replaySignature, null);
  await evictDurableObject(resumed);
  const afterReplay = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  const tombstones = await runInDurableObject(resumed, instance => instance.ctx.storage.sql.exec<{ event_id: string; received_at: number; acknowledged_at: number | null }>(
    "SELECT event_id, received_at, acknowledged_at FROM checkout_wake_events ORDER BY event_id",
  ).toArray());
  expect(tombstones.every(event => event.acknowledged_at !== null)).toBe(true);
  expect(tombstones).toEqual([
    { event_id: "evt_new", received_at: 1700000000200, acknowledged_at: expect.any(Number) },
    { event_id: "evt_old", received_at: 1700000000100, acknowledged_at: expect.any(Number) },
  ]);
  const replayed = await runInDurableObject(afterReplay, instance => instance.ctx.storage.sql.exec<{ event_id: string; received_at: number; acknowledged_at: number | null }>(
    "SELECT event_id, received_at, acknowledged_at FROM checkout_wake_events ORDER BY event_id",
  ).toArray());
  expect(replayed).toEqual(tombstones);
  const legacyRows = await runInDurableObject(afterReplay, instance => instance.ctx.storage.sql.exec<{ attempt_id: string; woke_at: number }>(
    "SELECT attempt_id, woke_at FROM checkout_wakes ORDER BY attempt_id",
  ).toArray());
  expect(legacyRows).toEqual([
    { attempt_id: "attempt-one", woke_at: 1700000000200 },
    { attempt_id: "historical-attempt-only", woke_at: 123 },
  ]);
});

test("characterization: lost create response leaves a claim unrecoverable by webhook until authorized ensure replay", async () => {
  // CURRENT RECOVERY GAP characterization: a provider-side create can exist
  // while the mapping is absent, and a webhook cannot recover that claim.
  // This is observed behavior, not a desired permanent product rule.
  const operations = new Map<string, { params: string; body: Record<string, unknown> }>();
  let createCalls = 0;
  let loseCreationResponse = true;
  const retrieveCalls: string[] = [];
  const createAccounts: (string | null)[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com") throw new Error(`unexpected provider host: ${url.hostname}`);
    const path = url.pathname;
    if (path === "/v1/accounts" && init?.method === "POST") {
      return Response.json({ object: "account", id: "acct_lostresponse", details_submitted: true, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: "active" }, requirements: {} });
    }
    if (path === "/v1/account_links") {
      return Response.json({ object: "account_link", url: "https://connect.stripe.com/setup/lost-response", expires_at: Math.floor(Date.now() / 1000) + 600 });
    }
    if (path === "/v1/accounts/acct_lostresponse") {
      return Response.json({ object: "account", id: "acct_lostresponse", details_submitted: true, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: "active" }, requirements: {} });
    }
    if (path === "/v1/checkout/sessions" && init?.method === "POST") {
      createCalls++;
      createAccounts.push(new Headers(init.headers).get("stripe-account"));
      const params = String(init.body ?? "");
      const key = new Headers(init.headers).get("idempotency-key");
      if (!key) throw new Error("missing synthetic idempotency key");
      const existing = operations.get(key);
      if (existing) {
        expect(params).toBe(existing.params);
        if (loseCreationResponse) throw new Error("synthetic lost creation response");
        return Response.json(existing.body);
      }
      const form = new URLSearchParams(params);
      const body = {
        object: "checkout.session",
        id: "cs_lostresponse",
        url: "https://checkout.stripe.com/c/pay/cs_lostresponse",
        status: "open",
        payment_status: "unpaid",
        amount_total: 1200,
        currency: "usd",
        created: Number(form.get("expires_at")) - 1860,
        expires_at: Number(form.get("expires_at")),
        livemode: false,
        payment_intent: null,
        metadata: {
          dinkus_attempt: form.get("metadata[dinkus_attempt]"),
          dinkus_binding: form.get("metadata[dinkus_binding]"),
          dinkus_site: form.get("metadata[dinkus_site]"),
        },
        payment_method_types: ["card"],
      };
      operations.set(key, { params, body });
      if (loseCreationResponse) {
        loseCreationResponse = false;
        throw new Error("synthetic lost creation response");
      }
      return Response.json(body);
    }
    if (path === "/v1/checkout/sessions/cs_lostresponse") {
      retrieveCalls.push(path);
      const body = [...operations.values()][0]?.body;
      if (!body) throw new Error("synthetic session operation missing");
      return Response.json(body);
    }
    throw new Error(`unexpected local Stripe route: ${init?.method ?? "GET"} ${path}`);
  });

  const principal = { accountId: "synthetic-owner", siteId: crypto.randomUUID() };
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  const connected = await stub.startOnboarding(principal);
  expect(connected.state).toBe("ready");
  const payment = {
    attemptId: "attempt-lost-response",
    bindingRef: connected.bindingRef!,
    lines: [{ catalogItemId: "sku-lost-response", quantity: 1, name: "Fixture Hat", unitPrice: { currency: "USD" as const, minor: "1200" } }],
    total: { currency: "USD" as const, minor: "1200" },
    paymentWindow: { minSeconds: 1800 as const, maxSeconds: 1860 as const },
    paymentMethods: ["card"] as const,
  };

  const first = await stub.ensureSession(principal, payment);
  expect(first).toEqual({ outcome: "unknown" });
  expect(operations.size).toBe(1);
  expect(createCalls).toBe(1);
  const originalClaim = await runInDurableObject(stub, instance => {
    const row = instance.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM checkout_attempts WHERE attempt_id=?",
      payment.attemptId,
    ).one();
    return JSON.parse(row.value);
  });
  expect(originalClaim).toMatchObject({
    attemptId: payment.attemptId,
    bindingRef: connected.bindingRef,
    stripeAccountId: "acct_lostresponse",
    siteId: principal.siteId,
    requestFingerprint: expect.any(String),
    idempotencyKey: "dinkus-checkout:attempt-lost-response",
    stripeSessionId: null,
    redirectUrl: null,
  });
  const originalIdentity = {
    requestFingerprint: originalClaim.requestFingerprint,
    idempotencyKey: originalClaim.idempotencyKey,
    requestedExpiresAtSeconds: originalClaim.requestedExpiresAtSeconds,
    claimedAtMs: originalClaim.claimedAtMs,
    stripeAccountId: originalClaim.stripeAccountId,
    siteId: originalClaim.siteId,
  };

  expect(await stub.lookup(principal, payment)).toEqual({ outcome: "unknown" });
  expect(createCalls).toBe(1);

  const payload = JSON.stringify({
    id: "evt_lostresponse",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    account: "acct_lostresponse",
    data: {
      object: {
        object: "checkout.session",
        id: "cs_lostresponse",
        url: "https://checkout.stripe.com/c/pay/cs_lostresponse",
        status: "open",
        payment_status: "unpaid",
        amount_total: 1200,
        currency: "usd",
        created: operations.values().next().value!.body.created,
        expires_at: operations.values().next().value!.body.expires_at,
        livemode: false,
        payment_intent: null,
        metadata: {
          dinkus_attempt: payment.attemptId,
          dinkus_binding: payment.bindingRef,
          dinkus_site: principal.siteId,
        },
      },
    },
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: "whsec_synthetic_fixture",
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  const webhookError = await runInDurableObject(stub, async instance => {
    try {
      await instance.receiveWebhook(new TextEncoder().encode(payload).buffer as ArrayBuffer, signature, "acct_lostresponse");
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(webhookError).toBe("session_missing");
  expect(retrieveCalls).toEqual([]);
  expect(await runInDurableObject(stub, instance => instance.ctx.storage.sql.exec(
    "SELECT attempt_id FROM checkout_wakes ORDER BY attempt_id",
  ).toArray())).toEqual([]);
  expect(await runInDurableObject(stub, instance => instance.ctx.storage.sql.exec(
    "SELECT event_id FROM checkout_wake_events ORDER BY event_id",
  ).toArray())).toEqual([]);
  expect(await runInDurableObject(stub, instance => instance.ctx.storage.sql.exec<{ value: string }>(
    "SELECT value FROM checkout_attempts WHERE attempt_id=?",
    payment.attemptId,
  ).one()).then(row => JSON.parse(row.value))).toEqual(originalClaim);

  await evictDurableObject(stub);
  const reopened = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  expect(await reopened.lookup(principal, payment)).toEqual({ outcome: "unknown" });
  expect(createCalls).toBe(1);
  const reopenedClaim = await runInDurableObject(reopened, instance => {
    const row = instance.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM checkout_attempts WHERE attempt_id=?",
      payment.attemptId,
    ).one();
    return JSON.parse(row.value);
  });
  expect(reopenedClaim).toEqual(originalClaim);
  expect({
    requestFingerprint: reopenedClaim.requestFingerprint,
    idempotencyKey: reopenedClaim.idempotencyKey,
    requestedExpiresAtSeconds: reopenedClaim.requestedExpiresAtSeconds,
    claimedAtMs: reopenedClaim.claimedAtMs,
    stripeAccountId: reopenedClaim.stripeAccountId,
    siteId: reopenedClaim.siteId,
  }).toEqual(originalIdentity);

  loseCreationResponse = false;
  const replay = await reopened.ensureSession(principal, payment);
  expect(replay).toMatchObject({
    outcome: "open",
    attemptId: payment.attemptId,
    session: {
      sessionId: "cs_lostresponse",
      redirectUrl: "https://checkout.stripe.com/c/pay/cs_lostresponse",
    },
  });
  expect(operations.size).toBe(1);
  expect(createCalls).toBe(2);
  expect(createAccounts).toEqual(["acct_lostresponse", "acct_lostresponse"]);
  expect(await reopened.lookup(principal, payment)).toEqual(replay);
  const recoveredClaim = await runInDurableObject(reopened, instance => {
    const row = instance.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM checkout_attempts WHERE attempt_id=?",
      payment.attemptId,
    ).one();
    return JSON.parse(row.value);
  });
  expect(recoveredClaim).toMatchObject({
    ...originalIdentity,
    stripeSessionId: "cs_lostresponse",
    redirectUrl: "https://checkout.stripe.com/c/pay/cs_lostresponse",
  });
  await evictDurableObject(reopened);
  const afterReplay = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  expect(await afterReplay.lookup(principal, payment)).toEqual(replay);
  expect(createCalls).toBe(2);
  expect(operations.size).toBe(1);
});

test("Durable Object wake consumers serialize callbacks and avoid ACK overcounting", async () => {
  const siteId = crypto.randomUUID();
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  await runInDurableObject(stub, instance => instance.ctx.storage.sql.exec(
    "INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,mode,received_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,NULL)",
    "evt_concurrent", "attempt-concurrent", siteId, "binding-concurrent", "acct_concurrent", "test", 1700000000400,
  ));

  let callbackCalls = 0;
  let releaseCallback!: () => void;
  let callbackStarted!: () => void;
  const started = new Promise<void>(resolve => { callbackStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseCallback = resolve; });
  const reconcile = async (context: Readonly<{ eventId: string }>) => {
    callbackCalls++;
    expect(context.eventId).toBe("evt_concurrent");
    callbackStarted();
    await gate;
    return true as const;
  };

  const first = stub.consumeWakes(reconcile);
  await started;
  const second = stub.consumeWakes(reconcile);
  releaseCallback();

  await expect(first).resolves.toEqual({ inspected: 1, acknowledged: 1 });
  await expect(second).resolves.toEqual({ inspected: 0, acknowledged: 0 });
  expect(callbackCalls).toBe(1);

  const state = await runInDurableObject(stub, instance => instance.ctx.storage.sql.exec<{ acknowledged_at: number | null }>(
    "SELECT acknowledged_at FROM checkout_wake_events WHERE event_id=?",
    "evt_concurrent",
  ).toArray());
  expect(state).toEqual([{ acknowledged_at: expect.any(Number) }]);
});
