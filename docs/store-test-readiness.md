# Store TEST-purchase readiness agreement

Approved 2026-10-08. Decision: `payments-store-test-readiness-028`.
This records the product agreement; it does not implement the readiness feature.

## Provider and launch scope

One Registry Payments plugin supports both Stripe and Authorize.net. Both must
be qualified before launch. Qualify Stripe first because merchant onboarding
is easier, then Authorize.net. Each store has exactly one server-selected
provider and no automatic fallback.

## Mandatory store proof

Before live checkout readiness, every store must complete an end-to-end TEST
purchase. Completion means a provider-confirmed TEST payment produces exactly
one paid Commerce order, visibly present in the Commerce backend/admin.
Inventory verification is expressly excluded from this gate.

The proof is bound to the selected provider, receiving account and critical
checkout/webhook bindings. Changing those invalidates readiness and requires
retesting. Ordinary product, price and catalog edits do not invalidate it.
The exact schema, protocol and enumeration of critical bindings remain
implementation design work, not settled choices in this agreement.

Test orders persist in the normal order list and are clearly marked TEST.
No test-order filter is required or requested. Test orders must not trigger
real fulfillment or shipping.

## Ownership and next bounded delivery

Payments owns provider verification and configuration. Commerce owns paid-order
state, the backend/admin view and checkout gating. Payments alone cannot attest
that an order is visible or that the Commerce readiness gate is complete.

The next bounded slice is a Payments–Commerce readiness contract: define the
proof inputs and invalidation boundary, assign the authoritative writer and
reader for each fact, and specify verification that a provider-confirmed TEST
payment maps to exactly one visibly marked TEST order without real fulfillment.
Retain the agreed exclusions and leave implementation choices explicit until
reviewed. The coordinator routes Commerce and template-store work; this record
authorizes no changes to those repositories.

Prerequisites include a genuine approved Registry installation, signed release
and consent evidence, a working account/service connection and selected-provider
receiving-account binding, Commerce checkout and reconciliation integration,
and an approved test-provider environment. The current Payments Registry bundle
is status-only; its seeded harness is not genuine installer or purchase proof.
Stripe-first specifies order of qualification, not permission to make provider
calls. Live credentials, provider traffic, deployment, account changes and
merges remain separately gated.

## Setup flow refinement

The additive [one payment setup screen decision](payment-setup-decision.md)
separates supported live connection checks from Commerce TEST-order proof in
one merchant screen. It preserves this agreement and rejects technical
sandbox-to-live account certification as a merchant task.
