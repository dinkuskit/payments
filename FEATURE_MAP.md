# Feature ownership map

The hosted connection backend is implemented locally. No feature has a
released public compatibility promise yet.

| Planned feature ID | Responsibility | Explicit exclusions | Status |
| --- | --- | --- | --- |
| `dinkus.payments-provider` | One server-owned active-provider selection and the adapter boundary that implements Commerce's payment-provider contract | Checkout totals, payment-attempt persistence, orders, receipts, browser provider selection, fallback routing | local CheckoutPaymentPort adapter |
| `dinkus.payments-stripe` | Stripe Checkout Session transport, durable attempt mapping, webhook signature verification, and normalized outcomes | Secret storage, Commerce state transitions, marking paid from events, non-Stripe processors, live Stripe proof | local test-mode adapter |
| `dinkus.payments-connection` | Shared-account authentication, persistent store binding, resumable Stripe onboarding, new-checkout readiness, and existing-binding reads | Login/account creation, registry admin rendering, account switching, live activation | local test-mode backend |

## Boundary rules

- Install type: the sandboxed Registry plugin is the supported product. A
  native entry is a developer and test setup with no features the Registry
  build lacks, except gaps the README lists (owner rule, 2026-10-08).
- Commerce defines the payment-provider contract. Payments implements it and
  must not create a second checkout or order model.
- Provider selection is store-level server state. A checkout request never
  chooses or overrides it.
- The demo supports only provider `stripe` and currency `USD`.
- Unknown providers and non-USD amounts fail before provider contact.
- No provider silently falls back to another provider after any result or
  failure.
