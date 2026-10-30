import { stripeV2Account, stripeV2Link } from "../helpers/stripe-v2.js";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import Stripe from "stripe";
import { afterEach, expect, test, vi } from "vitest";
import { projectSetupScreen } from "../../src/registry/setup.js";
import { decodeStatus } from "../../src/registry/status.js";

afterEach(() => vi.restoreAllMocks());

const readyAccount = (id: string) => stripeV2Account(id);

function stripeFixture() {
  const state: { paid: boolean; session: Record<string, unknown> | null } = { paid: false, session: null };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/account") return Response.json({ object: "account", id: "acct_platform" });
    if (url.hostname !== "api.stripe.com") throw new Error(`unexpected provider host: ${url.hostname}`);
    if (url.pathname === "/v2/core/accounts" && init?.method === "POST") return Response.json(readyAccount("acct_fixture"));
    if (url.pathname === "/v2/core/accounts/acct_fixture") return Response.json(readyAccount("acct_fixture"));
    if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
      const params = new URLSearchParams(String(init.body ?? ""));
      const expiresAt = Number(params.get("expires_at"));
      state.session = {
        object: "checkout.session", id: "cs_fixture", url: "https://checkout.stripe.com/c/pay/cs_fixture",
        status: "open", payment_status: "unpaid", amount_total: 1200, currency: "usd",
        created: expiresAt - 1860, expires_at: expiresAt, livemode: false, payment_intent: null,
        metadata: {
          dinkus_attempt: params.get("metadata[dinkus_attempt]"),
          dinkus_binding: params.get("metadata[dinkus_binding]"),
          dinkus_site: params.get("metadata[dinkus_site]"),
        },
        payment_method_types: ["card"],
      };
      return Response.json(state.session);
    }
    if (url.pathname === "/v1/checkout/sessions/cs_fixture") {
      return Response.json(state.paid
        ? { ...state.session, url: null, status: "complete", payment_status: "paid", payment_intent: "pi_fixture" }
        : state.session);
    }
    if (url.pathname === "/v1/payment_intents/pi_fixture") {
      return Response.json({ object: "payment_intent", id: "pi_fixture", status: "succeeded", amount: 1200, currency: "usd", latest_charge: null });
    }
    return new Response("missing", { status: 404 });
  });
  return state;
}

function payment(bindingRef: string) {
  return {
    attemptId: "attempt-one",
    bindingRef,
    lines: [{ catalogItemId: "sku-1", quantity: 1, name: "Hat", unitPrice: { currency: "USD" as const, minor: "1200" } }],
    total: { currency: "USD" as const, minor: "1200" },
    paymentWindow: { minSeconds: 1800 as const, maxSeconds: 1860 as const },
    paymentMethods: ["card"] as const,
  };
}

test("a paid TEST checkout shows in status, then counts once Commerce acknowledges its payment notice", async () => {
  const stripe = stripeFixture();
  const principal = { accountId: "synthetic-owner", siteId: crypto.randomUUID(), siteOrigin: "https://store.example.invalid" };
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  const { bindingRef } = await stub.startOnboarding(principal, "GB");
  const request = payment(bindingRef!);

  expect((await stub.ensureSession(principal, request)).outcome).toBe("open");
  expect((await stub.lookup(principal, request)).outcome).toBe("open");
  expect(await stub.status(principal)).not.toHaveProperty("testOrder");

  stripe.paid = true;
  const before = Date.now();
  expect((await stub.lookup(principal, request)).outcome).toBe("paid");
  const waitingForNotice = await stub.status(principal);
  expect(waitingForNotice.testOrder).toEqual({
    provider: "stripe", total: { currency: "USD", minor: "1200" }, paidAt: expect.any(Number), state: "awaiting_notice",
  });
  const paidAt = waitingForNotice.testOrder!.paidAt;
  expect(paidAt).toBeGreaterThanOrEqual(before);
  expect((await stub.ensureSession(principal, request)).outcome).toBe("paid");
  await evictDurableObject(stub);
  expect((await stub.status(principal)).testOrder?.paidAt).toBe(paidAt);

  const payload = JSON.stringify({
    id: "evt_paid", object: "event", type: "checkout.session.completed", livemode: false, account: "acct_fixture",
    data: { object: { ...stripe.session, url: null, status: "complete", payment_status: "paid", payment_intent: "pi_fixture" } },
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload, secret: env.STRIPE_WEBHOOK_SECRET, cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  await stub.receiveWebhook(new TextEncoder().encode(payload).buffer as ArrayBuffer, signature, null);
  expect((await stub.status(principal)).testOrder?.state).toBe("awaiting_commerce");

  const [wake] = await stub.listWakes(principal, bindingRef!, 25);
  expect(wake.attemptId).toBe("attempt-one");
  expect(await stub.acknowledgeWake(principal, wake)).toBe(true);
  const recorded = await stub.status(principal);
  expect(recorded.testOrder).toEqual({ provider: "stripe", total: { currency: "USD", minor: "1200" }, paidAt, state: "recorded" });

  // The Registry setup page reads exactly what the service sends.
  expect(decodeStatus(JSON.parse(JSON.stringify(recorded)))).toEqual(recorded);
  const screen = projectSetupScreen({ availability: "available", status: recorded });
  expect(screen.steps[1].status).toBe("complete");
  // The service verified this Stripe TEST connection, so the page says so.
  expect(recorded.connectionEvidence).toMatchObject({ provider: "stripe", mode: "test", result: "verified" });
  expect(screen.overall).toBe("Connected: Stripe test mode");
});

test("only the current connection's paid TEST checkouts count, and a saved one wins over a newer one", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/account") return Response.json({ object: "account", id: "acct_platform" });
    if (url.hostname === "api.stripe.com" && url.pathname === "/v2/core/accounts/acct_runtime") return Response.json(readyAccount("acct_runtime"));
    return new Response("missing", { status: 404 });
  });
  const siteId = crypto.randomUUID();
  const owner = { accountId: "synthetic-owner", siteId };
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  const bindingRef = "binding_runtime";
  await runInDurableObject(stub, instance => {
    const sql = (instance as any).ctx.storage.sql;
    sql.exec("INSERT INTO connection_state (id,value) VALUES (1,?)", JSON.stringify({
      bindingRef, owner, mode: "test", startedAt: 1, stripeAccountId: "acct_runtime",
    }));
    const paid = (attemptId: string, paidAt: number, account = "acct_runtime", binding = bindingRef, amount = "1500") => sql.exec(
      "INSERT INTO paid_test_checkouts (attempt_id,binding_ref,provider,account_ref,amount_minor,currency,paid_at) VALUES (?,?,?,?,?,?,?)",
      attemptId, binding, "stripe", account, amount, "USD", paidAt,
    );
    const notice = (eventId: string, attemptId: string, acknowledgedAt: number | null, account = "acct_runtime") => sql.exec(
      "INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,mode,received_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,?)",
      eventId, attemptId, siteId, bindingRef, account, "test", 1, acknowledgedAt,
    );
    paid("attempt_saved", 1_000, "acct_runtime", bindingRef, "1200");
    notice("evt_saved", "attempt_saved", 5);
    paid("attempt_newer", 2_000);
    notice("evt_newer", "attempt_newer", null);
    // Acknowledged under another receiving account: not this connection's confirmation.
    notice("evt_foreign", "attempt_newer", 6, "acct_other");
    paid("attempt_other_account", 3_000, "acct_other");
    paid("attempt_other_binding", 4_000, "acct_runtime", "binding_other");
  });

  expect((await stub.status(owner)).testOrder).toEqual({
    provider: "stripe", total: { currency: "USD", minor: "1200" }, paidAt: 1_000, state: "recorded",
  });
  await runInDurableObject(stub, instance => {
    (instance as any).ctx.storage.sql.exec("DELETE FROM paid_test_checkouts WHERE attempt_id='attempt_saved'");
  });
  expect((await stub.status(owner)).testOrder).toEqual({
    provider: "stripe", total: { currency: "USD", minor: "1500" }, paidAt: 2_000, state: "awaiting_commerce",
  });
  expect(await runInDurableObject(stub, async instance => {
    try { return await (instance as any).status({ accountId: "other-owner", siteId }); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe("connection_owner_mismatch");

  // Authorize.net notices carry its merchant ID instead of a Stripe account.
  const authorizeNet = { bindingRef: "binding_anet", providerId: "authorize_net", authorizeNetMerchantId: "synthetic-merchant", mode: "test" };
  const evidence = await runInDurableObject(stub, instance => {
    const object = instance as any;
    const sql = object.ctx.storage.sql;
    const outcome = (minor: string) => ({
      outcome: "paid", attemptId: "attempt_anet", total: { currency: "USD", minor }, paymentId: "60001",
      session: { sessionId: "token", redirectUrl: "https://test.authorize.net/payment/payment", createdAt: 1, expiresAt: 1861 },
    });
    object.recordPaid(authorizeNet, outcome("700"));
    object.recordPaid(authorizeNet, outcome("999"));
    object.recordPaid({ ...authorizeNet, mode: "live" }, { ...outcome("800"), attemptId: "attempt_live" });
    const waiting = object.paidTestCheckout(authorizeNet);
    sql.exec(
      "INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,authorize_net_merchant_id,mode,received_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,?,?)",
      "evt_anetother", "attempt_anet", siteId, "binding_anet", "", "other-merchant", "test", 1, 2,
    );
    const otherMerchant = object.paidTestCheckout(authorizeNet);
    sql.exec(
      "INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,authorize_net_merchant_id,mode,received_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,?,?)",
      "evt_anet", "attempt_anet", siteId, "binding_anet", "", "synthetic-merchant", "test", 1, 3,
    );
    return {
      waiting, otherMerchant, saved: object.paidTestCheckout(authorizeNet),
      live: sql.exec("SELECT attempt_id FROM paid_test_checkouts WHERE attempt_id='attempt_live'").toArray().length,
    };
  });
  expect(evidence.waiting).toMatchObject({ provider: "authorize_net", total: { currency: "USD", minor: "700" }, state: "awaiting_notice" });
  expect(evidence.otherMerchant.state).toBe("awaiting_notice");
  expect(evidence.saved).toEqual({ ...evidence.waiting, state: "recorded" });
  expect(evidence.live).toBe(0);
});
