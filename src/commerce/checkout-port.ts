/**
 * Types-only fixture of DinkusKit Commerce CheckoutPaymentPort / Money.
 * Package `@dinkuskit/commerce` is unpublished. This is not a competing
 * payment, order, or cart model.
 *
 * Recorded source identity:
 * git:1cb55c756ef746bcb042b9679dc43b57e67bcb0d
 * (github:dinkuskit/commerce/pull/29, published head). Port and Money
 * types are unchanged from 7a054ea6e7a148dd0e1039ec138d967f02431ceb.
 * Do not edit Commerce from this repository.
 *
 * PaymentSession.createdAt / expiresAt are Unix epoch seconds.
 * Commerce orchestrate.ts checks expiresAt === createdAt + 1800 and
 * compares clocks with Date.now()/1000. Existing Payments onboarding
 * times remain milliseconds.
 */
export const COMMERCE_CHECKOUT_CONTRACT_SOURCE =
  "git:1cb55c756ef746bcb042b9679dc43b57e67bcb0d" as const;
export const COMMERCE_CURRENCY_USD = "USD" as const;
export const PAYMENT_WINDOW_SECONDS = 1800 as const;

export interface Money {
  currency: typeof COMMERCE_CURRENCY_USD;
  minor: string;
}
export interface CheckoutLine {
  catalogItemId: string;
  quantity: number;
  name: string;
  unitPrice: Money;
}
export interface PaymentRequest {
  attemptId: string;
  bindingRef: string;
  lines: CheckoutLine[];
  total: Money;
  paymentWindowSeconds: typeof PAYMENT_WINDOW_SECONDS;
  paymentMethods: readonly ["card"];
}
export interface PaymentSession {
  sessionId: string;
  redirectUrl: string;
  createdAt: number;
  expiresAt: number;
}
export type PaymentOutcome =
  | { outcome: "unknown" }
  | { outcome: "open"; attemptId: string; total: Money; session: PaymentSession }
  | { outcome: "paid"; attemptId: string; total: Money; session: PaymentSession; paymentId: string }
  | { outcome: "expired-unpaid"; attemptId: string; total: Money; session: PaymentSession }
  | { outcome: "not-created"; attemptId: string };
export interface CheckoutPaymentPort {
  ensureSession(request: PaymentRequest): Promise<PaymentOutcome>;
  lookup(request: PaymentRequest): Promise<PaymentOutcome>;
}
