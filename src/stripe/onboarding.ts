import { validOnboardingUrl } from "../onboarding-url.js";
import { businessCountry } from "../business-country.js";
import Stripe from "stripe";
import type { Mode, OnboardingProvider } from "../hosted/connection.js";

// The account lifecycle moves to Endive; existing payment and diagnostic wire
// contracts retain their prior API version independently of the SDK upgrade.
export const LEGACY_STRIPE_API_VERSION = "2026-08-26.dahlia";
export const ACCOUNTS_STRIPE_API_VERSION = "2026-09-30.endive";
export function createStripeClient(apiKey: string, mode: Mode, httpClient?: Stripe.HttpClient) {
  if (!apiKey.startsWith(mode === "test" ? "sk_test_" : "sk_live_")) throw new Error("stripe_mode_mismatch");
  return new Stripe(apiKey, { apiVersion: LEGACY_STRIPE_API_VERSION as Stripe.LatestApiVersion, httpClient: httpClient ?? Stripe.createFetchHttpClient(), timeout: 10000, maxNetworkRetries: 0 });
}

// stripe-node can retry ECONNRESET/EPIPE even with maxNetworkRetries=0. Account
// creation must remain an explicit action; do not expose those retry codes.
class ExplicitAttemptHttpClient extends Stripe.HttpClient {
  constructor(private readonly client: Stripe.HttpClient) { super(); }
  getClientName() { return "explicit-account-attempt"; }
  async makeRequest(...args: Parameters<Stripe.HttpClient["makeRequest"]>): ReturnType<Stripe.HttpClient["makeRequest"]> {
    try { return await this.client.makeRequest(...args); }
    catch { throw new Error("account_transport_unconfirmed"); }
  }
}
const validId = (value: unknown): value is string => typeof value === "string" && /^acct_[A-Za-z0-9]{1,200}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Convert the v2 capability view, never deprecated v1 readiness flags. */
export function accountReadiness(value: unknown, accountId: string, mode: Mode) {
  if (!record(value) || value.object !== "v2.core.account" || value.id !== accountId || value.livemode !== (mode === "live")) throw new Error("invalid_account_status");
  const configuration = value.configuration;
  const merchant = record(configuration) ? configuration.merchant : undefined;
  const capabilities = record(merchant) ? merchant.capabilities : undefined;
  const card = record(capabilities) ? capabilities.card_payments : undefined;
  const balance = record(capabilities) ? capabilities.stripe_balance : undefined;
  const payouts = record(balance) ? balance.payouts : undefined;
  const states = [record(card) ? card.status : undefined, record(payouts) ? payouts.status : undefined];
  const notReady = { id: accountId, ready: false, actionRequired: false };
  if (states.some(s => s !== undefined && !["active", "pending", "restricted", "rejected", "unsupported"].includes(s as string))) throw new Error("invalid_account_capability");
  const requirements = value.requirements;
  // Missing include-dependent data never grants readiness, but is not a reason
  // to strand a valid saved account before it can complete hosted onboarding.
  if (states.some(s => s === undefined) || !record(requirements) || !Array.isArray(requirements.entries) || !record(merchant) || merchant.applied === false || !Array.isArray(value.applied_configurations) || !value.applied_configurations.includes("merchant")) return notReady;
  let actionRequired = states.some(s => s === "restricted" || s === "unsupported" || s === "rejected");
  for (const entry of requirements.entries) {
    if (!record(entry) || !record(entry.minimum_deadline) || !["currently_due", "eventually_due", "past_due"].includes(entry.minimum_deadline.status as string) || !["user", "stripe"].includes(entry.awaiting_action_from as string)) throw new Error("invalid_account_requirements");
    if (entry.awaiting_action_from === "user" && ["currently_due", "past_due"].includes(entry.minimum_deadline.status as string)) actionRequired = true;
  }
  return { id: accountId, ready: states.every(s => s === "active") && !actionRequired, actionRequired };
}

export function createStripeOnboarding(options: { apiKey: string; mode: Mode; returnUrl: string; refreshUrl: string; httpClient?: Stripe.HttpClient }): OnboardingProvider {
  if (!options.apiKey.startsWith(options.mode === "test" ? "sk_test_" : "sk_live_")) throw new Error("stripe_mode_mismatch");
  for (const value of [options.returnUrl, options.refreshUrl]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid_return_configuration");
  }
  const transport = new ExplicitAttemptHttpClient(options.httpClient ?? Stripe.createFetchHttpClient());
  const stripe = new Stripe(options.apiKey, { apiVersion: ACCOUNTS_STRIPE_API_VERSION, httpClient: transport, timeout: 10000, maxNetworkRetries: 0 });
  const platform = createStripeClient(options.apiKey, options.mode, transport);
  return {
    creationProtocol: "accounts_v2",
    async creationScope() {
      const account = await platform.accounts.retrieveCurrent();
      if (!account || account.object !== "account" || !validId(account.id)) throw new Error("invalid_platform_identity");
      return account.id;
    },
    async createAccount(bindingRef, country) {
      if (!businessCountry(country)) throw new Error("merchant_country_required");
      const account = await stripe.v2.core.accounts.create({
        identity: { country },
        dashboard: "full",
        configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
        metadata: { dinkus_binding: bindingRef },
      }, { idempotencyKey: `dinkus-connect:v2:${bindingRef}` });
      if (account.object !== "v2.core.account" || !validId(account.id) || account.livemode !== (options.mode === "live")) throw new Error("invalid_created_account");
      return account.id;
    },
    async accountStatus(accountId) {
      const account = await stripe.v2.core.accounts.retrieve(accountId, { include: ["configuration.merchant", "requirements"] });
      return accountReadiness(account, accountId, options.mode);
    },
    async createLink(accountId) {
      const link = await stripe.v2.core.accountLinks.create({
        account: accountId,
        use_case: { type: "account_onboarding", account_onboarding: { return_url: options.returnUrl, refresh_url: options.refreshUrl } },
      });
      const expiresAt = Date.parse(link.expires_at);
      if (link.object !== "v2.core.account_link" || link.account !== accountId || link.livemode !== (options.mode === "live") || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 3_600_000 || !validOnboardingUrl(link.url, options.mode, accountId)) throw new Error("invalid_account_link");
      return { url: link.url, expiresAt };
    },
  };
}
