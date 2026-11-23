import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { buildAuthorizeNetInvoiceReference } from "../../src/authorize-net/checkout";

// Through the real Durable Object: who may read a paid Authorize.net checkout and its paid-twice line, and that a
// try Authorize.net could not answer for is read again later (payments-authorize-net-paid-twice-044).

const attemptId = "attempt-two";
const bindingRef = "binding_anet";
const sessionId = `${"0123456789abcdef".repeat(2)}.${attemptId}`;
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
  authorizeNetPayPage(siteId: string, sessionId: string): Promise<{ action: string; url?: string }>;
  paidTwice(principal: unknown): Promise<unknown[] | undefined>;
  alarm(): Promise<void>;
  receiveAuthorizeNetWebhook(payload: Uint8Array, signature: string, eventId: string, siteId: string): Promise<void>;
};

/** Authorize.net's signed payment notice for one transaction of this checkout, as the webhook route passes it on. */
async function notice(invoiceNumber: string, transactionId: string) {
  const notificationId = crypto.randomUUID();
  const payload = new TextEncoder().encode(JSON.stringify({
    notificationId, eventType: "net.authorize.payment.authcapture.created", eventDate: "2026-11-23T16:00:00.000Z", webhookId: "synthetic-webhook",
    payload: { responseCode: 1, merchantReferenceId: invoiceNumber, authAmount: 12.0, entityName: "transaction", id: transactionId },
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("synthetic-signature-key"), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const digest = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, payload))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { payload, signature: `sha512=${digest}`, notificationId };
}

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
      bindingRef, siteId, amountMinor: "1200", currency: "USD", sessionId,
      redirectUrl: `https://payments.example.invalid/v1/pay/authorize-net/${siteId}/${sessionId}`,
      returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout",
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

test("the shopper's pay page that finds the payment also keeps an unanswered try open for the alarm", async () => {
  const { siteId, owner, invoiceNumber, stub } = await store();
  const provider = authorizeNet(invoiceNumber);
  try {
    const result = await asAuthorizeNet(stub, async object => {
      const sql = object.ctx.storage.sql;
      // No lookup from Commerce: the shopper's return to the pay page is the first read. 101 is paid, 102 unreadable.
      const page = await object.authorizeNetPayPage(siteId, sessionId);
      const open = sql.exec("SELECT tries FROM authorize_net_open_tries WHERE attempt_id=?", attemptId).toArray();
      const alarm = await object.ctx.storage.getAlarm();
      provider.state.down = false;
      sql.exec("UPDATE authorize_net_open_tries SET next_at=0");
      await object.alarm();
      return { page, open, alarm, alerts: await object.paidTwice(owner) };
    });
    expect(result.page).toEqual({ action: "redirect", url: "https://store.example/checkout/success" });
    expect(result.open).toEqual([{ tries: 0 }]);
    expect(typeof result.alarm).toBe("number");
    expect(result.alerts).toEqual([{ transactionIds: ["101", "102"], total: { currency: "USD", minor: "1200" }, at: expect.any(Number) }]);
  } finally {
    provider.restore();
  }
});

test("queued reads and the paid-twice line stay with the account that owned the connection", async () => {
  const { siteId, owner, invoiceNumber, stub } = await store();
  const provider = authorizeNet(invoiceNumber);
  try {
    const result = await asAuthorizeNet(stub, async object => {
      const sql = object.ctx.storage.sql;
      await object.lookup(owner, request);
      const connection = JSON.parse(String(sql.exec("SELECT value FROM connection_state WHERE id=1").toArray()[0].value));
      // The store's connection passes to another account before the alarm runs.
      const next = { accountId: "next-owner", siteId };
      sql.exec("UPDATE connection_state SET value=? WHERE id=1", JSON.stringify({ ...connection, owner: next, bindingRef: "binding_next" }));
      provider.state.down = false;
      const reads = provider.state.reads.length;
      sql.exec("UPDATE authorize_net_open_tries SET next_at=0");
      await object.alarm();
      const dropped = { readsByAlarm: provider.state.reads.length - reads, left: sql.exec("SELECT attempt_id FROM authorize_net_open_tries").toArray().length };
      // A notice found for the first owner is never shown to the next one, even after it is recorded.
      sql.exec("INSERT INTO authorize_net_paid_twice (attempt_id,transaction_ids,amount_minor,noticed_at,owner_account) VALUES (?,?,?,?,?)",
        "attempt-old", JSON.stringify(["201", "202"]), "500", Date.now(), owner.accountId);
      const nextSees = await object.paidTwice(next);
      // The same owner reconnecting with a new binding still sees it: the refund is still theirs to make.
      sql.exec("UPDATE connection_state SET value=? WHERE id=1", JSON.stringify({ ...connection, bindingRef: "binding_again" }));
      const ownerSees = await object.paidTwice(owner);
      return { dropped, nextSees, ownerSees };
    });
    expect(result.dropped).toEqual({ readsByAlarm: 0, left: 0 });
    expect(result.nextSees).toEqual([]);
    expect(result.ownerSees).toEqual([{ transactionIds: ["201", "202"], total: { currency: "USD", minor: "500" }, at: expect.any(Number) }]);
  } finally {
    provider.restore();
  }
});

test("a late notice of a second payment reaches only the account whose connection the checkout was opened under", async () => {
  /** One store whose checkout was paid with 101 alone; then, unless `replace`, a notice for 102 arrives as is. */
  async function run(replace: boolean) {
    const { siteId, owner, invoiceNumber, stub } = await store();
    const provider = authorizeNet(invoiceNumber);
    provider.state.down = false;
    try {
      return await asAuthorizeNet(stub, async object => {
        const sql = object.ctx.storage.sql;
        const stored = JSON.parse(String(sql.exec("SELECT value FROM authorize_net_attempts WHERE attempt_id=?", attemptId).toArray()[0].value));
        sql.exec("UPDATE authorize_net_attempts SET value=? WHERE attempt_id=?", JSON.stringify({ ...stored, transactionId: "101", transactionIds: ["101"] }), attemptId);
        const paid = await object.lookup(owner, request);
        const next = { accountId: "next-owner", siteId };
        if (replace) {
          // The store's connection is replaced by another account's before Authorize.net's notice for 102 arrives.
          const connection = JSON.parse(String(sql.exec("SELECT value FROM connection_state WHERE id=1").toArray()[0].value));
          sql.exec("UPDATE connection_state SET value=? WHERE id=1", JSON.stringify({ ...connection, owner: next, bindingRef: "binding_next" }));
        }
        const reads = provider.state.reads.length;
        const signed = await notice(invoiceNumber, "102");
        await object.receiveAuthorizeNetWebhook(signed.payload, signed.signature, signed.notificationId, siteId);
        sql.exec("UPDATE authorize_net_open_tries SET next_at=0");
        await object.alarm();
        return {
          paid: paid.paymentId,
          readsAfterNotice: provider.state.reads.slice(reads),
          rows: sql.exec("SELECT transaction_ids AS ids, owner_account AS owner FROM authorize_net_paid_twice").toArray(),
          queued: sql.exec("SELECT attempt_id FROM authorize_net_open_tries").toArray().length,
          seen: replace ? await object.paidTwice(next) : await object.paidTwice(owner),
        };
      });
    } finally {
      provider.restore();
    }
  }
  const allowed = await run(false), forbidden = await run(true);
  // Allowed: the checkout's own connection still stands, so 102 is read and its owner sees both payments.
  expect(allowed).toEqual({ paid: "101", readsAfterNotice: ["102"], rows: [{ ids: JSON.stringify(["101", "102"]), owner: "synthetic-owner" }], queued: 0,
    seen: [{ transactionIds: ["101", "102"], total: { currency: "USD", minor: "1200" }, at: expect.any(Number) }] });
  // Forbidden: the replacement account's connection never reads 102, records nothing, and sees nothing.
  expect(forbidden).toEqual({ paid: "101", readsAfterNotice: [], rows: [], queued: 0, seen: [] });
  console.log("late notice", JSON.stringify({ allowed: { reads: allowed.readsAfterNotice, owners: allowed.rows.map(row => row.owner) }, forbidden: { reads: forbidden.readsAfterNotice, rows: forbidden.rows.length } }));
});

test("only a pay-page visit whose session the page accepted queues reads of Authorize.net", async () => {
  const { siteId, owner, invoiceNumber, stub } = await store();
  const provider = authorizeNet(invoiceNumber);
  try {
    const result = await asAuthorizeNet(stub, async object => {
      const sql = object.ctx.storage.sql;
      // Paid with 101; 102 stayed unreadable until its reads ran out, so nothing is queued any more.
      await object.lookup(owner, request);
      sql.exec("DELETE FROM authorize_net_open_tries");
      const queued = () => sql.exec("SELECT attempt_id FROM authorize_net_open_tries").toArray().length;
      provider.state.down = false;
      // Forbidden: the checkout's ID with a made-up secret.
      const wrong = await object.authorizeNetPayPage(siteId, `${"f".repeat(32)}.${attemptId}`);
      const afterWrong = queued(), reads = provider.state.reads.length;
      sql.exec("UPDATE authorize_net_open_tries SET next_at=0");
      await object.alarm();
      const alarmReadsAfterWrong = provider.state.reads.length - reads;
      // Allowed: the shopper's own session.
      const right = await object.authorizeNetPayPage(siteId, sessionId);
      return { wrong, afterWrong, alarmReadsAfterWrong, right, afterRight: queued() };
    });
    expect(result.wrong).toEqual({ action: "not_found" });
    expect(result.afterWrong).toBe(0);
    expect(result.alarmReadsAfterWrong).toBe(0);
    expect(result.right).toEqual({ action: "redirect", url: "https://store.example/checkout/success" });
    expect(result.afterRight).toBe(1);
    console.log("pay page", JSON.stringify(result));
  } finally {
    provider.restore();
  }
});

test("a store stored by the Worker before this change keeps working after the upgrade", async () => {
  const { siteId, owner, invoiceNumber, stub } = await store();
  const provider = authorizeNet(invoiceNumber);
  try {
    const result = await runInDurableObject(stub, async instance => {
      const old = instance as unknown as Instance;
      const sql = old.ctx.storage.sql;
      // As main 6d78c3b left a store: none of this change's tables, and its checkout in main's record shape
      // (no paidId, alsoPaid, settled or requestFingerprint), which store() wrote.
      sql.exec("DROP TABLE authorize_net_paid_twice");
      sql.exec("DROP TABLE authorize_net_open_tries");
      const before = String(sql.exec("SELECT value FROM authorize_net_attempts WHERE attempt_id=?", attemptId).toArray()[0].value);
      // The deploy: this build's Durable Object starts on the same storage.
      const upgraded = new (instance.constructor as new (ctx: unknown, env: unknown) => Instance)(old.ctx, { ...old.env, PAYMENT_PROVIDER: "authorize_net" });
      const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('authorize_net_paid_twice','authorize_net_open_tries') ORDER BY name").toArray().map(row => row.name);
      const page = await upgraded.authorizeNetPayPage(siteId, sessionId);
      const paid = await upgraded.lookup(owner, request);
      provider.state.down = false;
      sql.exec("UPDATE authorize_net_open_tries SET next_at=0");
      await upgraded.alarm();
      const after = JSON.parse(String(sql.exec("SELECT value FROM authorize_net_attempts WHERE attempt_id=?", attemptId).toArray()[0].value));
      return { tables, page, paid, alerts: await upgraded.paidTwice(owner), before: JSON.parse(before), after };
    });
    expect(result.tables).toEqual(["authorize_net_open_tries", "authorize_net_paid_twice"]);
    expect(result.page).toEqual({ action: "redirect", url: "https://store.example/checkout/success" });
    expect(result.paid).toMatchObject({ outcome: "paid", paymentId: "101" });
    expect(result.alerts).toEqual([{ transactionIds: ["101", "102"], total: { currency: "USD", minor: "1200" }, at: expect.any(Number) }]);
    // Every field main stored is kept as it was; this change only adds its own.
    expect(result.after).toMatchObject(result.before);
    expect(result.after).toMatchObject({ paidId: "101", alsoPaid: ["102"] });
    console.log("upgrade", JSON.stringify({ tables: result.tables, paid: result.paid.paymentId, alerts: result.alerts?.length, kept: Object.keys(result.before).length }));
  } finally {
    provider.restore();
  }
});
