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
`mode`; it does not create an overall Ready to sell result or attest a
Commerce TEST order. Existing `connect` responses and TEST checkout admission
remain unchanged. Legacy status payloads decode with evidence absent.

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
a random immutable reference and a fixed Stripe creation idempotency key.

If account creation returns an unknown outcome, retry that key for at most
23 hours after the first attempt. After that, return `recovery_required` and
preserve state. Stripe may discard idempotency results after 24 hours; silently
starting over could create a duplicate. No automatic recovery or account
deletion is included. Changing the Stripe platform credential to a different
platform requires an explicit migration assessment, not a routine key rotation.

Once an account is known, resume produces a fresh one-use onboarding link.
Readiness requires submitted details, active card payments, enabled charges,
enabled payouts, and no provider-disabled reason. A provider outage returns
`checking` and refuses a new checkout binding. Test readiness is labeled
`mode: test`; it is not permission to accept live payments.

The new-checkout readiness gate must not become a reconciliation gate for
existing payments. The future Payments adapter must persist the original
recipient with each processor operation and reconcile that recipient even
when new payments are disabled. It must never substitute another account.

## Stripe integration scope

The local adapter uses the official Stripe SDK and its pinned stable API,
with Accounts v1 Standard onboarding. It requests no application fee and
does not implement subscription billing. Standard account availability and
the platform's live configuration must be verified with Stripe before live
activation. This is a test implementation, not a locked geography, fee, loss,
or platform eligibility policy. Existing-account OAuth linkage is not claimed.

The Worker is explicitly test-only. It refuses a live API key. Configuration
contains empty identity and callback settings, has no deployment routes, and
uses no real credentials. The Stripe key belongs in the host's secret binding;
it is never written to this repository or supplied to the registry plugin.

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

- [Stripe hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding)
- [Stripe SaaS platforms](https://docs.stripe.com/connect/saas)
- [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests)
- [Durable Object SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
