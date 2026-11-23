import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { buildAuthorizeNetInvoiceReference } from "../../src/authorize-net/checkout";

// Through the real Durable Object: who may read a paid Authorize.net checkout and its paid-twice line, and that a
// try Authorize.net could not answer for is read again later (payments-authorize-net-paid-twice-044).

const attemptId = "attempt-two";
const bindingRef = "binding_anet";
const request = {
  attemptId, bindingRef,
  lines: [{ catalogItemId: "sku", quantity: 1, name: "Item", unitPrice: { currency: "USD", minor: "1200" } }],
  total: { currency: "USD", minor: "1200" },
  paymentWindow: { minSeconds: 1800, maxSeconds: 1860 },
  paymentMethods: ["card"],
};

type Sql = { exec: (query: string, ...binds: unknown[]) => { toArray(): Record<string, unknown>[] } };
type Instance = {
  env: Record<string, unknown>;
  ctx: { storage: { sql: Sql; getAlarm(): Promise<number | null> } };
  lookup(principal: unknown, request: unknown): Promise<{ outcome: string; paymentId?: string }>;
  paidTwice(principal: unknown): Promise<unknown[] | undefined>;
  alarm(): Promise<void>;
};

/** One Authorize.net store: its connection, owned by `owner`, and one checkout with two notified tries and no lookup yet. */
async function store() {
  const siteId = crypto.randomUUID();
  const owner = { accountId: "synthetic-owner", siteId };
  const invoiceNumber = await buildAuthorizeNetInvoiceReference(siteId, attemptId);
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  const now = Math.floor(Date.now() / 1000);
  await runInDurableObject(stub, instance => {
    const sql = (instance as unknown as Instance).ctx.storage.sql;
    sql.exec("INSERT INTO connection_state (id,value) VALUES (1,?)", JSON.stringify({
      bindingRef, owner, mode: "test", providerId: "authorize_net", startedAt: Date.now(), stripeAccountId: null, authorizeNetMerchantId: "synthetic-merchant",
    }));
    sql.exec("INSERT INTO authorize_net_attempts (attempt_id,value) VALUES (?,?)", attemptId, JSON.stringify({
      token: "t", transactionId: "102", transactionIds: ["101", "102"], createdAt: now, expiresAt: now + 1860, tokenAt: now,
      bindingRef, siteId, amountMinor: "1200", currency: "USD",
    }));
  });
  return { siteId, owner, invoiceNumber, stub };
}

/** Authorize.net in the test: 101 is paid; 102 is paid too, but unreadable while `down` holds. */
function authorizeNet(invoiceNumber: string) {
  const state = { down: true, reads: [] as string[] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://apitest.authorize.net/xml/v1/request.api") return originalFetch(input, init);
    const transId = JSON.parse(String(init?.body)).getTransactionDetailsRequest.transId as string;
    state.reads.push(transId);
    if (transId === "102" && state.down) return new Response("unavailable", { status: 503 });
    return Response.json({ messages: { resultCode: "Ok" }, transaction: { transId, responseCode: 1, transactionStatus: "capturedPendingSettlement",
      authAmount: "12.00", order: { invoiceNumber } } });
  }) as typeof fetch;
  return { state, restore: () => { globalThis.fetch = originalFetch; } };
}

async function asAuthorizeNet<T>(stub: DurableObjectStub, fn: (object: Instance) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, async instance => {
    const object = instance as unknown as Instance;
    const saved = object.env.PAYMENT_PROVIDER;
    object.env.PAYMENT_PROVIDER = "authorize_net";
    try { return await fn(object); }
    finally { object.env.PAYMENT_PROVIDER = saved; }
  });
}

const refusal = (call: Promise<unknown>) => call.then(value => ({ value }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));

test("a try Authorize.net could not answer for is read again later, so a second payment still reaches the owner", async () => {
  const { owner, invoiceNumber, stub } = await store();
  const provider = authorizeNet(invoiceNumber);
  try {
    const result = await asAuthorizeNet(stub, async object => {
      const sql = object.ctx.storage.sql;
      // Both notices came before the first lookup. 101 proves the payment; 102 can't be read yet.
      const first = await object.lookup(owner, request);
      const open = sql.exec("SELECT tries FROM authorize_net_open_tries WHERE attempt_id=?", attemptId).toArray();
      const alarm = await object.ctx.storage.getAlarm();
      // A later lookup answers paid from what is kept, without reading Authorize.net again.
      const readsBefore = provider.state.reads.length;
      const second = await object.lookup(owner, request);
      const readsAfter = provider.state.reads.length;
      const before = await object.paidTwice(owner);
      // Authorize.net answers again; the alarm reads 102 and finds the second payment.
      provider.state.down = false;
      sql.exec("UPDATE authorize_net_open_tries SET next_at=0");
      await object.alarm();
      return {
        first, open, alarm, second, readsBefore, readsAfter, before, after: await object.paidTwice(owner),
        left: sql.exec("SELECT attempt_id FROM authorize_net_open_tries").toArray().length,
        record: JSON.parse(String(sql.exec("SELECT value FROM authorize_net_attempts WHERE attempt_id=?", attemptId).toArray()[0].value)),
      };
    });
    expect(result.first).toMatchObject({ outcome: "paid", paymentId: "101" });
    expect(result.open).toEqual([{ tries: 0 }]);
    expect(typeof result.alarm).toBe("number");
    expect(result.second).toMatchObject({ outcome: "paid", paymentId: "101" });
    expect(result.readsAfter).toBe(result.readsBefore);
    expect(result.before).toEqual([]);
    expect(result.after).toEqual([{ transactionIds: ["101", "102"], total: { currency: "USD", minor: "1200" }, at: expect.any(Number) }]);
    expect(result.left).toBe(0);
    expect(result.record).toMatchObject({ paidId: "101", alsoPaid: ["102"] });
  } finally {
    provider.restore();
  }
});

test("only the store's own connection, with its current binding, reads a paid checkout or its paid-twice line", async () => {
  const { siteId, owner, invoiceNumber, stub } = await store();
  const provider = authorizeNet(invoiceNumber);
  provider.state.down = false;
  try {
    const result = await asAuthorizeNet(stub, async object => {
      const sql = object.ctx.storage.sql;
      const paid = await object.lookup(owner, request);
      const reads = provider.state.reads.length;
      const other = { accountId: "another-account", siteId };
      const seen = {
        owner: await object.paidTwice(owner),
        // Another account, even for this store's ID: refused before anything is read.
        otherLookup: await refusal(object.lookup(other, request)),
        otherAlert: await refusal(object.paidTwice(other)),
        // A binding the store no longer has: nothing is answered from what was kept.
        oldBinding: await refusal(object.lookup(owner, { ...request, bindingRef: "binding_old" })),
        readsAfterRefusals: provider.state.reads.length - reads,
      };
      // The store reconnected with a new binding: the old binding's checkout gets no answer.
      const connection = JSON.parse(String(sql.exec("SELECT value FROM connection_state WHERE id=1").toArray()[0].value));
      sql.exec("UPDATE connection_state SET value=? WHERE id=1", JSON.stringify({ ...connection, bindingRef: "binding_new" }));
      const reassigned = await refusal(object.lookup(owner, request));
      // A Stripe connection on this store never sees Authorize.net's line.
      sql.exec("UPDATE connection_state SET value=? WHERE id=1", JSON.stringify({ ...connection, providerId: "stripe", authorizeNetMerchantId: null }));
      const stripe = await refusal(object.paidTwice(owner));
      // Disconnected: the line is no longer shown to anyone.
      sql.exec("DELETE FROM connection_state");
      const disconnected = await refusal(object.paidTwice(owner));
      return { paid, seen, reassigned, stripe, disconnected };
    });
    expect(result.paid).toMatchObject({ outcome: "paid" });
    expect(result.seen.owner).toEqual([{ transactionIds: ["101", "102"], total: { currency: "USD", minor: "1200" }, at: expect.any(Number) }]);
    expect(result.seen.otherLookup).toEqual({ error: "connection_owner_mismatch" });
    expect(result.seen.otherAlert).toEqual({ error: "connection_owner_mismatch" });
    expect(result.seen.oldBinding).toEqual({ value: { outcome: "unknown" } });
    expect(result.seen.readsAfterRefusals).toBe(0);
    expect(result.reassigned).toEqual({ value: { outcome: "unknown" } });
    expect(result.stripe).toEqual({ error: "binding_provider_mismatch" });
    expect(result.disconnected).toEqual({ value: [] });
  } finally {
    provider.restore();
  }
});
