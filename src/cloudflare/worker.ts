import { DurableObject } from "cloudflare:workers";
import { createCheckoutSessionService, type AttemptRecord } from "../checkout/sessions.js";
import { createStripeWebhookVerifier, createWebhookHandler, WebhookError } from "../checkout/webhook.js";
import { assertCommercePaymentWake, assertWakeContext, consumeWakeBatch, WakeError, type CommercePaymentWake, type ReconciliationResult, type WakeContext, type WakeEventStore } from "../checkout/wakes.js";
import { ConnectionError, createConnectionService, type CheckoutBinding, type Connection, type Principal } from "../hosted/connection.js";
import { createAccountAuthenticator } from "../hosted/auth.js";
import { createHostedHandler } from "../hosted/http.js";
import { createStripeCheckout } from "../stripe/checkout.js";
import { createStripeOnboarding } from "../stripe/onboarding.js";
import {
  authorizeNetEndpoints,
  authorizeNetStoreTag,
  createAuthorizeNetGateway,
  createAuthorizeNetPaymentPort,
  parseAuthorizeNetInvoiceReference,
} from "../authorize-net/checkout.js";
import { AuthorizeNetWebhookError, createAuthorizeNetWebhookHandler } from "../authorize-net/webhook.js";
import type { PaymentRequest } from "../commerce/checkout-port.js";

type WakeRow = Record<string, string | number | null> & WakeContext & { deliveryGeneration: number; wokeAt: number; acknowledgedAt: number | null; authorizeNetMerchantId: string | null };

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
  private checkout() {
    const sql = this.ctx.storage.sql;
    const connection = this.connection();
    return createCheckoutSessionService({
      mode: "test",
      successUrl: this.env.CHECKOUT_SUCCESS_URL,
      cancelUrl: this.env.CHECKOUT_CANCEL_URL,
      store: { transaction: fn => this.ctx.storage.transactionSync(() => fn({
        read: attemptId => {
          const row = sql.exec<{ value: string }>("SELECT value FROM checkout_attempts WHERE attempt_id=?", attemptId).toArray()[0];
          return row ? JSON.parse(row.value) as AttemptRecord : null;
        },
        write: record => { sql.exec("INSERT INTO checkout_attempts (attempt_id,value) VALUES (?,?) ON CONFLICT(attempt_id) DO UPDATE SET value=excluded.value", record.attemptId, JSON.stringify(record)); },
      })) },
      readyBinding: (principal, ref) => connection.checkoutBinding(principal, ref),
      existingBinding: (principal, ref) => connection.existingBinding(principal, ref),
      provider: createStripeCheckout({ apiKey: this.env.STRIPE_API_KEY, mode: "test" }),
    });
  }
  private authorizeNetCheckout(siteId: string) {
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
      returnUrl: this.env.CHECKOUT_SUCCESS_URL,
      cancelUrl: this.env.CHECKOUT_CANCEL_URL,
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
    });
  }
  async startOnboarding(principal: Principal) { return this.connection().connect(principal); }
  async status(principal: Principal) { return this.connection().status(principal); }
  async checkoutBinding(principal: Principal, bindingRef: string) { return this.connection().checkoutBinding(principal, bindingRef); }
  async existingBinding(principal: Principal, bindingRef: string) { return this.connection().existingBinding(principal, bindingRef); }
  async ensureSession(principal: Principal, request: PaymentRequest) {
    if ((this.env.PAYMENT_PROVIDER as string) === "authorize_net") {
      const binding = await this.connection().checkoutBinding(principal, request.bindingRef);
      if (!binding || binding.providerId !== "authorize_net") return { outcome: "unknown" as const };
      return this.authorizeNetCheckout(principal.siteId).ensureSession(request);
    }
    return this.checkout().ensureSessionFor(principal, request);
  }
  async lookup(principal: Principal, request: PaymentRequest) {
    if ((this.env.PAYMENT_PROVIDER as string) === "authorize_net") {
      const binding = await this.connection().existingBinding(principal, request.bindingRef);
      if (!binding || binding.providerId !== "authorize_net") return { outcome: "unknown" as const };
      return this.authorizeNetCheckout(principal.siteId).lookup(request);
    }
    return this.checkout().lookupFor(principal, request);
  }
  async consumeWakes(reconcile: (context: WakeContext) => Promise<ReconciliationResult>, limit = 25) {
    return consumeWakeBatch(this.wakeEvents, reconcile, limit);
  }
  async listWakes(principal: Principal, bindingRef: string, limit: number): Promise<readonly CommercePaymentWake[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WakeError("invalid_batch_limit");
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
        if (event.transactionId) this.authorizeNetCheckout(siteId).recordTransaction(parsed.attemptId, event.transactionId);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
            connect: p => stub.startOnboarding(p),
            status: p => stub.status(p),
            checkoutBinding: (p, ref) => stub.checkoutBinding(p, ref),
            existingBinding: (p, ref) => stub.existingBinding(p, ref),
          };
        },
        checkout: principal => {
          const stub = stubFor(env, principal.siteId);
          return { ensureSession: request => stub.ensureSession(principal, request), lookup: request => stub.lookup(principal, request) };
        },
        wakes: principal => {
          const stub = stubFor(env, principal.siteId);
          return {
            list: (bindingRef, limit) => stub.listWakes(principal, bindingRef, limit),
            acknowledge: wake => stub.acknowledgeWake(principal, wake),
          };
        },
        webhook: async (payload, signature, stripeAccount) => {
          if (!env.STRIPE_WEBHOOK_SECRET || !env.CHECKOUT_SUCCESS_URL || !env.CHECKOUT_CANCEL_URL) throw new Error("webhook_unconfigured");
          const verifier = createStripeWebhookVerifier({ apiKey: env.STRIPE_API_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
          const event = await verifier.verify(payload, signature);
          const session = event.data.object as { object?: string; metadata?: { dinkus_site?: string } };
          if (session.object !== "checkout.session") return;
          const siteId = session.metadata?.dinkus_site;
          if (!siteId) throw new WebhookError("missing_site");
          // Re-verify inside the site object. Routing uses only post-verify metadata.
          await stubFor(env, siteId).receiveWebhook(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer, signature, stripeAccount);
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
