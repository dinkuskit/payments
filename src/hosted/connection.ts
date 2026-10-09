export type Mode = "test" | "live";
/** Created by verified shared-account authentication, never by request JSON. */
export interface Principal { accountId: string; siteId: string }
export interface Connection {
  bindingRef: string;
  owner: Principal;
  mode: Mode;
  startedAt: number;
  stripeAccountId: string | null;
  authorizeNetMerchantId: string | null;
  providerId?: "stripe" | "authorize_net";
}
export interface ConnectionStore {
  /** Atomic across processes; the callback must be synchronous. */
  transaction<T>(fn: (state: { read(): Connection | null; write(value: Connection): void }) => T): T;
}
export interface AccountStatus { id: string; ready: boolean; actionRequired: boolean }
export interface OnboardingProvider {
  createAccount(bindingRef: string): Promise<string>;
  accountStatus(accountId: string): Promise<AccountStatus>;
  createLink(accountId: string): Promise<{ url: string; expiresAt: number }>;
}
export type Status = {
  state: "disconnected" | "connecting" | "setup_required" | "ready" | "checking" | "action_required" | "recovery_required";
  mode: Mode;
  bindingRef?: string;
};
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
  async function status(principal: Principal): Promise<Status> {
    const record = read(principal);
    if (!record) return { state: "disconnected", mode };
    const base = { mode, bindingRef: record.bindingRef };
    const merchantRef = providerId === "authorize_net" ? record.authorizeNetMerchantId : record.stripeAccountId;
    if (!merchantRef) return { ...base, state: now() - record.startedAt >= CREATION_RETRY_WINDOW_MS ? "recovery_required" : "connecting" };
    if (providerId === "authorize_net") return { ...base, state: "ready" };
    try {
      const result = await provider.accountStatus(record.stripeAccountId!);
      if (result.id !== record.stripeAccountId) throw new Error("unexpected_account");
      return { ...base, state: result.ready ? "ready" : result.actionRequired ? "action_required" : "setup_required" };
    } catch { return { ...base, state: "checking" }; }
  }
  async function connect(principal: Principal): Promise<Status & { url?: string; expiresAt?: number }> {
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
      };
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
      if (now() - record.startedAt >= CREATION_RETRY_WINDOW_MS) return { state: "recovery_required", mode, bindingRef: record.bindingRef };
      let accountId: string;
      try { accountId = await provider.createAccount(record.bindingRef); }
      catch { return status(principal); }
      if (!/^acct_[a-zA-Z0-9]+$/.test(accountId)) return { state: "checking", mode, bindingRef: record.bindingRef };
      store.transaction(tx => {
        const current = tx.read();
        if (!current || current.bindingRef !== record.bindingRef || (current.stripeAccountId && current.stripeAccountId !== accountId)) throw new ConnectionError("connection_conflict");
        tx.write({ ...current, stripeAccountId: accountId });
      });
    }
    const current = read(principal)!;
    const result = await status(principal);
    if (result.state === "ready" || result.state === "checking") return result;
    try {
      // Every resume obtains a fresh one-use link for the same account. Never
      // store an onboarding URL or infer success from a browser return.
      const link = await provider.createLink(current.stripeAccountId!);
      const url = new URL(link.url);
      if (url.protocol !== "https:" || url.hostname !== "connect.stripe.com" || url.username || url.password || (url.port && url.port !== "443") || !Number.isFinite(link.expiresAt) || link.expiresAt <= now()) throw new Error("invalid_link");
      return { ...result, ...link };
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
  return { connect, status, checkoutBinding, existingBinding };
}
