import type { CheckoutLine, CheckoutPricingSnapshot } from "../commerce/checkout-port.js";

/** Transport representation only; Commerce already allocated every amount. */
export interface CheckoutChargeLine {
  quantity: 1;
  amountMinor: string;
  name: string;
  description: string;
}

export function createPricedChargeLines(lines: readonly CheckoutLine[], pricing: CheckoutPricingSnapshot, requestTotal: string): CheckoutChargeLine[] {
  const items: CheckoutChargeLine[] = [];
  let total = 0n;
  for (const [index, line] of pricing.lines.entries()) {
    const net = BigInt(line.netAmount.minor);
    if (net === 0n) continue;
    if (net < 0n || net > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid_pricing_mapping");
    const original = lines[index];
    items.push({ quantity: 1, amountMinor: line.netAmount.minor,
      name: `${original.name} (quantity ${original.quantity})`,
      description: `Original catalog quantity: ${original.quantity}` });
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
