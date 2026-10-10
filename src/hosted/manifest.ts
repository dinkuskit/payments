/** Hosted service routes are not EmDash plugin routes. */
export const hostedHttpRoutes = {
  "/v1/connect": { method: "POST", scope: "payments:admin" },
  "/v1/status": { method: "GET", scope: "payments:admin" },
  "/v1/checkout-binding": { method: "GET", scope: "payments:checkout" },
  "/v1/existing-binding": { method: "GET", scope: "payments:checkout" },
  "/v1/checkout/session": { method: "POST", scope: "payments:checkout" },
  "/v1/checkout/lookup": { method: "POST", scope: "payments:checkout" },
  "/v1/checkout/wakes": { method: "GET", scope: "payments:checkout" },
  "/v1/checkout/wakes/ack": { method: "POST", scope: "payments:checkout" },
} as const;

export const hostedWebhookRoutes = {
  stripe: { path: "/v1/webhooks/stripe", method: "POST", authentication: "stripe-signature" },
  authorizeNet: { prefix: "/v1/webhooks/authorize-net/", method: "POST", authentication: "hmac-sha512" },
} as const;

/** Exact paths for one server-owned site, never an Access wildcard or template. */
export function hostedPublicRouteManifest(siteId: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(siteId)) throw new Error("invalid_site_path_segment");
  return [
    { ...hostedWebhookRoutes.stripe, surface: "hosted", public: true },
    {
      path: `${hostedWebhookRoutes.authorizeNet.prefix}${siteId}`,
      method: hostedWebhookRoutes.authorizeNet.method,
      authentication: hostedWebhookRoutes.authorizeNet.authentication,
      surface: "hosted", public: true,
    },
  ] as const;
}

export function matchAuthorizeNetWebhookSite(path: string): string | null {
  const prefix = hostedWebhookRoutes.authorizeNet.prefix;
  if (!path.startsWith(prefix)) return null;
  const siteId = path.slice(prefix.length);
  return siteId && !siteId.includes("/") ? siteId : null;
}
