import type { Principal } from "../hosted/connection.js";
import { CheckoutError } from "./sessions.js";

export type ReturnPages = { successUrl: string; cancelUrl: string };

/**
 * After paying or cancelling, shoppers go back to their own store. The address is the one
 * DinkusKit.com checked when the store connected and signed into the store's pass, never
 * request input, so a pass without it cannot start a checkout.
 */
export function storeReturnPages(principal: Principal, provider: "stripe" | "authorize_net"): ReturnPages {
  if (!principal.siteOrigin) throw new CheckoutError("store_origin_missing");
  return {
    // Stripe fills in the Checkout Session ID; Authorize.net has no such placeholder.
    successUrl: `${principal.siteOrigin}/checkout/success${provider === "stripe" ? "?session_id={CHECKOUT_SESSION_ID}" : ""}`,
    cancelUrl: `${principal.siteOrigin}/cart`,
  };
}
