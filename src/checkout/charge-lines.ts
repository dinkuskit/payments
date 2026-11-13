import type { CheckoutLine, CheckoutPricingSnapshot } from "../commerce/checkout-port.js";

/** Transport representation only; Commerce already allocated every amount. */
export interface CheckoutChargeLine {
  quantity: 1;
  amountMinor: string;
  name: string;
  /** Stripe's grey line under the name: the shopper's choices ("Size: M"), or none. */
  description?: string;
}

/**
 * v1: "Hat (quantity 2)" with "Original catalog quantity: 2", kept exactly for attempts claimed before v2,
 * since a same-key retry must resend the original parameters. v2: "Hat × 2" with the line's options.
 */
export type ChargeLineMapping = "stripe-whole-line-v1" | "stripe-whole-line-v2";
export const CURRENT_CHARGE_LINE_MAPPING: ChargeLineMapping = "stripe-whole-line-v2";

export function createPricedChargeLines(lines: readonly CheckoutLine[], pricing: CheckoutPricingSnapshot, requestTotal: string,
  mapping: ChargeLineMapping = CURRENT_CHARGE_LINE_MAPPING): CheckoutChargeLine[] {
  const items: CheckoutChargeLine[] = [];
  let total = 0n;
  for (const [index, line] of pricing.lines.entries()) {
    const net = BigInt(line.netAmount.minor);
    if (net === 0n) continue;
    if (net < 0n || net > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid_pricing_mapping");
    const original = lines[index];
    // One charge per line at its net total, so the name carries the quantity: "Tee", or "Tee × 2".
    items.push(mapping === "stripe-whole-line-v1"
      ? { quantity: 1, amountMinor: line.netAmount.minor, name: `${original.name} (quantity ${original.quantity})`,
        description: `Original catalog quantity: ${original.quantity}` }
      : { quantity: 1, amountMinor: line.netAmount.minor,
        name: original.quantity === 1 ? original.name : `${original.name} × ${original.quantity}`,
        ...(original.options ? { description: original.options } : {}) });
    total += net;
  }
  const shipping = BigInt(pricing.shipping.charge.minor);
  if (shipping < 0n || shipping > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid_pricing_mapping");
  if (shipping > 0n) {
    items.push({ quantity: 1, amountMinor: pricing.shipping.charge.minor, name: "Shipping", description: "Flat shipping" });
    total += shipping;
  }
  if (items.length > 100) throw new Error("stripe_line_item_limit");
  if (total <= 0n || total !== BigInt(pricing.finalTotal.minor) || pricing.finalTotal.minor !== requestTotal) throw new Error("invalid_pricing_mapping");
  return items;
}
