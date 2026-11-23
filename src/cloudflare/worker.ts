import { DurableObject } from "cloudflare:workers";
import { storeReturnPages, type ReturnPages } from "../checkout/return-pages.js";
import { CheckoutError, createCheckoutSessionService, type AttemptRecord } from "../checkout/sessions.js";
import { createStripeWebhookVerifier, createWebhookHandler, WebhookError } from "../checkout/webhook.js";
import { assertCommercePaymentWake, assertWakeContext, consumeWakeBatch, WakeError, type CommercePaymentWake, type ReconciliationResult, type WakeContext, type WakeEventStore } from "../checkout/wakes.js";
import { ConnectionError, createConnectionService, type CheckoutBinding, type Connection, type Principal, type Status, type TestOrderEvidence } from "../hosted/connection.js";
import { createAccountAuthenticator } from "../hosted/auth.js";
import { createHostedHandler } from "../hosted/http.js";
import { authorizeNetPayPagePath } from "../hosted/manifest.js";
import { createStripeCheckout } from "../stripe/checkout.js";
import {
  assertPlaygroundStripeKey,
  isPlayground,
  playgroundBinding,
  playgroundIpKey,
  takePlaygroundSessionSlot,
  PLAYGROUND_BINDING_REF,
  PLAYGROUND_IP_LIMIT,
  PLAYGROUND_RETENTION_MS,
  PLAYGROUND_SITE_ID,
  PLAYGROUND_STRIPE_ACCOUNT_ID,
  playgroundTenantLimit,
} from "../checkout/playground.js";
import { createStripeOnboarding } from "../stripe/onboarding.js";
import {
  authorizeNetEndpoints,
  authorizeNetStoreTag,
  createAuthorizeNetGateway,
  createAuthorizeNetPaymentPort,
  parseAuthorizeNetInvoiceReference,
} from "../authorize-net/checkout.js";
import { AuthorizeNetWebhookError, createAuthorizeNetWebhookHandler } from "../authorize-net/webhook.js";
import type { PaymentOutcome, PaymentRequest } from "../commerce/checkout-port.js";
import { checkStripePlatformIdentity } from "../stripe/identity.js";
import type { ProviderIdentityDiagnostic } from "../provider-identity.js";
import type { PaidTwiceNotice } from "../paid-twice.js";

type WakeRow = Record<string, string | number | null> & WakeContext & { deliveryGeneration: number; wokeAt: number; acknowledgedAt: number | null; authorizeNetMerchantId: string | null };
type PaidTestRow = Record<string, string | number> & { amountMinor: string; paidAt: number; noticed: number; recorded: number };

// A payment notice belongs to a paid checkout only for the same attempt,
// binding, TEST mode and receiving account.
const SAME_PAID_CHECKOUT = "w.attempt_id=p.attempt_id AND w.binding_ref=p.binding_ref AND w.mode='test' AND " +
  "(CASE p.provider WHEN 'authorize_net' THEN w.authorize_net_merchant_id ELSE w.stripe_account_id END)=p.account_ref";

function receivingAccount(binding: CheckoutBinding): string {
  return binding.providerId === "authorize_net" ? binding.authorizeNetMerchantId : binding.stripeAccountId;
}

export class PaymentConnection extends DurableObject<Env> {
  private readonly wakeEvents: WakeEventStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS connection_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS checkout_attempts (attempt_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS authorize_net_attempts (attempt_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS authorize_net_webhook_events (event_id TEXT PRIMARY KEY)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS checkout_wakes (attempt_id TEXT PRIMARY KEY, woke_at INTEGER NOT NULL)");
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS checkout_wake_events (event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, site_id TEXT NOT NULL, binding_ref TEXT NOT NULL, stripe_account_id TEXT NOT NULL, authorize_net_merchant_id TEXT, mode TEXT NOT NULL, received_at INTEGER NOT NULL, acknowledged_at INTEGER, delivery_generation INTEGER NOT NULL DEFAULT 1)");
    if (!sql.exec<{ name: string }>("PRAGMA table_info(checkout_wake_events)").toArray().some(column => column.name === "authorize_net_merchant_id")) {
      sql.exec("ALTER TABLE checkout_wake_events ADD COLUMN authorize_net_merchant_id TEXT");
    }
    if (!sql.exec<{ name: string }>("PRAGMA table_info(checkout_wake_events)").toArray().some(column => column.name === "delivery_generation")) {
      sql.exec("ALTER TABLE checkout_wake_events ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 1");
    }
    // Authorize.net checkouts paid more than once, for the owner to refund by hand (payments-authorize-net-paid-twice-044).
    sql.exec("CREATE TABLE IF NOT EXISTS authorize_net_paid_twice (attempt_id TEXT PRIMARY KEY, transaction_ids TEXT NOT NULL, amount_minor TEXT NOT NULL, noticed_at INTEGER NOT NULL)");
    // Paid Authorize.net checkouts with a try Authorize.net could not answer for yet: read again from the alarm,
    // so a second payment still reaches the owner after a notice was already answered.
    sql.exec("CREATE TABLE IF NOT EXISTS authorize_net_open_tries (attempt_id TEXT PRIMARY KEY, site_id TEXT NOT NULL, next_at INTEGER NOT NULL, tries INTEGER NOT NULL)");
    // Setup's "Place a test order" check: the first time the provider confirmed each TEST checkout as paid.
    sql.exec("CREATE TABLE IF NOT EXISTS paid_test_checkouts (attempt_id TEXT PRIMARY KEY, binding_ref TEXT NOT NULL, provider TEXT NOT NULL, account_ref TEXT NOT NULL, amount_minor TEXT NOT NULL, currency TEXT NOT NULL, paid_at INTEGER NOT NULL)");
    // Playground only: which attempts to purge, and opaque rate-limit hits.
    sql.exec("CREATE TABLE IF NOT EXISTS playground_attempts (attempt_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS playground_rate_hits (bucket TEXT NOT NULL, at INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS playground_rate_hits_bucket ON playground_rate_hits (bucket, at)");
    this.wakeEvents = {
      pending: batchLimit => sql.exec<WakeRow>(
        "SELECT event_id AS eventId, attempt_id AS attemptId, site_id AS siteId, binding_ref AS bindingRef, stripe_account_id AS stripeAccountId, authorize_net_merchant_id AS authorizeNetMerchantId, mode FROM checkout_wake_events WHERE acknowledged_at IS NULL ORDER BY received_at ASC LIMIT ?",
        batchLimit,
      ).toArray().map(row => wakeContextFromRow(row)),
      acknowledge: context => {
        assertWakeContext(context);
        const row = sql.exec<WakeRow>(
          "SELECT event_id AS eventId, attempt_id AS attemptId, site_id AS siteId, binding_ref AS bindingRef, stripe_account_id AS stripeAccountId, authorize_net_merchant_id AS authorizeNetMerchantId, mode FROM checkout_wake_events WHERE event_id=?",
          context.eventId,
        ).toArray()[0];
        if (!row || Object.keys(context).some(key => row[key as keyof WakeContext] !== context[key as keyof WakeContext])) {
          throw new WakeError("wake_association_mismatch");
        }
        return sql.exec("UPDATE checkout_wake_events SET acknowledged_at=? WHERE event_id=? AND acknowledged_at IS NULL", Date.now(), context.eventId).rowsWritten === 1;
      },
    };
  }
  private connection() {
    const sql = this.ctx.storage.sql;
    return createConnectionService({
      mode: "test",
      store: { transaction: fn => this.ctx.storage.transactionSync(() => fn({
        read: () => {
          const row = sql.exec<{ value: string }>("SELECT value FROM connection_state WHERE id=1").toArray()[0];
          return row ? JSON.parse(row.value) as Connection : null;
        },
        write: record => { sql.exec("INSERT INTO connection_state (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(record)); },
      })) },
      provider: (this.env.PAYMENT_PROVIDER as string) === "authorize_net"
        ? {
          createAccount: async () => { throw new ConnectionError("stripe_unconfigured"); },
          accountStatus: async () => { throw new ConnectionError("stripe_unconfigured"); },
          createLink: async () => { throw new ConnectionError("stripe_unconfigured"); },
        }
        : createStripeOnboarding({ apiKey: this.env.STRIPE_API_KEY, mode: "test", returnUrl: this.env.ONBOARDING_RETURN_URL, refreshUrl: this.env.ONBOARDING_REFRESH_URL }),
      providerId: (this.env.PAYMENT_PROVIDER as string) === "authorize_net" ? "authorize_net" : "stripe",
      authorizeNetMerchantId: (this.env.AUTHORIZE_NET_MERCHANT_ID as string) || this.env.AUTHORIZE_NET_API_LOGIN_ID,
    });
  }
  private checkout(returnPages?: ReturnPages, playground = false) {
    const sql = this.ctx.storage.sql;
    const connection = this.connection();
    const fixed = (principal: Principal, ref: string) =>
      isPlayground(principal) && ref === PLAYGROUND_BINDING_REF ? playgroundBinding() : null;
    return createCheckoutSessionService({
      mode: "test",
      successUrl: returnPages?.successUrl,
      cancelUrl: returnPages?.cancelUrl,
      store: { transaction: fn => this.ctx.storage.transactionSync(() => fn({
        read: attemptId => {
          const row = sql.exec<{ value: string }>("SELECT value FROM checkout_attempts WHERE attempt_id=?", attemptId).toArray()[0];
          return row ? JSON.parse(row.value) as AttemptRecord : null;
        },
        write: record => { sql.exec("INSERT INTO checkout_attempts (attempt_id,value) VALUES (?,?) ON CONFLICT(attempt_id) DO UPDATE SET value=excluded.value", record.attemptId, JSON.stringify(record)); },
      })) },
      readyBinding: async (principal, ref) => playground ? fixed(principal, ref) : connection.checkoutBinding(principal, ref),
      existingBinding: (principal, ref) => playground ? fixed(principal, ref) : connection.existingBinding(principal, ref),
      provider: playground
        // Fails closed with stripe_mode_mismatch unless the playground key is sk_test_.
        ? createStripeCheckout({ apiKey: assertPlaygroundStripeKey(this.env.STRIPE_PLAYGROUND_SECRET_KEY), mode: "test", ownAccountId: PLAYGROUND_STRIPE_ACCOUNT_ID })
        : createStripeCheckout({ apiKey: this.env.STRIPE_API_KEY, mode: "test" }),
    });
  }
  /**
   * The shared playground tenant: a fixed sandbox binding, lookup-only status
   * (no payment wakes), per-tenant and per-IP session limits, 24 h retention.
   */
  private assertPlaygroundObject(principal: Principal) {
    if (!isPlayground(principal)) throw new CheckoutError("binding_mismatch");
  }
  async playgroundEnsureSession(principal: Principal, request: PaymentRequest, clientIp: string) {
    this.assertPlaygroundObject(principal);
    const checkout = this.checkout(storeReturnPages(principal, "stripe"), true);
    if (!checkout.readAttempt(request.attemptId)) {
      const ipKey = await playgroundIpKey(clientIp);
      const sql = this.ctx.storage.sql;
      this.ctx.storage.transactionSync(() => takePlaygroundSessionSlot({
        hits: (bucket, since) => sql.exec<{ at: number }>("SELECT at FROM playground_rate_hits WHERE bucket=? AND at>?", bucket, since).toArray().map(row => row.at),
        record: (bucket, at) => { sql.exec("INSERT INTO playground_rate_hits (bucket,at) VALUES (?,?)", bucket, at); },
      }, ipKey, Date.now(), playgroundTenantLimit(this.env)));
    }
    const outcome = await checkout.ensureSessionFor(principal, request);
    if (checkout.readAttempt(request.attemptId)) {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO playground_attempts (attempt_id,created_at) VALUES (?,?)", request.attemptId, Date.now());
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + PLAYGROUND_RETENTION_MS);
    }
    return outcome;
  }
  async playgroundLookup(principal: Principal, request: PaymentRequest) {
    this.assertPlaygroundObject(principal);
    return this.checkout(undefined, true).lookupFor(principal, request);
  }
  async playgroundReceipt(principal: Principal, sessionId: string): Promise<PaymentOutcome> {
    this.assertPlaygroundObject(principal);
    const row = this.ctx.storage.sql.exec<{ attemptId: string }>(
      "SELECT a.attempt_id AS attemptId FROM checkout_attempts a JOIN playground_attempts p ON p.attempt_id=a.attempt_id WHERE json_extract(a.value,'$.stripeSessionId')=? LIMIT 1",
      sessionId,
    ).toArray()[0];
    if (!row) return { outcome: "unknown" };
    return this.checkout(undefined, true).lookupAttemptFor(principal, row.attemptId);
  }
  /** Deletes playground checkout records and rate-limit hits older than the retention window. */
  purgePlayground(now = Date.now()): number {
    const sql = this.ctx.storage.sql;
    const cutoff = now - PLAYGROUND_RETENTION_MS;
    return this.ctx.storage.transactionSync(() => {
      const stale = sql.exec<{ attemptId: string }>("SELECT attempt_id AS attemptId FROM playground_attempts WHERE created_at<=?", cutoff).toArray();
      for (const { attemptId } of stale) {
        sql.exec("DELETE FROM checkout_attempts WHERE attempt_id=?", attemptId);
        sql.exec("DELETE FROM playground_attempts WHERE attempt_id=?", attemptId);
      }
      sql.exec("DELETE FROM playground_rate_hits WHERE at<=?", now - Math.max(PLAYGROUND_IP_LIMIT.windowMs, playgroundTenantLimit(this.env).windowMs));
      return stale.length;
    });
  }
  async alarm() {
    const now = Date.now();
    this.purgePlayground(now);
    await this.recheckOpenTries(now);
    await this.scheduleAlarm(now);
  }
  /** One alarm serves the playground's purge and Authorize.net's open tries, whichever is due first. */
  private async scheduleAlarm(now = Date.now()) {
    const sql = this.ctx.storage.sql;
    const oldest = sql.exec<{ oldest: number | null }>("SELECT MIN(created_at) AS oldest FROM playground_attempts").toArray()[0]?.oldest;
    const open = sql.exec<{ next: number | null }>("SELECT MIN(next_at) AS next FROM authorize_net_open_tries").toArray()[0]?.next;
    const due = [typeof oldest === "number" ? oldest + PLAYGROUND_RETENTION_MS : null, open ?? null].filter((at): at is number => typeof at === "number");
    if (!due.length) return;
    const at = Math.max(now + 1000, Math.min(...due));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at || current <= now) await this.ctx.storage.setAlarm(at);
  }
  /** Keeps a paid checkout with an open try on the alarm's list, or takes it off once none is left. */
  private async noteOpenTries(siteId: string, attemptId: string, port: { openTries(attemptId: string): string[] }) {
    const sql = this.ctx.storage.sql;
    if (!port.openTries(attemptId).length) {
      sql.exec("DELETE FROM authorize_net_open_tries WHERE attempt_id=?", attemptId);
      return;
    }
    sql.exec("INSERT OR IGNORE INTO authorize_net_open_tries (attempt_id,site_id,next_at,tries) VALUES (?,?,?,0)", attemptId, siteId, Date.now() + OPEN_TRY_FIRST_DELAY_MS);
    await this.scheduleAlarm();
  }
  /** Reads each due open try again, backing off up to a day between reads, and gives up after OPEN_TRY_READS. */
  private async recheckOpenTries(now: number) {
    const sql = this.ctx.storage.sql;
    const due = sql.exec<{ attemptId: string; siteId: string; tries: number }>(
      "SELECT attempt_id AS attemptId, site_id AS siteId, tries FROM authorize_net_open_tries WHERE next_at<=? ORDER BY next_at LIMIT ?", now, OPEN_TRY_BATCH,
    ).toArray();
    for (const row of due) {
      const port = this.authorizeNetCheckout(row.siteId);
      const done = await port.recheck(row.attemptId).catch(() => false);
      if (done || row.tries + 1 >= OPEN_TRY_READS) {
        sql.exec("DELETE FROM authorize_net_open_tries WHERE attempt_id=?", row.attemptId);
        if (!done) console.warn("[payments] an Authorize.net try stayed unreadable; check the checkout in Authorize.net by hand", { attemptId: row.attemptId });
      } else {
        sql.exec("UPDATE authorize_net_open_tries SET tries=?, next_at=? WHERE attempt_id=?", row.tries + 1,
          now + Math.min(OPEN_TRY_FIRST_DELAY_MS * 2 ** (row.tries + 1), OPEN_TRY_MAX_DELAY_MS), row.attemptId);
      }
    }
  }
  private authorizeNetCheckout(siteId: string, returnPages?: ReturnPages, origin?: string) {
    const sql = this.ctx.storage.sql;
    const gateway = createAuthorizeNetGateway({
      apiLoginId: this.env.AUTHORIZE_NET_API_LOGIN_ID,
      transactionKey: this.env.AUTHORIZE_NET_TRANSACTION_KEY,
      merchantCurrency: "USD",
      mode: "test",
    });
    return createAuthorizeNetPaymentPort({
      gateway,
      siteId,
      hostedUrl: authorizeNetEndpoints("test").hosted,
      returnUrl: returnPages?.successUrl,
      cancelUrl: returnPages?.cancelUrl,
      payPageUrl: origin ? `${origin}${authorizeNetPayPagePath(siteId)}` : undefined,
      store: {
        transaction: fn => this.ctx.storage.transactionSync(() => fn({
          read: attemptId => {
            const row = sql.exec<{ value: string }>("SELECT value FROM authorize_net_attempts WHERE attempt_id=?", attemptId).toArray()[0];
            return row ? JSON.parse(row.value) : null;
          },
          write: (attemptId, value) => {
            sql.exec("INSERT INTO authorize_net_attempts (attempt_id,value) VALUES (?,?) ON CONFLICT(attempt_id) DO UPDATE SET value=excluded.value", attemptId, JSON.stringify(value));
          },
        })),
      },
      paidTwice: (attemptId, record) => {
        sql.exec(
          "INSERT INTO authorize_net_paid_twice (attempt_id,transaction_ids,amount_minor,noticed_at) VALUES (?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET transaction_ids=excluded.transaction_ids",
          attemptId, JSON.stringify([record.paidId, ...(record.alsoPaid ?? [])]), record.amountMinor ?? "", Date.now(),
        );
      },
    });
  }
  /**
   * Checkouts Authorize.net took payment for more than once, newest first, for the Payments page. Only a plugin
   * that asks gets them, since older plugins decode status strictly.
   */
  async paidTwice(principal: Principal): Promise<PaidTwiceNotice[] | undefined> {
    // Only Authorize.net checkouts are ever written here; a Stripe store's list is always empty.
    if (isPlayground(principal)) return undefined;
    // Refuses a caller that does not own this store's connection, and shows nothing once it is gone.
    if (this.connection().diagnostics(principal).state === "disconnected") return [];
    return this.ctx.storage.sql.exec<{ ids: string; minor: string; at: number }>(
      "SELECT transaction_ids AS ids, amount_minor AS minor, noticed_at AS at FROM authorize_net_paid_twice WHERE noticed_at>? ORDER BY noticed_at DESC, attempt_id DESC LIMIT ?",
      Date.now() - PAID_TWICE_SHOWN_MS, PAID_TWICE_SHOWN,
    ).toArray().map(row => ({ transactionIds: JSON.parse(row.ids) as string[], total: { currency: "USD" as const, minor: row.minor }, at: row.at }));
  }
  async connectionDiagnostics(principal: Principal) { return this.connection().diagnostics(principal); }
  async providerIdentityDiagnostic(principal: Principal): Promise<ProviderIdentityDiagnostic> {
    if ((this.env.PAYMENT_PROVIDER as string) === "authorize_net") {
      throw new ConnectionError("diagnostic_unavailable");
    }
    const operatorAccount = this.env.STRIPE_DIAGNOSTIC_OPERATOR_ACCOUNT;
    const operatorSite = this.env.STRIPE_DIAGNOSTIC_OPERATOR_SITE;
    const expectedAccount = this.env.STRIPE_DIAGNOSTIC_EXPECTED_ACCOUNT;
    const apiKey = this.env.STRIPE_API_KEY;

    if (!operatorAccount || !operatorSite || !expectedAccount || !apiKey) {
      throw new ConnectionError("diagnostic_unavailable");
    }
    let parsedOperatorAccount: unknown;
    try {
      parsedOperatorAccount = JSON.parse(operatorAccount);
    } catch {
      throw new ConnectionError("diagnostic_unavailable");
    }
    if (
      !Array.isArray(parsedOperatorAccount) ||
      parsedOperatorAccount.length !== 2 ||
      typeof parsedOperatorAccount[0] !== "string" ||
      parsedOperatorAccount[0] !== this.env.ACCOUNT_ISSUER ||
      typeof parsedOperatorAccount[1] !== "string" ||
      !parsedOperatorAccount[1].trim() || parsedOperatorAccount[1].length > 200 || JSON.stringify(parsedOperatorAccount) !== operatorAccount
    ) {
      throw new ConnectionError("diagnostic_unavailable");
    }
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(operatorSite)) {
      throw new ConnectionError("diagnostic_unavailable");
    }
    if (!/^acct_[A-Za-z0-9]{1,200}$/.test(expectedAccount)) {
      throw new ConnectionError("diagnostic_unavailable");
    }
    if (!/^sk_test_\S+$/.test(apiKey)) {
      throw new ConnectionError("diagnostic_unavailable");
    }

    if (principal.accountId !== operatorAccount || principal.siteId !== operatorSite) {
      throw new ConnectionError("connection_owner_mismatch");
    }

    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ value: string }>("SELECT value FROM connection_state WHERE id=1").toArray()[0];
    if (!row) {
      throw new ConnectionError("connection_owner_mismatch");
    }
    let record: Connection;
    try {
      record = JSON.parse(row.value) as Connection;
    } catch {
      throw new ConnectionError("connection_owner_mismatch");
    }
    if (
      !record ||
      !record.owner ||
      record.owner.accountId !== principal.accountId ||
      record.owner.siteId !== principal.siteId ||
      record.mode !== "test"
    ) {
      throw new ConnectionError("connection_owner_mismatch");
    }
    if ((record.providerId ?? "stripe") !== "stripe") {
      throw new ConnectionError("binding_provider_mismatch");
    }

    const safeDiagnostics = this.connection().diagnostics(principal);
    const result = await checkStripePlatformIdentity({ apiKey, expectedAccountId: expectedAccount });
    // Do not disclose a result after the stored owner/binding changed during I/O.
    const after = sql.exec<{ value: string }>("SELECT value FROM connection_state WHERE id=1").toArray()[0];
    if (after?.value !== row.value) throw new ConnectionError("connection_owner_mismatch");
    return { ...result, diagnostics: safeDiagnostics };
  }
  async startOnboarding(principal: Principal, country?: unknown) { return this.connection().connect(principal, country); }
  async status(principal: Principal): Promise<Status> {
    const status = await this.connection().status(principal);
    const testOrder = await this.testOrder(principal, status);
    return testOrder ? { ...status, testOrder } : status;
  }
  async businessCountry(principal: Principal) { return this.connection().businessCountry(principal); }
  async checkoutBinding(principal: Principal, bindingRef: string) { return this.connection().checkoutBinding(principal, bindingRef); }
  async existingBinding(principal: Principal, bindingRef: string) { return this.connection().existingBinding(principal, bindingRef); }
  async ensureSession(principal: Principal, request: PaymentRequest, origin?: string) {
    // The playground creates sessions only through playgroundEnsureSession (rate limited).
    if (isPlayground(principal)) throw new CheckoutError("binding_mismatch");
    if ((this.env.PAYMENT_PROVIDER as string) === "authorize_net") {
      const binding = await this.connection().checkoutBinding(principal, request.bindingRef);
      if (!binding || binding.providerId !== "authorize_net") return { outcome: "unknown" as const };
      const port = this.authorizeNetCheckout(principal.siteId, storeReturnPages(principal, "authorize_net"), origin);
      try { return this.notePaid(principal, request, await port.ensureSession(request)); }
      finally { await this.noteOpenTries(principal.siteId, request.attemptId, port); }
    }
    return this.notePaid(principal, request, await this.checkout(storeReturnPages(principal, "stripe")).ensureSessionFor(principal, request));
  }
  async lookup(principal: Principal, request: PaymentRequest) {
    if (isPlayground(principal)) return this.playgroundLookup(principal, request);
    if ((this.env.PAYMENT_PROVIDER as string) === "authorize_net") {
      const binding = await this.connection().existingBinding(principal, request.bindingRef);
      if (!binding || binding.providerId !== "authorize_net") return { outcome: "unknown" as const };
      const port = this.authorizeNetCheckout(principal.siteId);
      try { return this.notePaid(principal, request, await port.lookup(request)); }
      finally { await this.noteOpenTries(principal.siteId, request.attemptId, port); }
    }
    return this.notePaid(principal, request, await this.checkout().lookupFor(principal, request));
  }
  /**
   * Keeps the first time the provider itself confirmed a TEST checkout as paid.
   * Only this lookup outcome counts; a webhook or a browser return never does.
   */
  private async notePaid(principal: Principal, request: PaymentRequest, outcome: PaymentOutcome): Promise<PaymentOutcome> {
    if (outcome.outcome !== "paid") return outcome;
    const binding = await this.connection().existingBinding(principal, request.bindingRef);
    if (binding) this.recordPaid(binding, outcome);
    return outcome;
  }
  private recordPaid(binding: CheckoutBinding, outcome: Extract<PaymentOutcome, { outcome: "paid" }>): void {
    if (binding.mode !== "test") return;
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO paid_test_checkouts (attempt_id,binding_ref,provider,account_ref,amount_minor,currency,paid_at) VALUES (?,?,?,?,?,?,?)",
      outcome.attemptId, binding.bindingRef, binding.providerId, receivingAccount(binding), outcome.total.minor, outcome.total.currency, Date.now(),
    );
  }
  private async testOrder(principal: Principal, status: Status): Promise<TestOrderEvidence | undefined> {
    if (status.mode !== "test" || !status.bindingRef) return undefined;
    let binding: CheckoutBinding | null;
    try { binding = await this.connection().existingBinding(principal, status.bindingRef); }
    catch { return undefined; }
    return binding ? this.paidTestCheckout(binding) : undefined;
  }
  /**
   * The paid TEST checkout setup shows for this connection. Commerce
   * acknowledges a paid checkout's payment notice only after saving the paid
   * order bound to it, so that acknowledgement is its confirmation. A
   * recorded checkout wins over a newer one still waiting.
   */
  private paidTestCheckout(binding: CheckoutBinding): TestOrderEvidence | undefined {
    if (binding.mode !== "test") return undefined;
    const row = this.ctx.storage.sql.exec<PaidTestRow>(
      `SELECT p.amount_minor AS amountMinor, p.paid_at AS paidAt,
        EXISTS (SELECT 1 FROM checkout_wake_events w WHERE ${SAME_PAID_CHECKOUT}) AS noticed,
        EXISTS (SELECT 1 FROM checkout_wake_events w WHERE ${SAME_PAID_CHECKOUT} AND w.acknowledged_at IS NOT NULL) AS recorded
      FROM paid_test_checkouts p
      WHERE p.binding_ref=? AND p.provider=? AND p.account_ref=? AND p.currency='USD'
      ORDER BY recorded DESC, p.paid_at DESC, p.attempt_id DESC LIMIT 1`,
      binding.bindingRef, binding.providerId, receivingAccount(binding),
    ).toArray()[0];
    if (!row) return undefined;
    return {
      provider: binding.providerId,
      total: { currency: "USD", minor: row.amountMinor },
      paidAt: row.paidAt,
      state: row.recorded ? "recorded" : row.noticed ? "awaiting_commerce" : "awaiting_notice",
    };
  }
  async consumeWakes(reconcile: (context: WakeContext) => Promise<ReconciliationResult>, limit = 25) {
    return consumeWakeBatch(this.wakeEvents, reconcile, limit);
  }
  async listWakes(principal: Principal, bindingRef: string, limit: number): Promise<readonly CommercePaymentWake[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WakeError("invalid_batch_limit");
    if (isPlayground(principal)) return [];
    const binding = await this.connection().existingBinding(principal, bindingRef);
    if (!binding) throw new WakeError("binding_not_found");
    const rows = this.ctx.storage.sql.exec<WakeRow>(
      "SELECT event_id AS eventId, attempt_id AS attemptId, site_id AS siteId, binding_ref AS bindingRef, stripe_account_id AS stripeAccountId, authorize_net_merchant_id AS authorizeNetMerchantId, mode, delivery_generation AS deliveryGeneration, received_at AS wokeAt FROM checkout_wake_events WHERE binding_ref=? AND acknowledged_at IS NULL ORDER BY received_at ASC LIMIT ?",
      bindingRef, limit,
    ).toArray();
    return rows.map(row => {
      this.assertWakeAssociation(principal, binding, row);
      return {
        eventId: row.eventId,
        attemptId: row.attemptId,
        bindingRef: row.bindingRef,
        deliveryGeneration: row.deliveryGeneration,
        wokeAt: row.wokeAt,
      };
    });
  }
  async acknowledgeWake(principal: Principal, wake: CommercePaymentWake): Promise<boolean> {
    assertCommercePaymentWake(wake);
    if (isPlayground(principal)) throw new WakeError("binding_not_found");
    const binding = await this.connection().existingBinding(principal, wake.bindingRef);
    if (!binding) throw new WakeError("binding_not_found");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql.exec<WakeRow>(
        "SELECT event_id AS eventId, attempt_id AS attemptId, site_id AS siteId, binding_ref AS bindingRef, stripe_account_id AS stripeAccountId, authorize_net_merchant_id AS authorizeNetMerchantId, mode, delivery_generation AS deliveryGeneration, received_at AS wokeAt, acknowledged_at AS acknowledgedAt FROM checkout_wake_events WHERE event_id=?",
        wake.eventId,
      ).toArray()[0];
      if (!row) throw new WakeError("wake_not_found");
      this.assertWakeAssociation(principal, binding, row);
      if (row.attemptId !== wake.attemptId || row.bindingRef !== wake.bindingRef ||
          row.deliveryGeneration !== wake.deliveryGeneration || row.wokeAt !== wake.wokeAt) {
        throw new WakeError("wake_association_mismatch");
      }
      if (row.acknowledgedAt !== null) return true;
      return sql.exec(
        "UPDATE checkout_wake_events SET acknowledged_at=? WHERE event_id=? AND delivery_generation=? AND received_at=? AND acknowledged_at IS NULL",
        Date.now(), wake.eventId, wake.deliveryGeneration, wake.wokeAt,
      ).rowsWritten === 1;
    });
  }
  private assertWakeAssociation(principal: Principal, binding: CheckoutBinding, row: WakeRow): void {
    if (row.siteId !== principal.siteId || row.bindingRef !== binding.bindingRef ||
        row.mode !== "test" ||
        (binding.providerId === "stripe" && row.stripeAccountId !== binding.stripeAccountId) ||
        (binding.providerId === "authorize_net" && row.authorizeNetMerchantId !== binding.authorizeNetMerchantId)) {
      throw new WakeError("wake_association_mismatch");
    }
    const attempt = this.ctx.storage.sql.exec<{ value: string }>(
      `SELECT value FROM ${binding.providerId === "authorize_net" ? "authorize_net_attempts" : "checkout_attempts"} WHERE attempt_id=?`, row.attemptId,
    ).toArray()[0];
    if (!attempt) throw new WakeError("wake_association_mismatch");
    if (binding.providerId === "authorize_net") {
      let record: { bindingRef?: string; siteId?: string };
      try { record = JSON.parse(attempt.value); } catch { throw new WakeError("wake_association_mismatch"); }
      if (record.bindingRef !== binding.bindingRef || record.siteId !== principal.siteId) {
        throw new WakeError("wake_association_mismatch");
      }
      return;
    }
    let record: AttemptRecord;
    try { record = JSON.parse(attempt.value) as AttemptRecord; } catch { throw new WakeError("wake_association_mismatch"); }
    if (record.attemptId !== row.attemptId || record.siteId !== principal.siteId ||
        record.bindingRef !== binding.bindingRef || record.stripeAccountId !== binding.stripeAccountId ||
        record.mode !== "test") throw new WakeError("wake_association_mismatch");
  }
  async receiveWebhook(payload: ArrayBuffer, signature: string, stripeAccount: string | null) {
    const checkout = this.checkout();
    const sql = this.ctx.storage.sql;
    const verifier = createStripeWebhookVerifier({ apiKey: this.env.STRIPE_API_KEY, webhookSecret: this.env.STRIPE_WEBHOOK_SECRET });
    await createWebhookHandler({
      verify: (bytes, header) => verifier.verify(bytes, header),
      readAttempt: attemptId => checkout.readAttempt(attemptId),
      retrieveAndMatch: record => checkout.retrieveAndMatch(record),
      wake: {
        async wake(context) {
          assertWakeContext(context);
          // The playground is lookup-only: its store confirms on the success page.
          if (context.siteId === PLAYGROUND_SITE_ID) return;
          const existing = sql.exec<WakeRow>(
            "SELECT event_id AS eventId, attempt_id AS attemptId, site_id AS siteId, binding_ref AS bindingRef, stripe_account_id AS stripeAccountId, authorize_net_merchant_id AS authorizeNetMerchantId, mode FROM checkout_wake_events WHERE event_id=?",
            context.eventId,
          ).toArray()[0];
          if (existing) {
            if (Object.keys(context).some(key => existing[key as keyof WakeContext] !== context[key as keyof WakeContext])) {
              throw new WakeError("event_reuse");
            }
            return;
          }
          const receivedAt = Date.now();
          sql.exec("INSERT INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,mode,received_at,acknowledged_at,delivery_generation) VALUES (?,?,?,?,?,?,?,NULL,1)",
            context.eventId, context.attemptId, context.siteId, context.bindingRef, context.stripeAccountId, context.mode, receivedAt);
          // Keep the original attempt-only queue populated for legacy consumers.
          sql.exec("INSERT INTO checkout_wakes (attempt_id,woke_at) VALUES (?,?) ON CONFLICT(attempt_id) DO UPDATE SET woke_at=excluded.woke_at", context.attemptId, receivedAt);
        },
      },
      mode: "test",
    })(new Uint8Array(payload), signature, stripeAccount);
  }
  /** The shopper's visit to the Authorize.net pay page; the session segment is the only credential. */
  async authorizeNetPayPage(siteId: string, sessionId: string) {
    return this.authorizeNetCheckout(siteId).payPage(sessionId);
  }
  async receiveAuthorizeNetWebhook(payload: Uint8Array, signature: string, eventId: string, siteId: string) {
    const sql = this.ctx.storage.sql;
    const seen = new Set(sql.exec<{ eventId: string }>("SELECT event_id AS eventId FROM authorize_net_webhook_events").toArray().map(row => row.eventId));
    await createAuthorizeNetWebhookHandler({
      signatureKey: this.env.AUTHORIZE_NET_SIGNATURE_KEY,
      seenEventIds: seen,
      wake: async event => {
        // After signature verification: parse the store-bound invoice reference
        // and reject before any transactionId storage, wake insertion, or paid
        // lookup. A signed webhook never marks paid by itself.
        const parsed = event.invoiceReference
          ? parseAuthorizeNetInvoiceReference(event.invoiceReference)
          : null;
        if (!parsed) throw new AuthorizeNetWebhookError("invalid_invoice_reference");
        const expectedTag = await authorizeNetStoreTag(siteId);
        if (parsed.storeTag !== expectedTag) {
          throw new AuthorizeNetWebhookError("site_mismatch");
        }
        const record = sql.exec<{ value: string }>("SELECT value FROM authorize_net_attempts WHERE attempt_id=?", parsed.attemptId).toArray()[0];
        let stored: { bindingRef?: string; siteId?: string } | null = null;
        try { stored = record ? JSON.parse(record.value) as { bindingRef?: string; siteId?: string } : null; }
        catch { stored = null; }
        if (!stored?.bindingRef || stored.siteId !== siteId) {
          throw new AuthorizeNetWebhookError("site_mismatch");
        }
        if ((await authorizeNetStoreTag(stored.siteId)) !== parsed.storeTag) {
          throw new AuthorizeNetWebhookError("site_mismatch");
        }
        const port = this.authorizeNetCheckout(siteId);
        if (event.transactionId) port.recordTransaction(parsed.attemptId, event.transactionId);
        // Authorize.net notifications are only reconciliation hints. The
        // authoritative lookup remains the checkout port's getTransaction.
        const receivedAt = Date.now();
        sql.exec("INSERT OR IGNORE INTO checkout_wakes (attempt_id,woke_at) VALUES (?,?)", parsed.attemptId, receivedAt);
        const merchantId = (this.env.AUTHORIZE_NET_MERCHANT_ID as string) || this.env.AUTHORIZE_NET_API_LOGIN_ID;
        const wakeEventId = await authorizeNetWakeEventId(event.id);
        sql.exec(
          "INSERT OR IGNORE INTO checkout_wake_events (event_id,attempt_id,site_id,binding_ref,stripe_account_id,authorize_net_merchant_id,mode,received_at,acknowledged_at,delivery_generation) VALUES (?,?,?,?,?,?,?, ?,NULL,1)",
          wakeEventId, parsed.attemptId, stored.siteId, stored.bindingRef, "", merchantId, "test", receivedAt,
        );
        // A try notified after the checkout was paid is read now, so a second payment reaches the owner.
        if (event.transactionId) {
          try { await port.checkLateTry(parsed.attemptId, event.transactionId); }
          finally { await this.noteOpenTries(siteId, parsed.attemptId, port); }
        }
      },
    })(payload, signature, eventId);
    sql.exec("INSERT OR IGNORE INTO authorize_net_webhook_events (event_id) VALUES (?)", eventId);
  }
}

async function authorizeNetWakeEventId(notificationId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(notificationId));
  const hex = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  return `evt_anet${hex}`;
}

function wakeContextFromRow(row: WakeRow): WakeContext {
  const merchantId = typeof row.authorizeNetMerchantId === "string" ? row.authorizeNetMerchantId : "";
  if (merchantId) {
    return {
      eventId: row.eventId,
      attemptId: row.attemptId,
      siteId: row.siteId,
      bindingRef: row.bindingRef,
      authorizeNetMerchantId: merchantId,
      mode: row.mode,
    };
  }
  return {
    eventId: row.eventId,
    attemptId: row.attemptId,
    siteId: row.siteId,
    bindingRef: row.bindingRef,
    stripeAccountId: String(row.stripeAccountId ?? ""),
    mode: row.mode,
  };
}

function stubFor(env: Env, siteId: string) {
  return env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
}

const STRIPE_WEBHOOK_REFUSALS = new Set([
  "invalid_event_id", "missing_attempt", "unknown_attempt", "session_mismatch", "binding_mismatch", "site_mismatch",
  "mode_mismatch", "account_unsigned", "account_mismatch", "session_missing", "event_reuse", "wake_association_mismatch",
]);

/** A checkout request that does not match the checkout it names; errors lose their class over RPC. */
const CHECKOUT_REFUSALS = new Set([
  "attempt_mismatch", "request_mutation", "binding_mismatch", "binding_provider_mismatch", "session_mismatch",
  "amount_or_currency_mismatch", "identity_mismatch",
]);
async function checkoutRefusal(call: PromiseLike<unknown>): Promise<PaymentOutcome> {
  try { return await call as PaymentOutcome; }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (CHECKOUT_REFUSALS.has(message)) throw new CheckoutError(message);
    throw error;
  }
}
/** Paid-twice checkouts stay on the Payments page this long: inside Authorize.net's 120-day refund limit. */
const PAID_TWICE_SHOWN_MS = 90 * 24 * 60 * 60 * 1000;
const PAID_TWICE_SHOWN = 10;
/** An open try is read again after 5 minutes, then twice as long each time up to a day, for 12 reads (about 5 days). */
const OPEN_TRY_FIRST_DELAY_MS = 5 * 60 * 1000;
const OPEN_TRY_MAX_DELAY_MS = 24 * 60 * 60 * 1000;
const OPEN_TRY_READS = 12;
const OPEN_TRY_BATCH = 20;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      }
      return Response.json({ status: "ok", mode: "test" }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const authorizeNet = (env.PAYMENT_PROVIDER as string) === "authorize_net";
    const issuerConfigured = Boolean(env.ACCOUNT_ISSUER && env.ACCOUNT_AUDIENCE && env.ACCOUNT_JWKS_URL);
    const authorizeNetConfigured = env.AUTHORIZE_NET_MODE === "test" && Boolean(env.AUTHORIZE_NET_API_LOGIN_ID && env.AUTHORIZE_NET_TRANSACTION_KEY && env.AUTHORIZE_NET_SIGNATURE_KEY);
    const stripeConfigured = Boolean(env.STRIPE_API_KEY && env.ONBOARDING_RETURN_URL && env.ONBOARDING_REFRESH_URL);
    if (!issuerConfigured || (authorizeNet ? !authorizeNetConfigured : !stripeConfigured)) {
      return Response.json({ error: "payments_service_unconfigured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    try {
      return await createHostedHandler({
        authenticate: createAccountAuthenticator({ issuer: env.ACCOUNT_ISSUER, audience: env.ACCOUNT_AUDIENCE, jwksUrl: env.ACCOUNT_JWKS_URL }),
        // Route by site, so switching the authenticated account cannot silently
        // create a different payment recipient for an already-connected store.
        service: principal => {
          const stub = stubFor(env, principal.siteId);
          return {
            connect: (p, country) => stub.startOnboarding(p, country),
            status: p => stub.status(p),
            businessCountry: p => stub.businessCountry(p),
            paidTwice: p => stub.paidTwice(p),
            diagnostics: p => stub.connectionDiagnostics(p),
            checkoutBinding: (p, ref) => stub.checkoutBinding(p, ref),
            existingBinding: (p, ref) => stub.existingBinding(p, ref),
            providerIdentityDiagnostic: p => stub.providerIdentityDiagnostic(p),
          };
        },
        checkout: (principal, context) => {
          const stub = stubFor(env, principal.siteId);
          if (isPlayground(principal)) {
            if (!env.STRIPE_PLAYGROUND_SECRET_KEY) throw new Error("playground_unconfigured");
            return {
              ensureSession: request => {
                if (!context.clientIp) throw new Error("client_ip_required");
                return stub.playgroundEnsureSession(principal, request, context.clientIp);
              },
              lookup: request => stub.playgroundLookup(principal, request),
              receipt: sessionId => stub.playgroundReceipt(principal, sessionId),
            };
          }
          return {
            ensureSession: request => checkoutRefusal(stub.ensureSession(principal, request, context.origin)),
            lookup: request => checkoutRefusal(stub.lookup(principal, request)),
          };
        },
        wakes: principal => {
          const stub = stubFor(env, principal.siteId);
          return {
            list: (bindingRef, limit) => stub.listWakes(principal, bindingRef, limit),
            acknowledge: wake => stub.acknowledgeWake(principal, wake),
          };
        },
        webhook: async (payload, signature, stripeAccount) => {
          if (!env.STRIPE_WEBHOOK_SECRET) throw new Error("webhook_unconfigured");
          const verifier = createStripeWebhookVerifier({ apiKey: env.STRIPE_API_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
          const event = await verifier.verify(payload, signature);
          const session = event.data.object as { object?: string; metadata?: { dinkus_site?: string } };
          if (session.object !== "checkout.session") return;
          const siteId = session.metadata?.dinkus_site;
          if (!siteId) throw new WebhookError("missing_site");
          // Lookup-only tenant: never queue wakes for the playground.
          if (siteId === PLAYGROUND_SITE_ID) return;
          // Re-verify inside the site object. Routing uses only post-verify metadata.
          try {
            await stubFor(env, siteId).receiveWebhook(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer, signature, stripeAccount);
          } catch (error) {
            // Errors lose their class over RPC; restore known refusals so Stripe's delivery log shows the code.
            const message = error instanceof Error ? error.message : "";
            if (STRIPE_WEBHOOK_REFUSALS.has(message)) throw new WebhookError(message);
            throw error;
          }
        },
        authorizeNetPayPage: (siteId, sessionId) => {
          if ((env.PAYMENT_PROVIDER as string) !== "authorize_net" || env.AUTHORIZE_NET_MODE !== "test") return Promise.resolve({ action: "not_found" });
          return stubFor(env, siteId).authorizeNetPayPage(siteId, sessionId);
        },
        authorizeNetWebhook: async (payload, signature, eventId, siteId) => {
          if ((env.PAYMENT_PROVIDER as string) !== "authorize_net" || env.AUTHORIZE_NET_MODE !== "test") throw new Error("webhook_unconfigured");
          try {
            await stubFor(env, siteId).receiveAuthorizeNetWebhook(payload, signature, eventId, siteId);
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (
              message === "replayed_event" ||
              message === "notification_id_mismatch" ||
              message === "invalid_signature" ||
              message === "invalid_payload" ||
              message === "invalid_event_id" ||
              message === "raw_payload_required" ||
              message === "missing_signature_key" ||
              message === "site_mismatch" ||
              message === "invalid_invoice_reference"
            ) {
              throw new AuthorizeNetWebhookError(message);
            }
            throw error;
          }
        },
      })(request);
    } catch { return Response.json({ error: "payments_service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  },
} satisfies ExportedHandler<Env>;
