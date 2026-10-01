import Stripe from "stripe";
import type { Mode } from "../hosted/connection.js";
import type { AttemptRecord } from "./sessions.js";
import type { WakeContext } from "./wakes.js";

export class WebhookError extends Error {}

export interface WakePort {
  /** Durable wake of Commerce reconciliation. Must not mark paid. */
  wake(context: WakeContext): Promise<void>;
}

export function createStripeWebhookVerifier(options: {
  apiKey: string;
  webhookSecret: string;
  httpClient?: Stripe.HttpClient;
}) {
  if (!options.webhookSecret.startsWith("whsec_")) throw new Error("invalid_webhook_secret");
  const stripe = new Stripe(options.apiKey, {
    httpClient: options.httpClient ?? Stripe.createFetchHttpClient(),
    timeout: 10000,
    maxNetworkRetries: 0,
  });
  return {
    async verify(payload: Uint8Array, signature: string): Promise<Stripe.Event> {
      if (!(payload instanceof Uint8Array)) throw new WebhookError("raw_payload_required");
      if (!signature) throw new WebhookError("missing_signature");
      return stripe.webhooks.constructEventAsync(payload, signature, options.webhookSecret);
    },
  };
}

function sessionObject(event: Stripe.Event): Stripe.Checkout.Session | null {
  const object = event.data?.object as { object?: string } | undefined;
  if (!object || object.object !== "checkout.session") return null;
  return object as Stripe.Checkout.Session;
}

export function createWebhookHandler(options: {
  verify(payload: Uint8Array, signature: string): Promise<Stripe.Event>;
  readAttempt(attemptId: string): AttemptRecord | null;
  retrieveAndMatch(record: AttemptRecord): Promise<void>;
  wake: WakePort;
  mode: Mode;
}) {
  return async (payload: Uint8Array, signature: string, stripeAccountHeader: string | null): Promise<void> => {
    const event = await options.verify(payload, signature);
    const session = sessionObject(event);
    if (!session) return;
    if (typeof event.id !== "string" || !/^evt_[A-Za-z0-9]+$/.test(event.id)) throw new WebhookError("invalid_event_id");
    const attemptId = session.metadata?.dinkus_attempt;
    if (!attemptId) throw new WebhookError("missing_attempt");
    const record = options.readAttempt(attemptId);
    if (!record) throw new WebhookError("unknown_attempt");
    if (record.stripeSessionId && session.id !== record.stripeSessionId) throw new WebhookError("session_mismatch");
    if (session.metadata?.dinkus_binding !== record.bindingRef) throw new WebhookError("binding_mismatch");
    if (session.metadata?.dinkus_site !== record.siteId) throw new WebhookError("site_mismatch");
    if (event.livemode !== (options.mode === "live") || session.livemode !== event.livemode) throw new WebhookError("mode_mismatch");
    if (!event.account) throw new WebhookError("account_unsigned");
    if (event.account !== record.stripeAccountId) throw new WebhookError("account_mismatch");
    if (stripeAccountHeader && stripeAccountHeader !== event.account) throw new WebhookError("account_mismatch");
    await options.retrieveAndMatch(record);
    const context: WakeContext = {
      eventId: event.id,
      attemptId: record.attemptId,
      siteId: record.siteId,
      bindingRef: record.bindingRef,
      stripeAccountId: record.stripeAccountId,
      mode: record.mode,
    };
    await options.wake.wake(context);
  };
}
