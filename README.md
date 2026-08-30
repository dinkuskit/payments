# DinkusKit Payments

DinkusKit Payments is the open-source payment-provider plugin for EmDash
commerce sites. It gives DinkusKit Commerce one server-owned processor
connection while keeping processor APIs, webhook verification, and release
churn outside Commerce core.

## Status

Charter stage. The package name is reserved as `@dinkuskit/payments`, the
EmDash plugin ID is `dinkus-payments`, and the manifest remains private at
`0.0.0`. There is no installable provider, Stripe SDK, live payment path,
package release, or production compatibility promise yet.

The demo direction is deliberately narrow:

- one active payment provider per store;
- Stripe as the only implemented and accepted demo provider;
- USD as the only accepted demo currency;
- no automatic provider fallback or per-checkout provider selection;
- no currency conversion.

The plugin is adapter-ready rather than permanently Stripe-only. Future
processors may be added as isolated modules behind the same Commerce-owned
payment-provider contract. They do not require a second checkout model.

## Amount terminology

- **Currency** identifies the unit, such as `USD`.
- **Money** is an exact amount in a currency, such as
  `{ currency: "USD", minor: "1200" }` for USD 12.00.
- **Price** is the product-facing use of a Money value.

Integer minor units prevent floating-point rounding from entering payment
contracts. The demo allowlist contains only `USD`, while the explicit currency
field keeps the stored shape extensible after the demo.

## Ownership

DinkusKit Commerce owns authoritative prices and totals, checkout orchestration,
payment-attempt state, orders, receipts, and the provider contract. Payments
will own server-side processor selection, Stripe transport, webhook
verification, and normalized provider outcomes. Inventory, shipping,
storefront UI, and secret storage remain outside this repository.

See [the charter](docs/CHARTER.md) for the complete boundary.

## Development

```bash
npm ci
bin/verify-payments full
```

Under construction. MIT licensed.
