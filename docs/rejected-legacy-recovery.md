# Preparing v2 after a rejected legacy TEST operation

This operator action prepares one new Accounts-v2 operation on an existing
binding. It does not create an account, create an onboarding link, run checkout,
or retry the rejected Accounts-v1 request. Ordinary merchant setup never runs
this transition automatically. The separate recovery-evidence API is deferred.

## Admission

The action is disabled unless the deployment supplies
`STRIPE_TEST_LEGACY_V2_RECOVERY`. It reuses the exact
`STRIPE_DIAGNOSTIC_OPERATOR_ACCOUNT`, `STRIPE_DIAGNOSTIC_OPERATOR_SITE` and
`STRIPE_DIAGNOSTIC_EXPECTED_ACCOUNT` identity controls. Existing signed
`payments:admin` authentication and stored owner/site equality are required.
These controls are deployment-owned; a request cannot select them.

The single policy has this shape (all values below are synthetic):

```json
{
  "operationId": "approved-recovery-example",
  "siteId": "synthetic-site",
  "bindingRef": "stripe_synthetic",
  "expectedStartedAt": 1800000000000,
  "failureAt": 1800000001000,
  "expectedFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "evidenceSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "rejection": "accounts_v1_unsupported",
  "rejectedRequestCount": 6,
  "country": "US",
  "expiresAt": 1800000002000
}
```

Before configuration is approved, the owner must correlate the six known
creation requests with the exact binding and their terminal Accounts-v1
validation rejection. The policy is an operator attestation, not a claim that
this endpoint independently queries Stripe history. Keep the private evidence
outside this public repository. Its digest and count are retained in the
reconciliation record. A generic HTTP 400, empty account list or unmatched
request does not qualify.

`expectedFingerprint` is `legacyStateFingerprint` of the parsed current
connection, including its original owner, times and failure. Obtain it inside
an approved service-owner inspection; do not dump storage, read credentials or
add a generic storage endpoint. The current record must remain unchanged until
the operation commits. The admission expires and must be no more than 24 hours
in the future when invoked. Changing the operation ID never resets a prepared
operation.

The existing approved merchant-country configuration must select the same site
and country. Missing or conflicting country, identity or policy configuration
refuses the action. No fallback selects another platform or site.

## Request and result

An approved owner consumer sends **POST
`https://payments.dinkuskit.com/v1/connect/reconcile-legacy-rejection`**, with the
existing owner authentication and exact `X-Dinkus-Site`. No query or request
body is accepted. Credentials stay within that consumer. This document does
not authorize a new credential consumer, selector or login mode.

The service checks TEST/Stripe mode, the exact expired legacy record and absent
processor account, and performs one current-platform identity GET. A mismatch
or unconfirmed identity leaves state unchanged. After that read, the service
compares the entire original snapshot again in its storage transaction.

On success it retains the original connection under protected
`legacyRecovery.previous`, retains the evidence digest and count, and prepares
one v2 operation with a new start time, operation identity, verified platform
scope and approved country. The old failure remains in that historical record;
it is not an active failure of the new operation. Owner, site and binding stay
the same. The response contains only:

```json
{
  "state": "prepared",
  "mode": "test",
  "bindingRef": "stripe_synthetic",
  "operationId": "approved-recovery-example",
  "preparedAt": 1800000001500
}
```

Repeating the same approved operation returns the original receipt without
writing or contacting Stripe again. A different operation cannot replace it.
Existing diagnostics and Registry response schemas do not gain fields.

## Separate runtime gates

Source review and tests do not authorize configuration, deployment or use.
Before a live invocation, independently verify the active Worker source and
namespace, intended Sandbox/platform and exact stored record. Confirm no
unfenced old Worker can still write a creation result. The new code checks
operation identity on async result writes, but cannot retroactively change an
already running older executable. Keep the source and operator policy bound
to the reviewed scope; do not change shared keys or unrelated settings.

After the preparation receipt is verified, **a separate explicit Setup action**
may create the v2 account through the existing path and v2 idempotency key.
Preparation never invokes that path. The 23-hour window starts once for the new
operation, and failed/unknown results do not authorize another transition.

No rollback/reset endpoint is included. Before any v2 create, a separately
reviewed compensation would require the exact prepared snapshot and preserved
history. After a create was attempted or its outcome is unknown, retain the
operation and reconcile it; do not restore the old state, replay, delete an
account or change the clock.

## Verification

The synthetic unit and Durable Object tests cover preserved history, no account
or link calls, owner/site and policy rejection, platform failure, stale state,
concurrent preparation, same-operation replay and late old-operation results.
They do not establish live platform identity, provider request history,
deployment identity or old-executable quiescence. Those remain runtime gates.
