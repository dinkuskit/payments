import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import {
  assertPlaygroundStripeKey, playgroundBinding, playgroundIpKey, takePlaygroundSessionSlot,
  PlaygroundRateLimitError, PLAYGROUND_STRIPE_ACCOUNT_ID,
} from "../src/checkout/playground.ts";
import { createStripeCheckout } from "../src/stripe/checkout.ts";
import { createAccountAuthenticator } from "../src/hosted/auth.ts";

test("playground key must be a Stripe TEST secret key; anything else is stripe_mode_mismatch", () => {
  assert.equal(assertPlaygroundStripeKey("sk_test_synthetic"), "sk_test_synthetic");
  for (const key of ["sk_live_synthetic", "pk_test_synthetic", "pk_live_synthetic", "rk_test_synthetic", "sk_test_", "", undefined, null, 42]) {
    assert.throws(() => assertPlaygroundStripeKey(key), /^Error: stripe_mode_mismatch$/, String(key));
  }
  // The adapter's own mode check is the same fail-closed path.
  assert.throws(() => createStripeCheckout({ apiKey: "sk_live_synthetic", mode: "test" }), /stripe_mode_mismatch/);
  assert.deepEqual(playgroundBinding(), { bindingRef: "playground", providerId: "stripe", stripeAccountId: PLAYGROUND_STRIPE_ACCOUNT_ID, mode: "test" });
});

test("rate slot: 3 per IP per 10 minutes and a tenant ceiling, sliding window", () => {
  const rows = [];
  const store = { hits: (bucket, since) => rows.filter(r => r.bucket === bucket && r.at > since).map(r => r.at), record: (bucket, at) => rows.push({ bucket, at }) };
  const t0 = 1_000_000_000;
  for (let i = 0; i < 3; i++) takePlaygroundSessionSlot(store, "ip-a", t0 + i);
  assert.throws(() => takePlaygroundSessionSlot(store, "ip-a", t0 + 10), error => error instanceof PlaygroundRateLimitError && error.limit === "ip" && error.message === "playground_rate_limited" && error.retryAfterSeconds === 600);
  takePlaygroundSessionSlot(store, "ip-b", t0 + 10);
  takePlaygroundSessionSlot(store, "ip-a", t0 + 10 * 60 * 1000 + 1);
  const tenantRows = Array.from({ length: 60 }, () => ({ bucket: "tenant", at: t0 }));
  const full = { hits: (bucket, since) => tenantRows.filter(r => r.bucket === bucket && r.at > since).map(r => r.at), record: () => assert.fail("must not record") };
  assert.throws(() => takePlaygroundSessionSlot(full, "ip-z", t0 + 1), error => error.limit === "tenant");
});

test("shopper IPs are stored only as an opaque hash", async () => {
  const key = await playgroundIpKey("203.0.113.7");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes("203"));
});

test("the playground pass is checkout-only; a broader or admin pass for the playground is rejected", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const issuer = "https://accounts.example.invalid";
  const verify = createAccountAuthenticator({ issuer, audience: "dinkus-payments", jwksUrl: issuer + "/jwks" }, async () => publicKey);
  const issue = claims => new SignJWT({ site_id: "playground", scope: "payments:checkout", ...claims }).setProtectedHeader({ alg: "ES256" })
    .setIssuer(issuer).setAudience("dinkus-payments").setSubject("playground-worker").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const request = (token, site = "playground") => new Request("https://payments.example.invalid/v1/checkout/session", { headers: { authorization: `Bearer ${token}`, "x-dinkus-site": site } });
  assert.equal((await verify(request(await issue({})), "payments:checkout")).siteId, "playground");
  await assert.rejects(verify(request(await issue({})), "payments:admin"));
  await assert.rejects(verify(request(await issue({ scope: "payments:admin" })), "payments:admin"));
  await assert.rejects(verify(request(await issue({ scope: "payments:checkout payments:admin" })), "payments:checkout"));
  await assert.rejects(verify(request(await issue({}), "merchant-site"), "payments:checkout"));
  // Merchant passes keep their existing combined-scope behavior.
  const merchant = await issue({ site_id: "merchant-site", scope: "payments:checkout payments:admin" });
  assert.equal((await verify(request(merchant, "merchant-site"), "payments:admin")).siteId, "merchant-site");
});
