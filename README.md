# DinkusKit Payments

DinkusKit Payments is the open-source payment-provider plugin for EmDash
commerce sites. It gives DinkusKit Commerce one server-owned processor
connection while keeping processor APIs, webhook verification, and release
churn outside Commerce core.

## Kit direction and accepted standalone work

The organization [vision](https://github.com/dinkuskit/.github/blob/main/VISION.md)
and [scope and planning](https://github.com/dinkuskit/.github/blob/main/ROADMAP.md)
set the direction of independently useful tools. The current implementation
still connects through Commerce. The [charter](docs/CHARTER.md#product-boundary)
already records `payments-standalone-direction-042` (locked October 25, 2026,
**not yet built**): optional Commerce, a small Sales list and Buy button when
Commerce is absent, and hosted Connect or an owner-held provider-key path.
Commerce's connection disables the standalone order list. The accepted work
waits until the existing store is selling; this alignment does not start it
([decision PR #88](https://github.com/dinkuskit/payments/pull/88)).

[Issue #89](https://github.com/dinkuskit/payments/issues/89) and
[proposal PR #90](https://github.com/dinkuskit/payments/pull/90) own existing
Stripe-account connection work. Their earlier one-account/one-store proposal
needs reconciliation before lock or build: a business may have several sites,
and DinkusKit should preserve provider-permitted account sharing where safe and
explicitly scoped rather than impose a permanent one-site restriction.
[Stripe's domain list](https://docs.stripe.com/api/payment_method_domains/list)
and [connected-account Checkout routing](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted)
are design inputs, not proof of eligibility for every business or of safe
multi-site support here. Eligibility, routing and identity isolation still need
a focused design and proof; account sharing is not implemented by this change.

The hosted flow's no-pasted-key rule does not remove decision 042's standalone
owner-key option. Immutable bindings preserve payment history; they do not by
themselves decide whether a merchant can later leave or change providers.
These are reconciliation boundaries for the existing proposal, not new locks
or claims of implemented migration support.

## Status

Local hosted-connection and Checkout Session adapter. The package name is
reserved as `@dinkuskit/payments`, the EmDash plugin ID is `dinkus-payments`,
and package metadata and plugin manifests are aligned for public `0.2.0` release
preparation while remaining unpublished. The service includes persistent
account bindings, a readiness gate for new checkout, an existing-binding read
for reconciliation, Stripe hosted Checkout Sessions, and raw-byte webhook
verification that only wakes lookup. Its Worker is limited to test mode.
Actual package publication, Registry release, service deployment, and live
payment traffic have not occurred and remain separate human approval gates;
there is no production compatibility promise yet.

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

See [what ships and where it runs](https://dinkuskit.com/docs/developers/contribute#what-ships-and-where-it-runs)
for the boundaries between Registry plugins, hosted services, the template,
the playground and developer-only test tools. Beta and stable plugin artifacts
do not include those developer preview controls.

DinkusKit plugins ship as EmDash Registry plugins: sandboxed and installed
from the plugin Registry, which is how most EmDash sites add plugins. The
Registry build is the supported product, and features are designed, tested and
documented for it first. A native entry (code a site registers in its own
configuration or Astro routes) is a developer and test setup only. It may not
offer features the Registry build lacks, except temporary gaps listed here with
the work that closes them. The project owner set this rule on 2026-10-08.

Payments has a hosted service and a local installable Registry candidate. The
candidate provides an authenticated Payment setup page with explicit DinkusKit
account consent, a short-lived public store-proof route, encrypted session
storage and a server-configured status consumer. The default production status
endpoint is `https://payments.dinkuskit.com/v1/status`; an operator packaging
the plugin for another Payments service must provide an explicit build-time
endpoint override. **Place a test order** completes once the provider
confirmed a paid TEST checkout and Commerce saved its order
([test order check](docs/test-order-check.md)). A verified Stripe TEST
connection reads **Connected: Stripe test mode**; **Ready to sell** still needs a
verified live connection ([setup status wording](docs/registry-status.md#setup-status-wording)).

The official bundle is covered by EmDash's plugin runtime and an actual local
Registry installer/browser consent proof using synthetic authoritative records.
This does not establish public Registry publication or live service activation.
See [Registry setup and proof](docs/registry-status.md) and
[exact route authentication](docs/route-auth.md).

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

## Releasing

Every pull request declares its bump in `.changeset/` (`patch` for fixes,
`minor` for everything else during `0.x`, or `changeset --empty` for non-bumping
changes). Ordinary pushes to `main` do not cut betas or open a release PR:
operators run **Release** (`release.yml`) from `main` with `action: cut-beta` to
start `release/X.Y.Z` and its `vX.Y.Z-beta.N` tag, whose run publishes
`dinkus-payments-beta` and starts the `@running` journeys on the shared beta
store. `action: add-fix` copies a merged fix onto that branch as the next beta,
and `action: promote` turns a verified beta into a `ci: release vX.Y.Z` pull
request to `main`. Human merge of the `ci: release` PR is the only stable
publish path (`vX.Y.Z` tag on the release branch, GitHub Release, and delegated
`dinkus-payments` Registry publish). See [RELEASING.md](RELEASING.md) for the
full release flow and required repository secrets/variables.

## Command-line client

`dinkus-payments` is a dependency-free command-line client for the hosted
Payments API. It reads a site's connection status, starts or resumes provider
onboarding behind a dry run and typed confirmation, shows stored bindings,
looks up checkout outcomes, and lists pending payment wakes. It does not
acknowledge wakes or create checkout sessions. The interface is locked for the
scaffold slice (GrillTrack `payments-cli-scaffold-032`); see
[the CLI specification](docs/CLI-SPEC.md).

```bash
# DINKUS_PAYMENTS_TOKEN must already hold a site token from your secret
# manager. It is never accepted as a flag or config value.
node bin/dinkus-payments.mjs --endpoint https://payments.example.invalid \
  --site site_demo status
```

## Authorize.net sandbox proof

The credential-gated proof runs on Node 24.22.0 from `.nvmrc`:

```bash
npm ci
node --import tsx scripts/authorize-net-sandbox-proof.mjs --run
```

See [the Authorize.net adapter proof notes](docs/authorize-net.md) for the
required environment variables and the mock-versus-sandbox boundary. Without
`--run`, the script reports a dry run and exits without contacting the sandbox.
