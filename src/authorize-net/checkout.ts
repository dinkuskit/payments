import type { CheckoutPaymentPort, PaymentRequest } from "../commerce/checkout-port.js";
export { resolvePaymentProvider } from "../checkout/providers.js";

export const AUTHORIZE_NET_SANDBOX_URL = "https://apitest.authorize.net/xml/v1/request.api";
export const AUTHORIZE_NET_PRODUCTION_URL = "https://api2.authorize.net/xml/v1/request.api";
export const AUTHORIZE_NET_HOSTED_SANDBOX_URL = "https://test.authorize.net/payment/payment";
export const AUTHORIZE_NET_HOSTED_PRODUCTION_URL = "https://accept.authorize.net/payment/payment";
export const AUTHORIZE_NET_DUPLICATE_WINDOW_SECONDS = 120;

export function authorizeNetEndpoints(mode: "test" | "live"): {
  api: string;
  hosted: string;
} {
  if (mode === "test") return { api: AUTHORIZE_NET_SANDBOX_URL, hosted: AUTHORIZE_NET_HOSTED_SANDBOX_URL };
  if (mode === "live") return { api: AUTHORIZE_NET_PRODUCTION_URL, hosted: AUTHORIZE_NET_HOSTED_PRODUCTION_URL };
  throw new AuthorizeNetError("invalid_mode");
}

export interface AuthorizeNetTransport {
  request(body: unknown): Promise<unknown>;
}

export interface AuthorizeNetTransaction {
  readonly id: string;
  readonly status: string | null;
  readonly responseCode: number | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly invoiceNumber: string | null;
  readonly refId: string | null;
}

export class AuthorizeNetError extends Error {}

function minorToAmount(minor: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(minor)) throw new AuthorizeNetError("invalid_amount");
  const value = BigInt(minor);
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AuthorizeNetError("invalid_amount");
  const dollars = value / 100n;
  const cents = String(value % 100n).padStart(2, "0");
  return `${dollars}.${cents}`;
}

function amountToMinor(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text)) return null;
  const [dollars, cents = ""] = text.split(".");
  const minor = BigInt(dollars) * 100n + BigInt(cents.padEnd(2, "0"));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

function responseBody(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthorizeNetError("invalid_provider_response");
  const body = value as Record<string, any>;
  const resultCode = body.messages?.resultCode;
  if (resultCode === "Error") {
    throw new AuthorizeNetError("authorize_net_request_rejected");
  }
  return body;
}

function transactionFrom(body: unknown): AuthorizeNetTransaction {
  const response = responseBody(body).transactionResponse;
  if (!response || typeof response !== "object") throw new AuthorizeNetError("transaction_not_found");
  return {
    id: typeof response.transId === "string" ? response.transId : "",
    status: typeof response.transactionStatus === "string" ? response.transactionStatus : null,
    responseCode: Number.isSafeInteger(response.responseCode) ? response.responseCode : null,
    amountMinor: amountToMinor(response.settleAmount ?? response.amount),
    currency: typeof response.currencyCode === "string" ? response.currencyCode : null,
    invoiceNumber: typeof response.order?.invoiceNumber === "string" ? response.order.invoiceNumber : null,
    refId: null,
  };
}

function identityFor(attemptId: string): string {
  // Authorize.net limits refId and invoiceNumber to 20 characters. Preserve
  // short Commerce identities verbatim; long identities are intentionally
  // rejected rather than silently creating a collision-prone truncation.
  if (!/^[A-Za-z0-9._-]{1,20}$/.test(attemptId)) throw new AuthorizeNetError("invalid_attempt_id");
  return attemptId;
}

function assertUsd(request: Pick<PaymentRequest, "total" | "paymentMethods">): string {
  if (request.total.currency !== "USD") throw new AuthorizeNetError("currency_mismatch");
  if (request.paymentMethods.length !== 1 || request.paymentMethods[0] !== "card") {
    throw new AuthorizeNetError("payment_method_mismatch");
  }
  return minorToAmount(request.total.minor);
}

export function createAuthorizeNetGateway(options: {
  apiLoginId: string;
  transactionKey: string;
  mode: "test" | "live";
  transport?: AuthorizeNetTransport;
}): {
  createHostedPayment(input: {
    attemptId: string;
    total: { currency: "USD"; minor: string };
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ token: string; identity: string }>;
  getTransaction(transactionId: string): Promise<AuthorizeNetTransaction>;
} {
  const endpoints = authorizeNetEndpoints(options.mode);
  if (!options.apiLoginId || !options.transactionKey) throw new AuthorizeNetError("missing_credentials");
  const transport = options.transport ?? {
    async request(body: unknown) {
      const response = await fetch(endpoints.api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new AuthorizeNetError("authorize_net_transport");
      return response.json();
    },
  };
  const authentication = { name: options.apiLoginId, transactionKey: options.transactionKey };
  return {
    async createHostedPayment(input) {
      const identity = identityFor(input.attemptId);
      const amount = minorToAmount(input.total.minor);
      for (const value of [input.returnUrl, input.cancelUrl]) {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.hash) {
          throw new AuthorizeNetError("invalid_return_url");
        }
      }
      const body = await transport.request({
        getHostedPaymentPageRequest: {
          merchantAuthentication: authentication,
          refId: identity,
          transactionRequest: {
            transactionType: "authCaptureTransaction",
            amount,
            order: { invoiceNumber: identity },
          },
          hostedPaymentSettings: {
            setting: [
              {
                settingName: "hostedPaymentReturnOptions",
                settingValue: JSON.stringify({
                  url: input.returnUrl,
                  urlText: "Return",
                  cancelUrl: input.cancelUrl,
                  cancelUrlText: "Cancel",
                  showReceipt: false,
                }),
              },
            ],
          },
        },
      });
      const token = responseBody(body).token;
      if (typeof token !== "string" || token.length === 0) throw new AuthorizeNetError("missing_hosted_token");
      return { token, identity };
    },
    async getTransaction(transactionId) {
      if (!/^[0-9]+$/.test(transactionId)) throw new AuthorizeNetError("invalid_transaction_id");
      const body = await transport.request({
        getTransactionDetailsRequest: {
          merchantAuthentication: authentication,
          transId: transactionId,
        },
      });
      const transaction = transactionFrom(body);
      if (transaction.id !== transactionId) throw new AuthorizeNetError("transaction_mismatch");
      return transaction;
    },
  };
}

export function transactionOutcome(transaction: AuthorizeNetTransaction, expected: { minor: string; currency: "USD" }): "paid" | "unpaid" | "unknown" {
  if (transaction.amountMinor === null || transaction.amountMinor !== Number(expected.minor) ||
      transaction.currency !== expected.currency) throw new AuthorizeNetError("amount_or_currency_mismatch");
  if (transaction.responseCode === 1 &&
      ["capturedPendingSettlement", "settledSuccessfully"].includes(transaction.status ?? "")) return "paid";
  if (["declined", "failed", "voided"].includes(transaction.status ?? "")) return "unpaid";
  return "unknown";
}

export function createAuthorizeNetPaymentPort(options: {
  gateway: ReturnType<typeof createAuthorizeNetGateway>;
  returnUrl: string;
  cancelUrl: string;
}): CheckoutPaymentPort {
  // This port is intentionally only the adapter seam. Commerce remains the
  // durable owner of attempt/session mapping and must supply transaction IDs
  // to lookup in its reconciliation implementation.
  const sessions = new Map<string, { token: string; identity: string }>();
  return {
    async ensureSession(request) {
      assertUsd(request);
      const existing = sessions.get(request.attemptId);
      if (existing) return { outcome: "unknown" };
      try {
        const created = await options.gateway.createHostedPayment({
          attemptId: request.attemptId,
          total: request.total,
          returnUrl: options.returnUrl,
          cancelUrl: options.cancelUrl,
        });
        sessions.set(request.attemptId, created);
      } catch {
        return { outcome: "unknown" };
      }
      return { outcome: "unknown" };
    },
    async lookup() {
      return { outcome: "unknown" };
    },
  };
}
