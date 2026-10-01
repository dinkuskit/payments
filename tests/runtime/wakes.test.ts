import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { createAccountAuthenticator } from "../../src/hosted/auth.js";
import { createHostedHandler } from "../../src/hosted/http.js";

const bindingRef = "binding_runtime";
const accountId = "acct_runtime";

function principal(siteId: string, owner = "synthetic-owner") {
  return { accountId: owner, siteId };
}

function attempt(siteId: string, attemptId: string, overrides: Record<string, unknown> = {}) {
  return {
    attemptId, bindingRef, stripeAccountId: accountId, mode: "test", siteId,
    requestFingerprint: "original-request", lines: [], amountMinor: "100", currency: "USD",
    claimedAtMs: 1_800_000_000_000, requestedExpiresAtSeconds: 1_800_001_800,
    providerCreatedAtSeconds: 1_800_000_000, providerExpiresAtSeconds: 1_800_001_800,
    idempotencyKey: "original-key", successUrl: "https://merchant.invalid/success",
    cancelUrl: "https://merchant.invalid/cancel", stripeSessionId: `cs_${attemptId}`,
    redirectUrl: `https://checkout.stripe.com/c/pay/cs_${attemptId}`, ...overrides,
  };
}

function wake(eventId: string, attemptId: string, wokeAt: number) {
  return { eventId, attemptId, bindingRef, deliveryGeneration: 1, wokeAt };
}

async function seedConnection(
  stub: any,
  siteId: string,
  attempts: Record<string, unknown>[],
  owner = principal(siteId),
) {
  await runInDurableObject(stub, instance => {
    const sql = (instance as any).ctx.storage.sql;
    sql.exec("INSERT INTO connection_state (id,value) VALUES (1,?)", JSON.stringify({
      bindingRef, owner, mode: "test", startedAt: 1, stripeAccountId: accountId,
    }));
    for (const record of attempts) {
      sql.exec("INSERT INTO checkout_attempts (attempt_id,value) VALUES (?,?)", (record as any).attemptId, JSON.stringify(record));
    }
  });
}

async function eventRows(stub: any) {
  return runInDurableObject(stub, instance => (instance as any).ctx.storage.sql.exec(
    "SELECT event_id,attempt_id,site_id,binding_ref,stripe_account_id,mode,received_at,acknowledged_at,delivery_generation FROM checkout_wake_events ORDER BY event_id",
  ).toArray());
}

async function errorFrom(stub: any, operation: (instance: any) => Promise<unknown>) {
  return runInDurableObject(stub, async instance => {
    try {
      await operation(instance);
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

test("real SQLite additive upgrade preserves canonical, tombstone, legacy, and attempt bytes", async () => {
  const siteId = crypto.randomUUID();
  const owner = principal(siteId);
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  const pendingAttempt = attempt(siteId, "attempt_pending");
  const ackedAttempt = attempt(siteId, "attempt_acked");
  const historicalAttempt = attempt(siteId, "attempt_legacy");
  const pending = wake("evt_pending", pendingAttempt.attemptId, 1_800_000_000_123);
  const acked = wake("evt_acked", ackedAttempt.attemptId, 1_800_000_000_124);
  const attemptBytes = [
    [pendingAttempt.attemptId, JSON.stringify(pendingAttempt)],
    [ackedAttempt.attemptId, JSON.stringify(ackedAttempt)],
    [historicalAttempt.attemptId, JSON.stringify(historicalAttempt)],
  ];

  await seedConnection(stub, siteId, [pendingAttempt, ackedAttempt, historicalAttempt]);
  await runInDurableObject(stub, instance => {
    const sql = (instance as any).ctx.storage.sql;
    sql.exec("DROP TABLE checkout_wake_events");
    sql.exec("CREATE TABLE checkout_wake_events (event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, site_id TEXT NOT NULL, binding_ref TEXT NOT NULL, stripe_account_id TEXT NOT NULL, mode TEXT NOT NULL, received_at INTEGER NOT NULL, acknowledged_at INTEGER)");
    sql.exec("INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,mode,received_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,NULL)",
      pending.eventId, pending.attemptId, siteId, bindingRef, accountId, "test", pending.wokeAt);
    sql.exec("INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,mode,received_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,?)",
      acked.eventId, acked.attemptId, siteId, bindingRef, accountId, "test", acked.wokeAt, 1_800_000_000_999);
    sql.exec("INSERT INTO checkout_wakes (attempt_id,woke_at) VALUES (?,?)", historicalAttempt.attemptId, 1_700_000_000_001);
  });
  await evictDurableObject(stub);
  const reopened = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));

  expect(await reopened.listWakes(owner, bindingRef, 25)).toEqual([pending]);
  expect(await reopened.listWakes(owner, bindingRef, 25)).toEqual([pending]);
  expect((await reopened.listWakes(owner, bindingRef, 25)).some((item: any) => item.attemptId === historicalAttempt.attemptId)).toBe(false);
  expect(await reopened.acknowledgeWake(owner, pending)).toBe(true);
  expect(await reopened.acknowledgeWake(owner, pending)).toBe(true);
  expect(await reopened.acknowledgeWake(owner, acked)).toBe(true);
  expect(await reopened.listWakes(owner, bindingRef, 25)).toEqual([]);

  await evictDurableObject(reopened);
  const final = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  const preserved = await runInDurableObject(final, instance => {
    const sql = (instance as any).ctx.storage.sql;
    return {
      columns: sql.exec("PRAGMA table_info(checkout_wake_events)").toArray().map((column: any) => column.name),
      events: sql.exec("SELECT event_id,received_at,acknowledged_at,delivery_generation FROM checkout_wake_events ORDER BY event_id").toArray(),
      legacy: sql.exec("SELECT attempt_id,woke_at FROM checkout_wakes ORDER BY attempt_id").toArray(),
      attempts: sql.exec("SELECT attempt_id,value FROM checkout_attempts ORDER BY attempt_id").toArray(),
    };
  });
  expect(preserved.columns).toContain("delivery_generation");
  expect(preserved.events).toEqual([
    { event_id: "evt_acked", received_at: acked.wokeAt, acknowledged_at: 1_800_000_000_999, delivery_generation: 1 },
    { event_id: "evt_pending", received_at: pending.wokeAt, acknowledged_at: expect.any(Number), delivery_generation: 1 },
  ]);
  expect(preserved.legacy).toEqual([{ attempt_id: historicalAttempt.attemptId, woke_at: 1_700_000_000_001 }]);
  expect(preserved.attempts).toEqual([
    { attempt_id: ackedAttempt.attemptId, value: attemptBytes[1][1] },
    { attempt_id: historicalAttempt.attemptId, value: attemptBytes[2][1] },
    { attempt_id: pendingAttempt.attemptId, value: attemptBytes[0][1] },
  ]);
});

test("wrong owners, foreign bindings, and row or attempt context mismatches disclose or mutate nothing", async () => {
  const siteId = crypto.randomUUID();
  const owner = principal(siteId);
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  const record = attempt(siteId, "attempt_reject");
  const event = wake("evt_reject", record.attemptId, 1_800_000_000_200);
  await seedConnection(stub, siteId, [record]);
  await runInDurableObject(stub, instance => (instance as any).ctx.storage.sql.exec(
    "INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,mode,received_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,NULL)",
    event.eventId, event.attemptId, siteId, bindingRef, accountId, "test", event.wokeAt,
  ));

  const wrongOwner = principal(siteId, "other-owner");
  expect(await errorFrom(stub, instance => instance.listWakes(wrongOwner, bindingRef, 25))).toBe("connection_owner_mismatch");
  expect(await errorFrom(stub, instance => instance.acknowledgeWake(wrongOwner, event))).toBe("connection_owner_mismatch");
  const foreign = { ...event, bindingRef: "foreign-binding" };
  expect(await errorFrom(stub, instance => instance.listWakes(owner, foreign.bindingRef, 25))).toBe("binding_not_found");
  expect(await errorFrom(stub, instance => instance.acknowledgeWake(owner, foreign))).toBe("binding_not_found");

  for (const [field, value, restored] of [
    ["site_id", "other-site", siteId], ["binding_ref", "other-binding", bindingRef],
    ["stripe_account_id", "acct_other", accountId], ["mode", "live", "test"],
  ] as const) {
    await runInDurableObject(stub, instance => (instance as any).ctx.storage.sql.exec(
      `UPDATE checkout_wake_events SET ${field}=? WHERE event_id=?`, value, event.eventId,
    ));
    expect(await errorFrom(stub, instance => instance.listWakes(owner, bindingRef, 25)))
      .toBe(field === "binding_ref" ? "allowed" : "wake_association_mismatch");
    expect(await errorFrom(stub, instance => instance.acknowledgeWake(owner, event))).toBe("wake_association_mismatch");
    expect((await eventRows(stub))[0].acknowledged_at).toBeNull();
    await runInDurableObject(stub, instance => (instance as any).ctx.storage.sql.exec(
      `UPDATE checkout_wake_events SET ${field}=? WHERE event_id=?`, restored, event.eventId,
    ));
  }
  for (const [field, value] of [
    ["siteId", "other-site"], ["bindingRef", "other-binding"],
    ["stripeAccountId", "acct_other"], ["mode", "live"],
  ] as const) {
    await runInDurableObject(stub, instance => {
      const sql = (instance as any).ctx.storage.sql;
      const current = sql.exec<{ value: string }>("SELECT value FROM checkout_attempts WHERE attempt_id=?", record.attemptId).toArray()[0].value;
      sql.exec("UPDATE checkout_attempts SET value=? WHERE attempt_id=?", JSON.stringify({ ...JSON.parse(current), [field]: value }), record.attemptId);
    });
    expect(await errorFrom(stub, instance => instance.listWakes(owner, bindingRef, 25))).toBe("wake_association_mismatch");
    expect(await errorFrom(stub, instance => instance.acknowledgeWake(owner, event))).toBe("wake_association_mismatch");
    expect((await eventRows(stub))[0].acknowledged_at).toBeNull();
    await runInDurableObject(stub, instance => (instance as any).ctx.storage.sql.exec(
      "UPDATE checkout_attempts SET value=? WHERE attempt_id=?", JSON.stringify(record), record.attemptId,
    ));
  }
  expect((await eventRows(stub))[0]).toMatchObject({
    event_id: event.eventId, attempt_id: event.attemptId, site_id: siteId,
    binding_ref: bindingRef, stripe_account_id: accountId, mode: "test",
  });
});

test("exact ACK rejects stale or foreign snapshots, retains newer work, and serializes ACK races", async () => {
  const siteId = crypto.randomUUID();
  const owner = principal(siteId);
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  const firstRecord = attempt(siteId, "attempt_first");
  const newerRecord = attempt(siteId, "attempt_newer");
  const concurrentRecord = attempt(siteId, "attempt_concurrent");
  const first = wake("evt_first", firstRecord.attemptId, 1_800_000_000_300);
  const newer = wake("evt_newer", newerRecord.attemptId, 1_800_000_000_301);
  const concurrent = wake("evt_concurrent", concurrentRecord.attemptId, 1_800_000_000_302);
  await seedConnection(stub, siteId, [firstRecord, newerRecord, concurrentRecord]);
  await runInDurableObject(stub, instance => {
    const sql = (instance as any).ctx.storage.sql;
    for (const item of [first, newer, concurrent]) {
      sql.exec("INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,mode,received_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,NULL)",
        item.eventId, item.attemptId, siteId, bindingRef, accountId, "test", item.wokeAt);
    }
  });

  for (const forged of [
    { ...first, attemptId: "wrong-attempt" }, { ...first, bindingRef: "wrong-binding" },
    { ...first, deliveryGeneration: 2 }, { ...first, wokeAt: first.wokeAt + 1 },
    { ...first, eventId: "evt_unknown" },
  ]) {
    expect(await errorFrom(stub, instance => instance.acknowledgeWake(owner, forged))).not.toBe("allowed");
  }
  expect((await eventRows(stub)).every((row: any) => row.acknowledged_at === null)).toBe(true);
  expect(await stub.acknowledgeWake(owner, first)).toBe(true);
  expect(await stub.listWakes(owner, bindingRef, 25)).toEqual([newer, concurrent]);
  expect(await errorFrom(stub, instance => instance.acknowledgeWake(owner, { ...first, attemptId: "wrong-after-tombstone" }))).not.toBe("allowed");
  expect(await stub.acknowledgeWake(owner, first)).toBe(true);

  const [left, right] = await Promise.all([
    stub.acknowledgeWake(owner, concurrent), stub.acknowledgeWake(owner, concurrent),
  ]);
  expect([left, right].sort()).toEqual([true, true]);
  expect((await eventRows(stub)).filter((row: any) => row.event_id === concurrent.eventId && row.acknowledged_at !== null)).toHaveLength(1);

  let started!: () => void;
  let hostedAck!: Promise<boolean>;
  const began = new Promise<void>(resolve => { started = resolve; });
  const internal = stub.consumeWakes(async () => {
    started();
    hostedAck = stub.acknowledgeWake(owner, newer);
    await hostedAck;
    return true;
  });
  await began;
  expect(await internal).toEqual({ inspected: 1, acknowledged: 0 });
  expect(await hostedAck).toBe(true);
  expect((await eventRows(stub)).filter((row: any) => row.acknowledged_at === null)).toEqual([]);
});

test("signed JWT list and ACK reach the real Durable Object without provider traffic", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("unexpected provider traffic");
  });
  const siteId = crypto.randomUUID();
  const issuer = "https://accounts.example.invalid";
  const owner = principal(siteId, JSON.stringify([issuer, "merchant-a"]));
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  const record = attempt(siteId, "attempt_http");
  const event = wake("evt_http", record.attemptId, 1_800_000_000_400);
  await seedConnection(stub, siteId, [record], owner);
  await runInDurableObject(stub, instance => (instance as any).ctx.storage.sql.exec(
    "INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,mode,received_at,acknowledged_at) VALUES (?,?,?,?,?,?,?,NULL)",
    event.eventId, event.attemptId, siteId, bindingRef, accountId, "test", event.wokeAt,
  ));
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const authenticate = createAccountAuthenticator(
    { issuer, audience: "dinkus-payments", jwksUrl: `${issuer}/jwks` }, async () => publicKey,
  );
  const signToken = (subject: string) => new SignJWT({ site_id: siteId, scope: "payments:checkout" })
    .setProtectedHeader({ alg: "ES256" }).setIssuer(issuer).setAudience("dinkus-payments")
    .setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const token = await signToken("merchant-a");
  const differentOwnerToken = await signToken("merchant-b");
  const handle = createHostedHandler({
    authenticate, service: () => ({} as any),
    wakes: authenticatedPrincipal => ({
      list: (ref, limit) => stub.listWakes(authenticatedPrincipal, ref, limit),
      acknowledge: snapshot => stub.acknowledgeWake(authenticatedPrincipal, snapshot),
    }),
  });
  const wakeUrl = `https://service.invalid/v1/checkout/wakes?bindingRef=${bindingRef}`;
  const wrongHeaders = { authorization: `Bearer ${differentOwnerToken}`, "x-dinkus-site": siteId };
  const wrongListed = await handle(new Request(wakeUrl, { headers: wrongHeaders }));
  expect(wrongListed.status).toBe(403);
  const wrongAcknowledged = await handle(new Request("https://service.invalid/v1/checkout/wakes/ack", {
    method: "POST", headers: wrongHeaders, body: JSON.stringify(event),
  }));
  expect(wrongAcknowledged.status).toBe(403);
  expect((await eventRows(stub))[0].acknowledged_at).toBeNull();

  const headers = { authorization: `Bearer ${token}`, "x-dinkus-site": siteId };
  const listed = await handle(new Request(wakeUrl, { headers }));
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual([event]);
  const acknowledged = await handle(new Request("https://service.invalid/v1/checkout/wakes/ack", {
    method: "POST", headers, body: JSON.stringify(event),
  }));
  expect(acknowledged.status).toBe(200);
  expect(await acknowledged.json()).toEqual({ acknowledged: true });
  expect((await eventRows(stub))[0].acknowledged_at).toEqual(expect.any(Number));
});

afterEach(() => vi.restoreAllMocks());
