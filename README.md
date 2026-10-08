# DinkusKit Payments

DinkusKit Payments is the open-source payment-provider plugin for EmDash
commerce sites. It gives DinkusKit Commerce one server-owned processor
connection while keeping processor APIs, webhook verification, and release
churn outside Commerce core.

## Status

Local hosted-connection and Checkout Session adapter. The package name is
reserved as `@dinkuskit/payments`, the EmDash plugin ID is `dinkus-payments`,
and the manifest remains private at `0.0.0`. The service includes persistent
account bindings, a readiness gate for new checkout, an existing-binding read
for reconciliation, Stripe hosted Checkout Sessions, and raw-byte webhook
verification that only wakes lookup. Its Worker is limited to test mode.
There is no registry-installable plugin, deployed service, live payment path,
package release, or production compatibility promise yet.

The demo direction is deliberately narrow:

- one active payment provider per store;
- Stripe as the reference adapter and Authorize.net as the second approved
  adapter;
- USD as the only accepted demo currency;
- no automatic provider fallback or per-checkout provider selection;
- no currency conversion.

The plugin is adapter-ready rather than permanently Stripe-only. Future
processors may be added as isolated modules behind the same Commerce-owned
payment-provider contract. They do not require a second checkout model.

## Install type

DinkusKit plugins ship as EmDash Registry plugins: sandboxed and installed
from the plugin Registry, which is how most EmDash sites add plugins. The
Registry build is the supported product, and features are designed, tested and
documented for it first. A native entry (code a site registers in its own
configuration or Astro routes) is a developer and test setup only. It may not
offer features the Registry build lacks, except temporary gaps listed here with
the work that closes them. The project owner set this rule on 2026-10-08.

Payments runs as a hosted service and has no installable plugin yet. When the
`dinkus-payments` plugin ships, it ships as a Registry plugin under this rule.

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

See [the charter](docs/CHARTER.md) for the complete boundary and
[hosted connections](docs/hosted-connections.md) for the local implementation,
account-service dependency, and remaining integration work.

## Development

```bash
npm ci
bin/verify-payments full
```

Under construction. MIT licensed.

## Local verification

Run `bin/verify-payments quick` during edits and `bin/verify-payments full` before
delivery. See [the project verification skill](skills/payments-verification/SKILL.md)
for prerequisites, checks, and proof limits.

## Authorize.net sandbox proof

The credential-gated proof runs on Node 22.23.2 from `.nvmrc`:

```bash
npm ci
node --import tsx scripts/authorize-net-sandbox-proof.mjs --run
```

See [the Authorize.net adapter proof notes](docs/authorize-net.md) for the
required environment variables and the mock-versus-sandbox boundary. Without
`--run`, the script reports a dry run and exits without contacting the sandbox.
