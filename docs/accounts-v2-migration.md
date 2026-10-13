# Accounts v2 lifecycle migration

Payments creates new connected accounts through Accounts v2 while preserving
the agreed SaaS payment model: independent merchants use the full Stripe
Dashboard, Stripe collects their payment fees and bears negative balance
liability, and Checkout creates direct charges on their accounts. This change
adds no embedded components, customer/recipient configuration, platform fee,
new payment method or v1 policy toggle.

## API boundaries

Stripe Node SDK 23.0.0 and API `2026-09-30.endive` handle account creation,
account readiness and account links. Creation requests merchant card-payment
capability and leaves merchant identity/KYC details to Stripe-hosted onboarding.
No account default currency is imposed before hosted onboarding. The two
required responsibility fields are set to `stripe`; these are permanent
choices for the account. The API reference allows identity information to be
provided during onboarding rather than inventing country or person data.

The v2 readiness read explicitly includes `configuration.merchant` and
`requirements`. Both card payments and payouts must be active; current or
past-due user requirements prevent readiness. Missing fields never imply ready.
An incomplete account can still receive an authenticated onboarding link.
Only the internal `ready`/`actionRequired` projection is exposed; no KYC data is
copied to Registry diagnostics.

V2 links have an ISO timestamp expiry and a tightly constrained
`https://accounts.stripe.com/r/acct_...#alu_test_...` shape in TEST mode. The
account reference, mode, host, path and fragment are validated, and existing
flow/owner/expiry rechecks remain. The old Stripe-hosted URL shape remains
accepted for existing responses. Links remain ephemeral and are never stored.

Checkout, PaymentIntent reads and platform identity diagnostics retain their
prior API `2026-08-26.dahlia` wire contract despite the SDK update. In particular,
card-only Checkout, direct-charge account context, expiry, payment webhooks and
Commerce order behavior are unchanged. This intentional version boundary keeps
the account migration from changing the settled payment-method contract.

## Creation outcomes and existing state

New operations record `creationProtocol: accounts_v2`. Before an account-create
POST, Payments reads the platform account with the same configured credential,
records its identity as the private creation scope, and refuses to replay that
operation under a different platform. Transport failures do not trigger hidden
SDK retries. Explicit retries retain the binding/idempotency operation; the
existing conservative 23-hour limit remains even though v2 has a longer
idempotency window.

A legacy operation with no saved account does not gain v2 authorization just
because code was upgraded. It returns recovery-required without provider I/O.
Before the coordinator changes an exact legacy operation to v2, reconcile its
recorded outcome and provider scope; an unresolved outcome stays blocked.
Do not assume keys deduplicate across APIs/platforms or clear a record to make
onboarding start over. The reconciliation belongs to the explicit approved
rollout, not an automatic request path.

Existing saved account IDs and ownership remain intact. Readiness uses their
v2 view; Stripe documents that a newly created v1 account may take up to ten
minutes to become available there. An unavailable/incompatible read remains
not-ready and never causes account replacement.

## Verification and rollout

Synthetic tests cover exact request payloads/API versions, full-dashboard
responsibilities, current link format and expiry, incomplete capabilities,
unknown fields, cross-platform replay prevention and owner changes around
creation. Real Durable Object and compiled Registry tests cover existing
payment behavior and the ten-call setup budget with v2 links.

The owner authorized this bounded migration using the two official Stripe
skills; provenance is in `proof/accounts-v2/skill-provenance.json`. Already
settled choices override the skills' generic discovery, embedded-component,
payment-method and fee recommendations. No new key/account setup is performed
by the source lane.

After exact-head review, the coordinator owns merge, Worker deployment,
Registry publication/install, outcome reconciliation and the approved TEST E2E.
The browser owner verifies hosted onboarding, account readiness, connected
account payment ownership and exactly one paid Commerce order. No live-mode
activation is implied.

## References

- https://docs.stripe.com/connect/saas/tasks/create
- https://docs.stripe.com/connect/saas/tasks/onboard
- https://docs.stripe.com/api/v2/core/accounts/create
- https://docs.stripe.com/api/v2/core/account-links/create
- https://docs.stripe.com/connect/accounts-v2/migrate-integration
- https://docs.stripe.com/api-v2-overview
