import type { CheckoutPaymentPort, PaymentOutcome, PaymentRequest } from "../commerce/checkout-port.js";
import { requestFingerprint } from "../checkout/sessions.js";
export { resolvePaymentProvider } from "../checkout/providers.js";

export type AuthorizeNetSessionOutcome = Exclude<PaymentOutcome["outcome"], "not-created">;

/**
 * Explicit outcome progression for an Authorize.Net checkout attempt.
 * `paid` is absorbing; `expired-unpaid` can still surface a late authoritative
 * `paid` or `unknown` transaction when Authorize.Net delivers a delayed notice.
 */
export const AUTHORIZE_NET_OUTCOME_TRANSITIONS: Readonly<
  Record<AuthorizeNetSessionOutcome, readonly AuthorizeNetSessionOutcome[]>
> = {
  unknown: ["open", "paid", "expired-unpaid", "unknown"],
  open: ["open", "paid", "expired-unpaid", "unknown"],
  paid: ["paid"],
  "expired-unpaid": ["expired-unpaid", "paid", "unknown"],
};

export const AUTHORIZE_NET_SANDBOX_URL = "https://apitest.authorize.net/xml/v1/request.api";
export const AUTHORIZE_NET_PRODUCTION_URL = "https://api2.authorize.net/xml/v1/request.api";
export const AUTHORIZE_NET_HOSTED_SANDBOX_URL = "https://test.authorize.net/payment/payment";
export const AUTHORIZE_NET_HOSTED_PRODUCTION_URL = "https://accept.authorize.net/payment/payment";
/**
 * Sent on every hosted payment: Authorize.net's default 120 seconds refuses a declined shopper's corrected retry
 * as a duplicate. One checkout's tries all carry its invoice reference, and the authoritative lookup decides paid.
 */
export const AUTHORIZE_NET_DUPLICATE_WINDOW_SECONDS = 0;
/**
 * Authorize.net shows its hosted form for a token only within 15 minutes of minting it. A checkout has one live
 * token at a time: every pay page visit gets it until those 15 minutes end, so two tabs share one card form.
 */
export const AUTHORIZE_NET_FORM_TOKEN_SECONDS = 900;
/** After the last token can no longer be used, this long passes before every-try-unpaid becomes final. */
export const AUTHORIZE_NET_SETTLE_MARGIN_SECONDS = 300;
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

/**
 * Authorize.net invoiceNumber / refId format (max 20 characters).
 *
 *   {storeTag}.{attemptId}
 *
 * Length budget (20 total, fail closed — never truncate into ambiguity):
 *   storeTag:  8 lowercase hex chars = first 4 bytes of SHA-256(UTF-8 siteId)
 *   separator: 1 char "."
 *   attemptId: 1..11 chars matching [A-Za-z0-9._-]
 *
 * Characters are limited to Authorize.net-safe [A-Za-z0-9._-]. The store tag
 * binds the signed notification to a site so colliding Commerce attempt IDs
 * across stores cannot be applied to the wrong Durable Object.
 */
export const AUTHORIZE_NET_INVOICE_MAX_LENGTH = 20;
export const AUTHORIZE_NET_STORE_TAG_LENGTH = 8;
export const AUTHORIZE_NET_INVOICE_SEPARATOR = ".";
export const AUTHORIZE_NET_ATTEMPT_ID_MAX_LENGTH =
  AUTHORIZE_NET_INVOICE_MAX_LENGTH - AUTHORIZE_NET_STORE_TAG_LENGTH - AUTHORIZE_NET_INVOICE_SEPARATOR.length;

const ATTEMPT_ID_PATTERN = new RegExp(`^[A-Za-z0-9._-]{1,${AUTHORIZE_NET_ATTEMPT_ID_MAX_LENGTH}}$`);
const STORE_TAG_PATTERN = new RegExp(`^[0-9a-f]{${AUTHORIZE_NET_STORE_TAG_LENGTH}}$`);
const INVOICE_REFERENCE_PATTERN = /^[A-Za-z0-9._-]{1,20}$/;

function hexDigest(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function authorizeNetStoreTag(siteId: string): Promise<string> {
  if (typeof siteId !== "string" || siteId.length < 1 || siteId.length > 200) {
    throw new AuthorizeNetError("invalid_site_id");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(siteId));
  return hexDigest(digest).slice(0, AUTHORIZE_NET_STORE_TAG_LENGTH);
}

export async function buildAuthorizeNetInvoiceReference(siteId: string, attemptId: string): Promise<string> {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new AuthorizeNetError("invalid_attempt_id");
  const storeTag = await authorizeNetStoreTag(siteId);
  const reference = `${storeTag}${AUTHORIZE_NET_INVOICE_SEPARATOR}${attemptId}`;
  // Overflow must fail closed. Truncation would make two attempts share a ref.
  if (reference.length > AUTHORIZE_NET_INVOICE_MAX_LENGTH) {
    throw new AuthorizeNetError("invoice_reference_too_long");
  }
  if (!INVOICE_REFERENCE_PATTERN.test(reference)) throw new AuthorizeNetError("invalid_invoice_reference");
  return reference;
}

export function parseAuthorizeNetInvoiceReference(reference: string): { storeTag: string; attemptId: string } | null {
  if (typeof reference !== "string" || !INVOICE_REFERENCE_PATTERN.test(reference)) return null;
  const separatorAt = reference.indexOf(AUTHORIZE_NET_INVOICE_SEPARATOR);
  if (separatorAt !== AUTHORIZE_NET_STORE_TAG_LENGTH) return null;
  const storeTag = reference.slice(0, separatorAt);
  const attemptId = reference.slice(separatorAt + AUTHORIZE_NET_INVOICE_SEPARATOR.length);
  if (!STORE_TAG_PATTERN.test(storeTag) || !ATTEMPT_ID_PATTERN.test(attemptId)) return null;
  if (storeTag.length + AUTHORIZE_NET_INVOICE_SEPARATOR.length + attemptId.length > AUTHORIZE_NET_INVOICE_MAX_LENGTH) {
    return null;
  }
  return { storeTag, attemptId };
}

async function identityFor(siteId: string, attemptId: string): Promise<string> {
  return buildAuthorizeNetInvoiceReference(siteId, attemptId);
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
    siteId: string;
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
      const identity = await identityFor(input.siteId, input.attemptId);
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
            // After order: Authorize.net validates element order.
            transactionSettings: {
              setting: [{ settingName: "duplicateWindow", settingValue: String(AUTHORIZE_NET_DUPLICATE_WINDOW_SECONDS) }],
            },
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

/**
 * One checkout's stored state. Records written before the pay page have no sessionId: their session is the
 * Authorize.net token itself, and they keep that shape until they expire.
 */
export interface AuthorizeNetAttemptRecord {
  token: string;
  /** The checkout as Commerce first asked for it (Stripe's request fingerprint); a changed request is refused. */
  requestFingerprint?: string;
  /** The first try Authorize.net proved paid. Kept apart from the try list, so later tries never push it out. */
  paidId?: string;
  /** Further tries Authorize.net proved paid for this same checkout: the checkout was paid more than once. */
  alsoPaid?: string[];
  /** Tries read since the checkout was paid and found not to be a further payment, so they are not read again. */
  settled?: string[];
  transactionId: string | null;
  transactionIds?: string[];
  createdAt: number;
  expiresAt: number;
  bindingRef?: string;
  siteId?: string;
  amountMinor?: string;
  currency?: string;
  /** Stable session id: 32 random hex, ".", the attempt id. Also the pay page's last path segment. */
  sessionId?: string;
  redirectUrl?: string;
  /** When the current token was minted, in seconds. */
  tokenAt?: number;
  returnUrl?: string;
  cancelUrl?: string;
}

/** What the pay page does for one visit. */
export type AuthorizeNetPayPage =
  | { action: "post"; hostedUrl: string; token: string }
  | { action: "redirect"; url: string }
  | { action: "not_found" };

const PAY_SESSION_PATTERN = /^[0-9a-f]{32}\.[A-Za-z0-9._-]{1,11}$/;

function newPaySessionId(attemptId: string): string {
  const secret = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${secret}.${attemptId}`;
}

/** The attempt a pay page session belongs to, or null for anything malformed. */
export function payPageAttemptId(sessionId: string): string | null {
  if (typeof sessionId !== "string" || !PAY_SESSION_PATTERN.test(sessionId)) return null;
  const attemptId = sessionId.slice(33);
  return ATTEMPT_ID_PATTERN.test(attemptId) ? attemptId : null;
}

function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** Every try unpaid becomes final only once the checkout has ended and its last card form can no longer be used. */
function settlesAt(record: AuthorizeNetAttemptRecord): number {
  return Math.max(record.expiresAt, (record.tokenAt ?? record.createdAt) + AUTHORIZE_NET_FORM_TOKEN_SECONDS) +
    AUTHORIZE_NET_SETTLE_MARGIN_SECONDS;
}

/** Most transactions kept per checkout, which also bounds the provider reads one lookup makes. */
export const AUTHORIZE_NET_TRANSACTIONS_PER_ATTEMPT = 20;

/** The latest transactions notified for a checkout, including one stored before the list existed. */
function transactionsOf(record: { transactionId: string | null; transactionIds?: string[] }): string[] {
  const ids = Array.isArray(record.transactionIds) ? [...record.transactionIds] : [];
  if (record.transactionId && !ids.includes(record.transactionId)) ids.push(record.transactionId);
  return ids.slice(-AUTHORIZE_NET_TRANSACTIONS_PER_ATTEMPT);
}

/** Most further paid tries kept for one checkout. */
export const AUTHORIZE_NET_ALSO_PAID_PER_ATTEMPT = 20;

export function createAuthorizeNetPaymentPort(options: {
  gateway: ReturnType<typeof createAuthorizeNetGateway>;
  /** The store's own return pages, needed only to start a new hosted payment. */
  returnUrl?: string;
  cancelUrl?: string;
  hostedUrl: string;
  /**
   * This store's pay page address on the hosted service, without the session segment. Needed only to start a
   * new hosted payment, like the return pages.
   */
  payPageUrl?: string;
  siteId: string;
  store: {
    transaction<T>(fn: (state: {
      read(attemptId: string): AuthorizeNetAttemptRecord | null;
      write(attemptId: string, value: AuthorizeNetAttemptRecord): void;
    }) => T): T;
  };
  /**
   * Told, inside the store transaction, each time a checkout is found paid more than once: the first paid try and
   * every further one. The owner refunds the extra by hand; Payments never refunds on its own.
   */
  paidTwice?: (attemptId: string, record: AuthorizeNetAttemptRecord) => void;
  now?: () => number;
}): CheckoutPaymentPort & {
  recordTransaction(attemptId: string, transactionId: string): void;
  /** Reads a try notified after the checkout was already paid, so a second payment is never missed. */
  checkLateTry(attemptId: string, transactionId: string): Promise<void>;
  /** Tries of a paid checkout not yet read for a second payment: one Authorize.net could not answer for yet. */
  openTries(attemptId: string): string[];
  /** Reads a paid checkout's open tries again; true once none is left. */
  recheck(attemptId: string): Promise<boolean>;
  payPage(sessionId: string): Promise<AuthorizeNetPayPage>;
} {
  if (!options.siteId) throw new AuthorizeNetError("missing_site_id");
  const now = options.now ?? (() => Date.now());
  const seconds = () => Math.floor(now() / 1000);
  const read = (attemptId: string) => options.store.transaction(tx => tx.read(attemptId));
  // Commerce refuses a session that changes, so a pay page session is stored once and returned as is.
  const asSession = (record: AuthorizeNetAttemptRecord) => record.sessionId && record.redirectUrl
    ? { sessionId: record.sessionId, redirectUrl: record.redirectUrl, createdAt: record.createdAt, expiresAt: record.expiresAt }
    : {
      sessionId: record.token,
      redirectUrl: `${options.hostedUrl}?token=${encodeURIComponent(record.token)}`,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  const mismatched = (record: AuthorizeNetAttemptRecord, request: PaymentRequest) =>
    record.bindingRef !== request.bindingRef || (record.siteId !== undefined && record.siteId !== options.siteId) ||
    record.amountMinor !== request.total.minor || record.currency !== request.total.currency;
  /** Every call names the checkout exactly as it was first asked for, as the Stripe path requires. */
  const refuseChanged = (record: AuthorizeNetAttemptRecord, request: PaymentRequest) => {
    if (mismatched(record, request)) throw new AuthorizeNetError("attempt_mismatch");
    // Checkouts stored before the fingerprint was kept end within their payment window; they keep the checks above.
    if (record.requestFingerprint !== undefined && record.requestFingerprint !== requestFingerprint(request)) {
      throw new AuthorizeNetError("request_mutation");
    }
  };
  const savedTotal = (record: AuthorizeNetAttemptRecord) => ({ minor: record.amountMinor ?? "", currency: "USD" as const });

  /**
   * Any paid try makes the checkout paid; unpaid needs every try read and unpaid. Every try is read, so a second
   * paid one is found too. A try that names another checkout or another amount (a refund made by hand, say) is
   * not this checkout's payment: it never hides a paid try, and refuses the checkout only when nothing else decides.
   */
  async function tries(attemptId: string, record: AuthorizeNetAttemptRecord, total: { minor: string; currency: "USD" }):
    Promise<{ paid: string[]; read: string[] } | { pending: true } | { unpaid: number }> {
    const ids = transactionsOf(record);
    const identity = await identityFor(options.siteId, attemptId);
    // A shopper can be declined and pay on a second try, and Authorize.net's notices can arrive in any order.
    let pending = false, refused: string | undefined;
    const paid: string[] = [], undecided: string[] = [];
    for (const id of ids) {
      let transaction;
      // A try that can't be read now is pending; another try may still prove the payment.
      try { transaction = await options.gateway.getTransaction(id); }
      catch { pending = true; undecided.push(id); continue; }
      if (transaction.invoiceNumber !== identity && transaction.refId !== identity) {
        refused ??= "identity_mismatch";
        continue;
      }
      let outcome;
      try { outcome = transactionOutcome(transaction, total); }
      catch (error) {
        refused ??= error instanceof Error ? error.message : "amount_or_currency_mismatch";
        continue;
      }
      if (outcome === "paid") paid.push(transaction.id);
      if (outcome === "unknown") { pending = true; undecided.push(id); }
    }
    // A try not yet decided stays open, to be read again even once another try made the checkout paid.
    if (paid.length) return { paid, read: ids.filter(id => !undecided.includes(id)) };
    if (pending) return { pending: true };
    if (refused) throw new AuthorizeNetError(refused);
    return { unpaid: ids.length };
  }

  /**
   * Keeps the first proven paid try for good, and any further paid one as a payment the owner must refund by
   * hand. Returns the kept paid try and any try notified while this one was being read.
   */
  function remember(attemptId: string, paid: readonly string[], read: readonly string[]): { paidId: string; unread: string[] } {
    return options.store.transaction(tx => {
      const current = tx.read(attemptId);
      if (!current) return { paidId: paid[0], unread: [] };
      // Only a paid checkout keeps track of the tries read since.
      if (!current.paidId && !paid.length) return { paidId: paid[0], unread: [] };
      const paidId = current.paidId ?? paid[0];
      const before = current.alsoPaid ?? [];
      const alsoPaid = [...new Set([...before, ...paid])].filter(id => id !== paidId).slice(0, AUTHORIZE_NET_ALSO_PAID_PER_ATTEMPT);
      const tried = transactionsOf(current), wasSettled = current.settled ?? [];
      // Only tries still on the list are kept, so the list stays as short as the try list.
      const settled = tried.filter(id => wasSettled.includes(id) || read.includes(id) && id !== paidId && !alsoPaid.includes(id));
      // A full try list drops its oldest try, so the read list can change while keeping its length.
      const resettled = settled.length !== wasSettled.length || settled.some(id => !wasSettled.includes(id));
      if (current.paidId !== paidId || alsoPaid.length !== before.length || resettled) {
        const { settled: _wasSettled, ...kept } = current;
        const next = { ...kept, paidId, ...(alsoPaid.length ? { alsoPaid } : {}), ...(settled.length ? { settled } : {}) };
        tx.write(attemptId, next);
        if (alsoPaid.length !== before.length) options.paidTwice?.(attemptId, next);
      }
      return { paidId, unread: openOf({ ...current, paidId, alsoPaid, settled }) };
    });
  }

  async function checkLateTry(attemptId: string, transactionId: string): Promise<void> {
    const record = read(attemptId);
    if (!record?.paidId || record.paidId === transactionId || record.alsoPaid?.includes(transactionId) || !record.amountMinor) return;
    // A provider error is left to throw, so Authorize.net delivers the notice again later.
    const transaction = await options.gateway.getTransaction(transactionId);
    const identity = await identityFor(options.siteId, attemptId);
    // Not this checkout's payment, or not a payment: read, so it is not read again.
    if (transaction.invoiceNumber !== identity && transaction.refId !== identity) return void remember(attemptId, [], [transactionId]);
    let outcome;
    try { outcome = transactionOutcome(transaction, savedTotal(record)); }
    catch { return void remember(attemptId, [], [transactionId]); }
    if (outcome === "paid") remember(attemptId, [transaction.id], []);
    // Still undecided at Authorize.net (held for review, say): left open, to be read again.
    else if (outcome !== "unknown") remember(attemptId, [], [transactionId]);
  }

  function openTries(attemptId: string): string[] {
    const record = read(attemptId);
    return record ? openOf(record) : [];
  }

  /** A paid checkout's tries not yet read for a second payment. */
  const openOf = (record: AuthorizeNetAttemptRecord) => record.paidId
    ? transactionsOf(record).filter(id => id !== record.paidId && !record.alsoPaid?.includes(id) && !record.settled?.includes(id))
    : [];

  /** Records the paid result, then reads any try notified meanwhile, so a second payment is never missed. */
  async function settle(attemptId: string, paid: readonly string[], ids: readonly string[]): Promise<string> {
    const { paidId, unread } = remember(attemptId, paid, ids);
    for (const id of unread) await checkLateTry(attemptId, id).catch(() => {});
    return paidId;
  }

  async function lookup(request: PaymentRequest): Promise<PaymentOutcome> {
    assertUsd(request);
    const existing = read(request.attemptId);
    if (!existing) return { outcome: "unknown" };
    refuseChanged(existing, request);
    // The saved checkout decides the amount checked and answered, never the request.
    const total = savedTotal(existing);
    const fields = { attemptId: request.attemptId, total, session: asSession(existing) };
    if (existing.paidId) return { outcome: "paid", ...fields, paymentId: existing.paidId };
    if (transactionsOf(existing).length === 0) return { outcome: "unknown" };
    try {
      const result = await tries(request.attemptId, existing, total);
      if ("paid" in result) return { outcome: "paid", ...fields, paymentId: await settle(request.attemptId, result.paid, result.read) };
      if ("pending" in result) return { outcome: "unknown" };
      // Every try so far is unpaid. The shopper can still try again until the checkout ends, and a card form
      // opened just before the end stays usable for a while after it.
      const at = seconds();
      if (at < existing.expiresAt) return { outcome: "open", ...fields };
      if (at < settlesAt(existing)) return { outcome: "unknown" };
      return { outcome: "expired-unpaid", ...fields };
    } catch (error) {
      if (error instanceof AuthorizeNetError &&
          (error.message === "amount_or_currency_mismatch" || error.message === "identity_mismatch")) {
        throw error;
      }
      return { outcome: "unknown" };
    }
  }

  /** Resolves an already-stored attempt authoritatively instead of assuming it is still open. */
  async function resolveExisting(request: PaymentRequest, existing: AuthorizeNetAttemptRecord): Promise<PaymentOutcome> {
    if (existing.paidId || transactionsOf(existing).length > 0) return lookup(request);
    if (seconds() >= existing.expiresAt) return { outcome: "unknown" };
    return {
      outcome: "open",
      attemptId: request.attemptId,
      total: request.total,
      session: asSession(existing),
    };
  }

  return {
    async ensureSession(request) {
      assertUsd(request);
      const existing = read(request.attemptId);
      if (existing) {
        refuseChanged(existing, request);
        return resolveExisting(request, existing);
      }
      if (!options.returnUrl || !options.cancelUrl) throw new AuthorizeNetError("invalid_return_url");
      if (!options.payPageUrl) throw new AuthorizeNetError("invalid_pay_page_url");
      const fingerprint = requestFingerprint(request);
      try {
        const created = await options.gateway.createHostedPayment({
          attemptId: request.attemptId,
          siteId: options.siteId,
          total: request.total,
          returnUrl: options.returnUrl,
          cancelUrl: options.cancelUrl,
        });
        const createdAt = seconds();
        const expiresAt = createdAt + ("paymentWindow" in request && request.paymentWindow
          ? request.paymentWindow.maxSeconds : request.paymentWindowSeconds);
        const sessionId = newPaySessionId(request.attemptId);
        let existed = false;
        const saved = options.store.transaction(tx => {
          const current = tx.read(request.attemptId);
          if (current) {
            refuseChanged(current, request);
            existed = true;
            return current;
          }
          const record: AuthorizeNetAttemptRecord = {
            token: created.token, requestFingerprint: fingerprint, transactionId: null, createdAt, expiresAt,
            bindingRef: request.bindingRef, siteId: options.siteId,
            amountMinor: request.total.minor, currency: request.total.currency,
            sessionId, redirectUrl: `${options.payPageUrl}/${sessionId}`, tokenAt: createdAt,
            returnUrl: options.returnUrl, cancelUrl: options.cancelUrl,
          };
          tx.write(request.attemptId, record);
          return record;
        });
        if (existed) return resolveExisting(request, saved);
        return {
          outcome: "open",
          attemptId: request.attemptId,
          total: request.total,
          session: asSession(saved),
        };
      } catch (error) {
        if (error instanceof AuthorizeNetError &&
            (error.message === "attempt_mismatch" ||
             error.message === "request_mutation" ||
             error.message === "amount_or_currency_mismatch" ||
             error.message === "identity_mismatch")) {
          throw error;
        }
        return { outcome: "unknown" };
      }
    },
    lookup,
    checkLateTry,
    async payPage(sessionId) {
      const attemptId = payPageAttemptId(sessionId);
      if (!attemptId) return { action: "not_found" };
      const record = read(attemptId);
      if (!record?.sessionId || !sameText(record.sessionId, sessionId) || record.siteId !== options.siteId ||
          !record.returnUrl || !record.cancelUrl || !record.amountMinor || record.currency !== "USD") {
        return { action: "not_found" };
      }
      const total = savedTotal(record);
      const back = { action: "redirect" as const, url: record.returnUrl };
      const ended = { action: "redirect" as const, url: record.cancelUrl };
      // Only a checkout with no try, or only unpaid tries, gets a card form. Paid or still being decided goes
      // back to the store, where Commerce shows the result; so does a checkout that has ended. The end is
      // checked again after every provider call, so a visit that crosses it never gets a token.
      if (record.paidId) return back;
      if (seconds() >= record.expiresAt) return ended;
      if (transactionsOf(record).length > 0) {
        let result;
        try { result = await tries(attemptId, record, total); }
        catch { return back; }
        if ("paid" in result) await settle(attemptId, result.paid, result.read);
        if (!("unpaid" in result)) return back;
        if (seconds() >= record.expiresAt) return ended;
      }
      // One live card form per checkout: its token is handed out until Authorize.net stops showing it.
      const usable = (value: AuthorizeNetAttemptRecord) => seconds() - (value.tokenAt ?? value.createdAt) < AUTHORIZE_NET_FORM_TOKEN_SECONDS;
      if (usable(record)) return { action: "post", hostedUrl: options.hostedUrl, token: record.token };
      let created;
      try {
        created = await options.gateway.createHostedPayment({
          attemptId, siteId: options.siteId, total, returnUrl: record.returnUrl, cancelUrl: record.cancelUrl,
        });
      } catch {
        return ended;
      }
      const tokenAt = seconds();
      // A token minted after the end is never stored or shown.
      if (tokenAt >= record.expiresAt) return ended;
      // Two visits can mint at once. The first to store its token wins and both get it; the other token is never shown.
      const shown = options.store.transaction(tx => {
        const current = tx.read(attemptId);
        if (!current || current.sessionId !== record.sessionId) return null;
        if (current.paidId) return back;
        if ((current.tokenAt ?? current.createdAt) !== (record.tokenAt ?? record.createdAt)) {
          return usable(current) ? current.token : null;
        }
        tx.write(attemptId, { ...current, token: created.token, tokenAt });
        return created.token;
      });
      if (shown === null) return ended;
      if (typeof shown !== "string") return shown;
      return { action: "post", hostedUrl: options.hostedUrl, token: shown };
    },
    openTries,
    async recheck(attemptId) {
      for (const id of openTries(attemptId)) await checkLateTry(attemptId, id).catch(() => {});
      return openTries(attemptId).length === 0;
    },
    recordTransaction(attemptId, transactionId) {
      if (!/^[0-9]+$/.test(transactionId)) throw new AuthorizeNetError("invalid_transaction_id");
      options.store.transaction(tx => {
        const current = tx.read(attemptId);
        if (!current) return;
        // The latest tries are kept, in arrival order, and a full list drops its oldest first; the latest
        // also stays in transactionId for older readers. A proven paid try is kept apart, in paidId.
        const ids = transactionsOf(current).filter(id => id !== transactionId);
        ids.push(transactionId);
        tx.write(attemptId, { ...current, transactionId, transactionIds: ids.slice(-AUTHORIZE_NET_TRANSACTIONS_PER_ATTEMPT) });
      });
    },
  };
}
