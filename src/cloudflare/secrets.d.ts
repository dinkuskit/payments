// Supplied through the host secret binding, never plugin settings or source.
interface Env {
  /** Disabled-by-default operator attestation for one rejected legacy TEST binding. */
  STRIPE_TEST_LEGACY_V2_RECOVERY?: string;
  STRIPE_API_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** Stripe TEST secret key of the playground sandbox account. Must be sk_test_; fails closed otherwise. */
  STRIPE_PLAYGROUND_SECRET_KEY?: string;
  AUTHORIZE_NET_API_LOGIN_ID: string;
  AUTHORIZE_NET_TRANSACTION_KEY: string;
  AUTHORIZE_NET_SIGNATURE_KEY: string;
  STRIPE_DIAGNOSTIC_OPERATOR_ACCOUNT?: string;
  STRIPE_DIAGNOSTIC_OPERATOR_SITE?: string;
  STRIPE_DIAGNOSTIC_EXPECTED_ACCOUNT?: string;
  /** Private operator JSON selecting the country for one explicitly approved TEST site. */
  STRIPE_TEST_MERCHANT_COUNTRY_CONFIG?: string;
  /** Optional JSON array of closed {siteId, country} entries selecting countries for explicit approved TEST sites. */
  STRIPE_TEST_MERCHANT_COUNTRY_SITES?: string;
}
