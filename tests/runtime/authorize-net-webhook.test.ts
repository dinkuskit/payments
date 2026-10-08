import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import worker from "../../src/cloudflare/worker";

const bindingRef = "binding_runtime";
const attemptId = "attempt-one";
const signatureKey = "synthetic-signature-key";

function configuredEnv() {
  return {
    ...env,
    ACCOUNT_ISSUER: "https://accounts.example.invalid",
    ACCOUNT_AUDIENCE: "payments-runtime",
    ACCOUNT_JWKS_URL: "https://accounts.example.invalid/jwks",
    PAYMENT_PROVIDER: "authorize_net",
  };
}

async function signedWebhook(notificationId: string) {
  const payload = new TextEncoder().encode(JSON.stringify({
    notificationId,
    eventType: "net.authorize.payment.authcapture.created",
    payload: { transaction: { transId: "123", order: { invoiceNumber: attemptId } } },
  }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signatureKey),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const digest = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, payload))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { payload, signature: `sha512=${digest}`, notificationId };
}

async function postWebhook(siteId: string, notificationId: string, headerId = notificationId) {
  const signed = await signedWebhook(notificationId);
  return worker.fetch(new Request(`https://payments.example.invalid/v1/webhooks/authorize-net/${siteId}`, {
    method: "POST",
    headers: {
      "x-anet-signature": signed.signature,
      "x-anet-notification-id": headerId,
    },
    body: signed.payload,
  }), configuredEnv());
}

async function wakeEventIds(stub: DurableObjectStub) {
  return runInDurableObject(stub, instance => (instance as {
    ctx: { storage: { sql: { exec: (query: string) => { toArray: () => { event_id: string }[] } } } };
  }).ctx.storage.sql.exec(
    "SELECT event_id FROM checkout_wake_events ORDER BY event_id",
  ).toArray().map(row => row.event_id));
}

test("signed Authorize.net webhooks queue distinct consumable wakes and reject replay or mismatched identity before I/O", async () => {
  const siteId = crypto.randomUUID();
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  await runInDurableObject(stub, instance => {
    (instance as { ctx: { storage: { sql: { exec: (query: string, ...binds: unknown[]) => void } } } }).ctx.storage.sql.exec(
      "INSERT INTO authorize_net_attempts (attempt_id,value) VALUES (?,?)",
      attemptId,
      JSON.stringify({ attemptId, bindingRef }),
    );
  });

  const punctuated = await postWebhook(siteId, "ab");
  const colliding = await postWebhook(siteId, "a-b");
  const longId = "a".repeat(200);
  const long = await postWebhook(siteId, longId);
  expect(punctuated.status).toBe(200);
  expect(colliding.status).toBe(200);
  expect(long.status).toBe(200);

  const ids = await wakeEventIds(stub);
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(3);
  expect(ids.every(id => /^evt_anet[0-9a-f]{64}$/.test(id))).toBe(true);
  expect(ids.every(id => id.length <= 200)).toBe(true);

  const consumed = await stub.consumeWakes(async context => {
    expect(context.attemptId).toBe(attemptId);
    expect(context.siteId).toBe(siteId);
    expect(context.bindingRef).toBe(bindingRef);
    expect(context.authorizeNetMerchantId).toBe("synthetic-merchant");
    expect(Object.prototype.hasOwnProperty.call(context, "stripeAccountId")).toBe(false);
    return true;
  });
  expect(consumed).toEqual({ inspected: 3, acknowledged: 3 });

  const replayed = await postWebhook(siteId, "ab");
  expect(replayed.status).toBe(400);
  expect(await replayed.json()).toEqual({ error: "replayed_event" });
  const mismatched = await postWebhook(siteId, "ab", "a-b");
  expect(mismatched.status).toBe(400);
  expect(await mismatched.json()).toEqual({ error: "notification_id_mismatch" });
  expect(await wakeEventIds(stub)).toEqual(ids);
});
