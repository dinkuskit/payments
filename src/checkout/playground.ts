import type { CheckoutBinding, Principal } from "../hosted/connection.js";

/**
 * The shared public playground store. It checks out against one dedicated
 * Stripe sandbox account, never a merchant's connected account, and only ever
 * in TEST mode.
 */
export const PLAYGROUND_SITE_ID = "playground";
export const PLAYGROUND_BINDING_REF = "playground";
/** The dedicated Stripe sandbox account. An account id, not a secret. */
export const PLAYGROUND_STRIPE_ACCOUNT_ID = "acct_1UPn3tAq51efiBsg";

/** About 3 new checkout sessions per 10 minutes per shopper IP. */
export const PLAYGROUND_IP_LIMIT = { max: 3, windowMs: 10 * 60 * 1000 } as const;
/** Ceiling for the whole playground tenant, whatever the IP. */
export const PLAYGROUND_TENANT_LIMIT = { max: 60, windowMs: 10 * 60 * 1000 } as const;
/** Playground checkout records are deleted after this long. */
export const PLAYGROUND_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Stable public error code the store can show shoppers. */
export const PLAYGROUND_RATE_LIMIT_ERROR = "playground_rate_limited";

export class PlaygroundRateLimitError extends Error {
  constructor(readonly limit: "ip" | "tenant", readonly retryAfterSeconds: number) {
    super(PLAYGROUND_RATE_LIMIT_ERROR);
  }
}

export function isPlayground(principal: Pick<Principal, "siteId">): boolean {
  return principal.siteId === PLAYGROUND_SITE_ID;
}

/**
 * The playground key must be a Stripe TEST secret key. A live key, a
 * publishable key, a restricted key or no key fails closed with the same
 * error the Stripe adapter raises for any mode mismatch.
 */
export function assertPlaygroundStripeKey(key: unknown): string {
  if (typeof key !== "string" || !key.startsWith("sk_test_") || key.length <= "sk_test_".length) {
    throw new Error("stripe_mode_mismatch");
  }
  return key;
}

/** The playground's one checkout binding: server-owned config, never request input. */
export function playgroundBinding(): Extract<CheckoutBinding, { providerId: "stripe" }> {
  return { bindingRef: PLAYGROUND_BINDING_REF, providerId: "stripe", stripeAccountId: PLAYGROUND_STRIPE_ACCOUNT_ID, mode: "test" };
}

export interface RateWindowStore {
  /** Returns the hit timestamps (ms) for a bucket that are newer than `since`. */
  hits(bucket: string, since: number): number[];
  record(bucket: string, at: number): void;
}

/**
 * Checks both limits, then records one hit in each bucket. Must run inside one
 * synchronous storage transaction so concurrent requests cannot both pass.
 */
export function takePlaygroundSessionSlot(store: RateWindowStore, ipKey: string, now: number): void {
  const checks: Array<["ip" | "tenant", string, { max: number; windowMs: number }]> = [
    ["tenant", "tenant", PLAYGROUND_TENANT_LIMIT],
    ["ip", `ip:${ipKey}`, PLAYGROUND_IP_LIMIT],
  ];
  for (const [limit, bucket, rule] of checks) {
    const hits = store.hits(bucket, now - rule.windowMs);
    if (hits.length >= rule.max) {
      const oldest = Math.min(...hits);
      throw new PlaygroundRateLimitError(limit, Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)));
    }
  }
  for (const [, bucket] of checks) store.record(bucket, now);
}

/**
 * Hash the shopper IP so only an opaque key is stored. Rate-limit rows are
 * purged with the rest of the playground data.
 */
export async function playgroundIpKey(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`dinkus-playground-ip:${ip}`));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}
