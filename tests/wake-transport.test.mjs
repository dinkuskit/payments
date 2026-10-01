import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { createHostedHandler } from "../src/hosted/http.ts";
import { assertCommercePaymentWake } from "../src/checkout/wakes.ts";
import { createAccountAuthenticator } from "../src/hosted/auth.ts";

const principal = { accountId: "issuer:merchant-a", siteId: "store-a" };
const wake = {
  eventId: "evt_one",
  attemptId: "attempt-one",
  bindingRef: "binding-one",
  deliveryGeneration: 1,
  wokeAt: 1_800_000_000_000,
};

test("Commerce wake snapshots require exactly five fields and safe identity values", () => {
  assert.doesNotThrow(() => assertCommercePaymentWake(wake));
  for (const field of Object.keys(wake)) {
    const malformed = { ...wake };
    delete malformed[field];
    assert.throws(() => assertCommercePaymentWake(malformed), /invalid_wake/);
  }
  assert.throws(() => assertCommercePaymentWake({ ...wake, extra: true }), /invalid_wake/);
  assert.throws(() => assertCommercePaymentWake({ ...wake, deliveryGeneration: 0 }), /invalid_wake/);
  assert.throws(() => assertCommercePaymentWake({ ...wake, wokeAt: Infinity }), /invalid_wake/);
});

test("wake HTTP authenticates before list or ACK storage and keeps list non-destructive", async () => {
  const calls = [];
  let authenticateCalls = 0;
  let listCalls = 0;
  let ackCalls = 0;
  const handle = createHostedHandler({
    authenticate: async (request, scope) => {
      authenticateCalls++;
      if (request.headers.get("authorization") !== "Bearer valid" || scope !== "payments:checkout") throw new Error("unauthorized");
      return principal;
    },
    service: () => ({}),
    wakes: () => ({
      list: async (bindingRef, limit) => {
        calls.push(["list", bindingRef, limit]);
        listCalls++;
        return [wake];
      },
      acknowledge: async snapshot => {
        calls.push(["ack", snapshot]);
        ackCalls++;
        return true;
      },
    }),
  });

  const missing = await handle(new Request("https://service.invalid/v1/checkout/wakes?bindingRef=binding-one"));
  assert.equal(missing.status, 401);
  assert.equal(listCalls, 0);

  const headers = { authorization: "Bearer valid" };
  const first = await handle(new Request("https://service.invalid/v1/checkout/wakes?bindingRef=binding-one", { headers }));
  const second = await handle(new Request("https://service.invalid/v1/checkout/wakes?bindingRef=binding-one&limit=100", { headers }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), [wake]);
  assert.deepEqual(await second.json(), [wake]);
  assert.deepEqual(calls.slice(0, 2), [["list", "binding-one", 25], ["list", "binding-one", 100]]);

  const malformed = await handle(new Request("https://service.invalid/v1/checkout/wakes/ack", {
    method: "POST", headers, body: JSON.stringify({ ...wake, extra: true }),
  }));
  assert.equal(malformed.status, 400);
  assert.equal(ackCalls, 0);
  const acknowledged = await handle(new Request("https://service.invalid/v1/checkout/wakes/ack", {
    method: "POST", headers, body: JSON.stringify(wake),
  }));
  assert.equal(acknowledged.status, 200);
  assert.deepEqual(await acknowledged.json(), { acknowledged: true });
  assert.equal(authenticateCalls, 5);
});

test("wake list rejects malformed or caller-selected query configuration", async () => {
  const handle = createHostedHandler({
    authenticate: async () => principal,
    service: () => ({}),
    wakes: () => ({ list: async () => [], acknowledge: async () => false }),
  });
  const headers = { authorization: "Bearer valid" };
  for (const query of [
    "?limit=25",
    "?bindingRef=binding-one&limit=0",
    "?bindingRef=binding-one&limit=101",
    "?bindingRef=binding-one&limit=1.0",
    "?bindingRef=binding-one&siteId=store-a",
  ]) {
    const response = await handle(new Request(`https://service.invalid/v1/checkout/wakes${query}`, { headers }));
    assert.equal(response.status, 400, query);
  }
});

test("signed JWT scope and site checks reject both wake paths before storage", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const issuer = "https://accounts.example.invalid";
  const authenticate = createAccountAuthenticator(
    { issuer, audience: "dinkus-payments", jwksUrl: `${issuer}/jwks` },
    async () => publicKey,
  );
  const issue = (scope, siteId = "store-a") => new SignJWT({ site_id: siteId, scope })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(issuer).setAudience("dinkus-payments").setSubject("merchant-a")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  let storageCalls = 0;
  const handle = createHostedHandler({
    authenticate,
    service: () => ({}),
    wakes: () => ({
      list: async () => { storageCalls++; return []; },
      acknowledge: async () => { storageCalls++; return true; },
    }),
  });
  const valid = await issue("payments:checkout");
  const admin = await issue("payments:admin");
  for (const [path, init] of [
    ["/v1/checkout/wakes?bindingRef=binding-one", {}],
    ["/v1/checkout/wakes/ack", { method: "POST", body: JSON.stringify(wake) }],
  ]) {
    for (const [token, site] of [
      [null, "store-a"],
      [admin, "store-a"],
      [valid, "store-b"],
    ]) {
      const headers = { "x-dinkus-site": site };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await handle(new Request(`https://service.invalid${path}`, {
        ...init,
        headers,
      }));
      assert.equal(response.status, 401);
    }
  }
  assert.equal(storageCalls, 0);
});
