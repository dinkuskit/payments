import { configureStripeCountry } from "../helpers/merchant-country.js";
import { stripeV2Account, stripeV2Link } from "../helpers/stripe-v2.js";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

test("real Durable Object storage preserves the binding across eviction and gates readiness", async () => {
  let ready = false, creates = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/account") return Response.json({ object: "account", id: "acct_platform" });
    if (path === "/v2/core/accounts" && init?.method === "POST") creates++;
    const body = path === "/v2/core/account_links"
      ? stripeV2Link()
      : stripeV2Account("acct_fixture", ready);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  const principal = { accountId: "synthetic-owner", siteId: crypto.randomUUID() };
  const name = JSON.stringify(["test", principal.siteId]);
  const first = env.PAYMENT_CONNECTIONS.getByName(name);
  await configureStripeCountry(first, principal.siteId);
  const connected = await first.startOnboarding(principal);
  expect(connected.state).toBe("setup_required");
  expect(connected.url).toBe("https://accounts.stripe.com/r/acct_fixture#alu_test_synthetic");
  expect(connected.connectionEvidence).toBeUndefined();
  await evictDurableObject(first);
  const second = env.PAYMENT_CONNECTIONS.getByName(name);
  expect((await second.startOnboarding(principal)).bindingRef).toBe(connected.bindingRef);
  expect(creates).toBe(1);
  expect(await second.status(principal)).toMatchObject({
    state: "setup_required",
    mode: "test",
    connectionEvidence: {
      provider: "stripe",
      mode: "test",
      result: "unknown",
      accountRef: "acct_fixture",
    },
  });
  expect(await second.checkoutBinding(principal, connected.bindingRef!)).toBeNull();
  ready = true;
  expect(await second.status(principal)).toMatchObject({
    state: "ready",
    connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_fixture" },
  });
  expect(await second.checkoutBinding(principal, connected.bindingRef!)).toMatchObject({ stripeAccountId: "acct_fixture", mode: "test" });
  ready = false;
  expect(await second.status(principal)).toMatchObject({
    state: "setup_required",
    connectionEvidence: { provider: "stripe", mode: "test", result: "unknown", accountRef: "acct_fixture" },
  });
  expect(await second.checkoutBinding(principal, connected.bindingRef!)).toBeNull();
  // Catch the expected application error inside the object. The current
  // Vitest RPC wrapper reports rejected RPC calls as unhandled rejections.
  const denied = await runInDurableObject(second, async instance => {
    try { await instance.status({ ...principal, accountId: "someone-else" }); return "allowed"; }
    catch (error) { return error instanceof Error ? error.message : "unknown"; }
  });
  expect(denied).toBe("connection_owner_mismatch");
});

test("unconfigured shared identity returns unavailable, never a fake signed-in identity", async () => {
  const response = await exports.default.fetch("https://payments.example.invalid/v1/status");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "payments_service_unconfigured" });
});


test("persisted create failure diagnostics survive eviction without another provider request", async () => {
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => { if (new URL(String(input)).pathname === "/v1/account") return Response.json({object:"account",id:"acct_platform"}); calls++; throw Error("synthetic-private-provider-material"); });
  const principal = { accountId: "synthetic-diagnostic-owner", siteId: crypto.randomUUID() };
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  await configureStripeCountry(stub, principal.siteId);
  expect((await stub.startOnboarding(principal)).state).toBe("connecting");
  expect(calls).toBe(1);
  await evictDurableObject(stub);
  const restored = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
  const first = await restored.connectionDiagnostics(principal);
  expect(first).toMatchObject({ state: "connecting", mode: "test", processorAccountPresent: false, evidence: "observed", lastFailure: { category: "transport_unknown" } });
  expect(JSON.stringify(first)).not.toContain("synthetic-private-provider-material");
  expect(await restored.connectionDiagnostics(principal)).toEqual(first);
  expect(calls).toBe(1);
});
