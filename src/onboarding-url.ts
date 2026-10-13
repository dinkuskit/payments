/** Only Stripe-hosted onboarding links; the v2 fragment is an ephemeral bearer token. */
export function validOnboardingUrl(value: unknown, mode?: "test" | "live", accountId?: string): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (value.startsWith("https://connect.stripe.com/setup/") && url.hostname === "connect.stripe.com" && url.pathname.startsWith("/setup/") && !url.hash) return true;
    if (!value.startsWith("https://accounts.stripe.com/r/") || url.hostname !== "accounts.stripe.com" || url.search || !/^\/r\/acct_[A-Za-z0-9]+$/.test(url.pathname)) return false;
    if (accountId && url.pathname !== `/r/${accountId}`) return false;
    const token = url.hash.match(/^#alu_(test|live)_[A-Za-z0-9_-]{1,1024}$/);
    return !!token && (!mode || token[1] === mode);
  } catch { return false; }
}
