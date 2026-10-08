import type { CheckoutPaymentPort, PaymentRequest } from "../commerce/checkout-port.js";
export { resolvePaymentProvider } from "../checkout/providers.js";

export const AUTHORIZE_NET_SANDBOX_URL = "https://apitest.authorize.net/xml/v1/request.api";
export const AUTHORIZE_NET_PRODUCTION_URL = "https://api2.authorize.net/xml/v1/request.api";
export const AUTHORIZE_NET_HOSTED_SANDBOX_URL = "https://test.authorize.net/payment/payment";
export const AUTHORIZE_NET_HOSTED_PRODUCTION_URL = "https://accept.authorize.net/payment/payment";
export const AUTHORIZE_NET_DUPLICATE_WINDOW_SECONDS = 120;
export const AUTHORIZE_NET_REQUEST_TIMEOUT_MS = 10_000;

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

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new AuthorizeNetError("authorize_net_timeout"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuthorizeNetError("authorize_net_timeout")), remaining);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Keep the deadline at the promise boundary. Passing an AbortSignal through
 * the host RPC boundary is not reliable in the plugin sandbox, and a fetch
 * response can resolve before its body is available. The same deadline covers
 * both operations without crossing that boundary.
 */
export function createAuthorizeNetFetchTransport(options: {
  endpoint: string;
  timeoutMs?: number;
}): AuthorizeNetTransport {
  const timeoutMs = options.timeoutMs ?? AUTHORIZE_NET_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AuthorizeNetError("invalid_timeout");
  return {
    async request(body) {
      const deadline = Date.now() + timeoutMs;
      const response = await withDeadline(fetch(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }), deadline);
      if (!response.ok) throw new AuthorizeNetError("authorize_net_transport");
      const text = await withDeadline(response.text(), deadline);
      try { return JSON.parse(text); }
      catch { throw new AuthorizeNetError("invalid_provider_response"); }
    },
  };
}

export interface AuthorizeNetTransaction {
  readonly id: string;
  readonly status: string | null;
  readonly responseCode: number | null;
  readonly amountMinor: number | null;
  readonly authAmountMinor: number | null;
  readonly settleAmountMinor: number | null;
  readonly currency: string | null;
  readonly invoiceNumber: string | null;
  readonly refId: string | null;
}

export class AuthorizeNetError extends Error {
  readonly providerDiagnostic?: { resultCode: string | null; code: string | null; text: string | null };
  constructor(message: string, providerDiagnostic?: AuthorizeNetError["providerDiagnostic"]) {
    super(message);
    this.providerDiagnostic = providerDiagnostic;
  }
}

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
    const message = Array.isArray(body.messages?.message) ? body.messages.message[0] : null;
    throw new AuthorizeNetError("authorize_net_request_rejected", {
      resultCode,
      code: typeof message?.code === "string" ? message.code : null,
      text: typeof message?.text === "string" ? message.text : null,
    });
  }
  return body;
}

function transactionFrom(body: unknown, merchantCurrency: string): AuthorizeNetTransaction {
  const response = responseBody(body).transaction;
  if (!response || typeof response !== "object") throw new AuthorizeNetError("transaction_not_found");
  const authAmountMinor = amountToMinor(response.authAmount);
  const settleAmountMinor = response.settleAmount === undefined ? null : amountToMinor(response.settleAmount);
  return {
    id: typeof response.transId === "string" ? response.transId : "",
    status: typeof response.transactionStatus === "string" ? response.transactionStatus : null,
    responseCode: Number.isSafeInteger(response.responseCode) ? response.responseCode : null,
    amountMinor: authAmountMinor,
    authAmountMinor,
    settleAmountMinor,
    // Get Transaction Details does not return currencyCode. Currency is a
    // server-owned merchant invariant, never inferred from the response.
    currency: merchantCurrency,
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
  merchantCurrency: string;
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
  if (options.merchantCurrency !== "USD") throw new AuthorizeNetError("unsupported_merchant_currency");
  if (!options.apiLoginId || !options.transactionKey) throw new AuthorizeNetError("missing_credentials");
  const transport = options.transport ?? createAuthorizeNetFetchTransport({ endpoint: endpoints.api });
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
      const transaction = transactionFrom(body, options.merchantCurrency);
      if (transaction.id !== transactionId) throw new AuthorizeNetError("transaction_mismatch");
      return transaction;
    },
  };
}

export function transactionOutcome(transaction: AuthorizeNetTransaction, expected: { minor: string; currency: "USD" }): "paid" | "unpaid" | "unknown" {
  const expectedMinor = Number(expected.minor);
  if (transaction.authAmountMinor === null || transaction.authAmountMinor !== expectedMinor ||
      (transaction.settleAmountMinor !== null && transaction.settleAmountMinor !== expectedMinor) ||
      transaction.currency !== expected.currency) throw new AuthorizeNetError("amount_or_currency_mismatch");
  if (transaction.responseCode === 1 &&
      ["capturedPendingSettlement", "settledSuccessfully"].includes(transaction.status ?? "")) return "paid";
  if (["declined", "failed", "voided", "errored", "error", "settlementError"].includes(transaction.status ?? "")) return "unpaid";
  return "unknown";
}

export function createAuthorizeNetPaymentPort(options: {
  gateway: ReturnType<typeof createAuthorizeNetGateway>;
  returnUrl: string;
  cancelUrl: string;
  hostedUrl: string;
  siteId?: string;
  store: {
    transaction<T>(fn: (state: {
      read(attemptId: string): { token: string; transactionId: string | null; createdAt: number; expiresAt: number; bindingRef?: string; siteId?: string; amountMinor?: string; currency?: string } | null;
      write(attemptId: string, value: { token: string; transactionId: string | null; createdAt: number; expiresAt: number; bindingRef?: string; siteId?: string; amountMinor?: string; currency?: string }): void;
    }) => T): T;
  };
  now?: () => number;
}): CheckoutPaymentPort & { recordTransaction(attemptId: string, transactionId: string): void } {
  const now = options.now ?? (() => Date.now());
  const read = (attemptId: string) => options.store.transaction(tx => tx.read(attemptId));
  const asSession = (record: { token: string; createdAt: number; expiresAt: number }) => ({
    sessionId: record.token,
    redirectUrl: `${options.hostedUrl}?token=${encodeURIComponent(record.token)}`,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
  return {
    async ensureSession(request) {
      assertUsd(request);
      const existing = read(request.attemptId);
      if (existing) {
        if (existing.bindingRef !== request.bindingRef || existing.amountMinor !== request.total.minor || existing.currency !== request.total.currency) {
          throw new AuthorizeNetError("attempt_mismatch");
        }
        return {
        outcome: "open",
        attemptId: request.attemptId,
        total: request.total,
        session: asSession(existing),
        };
      }
      try {
        const created = await options.gateway.createHostedPayment({
          attemptId: request.attemptId,
          total: request.total,
          returnUrl: options.returnUrl,
          cancelUrl: options.cancelUrl,
        });
        const createdAt = Math.floor(now() / 1000);
        const expiresAt = createdAt + ("paymentWindow" in request && request.paymentWindow
          ? request.paymentWindow.maxSeconds : request.paymentWindowSeconds);
        options.store.transaction(tx => {
          if (!tx.read(request.attemptId)) tx.write(request.attemptId, {
            token: created.token, transactionId: null, createdAt, expiresAt,
            bindingRef: request.bindingRef, siteId: options.siteId,
            amountMinor: request.total.minor, currency: request.total.currency,
          });
        });
        const saved = read(request.attemptId);
        if (!saved) return { outcome: "unknown" };
        return {
          outcome: "open",
          attemptId: request.attemptId,
          total: request.total,
          session: asSession(saved),
        };
      } catch {
        return { outcome: "unknown" };
      }
    },
    async lookup(request) {
      assertUsd(request);
      const existing = read(request.attemptId);
      if (!existing?.transactionId) return { outcome: "unknown" };
      try {
        const transaction = await options.gateway.getTransaction(existing.transactionId);
        const outcome = transactionOutcome(transaction, request.total);
        const fields = { attemptId: request.attemptId, total: request.total, session: asSession(existing) };
        if (outcome === "paid") return { outcome, ...fields, paymentId: transaction.id };
        if (outcome === "unpaid") return { outcome: "expired-unpaid" as const, ...fields };
        return { outcome: "unknown" as const };
      } catch (error) {
        if (error instanceof AuthorizeNetError && error.message === "amount_or_currency_mismatch") throw error;
        return { outcome: "unknown" };
      }
    },
    recordTransaction(attemptId, transactionId) {
      if (!/^[0-9]+$/.test(transactionId)) throw new AuthorizeNetError("invalid_transaction_id");
      options.store.transaction(tx => {
        const current = tx.read(attemptId);
        if (current) tx.write(attemptId, { ...current, transactionId });
      });
    },
  };
}
