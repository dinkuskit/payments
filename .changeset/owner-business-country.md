---
"@dinkuskit/payments": minor
---

Payment settings asks a store with no Stripe connection for its business country (from Stripe's supported countries) before Set up Stripe, in test and live mode, so any store can set up Stripe without DinkusKit support. The hosted service saves the country before creating the Stripe account and no longer reads operator-configured test countries; the support-only legacy test recovery route is removed. Authorize.net setup is unchanged.
