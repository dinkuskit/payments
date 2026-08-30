# Feature ownership map

The repository is at scaffold stage. No feature below has an implementation or
public compatibility promise yet.

| Planned feature ID | Responsibility | Explicit exclusions | Status |
| --- | --- | --- | --- |
| `dinkus.payments-provider` | One server-owned active-provider selection and the adapter boundary that implements Commerce's payment-provider contract | Checkout totals, payment-attempt persistence, orders, receipts, browser provider selection, fallback routing | planned |
| `dinkus.payments-stripe` | Stripe transport, idempotent processor operations, webhook signature verification, and normalized Stripe outcomes | Secret storage, Commerce state transitions, non-Stripe processors | planned demo provider |

## Boundary rules

- Commerce defines the payment-provider contract. Payments implements it and
  must not create a second checkout or order model.
- Provider selection is store-level server state. A checkout request never
  chooses or overrides it.
- The demo supports only provider `stripe` and currency `USD`.
- Unknown providers and non-USD amounts fail before provider contact.
- No provider silently falls back to another provider after any result or
  failure.
