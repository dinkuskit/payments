# DinkusKit Payments Charter

## Public clean-room origin

DinkusKit Payments starts public with a new, independent Git history. Prior
private implementations may inform bounded behavior research, but their
history, artifacts, credentials, configuration, and files are not imported.
Useful behavior is reconstructed one inspected slice at a time with fresh tests
and public proof.

## Product boundary

DinkusKit Payments is the reusable processor-integration layer for DinkusKit
Commerce:

- one server-owned active payment-provider selection per store;
- provider discovery, compatibility, capabilities, and health;
- isolated processor adapters;
- idempotent processor calls using Commerce-owned attempt identities;
- webhook authenticity verification and normalized provider events;
- provider references and typed, fail-closed outcomes returned to Commerce.

DinkusKit Commerce remains authoritative for product prices, sellability,
currency policy, cart contents, checkout snapshots and totals, payment-attempt
state, orders, receipts, and reconciliation orchestration. Payments consumes
the Commerce-owned provider contract; it does not create a competing checkout
or order model.

This repository does not own physical inventory, fulfillment, shipping rates
or labels, storefront UI, customer identity, taxes, promotions, or secret
storage.

## Extension topology

The public package and EmDash installation are `@dinkuskit/payments` and
`dinkus-payments`. One internal adapter registry may contain multiple isolated
processor adapters over time, while each store selects exactly one active
provider in server-owned configuration.

For the demo, `stripe` is the only provider ID permitted for implementation and
acceptance. Unknown providers fail before transport. Checkout input cannot
select a provider, and the plugin never retries through a different processor.

## Amount and currency model

Authoritative amounts use integer minor units paired with an explicit currency
code. For example, USD 12.00 is represented as:

```json
{ "currency": "USD", "minor": "1200" }
```

The demo supports `USD` only. A non-USD amount fails before provider contact,
and no component performs currency conversion. Additional currencies are a
post-demo product decision; the explicit currency field prevents that future
work from requiring an ambiguous amount migration.

## Initial delivery boundary

The initial repository is a non-operational scaffold. It establishes public
ownership, safety rules, package identity, feature boundaries, verification,
and GrillTrack lineage. It includes no Stripe SDK, credentials, webhook
endpoint, processor calls, Commerce modifications, template-store changes,
package publication, deployment, or production mutation.

Implementation begins only after Commerce exposes a grilled payment-provider
contract and the corresponding Payments slice is locked.
