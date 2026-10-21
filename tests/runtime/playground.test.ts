import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import Stripe from "stripe";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../../src/cloudflare/worker";
import { PLAYGROUND_RETENTION_MS, PLAYGROUND_STRIPE_ACCOUNT_ID } from "../../src/checkout/playground.js";

afterEach(() => vi.restoreAllMocks());

const issuer = "https://accounts.example.invalid";
const audience = "payments-runtime-playground";
const origin = "https://playground.example.invalid";
const keys = await generateKeyPair("ES256");
const jwk = { ...await exportJWK(keys.publicKey), kid: "synthetic-playground", alg: "ES256", use: "sig" };
const configured = { ...env, ACCOUNT_ISSUER: issuer, ACCOUNT_AUDIENCE: audience, ACCOUNT_JWKS_URL: issuer + "/jwks" };
const playgroundStub = () => env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", "playground"]));

function issue(claims: Record<string, unknown> = {}) {
  return new SignJWT({ site_id: "playground", scope: "payments:checkout", site_origin: origin, ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "synthetic-playground" }).setIssuer(issuer).setAudience(audience)
    .setSubject("playground-worker").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
}

function payment(attemptId: string, bindingRef = "playground") {
  return {
    attemptId, bindingRef,
    lines: [{ catalogItemId: "sku-1", quantity: 1, name: "Hat", unitPrice: { currency: "USD", minor: "1200" } }],
    total: { currency: "USD", minor: "1200" },
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
    paymentMethods: ["card"],
  };
}

type StripeState = { creates: URLSearchParams[]; stripeAccountHeaders: (string | null)[]; paid: Set<string>; sessions: Map<string, Record<string, unknown>> };

function stripeFixture(): StripeState {
  const state: StripeState = { creates: [], stripeAccountHeaders: [], paid: new Set(), sessions: new Map() };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.href === issuer + "/jwks") return Response.json({ keys: [jwk] });
    if (url.hostname !== "api.stripe.com") throw new Error(`unexpected host ${url.hostname}`);
    state.stripeAccountHeaders.push(new Headers(init?.headers).get("stripe-account"));
    if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
      const params = new URLSearchParams(String(init.body ?? ""));
      state.creates.push(params);
      const id = `cs_test_pg${state.creates.length}`;
      const expiresAt = Number(params.get("expires_at"));
      const session = {
        object: "checkout.session", id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid",
        amount_total: 1200, currency: "usd", created: expiresAt - 1860, expires_at: expiresAt, livemode: false, payment_intent: null,
        metadata: { dinkus_attempt: params.get("metadata[dinkus_attempt]"), dinkus_binding: params.get("metadata[dinkus_binding]"), dinkus_site: params.get("metadata[dinkus_site]") },
        payment_method_types: ["card"],
      };
      state.sessions.set(id, session);
      return Response.json(session);
    }
    const sessionMatch = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_test_pg\d+)$/);
    if (sessionMatch) {
      const session = state.sessions.get(sessionMatch[1])!;
      return Response.json(state.paid.has(sessionMatch[1])
        ? { ...session, url: null, status: "complete", payment_status: "paid", payment_intent: `pi_${sessionMatch[1]}` } : session);
    }
    const intentMatch = url.pathname.match(/^\/v1\/payment_intents\/pi_(cs_test_pg\d+)$/);
    if (intentMatch) return Response.json({ object: "payment_intent", id: `pi_${intentMatch[1]}`, status: "succeeded", amount: 1200, currency: "usd", latest_charge: null });
    return new Response("missing", { status: 404 });
  });
  return state;
}

async function call(path: string, options: { method?: string; body?: unknown; token?: string; ip?: string | null; site?: string; env?: typeof configured } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token ?? await issue()}`, "x-dinkus-site": options.site ?? "playground" };
  if (options.ip !== null) headers["x-dinkus-client-ip"] = options.ip ?? "203.0.113.7";
  const body = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  return worker.fetch(new Request("https://payments.example.invalid" + path, { method: options.method ?? (body ? "POST" : "GET"), headers, body }), options.env ?? configured);
}

beforeEach(async () => {
  await runInDurableObject(playgroundStub(), instance => {
    for (const table of ["checkout_attempts", "playground_attempts", "playground_rate_hits", "checkout_wake_events", "checkout_wakes"]) {
      instance.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
});

test("playground session uses the sandbox key directly, expires >= 30 min out, and confirms by session_id", async () => {
  const stripe = stripeFixture();
  const before = Math.floor(Date.now() / 1000);
  const created = await call("/v1/checkout/session", { body: payment("pg-attempt-1") });
  expect(created.status).toBe(200);
  const outcome = await created.json<{ outcome: string; session: { sessionId: string; expiresAt: number } }>();
  expect(outcome.outcome).toBe("open");
  expect(outcome.session.expiresAt).toBeGreaterThanOrEqual(before + 1800);
  const sent = stripe.creates[0];
  expect(Number(sent.get("expires_at"))).toBeGreaterThanOrEqual(before + 1800);
  expect(sent.get("line_items[0][price_data][unit_amount]")).toBe("1200");
  expect(sent.get("success_url")).toBe(`${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`);
  expect(sent.get("metadata[dinkus_site]")).toBe("playground");
  // The key is the sandbox account's own: no Stripe-Account header.
  expect(stripe.stripeAccountHeaders.every(header => header === null)).toBe(true);
  await runInDurableObject(playgroundStub(), instance => {
    const record = JSON.parse(instance.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM checkout_attempts WHERE attempt_id='pg-attempt-1'").one().value);
    expect(record.stripeAccountId).toBe(PLAYGROUND_STRIPE_ACCOUNT_ID);
    expect(record.siteId).toBe("playground");
    // Only Stripe ids and catalog data; no shopper identity.
    expect(JSON.stringify(record)).not.toMatch(/203\.0\.113\.7|email/i);
  });
  stripe.paid.add(outcome.session.sessionId);
  const receipt = await call(`/v1/checkout/receipt?session_id=${outcome.session.sessionId}`);
  expect(receipt.status).toBe(200);
  expect(await receipt.json()).toMatchObject({ outcome: "paid", attemptId: "pg-attempt-1" });
  const lookup = await call("/v1/checkout/lookup", { body: payment("pg-attempt-1") });
  expect(await lookup.json()).toMatchObject({ outcome: "paid" });
  expect(await (await call("/v1/checkout/receipt?session_id=cs_test_unknown")).json()).toEqual({ outcome: "unknown" });
  expect((await call("/v1/checkout/receipt?session_id=cs_live_nope")).status).toBe(400);
});

test("a live or publishable playground key fails closed with stripe_mode_mismatch before Stripe is called", async () => {
  for (const key of ["sk_live_synthetic", "pk_test_synthetic", "pk_live_synthetic", "rk_test_synthetic"]) {
    const stripe = stripeFixture();
    await runInDurableObject(playgroundStub(), instance => {
      (instance as unknown as { env: Env }).env = { ...instance["env" as keyof typeof instance] as Env, STRIPE_PLAYGROUND_SECRET_KEY: key };
    });
    const response = await call("/v1/checkout/session", { body: payment(`pg-live-${key}`) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "stripe_mode_mismatch" });
    expect(stripe.creates).toHaveLength(0);
    vi.restoreAllMocks();
  }
  await runInDurableObject(playgroundStub(), instance => {
    (instance as unknown as { env: Env }).env = { ...instance["env" as keyof typeof instance] as Env, STRIPE_PLAYGROUND_SECRET_KEY: "sk_test_synthetic_playground_fixture" };
  });
  stripeFixture();
  const unset = await call("/v1/checkout/session", { body: payment("pg-unset"), env: { ...configured, STRIPE_PLAYGROUND_SECRET_KEY: "" } });
  expect(unset.status).toBe(503);
  expect(await unset.json()).toEqual({ error: "playground_unconfigured" });
});

test("playground queues no wakes, even for a verified Stripe webhook", async () => {
  stripeFixture();
  const created = await call("/v1/checkout/session", { body: payment("pg-wake") });
  const { session } = await created.json<{ session: { sessionId: string } }>();
  const payload = JSON.stringify({ id: "evt_pg", object: "event", type: "checkout.session.completed", data: { object: { object: "checkout.session", id: session.sessionId, metadata: { dinkus_site: "playground", dinkus_attempt: "pg-wake", dinkus_binding: "playground" } } } });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: "whsec_synthetic_fixture" });
  const webhook = await worker.fetch(new Request("https://payments.example.invalid/v1/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature }, body: payload }), configured);
  expect(webhook.status).toBe(200);
  // Even a wake that reached the object directly is dropped for the playground.
  await playgroundStub().receiveWebhook(new TextEncoder().encode(payload).buffer as ArrayBuffer, signature, null).catch(() => undefined);
  await runInDurableObject(playgroundStub(), instance => {
    expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM checkout_wake_events").one().n).toBe(0);
    expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM checkout_wakes").one().n).toBe(0);
  });
  // And the wake routes are closed to the playground's narrow pass.
  expect((await call("/v1/checkout/wakes?bindingRef=playground")).status).toBe(403);
  expect(await playgroundStub().listWakes({ accountId: "x", siteId: "playground" }, "playground", 25)).toEqual([]);
});

test("a Stripe webhook refused inside a store's object answers 409 with its code", async () => {
  stripeFixture();
  const payload = JSON.stringify({ id: "evt_refused", object: "event", type: "checkout.session.completed", livemode: false, account: "acct_refused", data: { object: { object: "checkout.session", id: "cs_test_refused", livemode: false, metadata: { dinkus_site: "site-refused", dinkus_attempt: "no-such-attempt", dinkus_binding: "binding-refused" } } } });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: "whsec_synthetic_fixture" });
  const webhook = await worker.fetch(new Request("https://payments.example.invalid/v1/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature }, body: payload }), configured);
  expect(webhook.status).toBe(409);
  expect(await webhook.json()).toEqual({ error: "unknown_attempt" });
});

test("about 3 sessions per 10 minutes per client IP, then a stable public 429", async () => {
  const stripe = stripeFixture();
  for (let i = 0; i < 3; i++) {
    expect((await call("/v1/checkout/session", { body: payment(`pg-rate-${i}`) })).status).toBe(200);
  }
  // Retrying an existing attempt is not a new session and is not counted.
  expect((await call("/v1/checkout/session", { body: payment("pg-rate-0") })).status).toBe(200);
  const limited = await call("/v1/checkout/session", { body: payment("pg-rate-3") });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("600");
  expect(await limited.json()).toMatchObject({ error: "playground_rate_limited" });
  expect(stripe.creates).toHaveLength(3);
  // A different shopper IP still gets a slot.
  expect((await call("/v1/checkout/session", { body: payment("pg-rate-4"), ip: "198.51.100.9" })).status).toBe(200);
  // No forwarded shopper IP: fail closed before the Durable Object.
  expect((await call("/v1/checkout/session", { body: payment("pg-rate-5"), ip: null })).status).toBe(400);
  // Malformed or overlong forwarded IPs fail closed with a clear 400 before the Durable Object.
  for (const ip of ["abcd", "::::", "1".repeat(46)]) {
    const rejected = await call("/v1/checkout/session", { body: payment("pg-rate-6"), ip });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_client_ip" });
  }
  expect(stripe.creates).toHaveLength(4);
  // Invalid bodies are rejected before any Durable Object or limit is touched.
  const hits = await runInDurableObject(playgroundStub(), instance => instance.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM playground_rate_hits").one().n);
  expect((await call("/v1/checkout/session", { body: { ...payment("pg-bad"), total: { currency: "EUR", minor: "1200" } }, ip: "192.0.2.1" })).status).toBe(400);
  expect((await call("/v1/checkout/session", { body: "{not json", ip: "192.0.2.1" })).status).toBe(400);
  expect(await runInDurableObject(playgroundStub(), instance => instance.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM playground_rate_hits").one().n)).toBe(hits);
});

test("the per-tenant limit applies across IPs", async () => {
  stripeFixture();
  await runInDurableObject(playgroundStub(), instance => {
    for (let i = 0; i < 60; i++) instance.ctx.storage.sql.exec("INSERT INTO playground_rate_hits (bucket,at) VALUES ('tenant',?)", Date.now() - 1000);
  });
  const limited = await call("/v1/checkout/session", { body: payment("pg-tenant"), ip: "192.0.2.50" });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ error: "playground_rate_limited" });
});

test("the tenant-wide limit follows PLAYGROUND_TENANT_RATE_LIMIT and falls back on invalid values", async () => {
  stripeFixture();
  const setVars = (vars: Record<string, string>) => runInDurableObject(playgroundStub(), instance => {
    (instance as unknown as { env: Env }).env = { ...instance["env" as keyof typeof instance] as Env, ...vars } as Env;
  });
  await setVars({ PLAYGROUND_TENANT_RATE_LIMIT: "2", PLAYGROUND_TENANT_RATE_WINDOW_SECONDS: "600" });
  expect((await call("/v1/checkout/session", { body: payment("pg-cfg-1"), ip: "192.0.2.61" })).status).toBe(200);
  expect((await call("/v1/checkout/session", { body: payment("pg-cfg-2"), ip: "192.0.2.62" })).status).toBe(200);
  const limited = await call("/v1/checkout/session", { body: payment("pg-cfg-3"), ip: "192.0.2.63" });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ error: "playground_rate_limited" });
  // An invalid value falls back to the default 60, so the next session is allowed.
  await setVars({ PLAYGROUND_TENANT_RATE_LIMIT: "not-a-number", PLAYGROUND_TENANT_RATE_WINDOW_SECONDS: "-5" });
  expect((await call("/v1/checkout/session", { body: payment("pg-cfg-4"), ip: "192.0.2.64" })).status).toBe(200);
  await setVars({ PLAYGROUND_TENANT_RATE_LIMIT: "60", PLAYGROUND_TENANT_RATE_WINDOW_SECONDS: "600" });
});

test("playground checkout records and rate hits are purged after 24 h by the alarm", async () => {
  stripeFixture();
  expect((await call("/v1/checkout/session", { body: payment("pg-old") })).status).toBe(200);
  expect((await call("/v1/checkout/session", { body: payment("pg-new"), ip: "198.51.100.20" })).status).toBe(200);
  const alarm = await runInDurableObject(playgroundStub(), async instance => {
    const sql = instance.ctx.storage.sql;
    sql.exec("UPDATE playground_attempts SET created_at=? WHERE attempt_id='pg-old'", Date.now() - PLAYGROUND_RETENTION_MS - 1);
    sql.exec("UPDATE playground_rate_hits SET at=?", Date.now() - PLAYGROUND_RETENTION_MS - 1);
    // A non-playground record in the same table is never touched by the purge.
    sql.exec("INSERT INTO checkout_attempts (attempt_id,value) VALUES ('other','{}')");
    return instance.ctx.storage.getAlarm();
  });
  expect(alarm).toBeGreaterThan(Date.now());
  expect(await runDurableObjectAlarm(playgroundStub())).toBe(true);
  await runInDurableObject(playgroundStub(), async instance => {
    const ids = instance.ctx.storage.sql.exec<{ attempt_id: string }>("SELECT attempt_id FROM checkout_attempts ORDER BY attempt_id").toArray().map(row => row.attempt_id);
    expect(ids).toEqual(["other", "pg-new"]);
    expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM playground_rate_hits").one().n).toBe(0);
    expect(await instance.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
});

test("the playground pass is checkout-only and cannot touch other tenants", async () => {
  stripeFixture();
  // site_id pins the pass to the playground; presenting another site fails auth.
  expect((await call("/v1/checkout/session", { body: payment("pg-x", "other-binding"), site: "merchant-site" })).status).toBe(401);
  // A pass for another site cannot claim the playground header.
  const other = await issue({ site_id: "merchant-site" });
  expect((await call("/v1/checkout/session", { token: other, body: payment("pg-x") })).status).toBe(401);
  // No admin: neither on admin routes nor a broader scope string. Status takes a
  // checkout pass for store admins, but the playground's stays closed to it.
  expect((await call("/v1/status")).status).toBe(403);
  expect((await call("/v1/connect", { method: "POST" })).status).toBe(401);
  expect((await call("/v1/checkout/session", { token: await issue({ scope: "payments:checkout payments:admin" }), body: payment("pg-x") })).status).toBe(401);
  // Binding routes are closed to it.
  expect((await call("/v1/existing-binding?bindingRef=playground")).status).toBe(403);
  // Another tenant's binding reference is not reachable from the playground.
  const foreign = await call("/v1/checkout/session", { body: payment("pg-foreign", "merchant-binding-ref") });
  expect(await foreign.json()).toEqual({ outcome: "unknown" });
  // Merchants cannot use the playground receipt route.
  const merchantToken = await issue({ site_id: "merchant-site", site_origin: "https://merchant.example.invalid" });
  expect((await call("/v1/checkout/receipt?session_id=cs_test_pg1", { token: merchantToken, site: "merchant-site" })).status).toBe(404);
  // Playground-only object methods refuse any other principal.
  const refused = await playgroundStub().playgroundLookup({ accountId: "x", siteId: "merchant-site" }, payment("pg-x") as never).then(() => null, (error: Error) => error.message);
  expect(refused).toBe("binding_mismatch");
});

test("IPv6 shoppers in one /64 and mixed-case spellings share one per-IP bucket", async () => {
  const stripe = stripeFixture();
  expect((await call("/v1/checkout/session", { body: payment("pg-v6-0"), ip: "2001:db8:a:b::1" })).status).toBe(200);
  expect((await call("/v1/checkout/session", { body: payment("pg-v6-1"), ip: "2001:DB8:A:B::FFFF" })).status).toBe(200);
  expect((await call("/v1/checkout/session", { body: payment("pg-v6-2"), ip: "2001:db8:a:b:1:2:3:4" })).status).toBe(200);
  expect((await call("/v1/checkout/session", { body: payment("pg-v6-3"), ip: "2001:0db8:000a:000b::9" })).status).toBe(429);
  // A different /64 and a valid IPv4 shopper still get slots.
  expect((await call("/v1/checkout/session", { body: payment("pg-v6-4"), ip: "2001:db8:a:c::1" })).status).toBe(200);
  expect((await call("/v1/checkout/session", { body: payment("pg-v4-0"), ip: "192.0.2.77" })).status).toBe(200);
  expect(stripe.creates).toHaveLength(5);
});
