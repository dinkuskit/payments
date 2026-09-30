import { DurableObject } from "cloudflare:workers";
import { createCheckoutSessionService, type AttemptRecord } from "../checkout/sessions.js";
import { createStripeWebhookVerifier, createWebhookHandler, WebhookError } from "../checkout/webhook.js";
import { createConnectionService, type Connection, type Principal } from "../hosted/connection.js";
import { createAccountAuthenticator } from "../hosted/auth.js";
import { createHostedHandler } from "../hosted/http.js";
import { createStripeCheckout } from "../stripe/checkout.js";
import { createStripeOnboarding } from "../stripe/onboarding.js";
import type { PaymentRequest } from "../commerce/checkout-port.js";

export class PaymentConnection extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS connection_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS checkout_attempts (attempt_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS checkout_wakes (attempt_id TEXT PRIMARY KEY, woke_at INTEGER NOT NULL)");
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
      provider: createStripeOnboarding({ apiKey: this.env.STRIPE_API_KEY, mode: "test", returnUrl: this.env.ONBOARDING_RETURN_URL, refreshUrl: this.env.ONBOARDING_REFRESH_URL }),
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
  async startOnboarding(principal: Principal) { return this.connection().connect(principal); }
  async status(principal: Principal) { return this.connection().status(principal); }
  async checkoutBinding(principal: Principal, bindingRef: string) { return this.connection().checkoutBinding(principal, bindingRef); }
  async existingBinding(principal: Principal, bindingRef: string) { return this.connection().existingBinding(principal, bindingRef); }
  async ensureSession(principal: Principal, request: PaymentRequest) { return this.checkout().ensureSessionFor(principal, request); }
  async lookup(principal: Principal, request: PaymentRequest) { return this.checkout().lookupFor(principal, request); }
  async receiveWebhook(payload: ArrayBuffer, signature: string, stripeAccount: string | null) {
    const checkout = this.checkout();
    const sql = this.ctx.storage.sql;
    const verifier = createStripeWebhookVerifier({ apiKey: this.env.STRIPE_API_KEY, webhookSecret: this.env.STRIPE_WEBHOOK_SECRET });
    await createWebhookHandler({
      verify: (bytes, header) => verifier.verify(bytes, header),
      readAttempt: attemptId => checkout.readAttempt(attemptId),
      retrieveAndMatch: record => checkout.retrieveAndMatch(record),
      wake: {
        async wake(attemptId) {
          sql.exec("INSERT INTO checkout_wakes (attempt_id,woke_at) VALUES (?,?) ON CONFLICT(attempt_id) DO UPDATE SET woke_at=excluded.woke_at", attemptId, Date.now());
        },
      },
      mode: "test",
    })(new Uint8Array(payload), signature, stripeAccount);
  }
}

function stubFor(env: Env, siteId: string) {
  return env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ACCOUNT_ISSUER || !env.ACCOUNT_AUDIENCE || !env.ACCOUNT_JWKS_URL || !env.STRIPE_API_KEY || !env.ONBOARDING_RETURN_URL || !env.ONBOARDING_REFRESH_URL) {
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
      })(request);
    } catch { return Response.json({ error: "payments_service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  },
} satisfies ExportedHandler<Env>;
