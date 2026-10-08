export type PaymentProviderId = "stripe" | "authorize_net";

export class ProviderRegistryError extends Error {}

/**
 * Provider IDs come from server-owned store configuration. Checkout request
 * data is never passed to this function, and no provider fallback exists.
 */
export function resolvePaymentProvider<T>(
  providerId: string,
  providers: Partial<Record<PaymentProviderId, T>>,
): T {
  if (providerId !== "stripe" && providerId !== "authorize_net") {
    throw new ProviderRegistryError("unknown_provider");
  }
  const provider = providers[providerId];
  if (!provider) throw new ProviderRegistryError("provider_unconfigured");
  return provider;
}
