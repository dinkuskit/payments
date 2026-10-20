import Stripe from "stripe";
import { createStripeClient } from "./onboarding.js";
import type { CheckoutProvider, LatestCharge, ProviderPaymentIntent, ProviderSession } from "../checkout/sessions.js";
import { createPricedChargeLines } from "../checkout/charge-lines.js";
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

/** Shown on every TEST Checkout page; live sessions carry no custom text. */
export const TEST_MODE_CARD_MESSAGE =
  "Test mode, no real charge: pay with card 4242 4242 4242 4242, any future expiry date and any CVC.";

export function createStripeCheckout(options: {
  apiKey: string;
  mode: Mode;
  httpClient?: Stripe.HttpClient;
  /**
   * When the key belongs to the receiving account itself (the playground
   * sandbox), calls for that account go direct, without a Stripe-Account header.
   */
  ownAccountId?: string;
}): CheckoutProvider {
  if (!options.apiKey.startsWith(options.mode === "test" ? "sk_test_" : "sk_live_")) throw new Error("stripe_mode_mismatch");
  const accountOption = (stripeAccountId: string) =>
    options.ownAccountId !== undefined && stripeAccountId === options.ownAccountId ? {} : { stripeAccount: stripeAccountId };
  const stripe = createStripeClient(options.apiKey, options.mode, options.httpClient);
  return {
    async createSession(input) {
      const priced = input.pricing ? createPricedChargeLines(input.lines, input.pricing, input.total.minor) : undefined;
      if (input.chargeLines && JSON.stringify(input.chargeLines) !== JSON.stringify(priced)) throw new Error("invalid_pricing_mapping");
      const lineItems = priced
        ? (input.chargeLines ?? priced).map(line => ({ quantity: line.quantity, price_data: {
          currency: "usd", unit_amount: Number(line.amountMinor), product_data: { name: line.name, description: line.description },
        } }))
        : input.lines.map(line => ({
          quantity: line.quantity,
          price_data: {
            currency: "usd",
            unit_amount: Number(line.unitPrice.minor),
            product_data: { name: line.name },
          },
        }));
      if (lineItems.length > 100) throw new Error("stripe_line_item_limit");
      // Preserve the pre-migration card-only Checkout contract on the pinned v1 API.
      const params: Stripe.Checkout.SessionCreateParams & { payment_method_types: ["card"] } = {
        mode: "payment",
        payment_method_types: ["card"],
        expires_at: input.expiresAtSeconds,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.attemptId,
        metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId },
        payment_intent_data: { metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId } },
        line_items: lineItems,
        // Stripe shows this beside its Pay button, so a shopper on a test store knows which card works.
        // Only attempts claimed with it pinned get it, so a same-key retry of an older attempt is unchanged.
        ...(options.mode === "test" && input.testCardMessage === true ? { custom_text: { submit: { message: TEST_MODE_CARD_MESSAGE } } } : {}),
      };
      const session = await stripe.checkout.sessions.create(params, { ...accountOption(input.stripeAccountId), idempotencyKey: input.idempotencyKey });
      return asSession(session);
    },
    async retrieveSession(sessionId, stripeAccountId) {
      return asSession(await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] }, accountOption(stripeAccountId)));
    },
    async retrievePaymentIntent(paymentIntentId, stripeAccountId): Promise<ProviderPaymentIntent> {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] }, accountOption(stripeAccountId));
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
