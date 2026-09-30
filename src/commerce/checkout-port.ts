/**
 * Fixture for Commerce checkout payment port and policy helpers. Payments integrates
 * through this contract and does not create an independent or competing
 * payment, order, or cart model.
 *
 * Recorded source identity:
 * git:ab37cd7f362f1c37cb1d321192abbbc48a623833
 * (github:dinkuskit/commerce/pull/37, merged).
 * Port, Money types, and payment-window policy helpers consume the approved payment window.
 * Do not edit Commerce from this repository.
 *
 * PaymentSession.createdAt / expiresAt are Unix epoch seconds.
 * Commerce orchestrate.ts validates providerSessionWindowIsValid (1800..1860s)
 * and compares clocks with Date.now()/1000. Existing Payments onboarding
 * times remain milliseconds.
 */
export const COMMERCE_CHECKOUT_CONTRACT_SOURCE =
  "git:ab37cd7f362f1c37cb1d321192abbbc48a623833" as const;
export const COMMERCE_CURRENCY_USD = "USD" as const;

export const CURRENT_PAYMENT_WINDOW_MIN_SECONDS = 1800;
export const CURRENT_PAYMENT_WINDOW_MAX_SECONDS = 1860;
export const LEGACY_EXACT_PAYMENT_WINDOW_SECONDS = 1800;
export const PAYMENTS_CREATE_RETRY_BOUND_HOURS = 23;
export const PAYMENTS_SAFE_PROVIDER_DELAY_SECONDS = 60;

export const CURRENT_PAYMENT_WINDOW = {
  minSeconds: CURRENT_PAYMENT_WINDOW_MIN_SECONDS,
  maxSeconds: CURRENT_PAYMENT_WINDOW_MAX_SECONDS,
} as const;

export type CurrentPaymentWindow = {
  readonly minSeconds: typeof CURRENT_PAYMENT_WINDOW_MIN_SECONDS;
  readonly maxSeconds: typeof CURRENT_PAYMENT_WINDOW_MAX_SECONDS;
};

export type PaymentWindowPolicyKind =
  | "current-bounded-1800-1860"
  | "legacy-exact-1800";

export interface PaymentWindowBounds {
  readonly kind: PaymentWindowPolicyKind;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

export interface Money {
  currency: typeof COMMERCE_CURRENCY_USD;
  minor: string;
}

export interface CartLine {
  catalogItemId: string;
  quantity: number;
}

export interface CheckoutLine extends CartLine {
  name: string;
  unitPrice: Money;
}

interface PaymentRequestBase {
  attemptId: string;
  bindingRef: string;
  lines: CheckoutLine[];
  total: Money;
  paymentMethods: readonly ["card"];
}

/** Current Commerce construction. New attempts use only this shape. */
export interface CurrentPaymentRequest extends PaymentRequestBase {
  paymentWindow: CurrentPaymentWindow;
  paymentWindowSeconds?: never;
}

/**
 * Frozen historical originals only. Replay exactly; never rewrite to
 * `paymentWindow` on retry or restart.
 */
export interface LegacyExact1800PaymentRequest extends PaymentRequestBase {
  paymentWindowSeconds: typeof LEGACY_EXACT_PAYMENT_WINDOW_SECONDS;
  paymentWindow?: never;
}

export type PaymentRequest = CurrentPaymentRequest | LegacyExact1800PaymentRequest;

export type PaymentRequestHandoff =
  | { kind: "current-bounded-1800-1860"; request: CurrentPaymentRequest }
  | { kind: "legacy-exact-1800"; request: LegacyExact1800PaymentRequest };

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

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isExactCurrentWindow(value: unknown): value is CurrentPaymentRequest["paymentWindow"] {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value).sort();
  if (keys.join() !== "maxSeconds,minSeconds") return false;
  const window = value as { minSeconds: unknown; maxSeconds: unknown };
  return (
    window.minSeconds === CURRENT_PAYMENT_WINDOW_MIN_SECONDS &&
    window.maxSeconds === CURRENT_PAYMENT_WINDOW_MAX_SECONDS
  );
}

export function isCurrentPaymentRequest(request: PaymentRequest): request is CurrentPaymentRequest {
  return hasOwn(request, "paymentWindow") && !hasOwn(request, "paymentWindowSeconds");
}

export function isLegacyExact1800PaymentRequest(
  request: PaymentRequest,
): request is LegacyExact1800PaymentRequest {
  return hasOwn(request, "paymentWindowSeconds") && !hasOwn(request, "paymentWindow");
}

export function createCurrentPaymentRequest(
  input: Omit<CurrentPaymentRequest, "paymentWindow" | "paymentMethods">,
): CurrentPaymentRequest {
  return {
    ...input,
    paymentWindow: { ...CURRENT_PAYMENT_WINDOW },
    paymentMethods: ["card"],
  };
}

export function paymentRequestHandoff(request: PaymentRequest): PaymentRequestHandoff | null {
  if (isLegacyExact1800PaymentRequest(request)) {
    if (request.paymentWindowSeconds !== LEGACY_EXACT_PAYMENT_WINDOW_SECONDS) return null;
    return { kind: "legacy-exact-1800", request };
  }
  if (isCurrentPaymentRequest(request)) {
    if (!isExactCurrentWindow(request.paymentWindow)) return null;
    return { kind: "current-bounded-1800-1860", request };
  }
  return null;
}

export function readFrozenPaymentWindowBounds(request: PaymentRequest): PaymentWindowBounds | null {
  const handoff = paymentRequestHandoff(request);
  if (!handoff) return null;
  if (handoff.kind === "legacy-exact-1800") {
    return {
      kind: "legacy-exact-1800",
      minSeconds: LEGACY_EXACT_PAYMENT_WINDOW_SECONDS,
      maxSeconds: LEGACY_EXACT_PAYMENT_WINDOW_SECONDS,
    };
  }
  return {
    kind: "current-bounded-1800-1860",
    minSeconds: CURRENT_PAYMENT_WINDOW_MIN_SECONDS,
    maxSeconds: CURRENT_PAYMENT_WINDOW_MAX_SECONDS,
  };
}

export function providerSessionWindowIsValid(session: PaymentSession, request: PaymentRequest): boolean {
  if (typeof session.sessionId !== "string" || !session.sessionId) return false;
  if (!Number.isSafeInteger(session.createdAt)) return false;
  if (!Number.isSafeInteger(session.expiresAt)) return false;
  const duration = session.expiresAt - session.createdAt;
  if (!Number.isSafeInteger(duration)) return false;
  const bounds = readFrozenPaymentWindowBounds(request);
  if (!bounds) return false;
  return duration >= bounds.minSeconds && duration <= bounds.maxSeconds;
}
