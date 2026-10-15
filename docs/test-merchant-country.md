# Explicit country for a TEST merchant

Accounts v2 requires `identity.country` before `configuration.merchant`.
Payments therefore takes country from explicit, operator-approved TEST
site configuration. It never derives it from IP, shipping, email, currency,
platform country or a browser-supplied field. This is a bounded TEST fixture
path, not general merchant-country collection for a production rollout.

## Configuration

### Legacy Singleton Configuration

Set the private host binding `STRIPE_TEST_MERCHANT_COUNTRY_CONFIG` to a JSON
object. Only the authenticated site named in the object can consume it:

```json
{"siteId":"synthetic-site","country":"GB"}
```

Country must have uppercase ISO alpha-2 syntax; Stripe remains authoritative
for supported countries and eligibility. No default is supplied. A new v2
binding without matching configuration fails before state/provider creation.
Existing saved accounts do not require this setting to resume or read status.
The country itself stays in operator configuration, not a merchant setting.
Registry 0.2.8 adds only the owner-visible support reference needed to identify
an existing rejected attempt without extracting credentials or raw responses.

The country is persisted in `creationCountry` before the create POST. A later
configuration change cannot change that operation's country. Missing later
configuration does not erase the saved country. Account creation serializes
`identity: { country }`; Dashboard access, fee/loss responsibility, direct
charges and the absence of a forced default currency remain unchanged.

### Additive Multi-site Configuration

To admit country configuration across multiple explicit TEST sites without
retargeting or altering existing single-site configurations, set the optional
operator binding `STRIPE_TEST_MERCHANT_COUNTRY_SITES` to a JSON array of closed
`{siteId, country}` objects:

```json
[
  {"siteId":"synthetic-site-alpha","country":"FR"},
  {"siteId":"synthetic-site-beta","country":"DE"}
]
```

- **Bounds & Constraints**:
  - Max length: 8192 characters.
  - Max entries: 16 entries.
  - Valid site ID: must match `/^[A-Za-z0-9_-]{1,200}$/` (identical to the legacy parser).
  - Country: uppercase 2-letter ISO alpha-2 syntax (`/^[A-Z]{2}$/`).
  - Closed entries: objects must contain only `siteId` and `country` keys (extra keys, unknown fields, or `rejectedCreation` are strictly prohibited in new entries).
  - Duplicate site IDs are rejected.
  - Malformed, non-array, or over-limit configuration fails closed (`merchant_country_configuration_invalid`).

- **Resolver Composition & Fallback Semantics**:
  - **Absent/Empty Binding**: If `STRIPE_TEST_MERCHANT_COUNTRY_SITES` is absent (`undefined`) or empty (`""`), resolver semantics fall back exactly to the unchanged legacy `STRIPE_TEST_MERCHANT_COUNTRY_CONFIG` parser.
  - **Matching New Site**: If `STRIPE_TEST_MERCHANT_COUNTRY_SITES` contains a matching `siteId`, it provides country only. If the legacy configuration also selects the same `siteId`, ambiguity is rejected (fails closed with `merchant_country_configuration_invalid`, even if the configured country is identical) so that the multi-site binding can never inadvertently override an explicit known-400 correction.
  - **Valid Nonmatching Site**: If `STRIPE_TEST_MERCHANT_COUNTRY_SITES` is present and valid, but does not match the requested site, the resolver falls back to `STRIPE_TEST_MERCHANT_COUNTRY_CONFIG`, preserving legacy singleton semantics including `rejectedCreation`.
  - **Fail Closed**: No defaults or inferences are ever applied. Any malformed present configuration (in either binding) fails closed. Old configuration is never retargeted, and no live provider calls or actions occur.

## Correcting the known missing-country rejection

An existing v2 binding created before this field was introduced may have a
known `identity_country_required` rejection. Its old diagnostic record keeps
only category/status/time, so an operator must correlate the exact attempt
with the provider's validation error before enabling this narrow correction.
Do not use this path for unconfirmed, unrelated or transport-unknown outcomes.

The approved configuration adds an exact binding and recorded diagnostic
failure timestamp; these sample values are synthetic:

```json
{
  "siteId":"synthetic-site",
  "country":"GB",
  "rejectedCreation":{
    "bindingRef":"stripe_synthetic",
    "failureAt":1000,
    "code":"identity_country_required"
  }
}
```

After installing Registry 0.2.8, open Payments and use **Check connection**.
For a recorded TEST creation failure, the page shows **Setup support reference**
with `bindingRef`, the exact numeric epoch-millisecond `failureAt`, category and
bounded HTTP status. It uses the already authenticated status/diagnostics read
and adds no request. With this pending, account-less binding, status and
diagnostics do not contact Stripe. It never shows credentials, provider bodies,
account IDs or headers. Copy only those closed fields into private operator configuration.
Do not substitute the Workbench timestamp or the minute-rounded identity UI.
An unavailable/unobserved/mismatched result has no support reference. The code requires the same site, binding, failure
category `unknown`, HTTP 400, timestamp, existing v2 protocol and previously
recorded platform. The operator's code value attests to the independently
verified provider error; this is not reconstructed from every generic 400.

On the next explicit Setup action, Payments rechecks the actual platform and
current owner/state, saves the country and a `creationCountryRepair` receipt,
and calls the same create API with the same `dinkus-connect:v2:<bindingRef>`
key. It retains the binding, owner, start time, platform scope and conservative
23-hour retry window. It does not reset a generation, create another binding,
or clear the failure to make retry possible. After a successful create, the
normal saved-account path applies; the country-repair receipt is retained.
Legacy v1 unresolved bindings remain blocked. An unstarted v2 operation with
neither persisted scope nor failure can accept country because that path has
not reached its create POST.

[Stripe API v2 idempotency](https://docs.stripe.com/api-v2-overview#idempotency)
defines replay by the same API, account/sandbox, key and a 30-day window, and
re-executes failed work. The
[current idempotency reference](https://docs.stripe.com/api/idempotent_requests)
scopes its cached-error description to API v1. The Accounts v2 create
reference also documents `409 idempotency_error` for changed parameters, so
the documentation does not guarantee that adding country to this rejected
request will be accepted. This correction retains the same v2 operation and
sandbox: it can retry failed work or be refused, but never falls back to a new
key. If Stripe declines the replay, stop and report the result; do not reset
state or change operation identity. Local tests prove our request and state behavior, not Stripe's live
response. The reviewed coordinator rollout performs at most one authorized
retry and inspects the actual result.

## Verification and scope

Synthetic wire tests assert a configured non-US country is serialized with
all retained payment choices. State tests cover absent/malformed/wrong-site
configuration, country changes after unknown outcomes, exact correction
admission, mismatched failure/binding, cross-platform refusal, saved-account
compatibility, and multi-site configuration resolution. Hosted tests exercise
the real Durable Object path for both single-site and multi-site admission.

The initial known-country correction requires explicit operator configuration
and an authorized Setup; no tests or build commands perform that live action.
The old unresolved merchant binding is outside this scoped correction.

The repair receipt is persisted before the corrected create request and consumes that one authorization. If its response fails or is lost, subsequent Setup calls remain in recovery without a second provider create call. A successfully saved account can still resume onboarding.
