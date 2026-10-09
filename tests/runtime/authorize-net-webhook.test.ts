import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  authorizeNetStoreTag,
  buildAuthorizeNetInvoiceReference,
} from "../../src/authorize-net/checkout";
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

async function signedWebhook(notificationId: string, invoiceNumber: string, transactionId = "123") {
  const payload = new TextEncoder().encode(JSON.stringify({
    notificationId,
    eventType: "net.authorize.payment.authcapture.created",
    payload: { transaction: { transId: transactionId, order: { invoiceNumber } } },
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

async function postWebhook(
  siteId: string,
  notificationId: string,
  invoiceNumber: string,
  headerId = notificationId,
  transactionId = "123",
) {
  const signed = await signedWebhook(notificationId, invoiceNumber, transactionId);
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

async function attemptRecord(stub: DurableObjectStub, id = attemptId) {
  return runInDurableObject(stub, instance => {
    const row = (instance as {
      ctx: { storage: { sql: { exec: (query: string, ...binds: unknown[]) => { toArray: () => { value: string }[] } } } };
    }).ctx.storage.sql.exec("SELECT value FROM authorize_net_attempts WHERE attempt_id=?", id).toArray()[0];
    return row ? JSON.parse(row.value) as { transactionId?: string | null; siteId?: string } : null;
  });
}

async function webhookEventCount(stub: DurableObjectStub) {
  return runInDurableObject(stub, instance => (instance as {
    ctx: { storage: { sql: { exec: (query: string) => { toArray: () => unknown[] } } } };
  }).ctx.storage.sql.exec("SELECT event_id FROM authorize_net_webhook_events").toArray().length);
}

async function seedAttempt(stub: DurableObjectStub, siteId: string, id = attemptId) {
  await runInDurableObject(stub, instance => {
    (instance as { ctx: { storage: { sql: { exec: (query: string, ...binds: unknown[]) => void } } } }).ctx.storage.sql.exec(
      "INSERT INTO authorize_net_attempts (attempt_id,value) VALUES (?,?)",
      id,
      JSON.stringify({ attemptId: id, bindingRef, siteId, transactionId: null }),
    );
  });
}

test("signed Authorize.net webhooks queue distinct consumable wakes and reject replay or mismatched identity before I/O", async () => {
  const siteId = crypto.randomUUID();
  const invoiceNumber = await buildAuthorizeNetInvoiceReference(siteId, attemptId);
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  await seedAttempt(stub, siteId);

  const punctuated = await postWebhook(siteId, "ab", invoiceNumber);
  const colliding = await postWebhook(siteId, "a-b", invoiceNumber);
  const longId = "a".repeat(200);
  const long = await postWebhook(siteId, longId, invoiceNumber);
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

  const replayed = await postWebhook(siteId, "ab", invoiceNumber);
  expect(replayed.status).toBe(400);
  expect(await replayed.json()).toEqual({ error: "replayed_event" });
  const mismatched = await postWebhook(siteId, "ab", invoiceNumber, "a-b");
  expect(mismatched.status).toBe(400);
  expect(await mismatched.json()).toEqual({ error: "notification_id_mismatch" });
  expect(await wakeEventIds(stub)).toEqual(ids);
});

test("validly signed wrong-store notification is rejected before transactionId, wake, or lookup", async () => {
  const siteA = crypto.randomUUID();
  const siteB = crypto.randomUUID();
  const invoiceForA = await buildAuthorizeNetInvoiceReference(siteA, attemptId);
  const stubA = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteA]));
  const stubB = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteB]));
  // Colliding attempt IDs: both stores own the same Commerce attempt id.
  await seedAttempt(stubA, siteA);
  await seedAttempt(stubB, siteB);

  let lookupCalls = 0;
  await runInDurableObject(stubB, instance => {
    const original = (instance as { lookup: (principal: unknown, request: unknown) => Promise<unknown> }).lookup.bind(instance);
    (instance as { lookup: (principal: unknown, request: unknown) => Promise<unknown> }).lookup = async (principal, request) => {
      lookupCalls += 1;
      return original(principal, request);
    };
  });

  // Valid HMAC-SHA512 for store A's invoice reference, posted to store B's URL.
  const forbidden = await postWebhook(siteB, "cross-store-1", invoiceForA, "cross-store-1", "999");
  expect(forbidden.status).toBe(400);
  expect(await forbidden.json()).toEqual({ error: "site_mismatch" });

  expect(await wakeEventIds(stubB)).toEqual([]);
  expect(await wakeEventIds(stubA)).toEqual([]);
  expect((await attemptRecord(stubB))?.transactionId ?? null).toBeNull();
  expect((await attemptRecord(stubA))?.transactionId ?? null).toBeNull();
  expect(await webhookEventCount(stubB)).toBe(0);
  expect(lookupCalls).toBe(0);

  // Right-store happy path still works with the same colliding attempt id.
  const allowed = await postWebhook(siteA, "cross-store-1", invoiceForA, "cross-store-1", "999");
  expect(allowed.status).toBe(200);
  expect(await wakeEventIds(stubA)).toHaveLength(1);
  expect((await attemptRecord(stubA))?.transactionId).toBe("999");
  expect(await wakeEventIds(stubB)).toEqual([]);
  expect((await attemptRecord(stubB))?.transactionId ?? null).toBeNull();
  expect(lookupCalls).toBe(0);
});

test("malformed and legacy invoice references are rejected with no durable writes", async () => {
  const siteId = crypto.randomUUID();
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  await seedAttempt(stub, siteId);
  const tag = await authorizeNetStoreTag(siteId);

  for (const [label, invoiceNumber] of [
    ["legacy-bare-attempt", attemptId],
    ["missing-separator", `${tag}${attemptId}`],
    ["wrong-tag-length", `abcd.${attemptId}`],
    ["empty-attempt", `${tag}.`],
  ] as const) {
    const response = await postWebhook(siteId, `malformed-${label}`, invoiceNumber);
    expect(response.status, label).toBe(400);
    expect(await response.json(), label).toEqual({ error: "invalid_invoice_reference" });
  }

  expect(await wakeEventIds(stub)).toEqual([]);
  expect((await attemptRecord(stub))?.transactionId ?? null).toBeNull();
  expect(await webhookEventCount(stub)).toBe(0);
});

test("public notification endpoint rejects forged and malformed bytes before durable effects", async () => {
  const siteId = crypto.randomUUID();
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  await seedAttempt(stub, siteId);
  const invoice = await buildAuthorizeNetInvoiceReference(siteId, attemptId);
  const signed = await signedWebhook("forged-notification", invoice);
  for (const [payload, signature] of [
    [signed.payload, `sha512=${"0".repeat(128)}`],
    [new TextEncoder().encode("{bad-json"), signed.signature],
  ] as const) {
    const response = await worker.fetch(new Request(`https://payments.example.invalid/v1/webhooks/authorize-net/${siteId}`, {
      method: "POST",
      headers: { "x-anet-signature": signature, "x-anet-notification-id": signed.notificationId },
      body: payload,
    }), configuredEnv());
    expect(response.status).toBe(400);
    expect(await wakeEventIds(stub)).toEqual([]);
    expect(await webhookEventCount(stub)).toBe(0);
    expect((await attemptRecord(stub))?.transactionId ?? null).toBeNull();
  }
});
