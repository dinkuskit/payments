# Playground tenant

The shared `playground` store lets the public try checkout against Stripe's
sandbox. It is a hosted-service tenant like any store, with these differences.

- **Fixed TEST binding.** Site id and binding ref are `playground`. Sessions go
  to the dedicated sandbox account `acct_1UPn3tAq51efiBsg` using the secret
  binding `STRIPE_PLAYGROUND_SECRET_KEY`. Anything other than an `sk_test_` key
  (live, publishable, restricted, empty) fails closed with
  `stripe_mode_mismatch` before Stripe is called; an unset binding returns
  `503 playground_unconfigured`.
- **Lookup-only status.** No payment wakes are queued. The store confirms on its
  success page with `POST /v1/checkout/lookup` or
  `GET /v1/checkout/receipt?session_id=cs_test_...` (playground only).
- **Rate limits.** 3 new sessions per 10 minutes per shopper IP and 60 per
  10 minutes for the whole tenant. Over the limit:
  `429 {"error":"playground_rate_limited"}` with `Retry-After: 600`. The
  playground Worker forwards the shopper IP in `x-dinkus-client-ip`; without it
  session creation fails with `400 client_ip_required`. IPs are stored only as
  SHA-256 hashes.
- **Retention.** Playground checkout records and rate-limit hits are deleted
  after 24 h by a Durable Object alarm. Records hold catalog lines and Stripe
  ids only.
- **Narrow credential.** The playground Worker's pass is the usual account JWT
  with `site_id: "playground"` and scope exactly `payments:checkout`. Any other
  scope for the playground site is rejected, and the pass can reach only
  session, lookup and receipt.
