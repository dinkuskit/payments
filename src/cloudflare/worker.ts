import { DurableObject } from "cloudflare:workers";
import { createConnectionService, type Connection, type Principal } from "../hosted/connection.js";
import { createAccountAuthenticator } from "../hosted/auth.js";
import { createHostedHandler } from "../hosted/http.js";
import { createStripeOnboarding } from "../stripe/onboarding.js";

export class PaymentConnection extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS connection_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
  }
  private service() {
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
  async startOnboarding(principal: Principal) { return this.service().connect(principal); }
  async status(principal: Principal) { return this.service().status(principal); }
  async checkoutBinding(principal: Principal, bindingRef: string) { return this.service().checkoutBinding(principal, bindingRef); }
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
          const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principal.siteId]));
          return { connect: p => stub.startOnboarding(p), status: p => stub.status(p), checkoutBinding: (p, ref) => stub.checkoutBinding(p, ref) };
        },
      })(request);
    } catch { return Response.json({ error: "payments_service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  },
} satisfies ExportedHandler<Env>;
