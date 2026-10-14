# Explicit country for a TEST merchant

Accounts v2 requires `identity.country` before `configuration.merchant`.
Payments therefore takes country from one explicit, operator-approved TEST
site configuration. It never derives it from IP, shipping, email, currency,
platform country or a browser-supplied field. This is a bounded TEST fixture
path, not general merchant-country collection for a production rollout.

## Configuration

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
Registry0.2.8 adds only the owner-visible support reference needed to identify
an existing rejected attempt without extracting credentials or raw responses.

The country is persisted in `creationCountry` before the create POST. A later
configuration change cannot change that operation's country. Missing later
configuration does not erase the saved country. Account creation serializes
`identity: { country }`; Dashboard access, fee/loss responsibility, direct
charges and the absence of a forced default currency remain unchanged.

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

After installing Registry0.2.8, open Payments and use **Check connection**.
For a recorded TEST creation failure, the page shows **Setup support reference**
with `bindingRef`, the exact numeric epoch-millisecond `failureAt`, category and
bounded HTTP status. It uses the already authenticated status/diagnostics read
and adds no request. With this pending, account-less binding, status and
diagnostics do not contact Stripe. It never shows credentials, provider bodies,
account IDs or headers. Copy only those closed fields into private operator configuration.
Do not substitute the Workbench timestamp or the minute-rounded identity UI.
An unavailable/unobserved/mismatched result has no support reference. The code requires the same site, binding, failure
category `unknown`, HTTP400, timestamp, existing v2 protocol and previously
recorded platform. The operator's code value attests to the independently
verified provider error; this is not reconstructed from every generic400.

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
defines replay by the same API, account/sandbox, key and a30-day window, and
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
admission, mismatched failure/binding, cross-platform refusal, and saved-account
compatibility. Hosted tests exercise the real Durable Object path.

The initial known-country correction requires explicit operator configuration
and an authorized Setup; no tests or build commands perform that live action.
The old unresolved merchant binding is outside this scoped correction.
