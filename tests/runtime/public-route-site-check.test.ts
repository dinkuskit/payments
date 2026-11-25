import { env, runInDurableObject } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../../src/cloudflare/worker";

// Proof for the public-route site check: every request goes through the real Worker
// entry, and the trace counts Durable Object lookups and Authorize.net calls per request.
// Each trace row is printed as `PROOF {json}` so proof/public-route-site-check-20261125
// can show the same rows on main and on this branch.

afterEach(() => vi.restoreAllMocks());

const attemptId = "attempt-one";
const secret = "0123456789abcdef0123456789abcdef";
const sessionId = `${secret}.${attemptId}`;
const issuer = "https://accounts.example.invalid";
const audience = "payments-runtime";

type Row = { route: string; case: string; status: number; doLookups: number; providerCalls: number };

function harness() {
  const names: string[] = [];
  let providerCalls = 0;
  const namespace = env.PAYMENT_CONNECTIONS;
  const counted = new Proxy(namespace, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "getByName" || property === "idFromName") {
        return (name: string, ...rest: unknown[]) => {
          names.push(name);
          return (value as (...args: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const configured = {
    ...env,
    PAYMENT_CONNECTIONS: counted,
    ACCOUNT_ISSUER: issuer,
    ACCOUNT_AUDIENCE: audience,
    ACCOUNT_JWKS_URL: `${issuer}/jwks`,
    PAYMENT_PROVIDER: "authorize_net",
  };
  const rows: Row[] = [];
  const send = async (route: string, label: string, request: Request) => {
    const beforeNames = names.length, beforeCalls = providerCalls;
    const response = await worker.fetch(request, configured as typeof env);
    await response.arrayBuffer();
    const row = { route, case: label, status: response.status, doLookups: names.length - beforeNames, providerCalls: providerCalls - beforeCalls };
    rows.push(row);
    console.log(`PROOF ${JSON.stringify(row)}`);
    return row;
  };
  return { rows, send, countProvider: () => { providerCalls++; } };
}

async function seed(siteId: string) {
  const now = Math.floor(Date.now() / 1000);
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  await runInDurableObject(stub, instance => {
    (instance as { ctx: { storage: { sql: { exec: (query: string, ...binds: unknown[]) => void } } } }).ctx.storage.sql.exec(
      "INSERT INTO authorize_net_attempts (attempt_id,value) VALUES (?,?)", attemptId, JSON.stringify({
        token: "stored-token", transactionId: null, createdAt: now - 960, expiresAt: now + 900, bindingRef: "binding_runtime", siteId,
        amountMinor: "1200", currency: "USD", sessionId, redirectUrl: `https://payments.example.invalid/v1/pay/authorize-net/${siteId}/${sessionId}`,
        tokenAt: now - 960, returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout",
      }),
    );
  });
}

test("public Authorize.net routes refuse malformed store names and sessions before any Durable Object lookup", async () => {
  const { rows, send, countProvider } = harness();
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://apitest.authorize.net/xml/v1/request.api") return originalFetch(input, init);
    countProvider();
    return Response.json({ messages: { resultCode: "Ok" }, token: "minted-token" });
  });
  const store = crypto.randomUUID();
  await seed(store);
  const pay = (path: string) => new Request(`https://payments.example.invalid/v1/pay/authorize-net/${path}`);
  const notice = (site: string) => new Request(`https://payments.example.invalid/v1/webhooks/authorize-net/${site}`, {
    method: "POST", headers: { "x-anet-signature": `sha512=${"0".repeat(128)}`, "x-anet-notification-id": "proof-notice" }, body: "{}",
  });

  const accepted = await send("pay page", "the store's own session", pay(`${store}/${sessionId}`));
  const wrongSession = await send("pay page", "well-formed wrong session secret", pay(`${store}/${"f".repeat(32)}.${attemptId}`));
  const crossStore = await send("pay page", "this session under another store", pay(`${crypto.randomUUID()}/${sessionId}`));
  const malformedPay = [
    await send("pay page", "percent-encoded store name", pay(`store%20a/${sessionId}`)),
    await send("pay page", "non-ASCII store name", pay(`caf%C3%A9/${sessionId}`)),
    await send("pay page", "201-character store name", pay(`${"s".repeat(201)}/${sessionId}`)),
    await send("pay page", "malformed session", pay(`${store}/not-a-session`)),
  ];
  const malformedNotice = [
    await send("notice", "percent-encoded store name", notice("store%20a")),
    await send("notice", "non-ASCII store name", notice("caf%C3%A9")),
    await send("notice", "201-character store name", notice("s".repeat(201))),
  ];
  const wellFormedNotice = await send("notice", "well-formed store name, bad signature", notice(store));

  expect(accepted).toMatchObject({ status: 200, doLookups: 1, providerCalls: 1 });
  expect(wrongSession).toMatchObject({ status: 404, doLookups: 1, providerCalls: 0 });
  expect(crossStore).toMatchObject({ status: 404, doLookups: 1, providerCalls: 0 });
  for (const row of [...malformedPay, ...malformedNotice]) expect(row).toMatchObject({ status: 404, doLookups: 0, providerCalls: 0 });
  // The signature is checked inside the store's object, so a well-formed name still reaches it and is refused there.
  expect(wellFormedNotice).toMatchObject({ doLookups: 1, providerCalls: 0 });
  expect(wellFormedNotice.status).toBeGreaterThanOrEqual(400);
  expect(rows).toHaveLength(11);
});

test("a store pass with a malformed site id is refused before any Durable Object lookup", async () => {
  const { send } = harness();
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(publicKey), kid: "proof-pass", alg: "ES256", use: "sig" };
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    return originalFetch(input, init);
  });
  const status = async (label: string, site: string) => {
    const token = await new SignJWT({ site_id: site, scope: "payments:admin" })
      .setProtectedHeader({ alg: "ES256", kid: "proof-pass" }).setIssuer(issuer).setAudience(audience)
      .setSubject("proof-merchant").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return send("store pass", label, new Request("https://payments.example.invalid/v1/status", {
      headers: { authorization: `Bearer ${token}`, "x-dinkus-site": site },
    }));
  };
  const good = await status("a DinkusKit.com site id (UUID)", crypto.randomUUID());
  const longest = await status("200-character site id", "S".repeat(200));
  const refused = [
    await status("site id with a space", "store a"),
    await status("non-ASCII site id", "café"),
    await status("201-character site id", "S".repeat(201)),
  ];
  expect(good).toMatchObject({ status: 200, doLookups: 1 });
  expect(longest).toMatchObject({ status: 200, doLookups: 1 });
  for (const row of refused) expect(row).toMatchObject({ status: 401, doLookups: 0, providerCalls: 0 });
});
