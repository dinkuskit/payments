import Stripe from "stripe";
import type { Mode, OnboardingProvider } from "../hosted/connection.js";

export function createStripeOnboarding(options: { apiKey: string; mode: Mode; returnUrl: string; refreshUrl: string; httpClient?: Stripe.HttpClient }): OnboardingProvider {
  if (!options.apiKey.startsWith(options.mode === "test" ? "sk_test_" : "sk_live_")) throw new Error("stripe_mode_mismatch");
  for (const value of [options.returnUrl, options.refreshUrl]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid_return_configuration");
  }
  const stripe = new Stripe(options.apiKey, { httpClient: options.httpClient ?? Stripe.createFetchHttpClient(), timeout: 10000, maxNetworkRetries: 0 });
  return {
    async createAccount(bindingRef) {
      // Stable Accounts v1 Standard integration. The account holder completes
      // business details on Stripe; no business/customer data is copied here.
      const account = await stripe.accounts.create({ type: "standard", metadata: { dinkus_binding: bindingRef } }, { idempotencyKey: `dinkus-connect:${bindingRef}` });
      return account.id;
    },
    async accountStatus(accountId) {
      const account = await stripe.accounts.retrieve(accountId);
      const disabled = Boolean(account.requirements?.disabled_reason);
      return {
        id: account.id,
        ready: account.details_submitted === true && account.charges_enabled === true && account.payouts_enabled === true && account.capabilities?.card_payments === "active" && !disabled,
        actionRequired: disabled || Boolean(account.requirements?.currently_due?.length || account.requirements?.past_due?.length),
      };
    },
    async createLink(accountId) {
      const link = await stripe.accountLinks.create({ account: accountId, type: "account_onboarding", return_url: options.returnUrl, refresh_url: options.refreshUrl });
      return { url: link.url, expiresAt: link.expires_at * 1000 };
    },
  };
}
