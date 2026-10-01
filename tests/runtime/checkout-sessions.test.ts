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

test("SQLite mapping survives eviction and lookup continues after readiness regression", async () => {
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
    lines: [{ catalogItemId: "sku-1", quantity: 1, name: "Hat", unitPrice: { currency: "USD" as const, minor: "1200" } }],
    total: { currency: "USD" as const, minor: "1200" },
    paymentWindow: { minSeconds: 1800 as const, maxSeconds: 1860 as const },
    paymentMethods: ["card"] as const,
  };
  expect((await stub.ensureSession(principal, payment)).outcome).toBe("unknown");
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
  }
  await evictDurableObject(again);
  const resumed = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  await runInDurableObject(resumed, instance => instance.ctx.storage.sql.exec(
    "INSERT INTO checkout_wakes (attempt_id,woke_at) VALUES (?,?)",
    "historical-attempt-only",
    123,
  ));
  const pending = await runInDurableObject(resumed, instance => instance.ctx.storage.sql.exec<{ attempt_id: string }>(
    "SELECT attempt_id FROM checkout_wakes ORDER BY attempt_id",
  ).toArray());
  expect(pending).toEqual([
    { attempt_id: "attempt-one" },
    { attempt_id: "historical-attempt-only" },
  ]);
  const events = await runInDurableObject(resumed, instance => instance.ctx.storage.sql.exec<{ event_id: string; acknowledged_at: number | null }>(
    "SELECT event_id, acknowledged_at FROM checkout_wake_events ORDER BY event_id",
  ).toArray());
  expect(events).toEqual([
    { event_id: "evt_new", acknowledged_at: null },
    { event_id: "evt_old", acknowledged_at: null },
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
  const tombstones = await runInDurableObject(resumed, instance => instance.ctx.storage.sql.exec<{ event_id: string; acknowledged_at: number | null }>(
    "SELECT event_id, acknowledged_at FROM checkout_wake_events ORDER BY event_id",
  ).toArray());
  expect(tombstones.every(event => event.acknowledged_at !== null)).toBe(true);
  const replayed = await runInDurableObject(afterReplay, instance => instance.ctx.storage.sql.exec<{ event_id: string; acknowledged_at: number | null }>(
    "SELECT event_id, acknowledged_at FROM checkout_wake_events ORDER BY event_id",
  ).toArray());
  expect(replayed).toEqual(tombstones);
  const legacyRows = await runInDurableObject(afterReplay, instance => instance.ctx.storage.sql.exec<{ attempt_id: string }>(
    "SELECT attempt_id FROM checkout_wakes ORDER BY attempt_id",
  ).toArray());
  expect(legacyRows).toEqual([
    { attempt_id: "attempt-one" },
    { attempt_id: "historical-attempt-only" },
  ]);
});
