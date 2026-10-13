import Stripe from "stripe";
import { createStripeClient } from "./onboarding.js";
import { BOUNDED_IDENTITY_HTTP_STATUSES, type ProviderIdentityDiagnostic } from "../provider-identity.js";

/** Fixed read-only transport. Erase retryable transport codes before the SDK sees them. */
class IdentityHttpClient extends Stripe.HttpClient {
  private attempted = false;
  status?: number;
  constructor(private readonly underlying: Stripe.HttpClient) { super(); }
  getClientName() { return "identity-single-read"; }
  async makeRequest(...args: Parameters<Stripe.HttpClient["makeRequest"]>): ReturnType<Stripe.HttpClient["makeRequest"]> {
    const [host, port, path, method, headers, body, protocol] = args;
    if (this.attempted || host !== "api.stripe.com" || String(port) !== "443" || path !== "/v1/account" || method !== "GET" || protocol !== "https" || body ||
        Object.keys(headers).some(k => ["stripe-account", "stripe-context"].includes(k.toLowerCase()))) throw new Error("identity_request_refused");
    this.attempted = true;
    try {
      const response = await this.underlying.makeRequest(...args);
      const status = response.getStatusCode();
      if ((BOUNDED_IDENTITY_HTTP_STATUSES as readonly number[]).includes(status)) this.status = status;
      return response;
    } catch { throw new Error("identity_transport_unconfirmed"); }
  }
}

export async function checkStripePlatformIdentity(options: {
  apiKey: string; expectedAccountId: string; httpClient?: Stripe.HttpClient;
}): Promise<ProviderIdentityDiagnostic> {
  const at = Date.now();
  const validTestPrefix = /^sk_test_\S+$/.test(options.apiKey);
  if (!validTestPrefix || !/^acct_[A-Za-z0-9]{1,200}$/.test(options.expectedAccountId)) return { result: "unavailable", validTestPrefix, at };
  const transport = new IdentityHttpClient(options.httpClient ?? Stripe.createFetchHttpClient());
  try {
    const stripe = createStripeClient(options.apiKey, "test", transport);
    const account = await stripe.accounts.retrieveCurrent();
    if (!account || typeof account !== "object" || Array.isArray(account) || account.object !== "account" || typeof account.id !== "string" || !/^acct_[A-Za-z0-9]{1,200}$/.test(account.id) || transport.status !== 200) throw new Error("identity_response_unconfirmed");
    return { result: account.id === options.expectedAccountId ? "match" : "mismatch", validTestPrefix, httpStatus: 200, at };
  } catch {
    return { result: "unconfirmed", validTestPrefix, ...(transport.status === undefined ? {} : { httpStatus: transport.status }), at };
  }
}
