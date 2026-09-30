# Feature ownership map

The hosted connection backend is implemented locally. No feature has a
released public compatibility promise yet.

| Planned feature ID | Responsibility | Explicit exclusions | Status |
| --- | --- | --- | --- |
| `dinkus.payments-provider` | One server-owned active-provider selection and the adapter boundary that implements Commerce's payment-provider contract | Checkout totals, payment-attempt persistence, orders, receipts, browser provider selection, fallback routing | planned |
| `dinkus.payments-stripe` | Stripe transport, idempotent processor operations, webhook signature verification, and normalized Stripe outcomes | Secret storage, Commerce state transitions, non-Stripe processors | planned demo provider |
| `dinkus.payments-connection` | Shared-account authentication, persistent store binding, resumable Stripe onboarding, and new-checkout readiness | Login/account creation, registry admin rendering, checkout sessions, webhooks, account switching, live activation | local test-mode backend |

## Boundary rules

- Commerce defines the payment-provider contract. Payments implements it and
  must not create a second checkout or order model.
- Provider selection is store-level server state. A checkout request never
  chooses or overrides it.
- The demo supports only provider `stripe` and currency `USD`.
- Unknown providers and non-USD amounts fail before provider contact.
- No provider silently falls back to another provider after any result or
  failure.
