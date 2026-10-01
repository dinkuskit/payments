import Stripe from "stripe";
import type { CheckoutProvider, LatestCharge, ProviderPaymentIntent, ProviderSession } from "../checkout/sessions.js";
import type { Mode } from "../hosted/connection.js";

function asSession(session: Stripe.Checkout.Session): ProviderSession {
  const paymentIntent = session.payment_intent;
  return {
    id: session.id,
    url: session.url,
    status: session.status ?? "",
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total ?? -1,
    currency: session.currency ?? "",
    created: session.created,
    expiresAt: session.expires_at,
    livemode: session.livemode,
    paymentIntentId: typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id ?? null,
    metadata: session.metadata ?? {},
    paymentMethodTypes: session.payment_method_types ?? [],
  };
}

function latestCharge(intent: Stripe.PaymentIntent): LatestCharge {
  if (!Object.hasOwn(intent, "latest_charge")) return { state: "unknown" };
  const charge = intent.latest_charge;
  if (charge === null) return { state: "absent" };
  if (typeof charge === "string") return { state: "unknown" };
  if (charge && typeof charge === "object" && typeof charge.status === "string") {
    return { state: "known", status: charge.status };
  }
  return { state: "unknown" };
}

export function createStripeCheckout(options: {
  apiKey: string;
  mode: Mode;
  httpClient?: Stripe.HttpClient;
}): CheckoutProvider {
  if (!options.apiKey.startsWith(options.mode === "test" ? "sk_test_" : "sk_live_")) throw new Error("stripe_mode_mismatch");
  const stripe = new Stripe(options.apiKey, { httpClient: options.httpClient ?? Stripe.createFetchHttpClient(), timeout: 10000, maxNetworkRetries: 0 });
  return {
    async createSession(input) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        expires_at: input.expiresAtSeconds,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.attemptId,
        metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
        payment_intent_data: { metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId } },
        line_items: input.lines.map(line => ({
          quantity: line.quantity,
          price_data: {
            currency: "usd",
            unit_amount: Number(line.unitPrice.minor),
            product_data: { name: line.name },
          },
        })),
      }, { stripeAccount: input.stripeAccountId, idempotencyKey: input.idempotencyKey });
      return asSession(session);
    },
    async retrieveSession(sessionId, stripeAccountId) {
      return asSession(await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] }, { stripeAccount: stripeAccountId }));
    },
    async retrievePaymentIntent(paymentIntentId, stripeAccountId): Promise<ProviderPaymentIntent> {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] }, { stripeAccount: stripeAccountId });
      return {
        id: intent.id,
        status: intent.status,
        amount: intent.amount,
        currency: intent.currency,
        latestCharge: latestCharge(intent),
      };
    },
  };
}
