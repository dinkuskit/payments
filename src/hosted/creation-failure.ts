import Stripe from "stripe";
import type { CreationFailure } from "../connection-diagnostics.js";

/** Copy only closed scalar facts; never message, raw body, headers or request IDs. */
export function creationFailure(error: unknown, at: number): CreationFailure {
  let category: CreationFailure["category"] = "unknown";
  let status: number | undefined;
  if (error instanceof Stripe.errors.StripeError) {
    if ([400, 401, 403, 409, 429, 500, 502, 503, 504].includes(error.statusCode!)) status = error.statusCode;
    if (error instanceof Stripe.errors.StripeAuthenticationError) category = "authentication";
    else if (error instanceof Stripe.errors.StripePermissionError) category = "permission";
    else if (error instanceof Stripe.errors.StripeRateLimitError) category = "rate_limited";
    else if (error instanceof Stripe.errors.StripeConnectionError) category = "transport_unknown";
    else if (error instanceof Stripe.errors.StripeAPIError) category = "provider_unavailable";
    else if (error.code === "platform_account_required") category = "platform_required";
  }
  return { category, at: Math.max(0, Math.min(8_640_000_000_000_000, Number.isFinite(at) ? Math.trunc(at) : 0)), ...(status === undefined ? {} : { status }) };
}
