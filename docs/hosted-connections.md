# Hosted Payments connections

## Accepted experience

Install the registry Payments plugin, choose **Connect Stripe** in EmDash,
complete Stripe's hosted setup, and return to a verified status. The receiving
Stripe account belongs to the merchant. DinkusKit runs the connection service
and reuses the same merchant identity as hosted Inventory. Shop owners do not
configure infrastructure or manually enter Stripe API keys.

The implementation here is the first backend slice. It is not a registry
release or proof that the entire experience is available. Stripe bindings
carry `stripeAccountId`; sandbox Authorize.net bindings carry the separate
server-owned `authorizeNetMerchantId`. Cross-provider fields and provider
sentinels fail closed.

## Backend contract

All endpoints require a signed access token from the configured DinkusKit
account issuer. Tokens must carry `sub`, `iat`, `exp`, `site_id`, the correct
audience, and the required scope. The `X-Dinkus-Site` header must match the
signed site claim. The issuer must authorize site ownership before granting
that claim. The backend cannot make an untrusted identity issuer safe.

| Endpoint | Scope | Result |
| --- | --- | --- |
| `POST /v1/connect` with no body or query | `payments:admin` | Resume the existing account or persist a new binding before starting creation; optionally return a fresh Stripe onboarding URL |
| `GET /v1/connect/diagnostics` with no body or query | `payments:admin` | Read-only local account-creation evidence for the authenticated site and stored owner; no provider calls or state writes |
| `GET /v1/status` | `payments:admin` | Current provider-verified state; no cached ready fallback |
| `GET /v1/checkout-binding?bindingRef=...` | `payments:checkout` | Exact immutable recipient binding for a new checkout, or `409 payments_not_ready` |
| `GET /v1/existing-binding?bindingRef=...` | `payments:checkout` | Exact stored recipient for an existing attempt, even if new checkout is not ready |
| `GET /v1/checkout/wakes?bindingRef=...&limit=...` | `payments:checkout` | Non-destructive JSON list of canonical five-field Commerce wake snapshots; `limit` is `1..100`, default `25` |
| `POST /v1/checkout/wakes/ack` | `payments:checkout` | `{ "acknowledged": boolean }` for one exact `{ eventId, attemptId, bindingRef, deliveryGeneration, wokeAt }` snapshot |

These are authenticated server-to-server endpoints. A browser landing on a
Stripe return URL does not authenticate a merchant or mark setup complete.
The shared account application must handle that landing, restore its signed-in
session, then query status. Its refresh callback similarly requests a new link
for the same store and account. Neither callback is implemented by this slice.

Responses use `Cache-Control: no-store`. Onboarding URLs are not stored. The
client must treat them as short-lived sensitive links and open them only for
the authenticated merchant. No caller may supply an account ID, provider,
mode, or callback URL. Callback URLs are trusted operator configuration.

Diagnostics use the same signed site claim, `X-Dinkus-Site` match and stored-owner
checks as the connection. They return `state` (`disconnected`, `connecting`,
`recovery_required` or `account_present`), `mode`, `processorAccountPresent` and
`evidence` (`observed` or `unobserved`). An observed failure adds `lastFailure`
with a closed `category`, optional allowlisted HTTP `status`, and timestamp `at`.
Categories are `authentication`, `permission`, `platform_required`,
`rate_limited`, `provider_unavailable`, `transport_unknown` and `unknown`.
No account/binding identifiers, raw provider data or URLs are exposed. Legacy
attempts without recorded failure evidence remain `unobserved`; reading them
neither reconstructs a cause nor retries setup. This separate response does not
change the legacy `/v1/status` or `/v1/connect` shapes.

Authenticated status responses may add this minimal `connectionEvidence`
object without changing the legacy `state`, `mode`, or `bindingRef` fields:

```json
{
  "provider": "stripe",
  "mode": "test",
  "result": "verified",
  "accountRef": "acct_example"
}
```

`result` is `verified`, `action_required`, `unknown`, or `unsupported`.
Stripe reuses the existing account lookup once per status request, requires
the returned account ID to match the stored account, and includes its account
reference only as a provider identity reference. Lookup failures and account
mismatches are `unknown`, never verified. Authorize.net reports
`unsupported` for its configured legacy merchant binding without a readiness
call or an inferred live claim. Status evidence always states the explicit
`mode`; it does not create an overall Ready to sell result. Existing `connect`
responses and TEST checkout admission remain unchanged. Legacy status payloads
decode with evidence absent.

Status responses also add `testOrder` once the current connection has a TEST
checkout its provider confirmed as paid through Payments' own lookup:
`{ provider, total, paidAt, state }`, where `state` is `awaiting_notice`,
`awaiting_commerce` or `recorded`. `recorded` means Commerce acknowledged that
checkout's payment notice, which it does only after saving the paid order. See
[test order check](test-order-check.md).

The account service owns shared identity and site grants. Payments verifies
them with `jose`; it does not create passwords or issue an alternative account
token. Identity is the issuer/subject pair, matching Inventory's current
identity boundary. Audience and scope remain specific to each service.

Wake list and ACK authenticate before touching wake storage. Payments derives
site, account, and `mode: "test"` from the verified principal and the existing
stored connection. It compares the canonical event, its original attempt
association, immutable merchant binding, connected account, mode, generation,
and original `received_at` timestamp before projecting or acknowledging.
Generation `1` is persisted once per canonical event; replay does not reopen or
increment a tombstone. Historical attempt-only rows remain in the legacy queue
and are not given synthetic event IDs. ACK uses an atomic conditional update,
so a changed-row count is a new internal consumption, while an exact retry of
an already acknowledged snapshot is idempotently true.

## Persistence and retries

One SQLite Durable Object owns a site's payment connection. The first valid
merchant becomes its binding owner; a different owner is rejected. There is
no automatic ownership transfer or account-switch operation. Each binding has
a random immutable reference. New account operations record the Accounts v2
protocol and the actual Stripe platform identity before creation. Explicit
retries retain the same v2 idempotency key and cannot switch platform scope.

Unknown v2 creation outcomes may be explicitly retried for at most 23 hours
from the first attempt. This conservative application window remains even
though Accounts v2 documents a longer idempotency lifetime. An older operation
without a saved account and without the v2 protocol marker returns
`recovery_required` without provider I/O. Upgrading code does not authorize a
new operation on another API or platform. Preserve unresolved state; no reset,
automatic reconciliation or account deletion is included. See the
[Accounts v2 migration](accounts-v2-migration.md) for the rollout boundary.

Existing saved account IDs remain in place and are read through their v2 view.
Readiness requires an applied merchant configuration, active card-payment and
payout capabilities, and no user requirements that are currently or past due.
The read includes `configuration.merchant` and `requirements`; missing or
unrecognized data never grants readiness. A provider outage returns `checking`
and refuses a new checkout binding. A valid incomplete account can still
receive a fresh hosted onboarding link; a browser return never proves ready.

Links use the validated `https://accounts.stripe.com/r/acct_...#alu_test_...`
format in TEST mode with an ISO expiry from Stripe. The account, mode, host,
path, fragment and expiry are checked. The legacy `connect.stripe.com/setup/`
URL format remains accepted for compatibility. Links are ephemeral, never
stored, and every resume requests a new link for the same account. Test
readiness is labeled `mode: test`; it is not permission to accept live payments.

The new-checkout readiness gate must not become a reconciliation gate for
existing payments. The future Payments adapter must persist the original
recipient with each processor operation and reconcile that recipient even
when new payments are disabled. It must never substitute another account.

## Stripe integration scope

The account lifecycle uses the official Stripe SDK 23.0.0 with Accounts v2
on API `2026-09-30.endive`: creation, readiness reads and hosted account links.
It requests merchant card payments, full Stripe Dashboard access, and Stripe
fee collection/negative balance responsibility. The owner's chosen business
country is saved before creation and sent as `identity.country`; other identity details and account currency remain with hosted
onboarding. See [Business country](business-country.md). Direct-charge
Checkout and platform diagnostics retain API `2026-08-26.dahlia`. No application fee,
subscription billing, embedded component or existing-account OAuth linkage is
introduced. Owners who already have Stripe reuse their verified details
through Stripe's networked onboarding during hosted onboarding
(`payments-existing-stripe-account-046`). Provider eligibility and live activation remain separate gates.

The Worker is explicitly TEST-only and refuses a live API key. Non-secret
production deployment settings are documented in `DEPLOY.md` and
`wrangler.production.jsonc`; keys and webhook secrets remain host bindings,
never repository content or Registry plugin input.

## Remaining delivery work

1. Provide the real shared DinkusKit identity service, authorized site grants,
   sign-in reuse, and the two authenticated Stripe return/refresh pages.
2. Implement and prove the EmDash 1.0 registry sandbox/Block Kit client using
   that service. Keep credentials server-side and declare network hosts.
3. Wire Commerce's reconcile caller to the Payments webhook wake and prove a
   real Stripe test-mode purchase. This backend owns neither checkout amounts
   nor orders.
4. Verify real Stripe test-mode onboarding and a complete synthetic purchase,
   then review the exact resulting source before any live activation.

## Verification and references

`bin/verify-payments full` runs Node behavior tests, TypeScript, the public
repository audit, local workerd/SQLite tests, and an offline Worker bundle.
Tests use synthetic signed tokens and intercepted Stripe transport. They prove
backend behavior, not real identity-provider or Stripe account activation.

- [Stripe v2 hosted onboarding](https://docs.stripe.com/connect/saas/tasks/onboard)
- [Stripe SaaS platforms](https://docs.stripe.com/connect/saas)
- [Stripe API v2 and idempotency](https://docs.stripe.com/api-v2-overview)
- [Durable Object SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
