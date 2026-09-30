import {
  CURRENT_PAYMENT_WINDOW_MAX_SECONDS,
  CURRENT_PAYMENT_WINDOW_MIN_SECONDS,
  LEGACY_EXACT_PAYMENT_WINDOW_SECONDS,
  paymentRequestHandoff,
  type CheckoutLine,
  type CheckoutPaymentPort,
  type CurrentPaymentRequest,
  type LegacyExact1800PaymentRequest,
  type Money,
  type PaymentOutcome,
  type PaymentRequest,
  type PaymentSession,
  type PaymentWindowPolicyKind,
} from "../commerce/checkout-port.js";
import type { CheckoutBinding, Mode, Principal } from "../hosted/connection.js";

export class CheckoutError extends Error {}

// Stripe retains idempotency results for at least 24 hours. Stop early rather
// than create a second session after an unacknowledged request ages out.
export const CREATION_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const STRIPE_MIN_EXPIRES_AT_SECONDS = 1800;
const SESSION_ID_PATTERN = /^cs_(?:test_|live_)?[A-Za-z0-9]+$/;

const MINOR_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export type LatestCharge =
  | { state: "absent" }
  | { state: "known"; status: string }
  | { state: "unknown" };

export interface AttemptRecord {
  attemptId: string;
  bindingRef: string;
  stripeAccountId: string;
  mode: Mode;
  siteId: string;
  requestFingerprint: string;
  lines: CheckoutLine[];
  amountMinor: string;
  currency: "USD";
  claimedAtMs: number;
  requestedExpiresAtSeconds: number;
  providerCreatedAtSeconds: number | null;
  providerExpiresAtSeconds: number | null;
  idempotencyKey: string;
  successUrl: string;
  cancelUrl: string;
  stripeSessionId: string | null;
  redirectUrl: string | null;
  policyKind?: PaymentWindowPolicyKind;
}

export interface AttemptStore {
  transaction<T>(fn: (state: {
    read(attemptId: string): AttemptRecord | null;
    write(value: AttemptRecord): void;
  }) => T): T;
}

export interface ProviderSession {
  id: string;
  url: string | null;
  status: string;
  paymentStatus: string;
  amountTotal: number;
  currency: string;
  created: number;
  expiresAt: number;
  livemode: boolean;
  paymentIntentId: string | null;
  metadata: Record<string, string>;
  paymentMethodTypes: string[];
}

export interface ProviderPaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  latestCharge: LatestCharge;
}

export interface CheckoutProvider {
  createSession(input: {
    attemptId: string;
    bindingRef: string;
    siteId: string;
    stripeAccountId: string;
    lines: PaymentRequest["lines"];
    total: Money;
    expiresAtSeconds: number;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<ProviderSession>;
  retrieveSession(sessionId: string, stripeAccountId: string): Promise<ProviderSession>;
  retrievePaymentIntent(paymentIntentId: string, stripeAccountId: string): Promise<ProviderPaymentIntent>;
}

export function parseMinorUnits(minor: string): bigint {
  if (!MINOR_PATTERN.test(minor)) throw new CheckoutError("invalid_amount");
  const value = BigInt(minor);
  if (value > MAX_SAFE_MINOR) throw new CheckoutError("invalid_amount");
  return value;
}

function canonicalizeLine(line: CheckoutLine): CheckoutLine {
  return {
    catalogItemId: line.catalogItemId,
    quantity: line.quantity,
    name: line.name,
    unitPrice: { currency: "USD", minor: line.unitPrice.minor },
  };
}

function canonicalizeLegacyRequest(request: LegacyExact1800PaymentRequest): LegacyExact1800PaymentRequest {
  return {
    attemptId: request.attemptId,
    bindingRef: request.bindingRef,
    lines: request.lines.map(canonicalizeLine),
    total: { currency: "USD", minor: request.total.minor },
    paymentWindowSeconds: LEGACY_EXACT_PAYMENT_WINDOW_SECONDS,
    paymentMethods: ["card"],
  };
}

function canonicalizeCurrentRequest(request: CurrentPaymentRequest): CurrentPaymentRequest {
  return {
    attemptId: request.attemptId,
    bindingRef: request.bindingRef,
    lines: request.lines.map(canonicalizeLine),
    total: { currency: "USD", minor: request.total.minor },
    paymentWindow: {
      minSeconds: CURRENT_PAYMENT_WINDOW_MIN_SECONDS,
      maxSeconds: CURRENT_PAYMENT_WINDOW_MAX_SECONDS,
    },
    paymentMethods: ["card"],
  };
}

export function canonicalizePaymentRequest(request: PaymentRequest): PaymentRequest {
  const handoff = paymentRequestHandoff(request);
  if (!handoff) throw new CheckoutError("invalid_request");
  if (handoff.kind === "current-bounded-1800-1860") return canonicalizeCurrentRequest(handoff.request);
  return canonicalizeLegacyRequest(handoff.request);
}

function legacyFingerprint(canonical: LegacyExact1800PaymentRequest): string {
  return JSON.stringify({
    attemptId: canonical.attemptId,
    bindingRef: canonical.bindingRef,
    lines: canonical.lines,
    total: canonical.total,
    paymentWindowSeconds: canonical.paymentWindowSeconds,
    paymentMethods: canonical.paymentMethods,
  });
}

function currentFingerprint(canonical: CurrentPaymentRequest): string {
  return JSON.stringify({
    attemptId: canonical.attemptId,
    bindingRef: canonical.bindingRef,
    lines: canonical.lines,
    total: canonical.total,
    paymentWindow: {
      minSeconds: canonical.paymentWindow.minSeconds,
      maxSeconds: canonical.paymentWindow.maxSeconds,
    },
    paymentMethods: canonical.paymentMethods,
  });
}

export function requestFingerprint(request: PaymentRequest): string {
  const canonical = canonicalizePaymentRequest(request);
  const handoff = paymentRequestHandoff(canonical);
  if (!handoff) throw new CheckoutError("invalid_request");
  if (handoff.kind === "current-bounded-1800-1860") return currentFingerprint(handoff.request);
  return legacyFingerprint(handoff.request);
}

export function validatePaymentRequest(request: PaymentRequest): PaymentRequest {
  if (!request || typeof request !== "object") throw new CheckoutError("invalid_request");
  if (!request.attemptId || typeof request.attemptId !== "string" || request.attemptId.length > 200) throw new CheckoutError("invalid_request");
  if (!request.bindingRef || typeof request.bindingRef !== "string" || request.bindingRef.length > 200) throw new CheckoutError("invalid_request");
  const handoff = paymentRequestHandoff(request);
  if (!handoff) throw new CheckoutError("invalid_request");
  if (!Array.isArray(request.paymentMethods) || request.paymentMethods.length !== 1 || request.paymentMethods[0] !== "card") {
    throw new CheckoutError("invalid_request");
  }
  if (!request.total || request.total.currency !== "USD" || typeof request.total.minor !== "string") throw new CheckoutError("invalid_amount");
  const totalMinor = parseMinorUnits(request.total.minor);
  if (totalMinor <= 0n) throw new CheckoutError("invalid_amount");
  if (!Array.isArray(request.lines) || request.lines.length === 0 || request.lines.length > 100) throw new CheckoutError("invalid_request");
  let sum = 0n;
  for (const line of request.lines) {
    if (!line || typeof line.catalogItemId !== "string" || !line.catalogItemId || typeof line.name !== "string" || !line.name) {
      throw new CheckoutError("invalid_request");
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) throw new CheckoutError("invalid_request");
    if (!line.unitPrice || line.unitPrice.currency !== "USD" || typeof line.unitPrice.minor !== "string") throw new CheckoutError("invalid_amount");
    sum += parseMinorUnits(line.unitPrice.minor) * BigInt(line.quantity);
    if (sum > MAX_SAFE_MINOR) throw new CheckoutError("invalid_amount");
  }
  if (sum !== totalMinor) throw new CheckoutError("invalid_amount");
  return canonicalizePaymentRequest(request);
}

function epochSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sessionIdOrThrow(id: string): string {
  if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) throw new CheckoutError("invalid_session_id");
  return id;
}

function redirectUrlOrThrow(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CheckoutError("invalid_session_url"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new CheckoutError("invalid_session_url");
  if (parsed.hostname !== "checkout.stripe.com" || (parsed.port && parsed.port !== "443")) throw new CheckoutError("invalid_session_url");
  return url;
}

function storedSession(record: AttemptRecord): PaymentSession | null {
  if (!record.stripeSessionId || !record.redirectUrl) return null;
  const created = record.providerCreatedAtSeconds;
  const expires = record.providerExpiresAtSeconds;
  if (created === null || expires === null) return null;
  if (!Number.isSafeInteger(created) || !Number.isSafeInteger(expires)) return null;
  const duration = expires - created;
  if (!Number.isSafeInteger(duration)) return null;
  const policy: PaymentWindowPolicyKind = record.policyKind ?? "legacy-exact-1800";
  if (policy === "current-bounded-1800-1860") {
    if (duration < CURRENT_PAYMENT_WINDOW_MIN_SECONDS || duration > CURRENT_PAYMENT_WINDOW_MAX_SECONDS) return null;
  } else if (policy === "legacy-exact-1800") {
    if (duration !== LEGACY_EXACT_PAYMENT_WINDOW_SECONDS) return null;
  } else {
    return null;
  }
  return {
    sessionId: record.stripeSessionId,
    redirectUrl: record.redirectUrl,
    createdAt: created,
    expiresAt: expires,
  };
}

function assertBinding(record: AttemptRecord, binding: CheckoutBinding, request: PaymentRequest, principal: Principal) {
  if (record.siteId !== principal.siteId) throw new CheckoutError("binding_mismatch");
  if (record.bindingRef !== request.bindingRef || binding.bindingRef !== request.bindingRef) throw new CheckoutError("binding_mismatch");
  if (record.stripeAccountId !== binding.stripeAccountId || record.mode !== binding.mode) throw new CheckoutError("binding_mismatch");
  if (record.requestFingerprint !== requestFingerprint(request)) throw new CheckoutError("request_mutation");
  if (record.amountMinor !== request.total.minor || record.currency !== request.total.currency) throw new CheckoutError("request_mutation");
}

function assertProviderSession(record: AttemptRecord, session: ProviderSession) {
  if (session.id !== record.stripeSessionId) throw new CheckoutError("session_mismatch");
  if (session.livemode !== (record.mode === "live")) throw new CheckoutError("mode_mismatch");
  if (session.currency !== "usd") throw new CheckoutError("currency_mismatch");
  if (String(session.amountTotal) !== record.amountMinor) throw new CheckoutError("amount_mismatch");
  if (session.metadata.dinkus_attempt !== record.attemptId || session.metadata.dinkus_binding !== record.bindingRef) {
    throw new CheckoutError("session_mismatch");
  }
  const created = epochSeconds(session.created);
  const expires = epochSeconds(session.expiresAt);
  if (created === null || expires === null) throw new CheckoutError("window_mismatch");
  if (expires !== record.requestedExpiresAtSeconds) throw new CheckoutError("window_mismatch");
  if (record.providerCreatedAtSeconds !== null && created !== record.providerCreatedAtSeconds) throw new CheckoutError("window_mismatch");
  if (record.providerExpiresAtSeconds !== null && expires !== record.providerExpiresAtSeconds) throw new CheckoutError("window_mismatch");
  if (!session.paymentMethodTypes.every(type => type === "card") || session.paymentMethodTypes.length === 0) {
    throw new CheckoutError("method_mismatch");
  }
}

function unknown(): PaymentOutcome {
  return { outcome: "unknown" };
}

function sessionFields(record: AttemptRecord) {
  const session = storedSession(record);
  if (!session) return null;
  return { attemptId: record.attemptId, total: { currency: "USD" as const, minor: record.amountMinor }, session };
}

function expiredUnpaidAllowed(intent: ProviderPaymentIntent): boolean {
  if (intent.status !== "canceled") return false;
  if (intent.latestCharge.state === "unknown") return false;
  if (intent.latestCharge.state === "known" && intent.latestCharge.status !== "failed") return false;
  return true;
}

async function interpret(
  record: AttemptRecord,
  session: ProviderSession,
  provider: CheckoutProvider,
): Promise<PaymentOutcome> {
  assertProviderSession(record, session);
  let intent: ProviderPaymentIntent | null = null;
  if (session.paymentIntentId) {
    try { intent = await provider.retrievePaymentIntent(session.paymentIntentId, record.stripeAccountId); }
    catch { return unknown(); }
    if (intent.id !== session.paymentIntentId) return unknown();
    if (intent.amount !== session.amountTotal || intent.currency !== session.currency) throw new CheckoutError("amount_mismatch");
  }
  const fields = sessionFields(record);
  if (!fields) return unknown();
  if (intent?.status === "succeeded") return { outcome: "paid", paymentId: intent.id, ...fields };
  if (session.paymentStatus === "paid") return unknown();
  if (session.status === "open") return { outcome: "open", ...fields };
  // Stripe documents session.status=complete as "payment processing may still
  // be in progress". Expired + unpaid is not enough: a PaymentIntent can still
  // be processing or succeed after the Session object expires. Terminal unpaid
  // requires an authoritative canceled PaymentIntent and a proven latest
  // charge: explicit null (confirmation never attempted) or an expanded
  // failed charge. Pending charges, unexpanded IDs, and missing status stay unknown.
  if (session.status === "expired" && session.paymentStatus === "unpaid" && intent && expiredUnpaidAllowed(intent)) {
    return { outcome: "expired-unpaid", ...fields };
  }
  return unknown();
}

export function createCheckoutSessionService(options: {
  store: AttemptStore;
  readyBinding(principal: Principal, bindingRef: string): Promise<CheckoutBinding | null>;
  existingBinding(principal: Principal, bindingRef: string): Promise<CheckoutBinding | null> | CheckoutBinding | null;
  provider: CheckoutProvider;
  mode: Mode;
  successUrl: string;
  cancelUrl: string;
  now?: () => number;
}): {
  ensureSessionFor(principal: Principal, request: PaymentRequest): Promise<PaymentOutcome>;
  lookupFor(principal: Principal, request: PaymentRequest): Promise<PaymentOutcome>;
  readAttempt(attemptId: string): AttemptRecord | null;
  retrieveAndMatch(record: AttemptRecord): Promise<void>;
  forPrincipal(principal: Principal): CheckoutPaymentPort;
} {
  const now = options.now ?? Date.now;
  const successUrl = options.successUrl;
  const cancelUrl = options.cancelUrl;
  for (const value of [successUrl, cancelUrl]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid_checkout_return_configuration");
  }

  async function claim(principal: Principal, request: PaymentRequest, binding: CheckoutBinding): Promise<AttemptRecord> {
    const claimedAtMs = now();
    const handoff = paymentRequestHandoff(request);
    if (!handoff) throw new CheckoutError("invalid_request");
    const isCurrent = handoff.kind === "current-bounded-1800-1860";
    const windowSeconds = isCurrent ? CURRENT_PAYMENT_WINDOW_MAX_SECONDS : LEGACY_EXACT_PAYMENT_WINDOW_SECONDS;
    const policyKind: PaymentWindowPolicyKind = handoff.kind;
    const record: AttemptRecord = {
      attemptId: request.attemptId,
      bindingRef: request.bindingRef,
      stripeAccountId: binding.stripeAccountId,
      mode: options.mode,
      siteId: principal.siteId,
      requestFingerprint: requestFingerprint(request),
      lines: request.lines.map(canonicalizeLine),
      amountMinor: request.total.minor,
      currency: "USD",
      claimedAtMs,
      requestedExpiresAtSeconds: Math.floor(claimedAtMs / 1000) + windowSeconds,
      providerCreatedAtSeconds: null,
      providerExpiresAtSeconds: null,
      idempotencyKey: `dinkus-checkout:${request.attemptId}`,
      successUrl,
      cancelUrl,
      stripeSessionId: null,
      redirectUrl: null,
      policyKind,
    };
    const currentBinding = await options.existingBinding(principal, request.bindingRef) ?? binding;
    return options.store.transaction(tx => {
      const existing = tx.read(request.attemptId);
      if (existing) {
        assertBinding(existing, currentBinding, request, principal);
        return existing;
      }
      tx.write(record);
      return record;
    });
  }

  function persistSession(record: AttemptRecord, session: ProviderSession): AttemptRecord {
    if (session.livemode !== (record.mode === "live")) throw new CheckoutError("mode_mismatch");
    if (session.currency !== "usd") throw new CheckoutError("currency_mismatch");
    if (String(session.amountTotal) !== record.amountMinor) throw new CheckoutError("amount_mismatch");
    if (session.metadata.dinkus_attempt !== record.attemptId || session.metadata.dinkus_binding !== record.bindingRef) {
      throw new CheckoutError("session_mismatch");
    }
    const sessionId = sessionIdOrThrow(session.id);
    let redirectUrl: string | null = null;
    let urlError: CheckoutError | null = null;
    if (session.url) {
      try { redirectUrl = redirectUrlOrThrow(session.url); }
      catch (error) { urlError = error instanceof CheckoutError ? error : new CheckoutError("invalid_session_url"); }
    }
    const created = epochSeconds(session.created);
    const expires = epochSeconds(session.expiresAt);
    const persisted = options.store.transaction(tx => {
      const current = tx.read(record.attemptId);
      if (!current) throw new CheckoutError("attempt_missing");
      if (current.stripeSessionId && current.stripeSessionId !== sessionId) throw new CheckoutError("session_mismatch");
      if (current.providerCreatedAtSeconds !== null && created !== null && current.providerCreatedAtSeconds !== created) {
        throw new CheckoutError("window_mismatch");
      }
      if (current.providerExpiresAtSeconds !== null && expires !== null && current.providerExpiresAtSeconds !== expires) {
        throw new CheckoutError("window_mismatch");
      }
      const next: AttemptRecord = {
        ...current,
        stripeSessionId: sessionId,
        redirectUrl: current.redirectUrl ?? redirectUrl,
        providerCreatedAtSeconds: current.providerCreatedAtSeconds ?? created,
        providerExpiresAtSeconds: current.providerExpiresAtSeconds ?? expires,
      };
      tx.write(next);
      return next;
    });
    if (urlError && !persisted.redirectUrl) throw urlError;
    if (urlError) throw urlError;
    return persisted;
  }

  async function mappedOutcome(record: AttemptRecord): Promise<PaymentOutcome> {
    if (!record.stripeSessionId) return unknown();
    try {
      const session = await options.provider.retrieveSession(record.stripeSessionId, record.stripeAccountId);
      return interpret(persistSession(record, session), session, options.provider);
    } catch (error) {
      if (error instanceof CheckoutError) throw error;
      return unknown();
    }
  }

  async function retrieveAndMatch(record: AttemptRecord): Promise<void> {
    if (!record.stripeSessionId) throw new CheckoutError("session_missing");
    const session = await options.provider.retrieveSession(record.stripeSessionId, record.stripeAccountId);
    assertProviderSession(persistSession(record, session), session);
  }

  async function createOrRecover(record: AttemptRecord): Promise<PaymentOutcome> {
    if (record.stripeSessionId) return mappedOutcome(record);
    if (now() - record.claimedAtMs >= CREATION_RETRY_WINDOW_MS) return unknown();
    // Retry the original pinned expires_at and persisted transport params.
    // Stripe will replay a completed create. If the first request never landed
    // and expires_at is now sooner than 30 minutes, Stripe rejects; we keep
    // unknown and never mint a later deadline.
    let session: ProviderSession;
    try {
      session = await options.provider.createSession({
        attemptId: record.attemptId,
        bindingRef: record.bindingRef,
        siteId: record.siteId,
        stripeAccountId: record.stripeAccountId,
        lines: record.lines,
        total: { currency: "USD", minor: record.amountMinor },
        expiresAtSeconds: record.requestedExpiresAtSeconds,
        successUrl: record.successUrl,
        cancelUrl: record.cancelUrl,
        idempotencyKey: record.idempotencyKey,
      });
    } catch { return unknown(); }
    try { return interpret(persistSession(record, session), session, options.provider); }
    catch (error) {
      if (error instanceof CheckoutError) throw error;
      return unknown();
    }
  }

  async function ensureSessionFor(principal: Principal, raw: PaymentRequest): Promise<PaymentOutcome> {
    const request = validatePaymentRequest(raw);
    const existing = options.store.transaction(tx => tx.read(request.attemptId));
    if (existing) {
      const binding = await options.existingBinding(principal, request.bindingRef);
      if (!binding) throw new CheckoutError("binding_mismatch");
      assertBinding(existing, binding, request, principal);
      return createOrRecover(existing);
    }
    const handoff = paymentRequestHandoff(request);
    if (handoff?.kind === "legacy-exact-1800") {
      return unknown();
    }
    const ready = await options.readyBinding(principal, request.bindingRef);
    if (!ready) return unknown();
    return createOrRecover(await claim(principal, request, ready));
  }

  async function lookupFor(principal: Principal, raw: PaymentRequest): Promise<PaymentOutcome> {
    const request = validatePaymentRequest(raw);
    const existing = options.store.transaction(tx => tx.read(request.attemptId));
    if (!existing) return unknown();
    const binding = await options.existingBinding(principal, request.bindingRef);
    if (!binding) throw new CheckoutError("binding_mismatch");
    assertBinding(existing, binding, request, principal);
    if (!existing.stripeSessionId) return unknown();
    return mappedOutcome(existing);
  }

  return {
    ensureSessionFor,
    lookupFor,
    readAttempt: attemptId => options.store.transaction(tx => tx.read(attemptId)),
    retrieveAndMatch,
    forPrincipal: principal => ({
      ensureSession: request => ensureSessionFor(principal, request),
      lookup: request => lookupFor(principal, request),
    }),
  };
}
