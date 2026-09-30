import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

test("real Durable Object storage preserves the binding across eviction and gates readiness", async () => {
  let ready = false, creates = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/accounts" && init?.method === "POST") creates++;
    const body = path === "/v1/account_links"
      ? { object: "account_link", url: "https://connect.stripe.com/setup/fixture", expires_at: Math.floor(Date.now() / 1000) + 600 }
      : { object: "account", id: "acct_fixture", details_submitted: ready, charges_enabled: ready, payouts_enabled: ready, capabilities: { card_payments: ready ? "active" : "pending" }, requirements: {} };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  const principal = { accountId: "synthetic-owner", siteId: crypto.randomUUID() };
  const name = JSON.stringify(["test", principal.siteId]);
  const first = env.PAYMENT_CONNECTIONS.getByName(name);
  const connected = await first.startOnboarding(principal);
  expect(connected.state).toBe("setup_required");
  expect(connected.url).toBe("https://connect.stripe.com/setup/fixture");
  await evictDurableObject(first);
  const second = env.PAYMENT_CONNECTIONS.getByName(name);
  expect((await second.startOnboarding(principal)).bindingRef).toBe(connected.bindingRef);
  expect(creates).toBe(1);
  expect(await second.checkoutBinding(principal, connected.bindingRef!)).toBeNull();
  ready = true;
  expect(await second.checkoutBinding(principal, connected.bindingRef!)).toMatchObject({ stripeAccountId: "acct_fixture", mode: "test" });
  ready = false;
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
