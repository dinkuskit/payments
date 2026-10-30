import { validOnboardingUrl } from "../onboarding-url.js";
import { businessCountry } from "../business-country.js";
import { creationFailure } from "./creation-failure.js";
import { decodeDiagnostics, type ConnectionDiagnostics, type CreationFailure } from "../connection-diagnostics.js";
export type Mode = "test" | "live";
/** Created by verified shared-account authentication, never by request JSON. */
export interface Principal {
  accountId: string;
  siteId: string;
  /** The store's web address DinkusKit.com checked at Connect and signed into the pass. */
  siteOrigin?: string;
}
export interface Connection {
  bindingRef: string;
  owner: Principal;
  mode: Mode;
  startedAt: number;
  stripeAccountId: string | null;
  authorizeNetMerchantId: string | null;
  providerId?: "stripe" | "authorize_net";
  creationFailure?: CreationFailure;
  /** Omitted on legacy operations; never infer cross-API idempotency. */
  creationProtocol?: "accounts_v2";
  creationScope?: string;
  /** The owner's business country, saved before the Accounts v2 create call. */
  creationCountry?: string;
}
export interface ConnectionStore {
  /** Atomic across processes; the callback must be synchronous. */
  transaction<T>(fn: (state: { read(): Connection | null; write(value: Connection): void }) => T): T;
}
export interface AccountStatus { id: string; ready: boolean; actionRequired: boolean }
export interface OnboardingProvider {
  creationProtocol?: "accounts_v2";
  creationScope?(): Promise<string>;
  createAccount(bindingRef: string, country?: string): Promise<string>;
  accountStatus(accountId: string): Promise<AccountStatus>;
  createLink(accountId: string): Promise<{ url: string; expiresAt: number }>;
}
export type Status = {
  state: "disconnected" | "connecting" | "setup_required" | "ready" | "checking" | "action_required" | "recovery_required";
  mode: Mode;
  bindingRef?: string;
  connectionEvidence?: ConnectionEvidence;
  testOrder?: TestOrderEvidence;
};
/**
 * A TEST checkout the provider confirmed as paid through Payments' own lookup,
 * for the current connection. `recorded` means Commerce acknowledged its
 * payment notice, which Commerce does only after saving the paid order.
 */
export type TestOrderEvidence = {
  provider: "stripe" | "authorize_net";
  total: { currency: "USD"; minor: string };
  paidAt: number;
  state: "awaiting_notice" | "awaiting_commerce" | "recorded";
};
export type ConnectionEvidence = {
  provider: "stripe" | "authorize_net";
  mode: Mode;
  result: "verified" | "action_required" | "unknown" | "unsupported";
  accountRef?: string;
};
type ConnectStatus = Omit<Status, "connectionEvidence">;
export type CheckoutBinding =
  | { bindingRef: string; providerId: "stripe"; stripeAccountId: string; mode: Mode }
  | { bindingRef: string; providerId: "authorize_net"; authorizeNetMerchantId: string; mode: Mode };
export class ConnectionError extends Error {}

// Stripe retains idempotency results for at least 24 hours. Stop early rather
// than recreate an account after an unacknowledged request ages out.
const CREATION_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function createConnectionService(options: {
  store: ConnectionStore;
  provider: OnboardingProvider;
  mode: Mode;
  providerId?: "stripe" | "authorize_net";
  authorizeNetMerchantId?: string;
  now?: () => number;
  newId?: () => string;
}) {
  const now = options.now ?? Date.now;
  const { store, provider, mode } = options;
  const providerId = options.providerId ?? "stripe";
  const authorizeNetMerchantId = options.authorizeNetMerchantId;
  const sameOperation = (a: Connection, b: Connection) => a.creationProtocol === b.creationProtocol && a.startedAt === b.startedAt;

  // Saved before the create POST and fixed from then on: Stripe never changes an
  // account's country, and the idempotent create must resend the same body.
  function creationCountry(record: Connection, requested: unknown): string | undefined | null {
    if (provider.creationProtocol !== "accounts_v2") return undefined;
    if (record.creationCountry !== undefined) return businessCountry(record.creationCountry) ? record.creationCountry : null;
    // A create POST may already have gone out without a country.
    if (record.creationScope || record.creationFailure) return null;
    return businessCountry(requested) ? requested : null;
  }
  function withoutEvidence(status: Status): ConnectStatus {
    const { connectionEvidence: _connectionEvidence, ...legacy } = status;
    return legacy;
  }
  function read(principal: Principal) {
    if (!principal.accountId || !principal.siteId) throw new ConnectionError("unauthorized");
    return store.transaction(tx => {
      const current = tx.read();
      if (current && (current.owner.accountId !== principal.accountId || current.owner.siteId !== principal.siteId || current.mode !== mode)) {
        throw new ConnectionError("connection_owner_mismatch");
      }
      if (current) {
        const normalized = {
          ...current,
          providerId: current.providerId ?? "stripe" as const,
          authorizeNetMerchantId: current.authorizeNetMerchantId ?? null,
        };
        if (current.providerId === undefined || current.authorizeNetMerchantId === undefined) tx.write(normalized);
        const storedProvider = normalized.providerId;
        if (storedProvider !== providerId) throw new ConnectionError("binding_provider_mismatch");
        if (normalized.stripeAccountId !== null && !/^acct_[A-Za-z0-9]+$/.test(normalized.stripeAccountId)) {
          throw new ConnectionError("binding_invalid_stripe_account");
        }
        if (normalized.authorizeNetMerchantId !== null &&
            (!normalized.authorizeNetMerchantId || normalized.authorizeNetMerchantId.length > 200)) {
          throw new ConnectionError("binding_invalid_authorize_net_merchant");
        }
        if (normalized.stripeAccountId !== null && normalized.authorizeNetMerchantId !== null) {
          throw new ConnectionError("binding_cross_provider_fields");
        }
        if (storedProvider === "stripe" && normalized.authorizeNetMerchantId !== null) {
          throw new ConnectionError("binding_cross_provider_fields");
        }
        if (storedProvider === "authorize_net" && normalized.stripeAccountId !== null) {
          throw new ConnectionError("binding_cross_provider_fields");
        }
        return normalized;
      }
      return current;
    });
  }
  const legacyCreation = (r: Connection) => providerId === "stripe" && !r.stripeAccountId && provider.creationProtocol === "accounts_v2" && r.creationProtocol !== "accounts_v2";
  async function status(principal: Principal): Promise<Status> {
    const record = read(principal);
    if (!record) return { state: "disconnected", mode };
    const base = { mode, bindingRef: record.bindingRef };
    const merchantRef = providerId === "authorize_net" ? record.authorizeNetMerchantId : record.stripeAccountId;
    if (!merchantRef) return { ...base, state: legacyCreation(record) || now() - record.startedAt >= CREATION_RETRY_WINDOW_MS ? "recovery_required" : "connecting" };
    if (providerId === "authorize_net") {
      return {
        ...base,
        state: "ready",
        connectionEvidence: { provider: "authorize_net", mode, result: "unsupported" },
      };
    }
    const connectionEvidence = {
      provider: "stripe" as const,
      mode,
      accountRef: record.stripeAccountId!,
      result: "unknown" as ConnectionEvidence["result"],
    };
    try {
      const result = await provider.accountStatus(record.stripeAccountId!);
      if (result.id !== record.stripeAccountId) throw new Error("unexpected_account");
      if (result.ready) {
        return { ...base, state: "ready", connectionEvidence: { ...connectionEvidence, result: "verified" } };
      }
      if (result.actionRequired) {
        return { ...base, state: "action_required", connectionEvidence: { ...connectionEvidence, result: "action_required" } };
      }
      return { ...base, state: "setup_required", connectionEvidence };
    } catch {
      return { ...base, state: "checking", connectionEvidence };
    }
  }
  async function connect(principal: Principal, requestedCountry?: unknown): Promise<ConnectStatus & { url?: string; expiresAt?: number }> {
    // Check owner before the transaction that may create the first binding.
    read(principal);
    const record = store.transaction(tx => {
      const existing = tx.read();
      if (existing) {
        if (existing.owner.accountId !== principal.accountId || existing.owner.siteId !== principal.siteId || existing.mode !== mode) throw new ConnectionError("connection_owner_mismatch");
        return existing;
      }
      const initial: Connection = {
        bindingRef: `${providerId}_${(options.newId ? options.newId() : crypto.randomUUID())}`,
        owner: { ...principal }, mode, startedAt: now(), stripeAccountId: null,
        authorizeNetMerchantId: null, providerId,
        ...(provider.creationProtocol ? { creationProtocol: provider.creationProtocol } : {}),
      };
      const country = creationCountry(initial, requestedCountry);
      if (country === null) throw new ConnectionError("merchant_country_required");
      if (country !== undefined) initial.creationCountry = country;
      tx.write(initial);
      return initial;
    });
    if (providerId === "authorize_net" && !record.authorizeNetMerchantId) {
      if (!authorizeNetMerchantId) throw new ConnectionError("authorize_net_merchant_missing");
      store.transaction(tx => {
        const current = tx.read();
        if (current && current.bindingRef === record.bindingRef) {
          tx.write({ ...current, authorizeNetMerchantId });
        }
      });
      return { state: "ready", mode, bindingRef: record.bindingRef };
    }
    if (providerId === "stripe" && !record.stripeAccountId) {
      if (legacyCreation(record) || now() - record.startedAt >= CREATION_RETRY_WINDOW_MS) return { state: "recovery_required", mode, bindingRef: record.bindingRef };
      const country = creationCountry(record, requestedCountry);
      if (country === null) return { state: "recovery_required", mode, bindingRef: record.bindingRef };
      let scope: string | undefined;
      if (provider.creationScope) {
        try { scope = await provider.creationScope(); } catch { return { state: "checking", mode, bindingRef: record.bindingRef }; }
        const admitted = store.transaction(tx => {
          const current = tx.read();
          if (!current || !sameOperation(current, record) || current.bindingRef !== record.bindingRef || current.owner.accountId !== principal.accountId || current.owner.siteId !== principal.siteId || current.mode !== mode || current.creationProtocol !== provider.creationProtocol || current.stripeAccountId) return false;
          if (current.creationScope && current.creationScope !== scope) return false;
          if (current.creationCountry !== record.creationCountry || creationCountry(current, requestedCountry) !== country) return false;
          if (!current.creationScope || current.creationCountry !== country) tx.write({ ...current, creationScope: scope,
            ...(country === undefined ? {} : { creationCountry: country }),
          });
          return true;
        });
        if (!admitted) return { state: "recovery_required", mode, bindingRef: record.bindingRef };
      }
      let accountId: string;
      try { accountId = await provider.createAccount(record.bindingRef, country); }
      catch (error) {
        const failure = creationFailure(error, now());
        store.transaction(tx => {
          const current = tx.read();
          if (current && sameOperation(current, record) && current.bindingRef === record.bindingRef && current.owner.accountId === principal.accountId && current.owner.siteId === principal.siteId && current.creationCountry === country && (scope === undefined || current.creationScope === scope) && !current.stripeAccountId) {
            tx.write({ ...current, creationFailure: failure });
          }
        });
        return withoutEvidence(await status(principal));
      }
      if (!/^acct_[a-zA-Z0-9]+$/.test(accountId)) return { state: "checking", mode, bindingRef: record.bindingRef };
      store.transaction(tx => {
        const current = tx.read();
        if (!current || !sameOperation(current, record) || current.bindingRef !== record.bindingRef || current.owner.accountId !== principal.accountId || current.owner.siteId !== principal.siteId || current.mode !== mode || current.creationCountry !== country || (scope !== undefined && (current.creationScope !== scope || current.creationProtocol !== provider.creationProtocol)) || (current.stripeAccountId && current.stripeAccountId !== accountId)) throw new ConnectionError("connection_conflict");
        const { creationFailure: _failure, ...cleared } = current;
        tx.write({ ...cleared, stripeAccountId: accountId });
      });
    }
    const current = read(principal)!;
    const result = await status(principal);
    if (result.state === "ready" || result.state === "checking") return withoutEvidence(result);
    try {
      // Every resume obtains a fresh one-use link for the same account. Never
      // store an onboarding URL or infer success from a browser return.
      const link = await provider.createLink(current.stripeAccountId!);
      if (!validOnboardingUrl(link.url, mode, current.stripeAccountId!) || !Number.isFinite(link.expiresAt) || link.expiresAt <= now()) throw new Error("invalid_link");
      return { ...withoutEvidence(result), ...link };
    } catch { return { state: "checking", mode, bindingRef: record.bindingRef }; }
  }
  async function checkoutBinding(principal: Principal, bindingRef: string): Promise<CheckoutBinding | null> {
    const record = read(principal);
    if (!record || record.bindingRef !== bindingRef) return null;
    if ((await status(principal)).state !== "ready") return null;
    if (providerId === "stripe" && record.stripeAccountId) return { bindingRef, providerId, stripeAccountId: record.stripeAccountId, mode };
    if (providerId === "authorize_net" && record.authorizeNetMerchantId) return { bindingRef, providerId, authorizeNetMerchantId: record.authorizeNetMerchantId, mode };
    throw new ConnectionError("binding_missing_provider_field");
  }
  // Existing-attempt reads must keep the original recipient after readiness
  // regresses. New checkout still uses checkoutBinding.
  async function existingBinding(principal: Principal, bindingRef: string): Promise<CheckoutBinding | null> {
    const record = read(principal);
    if (!record || record.bindingRef !== bindingRef) return null;
    if (providerId === "stripe" && record.stripeAccountId) return { bindingRef, providerId, stripeAccountId: record.stripeAccountId, mode };
    if (providerId === "authorize_net" && record.authorizeNetMerchantId) return { bindingRef, providerId, authorizeNetMerchantId: record.authorizeNetMerchantId, mode };
    throw new ConnectionError("binding_missing_provider_field");
  }
  function diagnostics(principal: Principal): ConnectionDiagnostics {
    if (!principal.accountId || !principal.siteId) throw new ConnectionError("unauthorized");
    // Unlike read(), this never normalizes or writes a legacy connection.
    const record = store.transaction(tx => tx.read());
    if (record && (record.owner.accountId !== principal.accountId || record.owner.siteId !== principal.siteId || record.mode !== mode)) throw new ConnectionError("connection_owner_mismatch");
    if (record && (record.providerId ?? "stripe") !== providerId) throw new ConnectionError("binding_provider_mismatch");
    const present = Boolean(record && (providerId === "stripe" ? record.stripeAccountId : record.authorizeNetMerchantId));
    const result: ConnectionDiagnostics = {
      state: !record ? "disconnected" : present ? "account_present" : legacyCreation(record) || now() - record.startedAt >= CREATION_RETRY_WINDOW_MS ? "recovery_required" : "connecting",
      mode, processorAccountPresent: present, evidence: record?.creationFailure ? "observed" : "unobserved",
      ...(record?.creationFailure ? { lastFailure: record.creationFailure } : {}),
    };
    return decodeDiagnostics(result, now());
  }
  return { connect, status, diagnostics, checkoutBinding, existingBinding };
}
