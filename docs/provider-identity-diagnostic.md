# Optional TEST platform identity diagnostic

This diagnostic is an explicit operator action for investigating a missing
provider request. It does not create an account, resume onboarding, repair a
binding or prove what happened during an earlier request.

The deployed consumer uses its existing Stripe credential to retrieve the
current platform account and compares the returned ID internally to the
deployment-owned expected account. Only a match/mismatch/unconfirmed result,
validated test-prefix flag, bounded HTTP status and time may leave the consumer.
Account IDs, credentials, request IDs, headers, raw responses and errors do not.

## Admission and deployment

Existing signed `payments:admin` authentication and stored account/site
ownership are mandatory. A deployment-owned exact operator account and site
allowlist further restrict the action. A store administrator is not implicitly
a platform operator. Missing or invalid configuration disables the diagnostic
before provider I/O; it does not alter existing setup or status actions.

The optional bindings are `STRIPE_DIAGNOSTIC_OPERATOR_ACCOUNT` (the exact
canonical JSON account identity), `STRIPE_DIAGNOSTIC_OPERATOR_SITE`, and
`STRIPE_DIAGNOSTIC_EXPECTED_ACCOUNT`. The issuer must match `ACCOUNT_ISSUER`.
All configuration values must be provided outside this public repository.
Examples and tests use synthetic values. Preparing this code does not authorize
configuration, deployment, package publication or a live diagnostic request.

## Behavior

The action is manual and distinct from Check connection. It permits only the
fixed TEST `GET /v1/account` using the same deployed credential as onboarding,
without a connected-account override. It makes at most one actual provider
request, including on closed connections, and writes no persisted state.
The existing failure timestamp/category/HTTP status remain historical evidence
and are not cleared or replaced by this diagnostic.

A current match confirms the configured credential belongs to the expected
platform at observation time. It does not establish a historical request's
destination or prove that no account was created. An unconfirmed result does
not authorize a setup retry.

## Acquiring configuration for an approved deployment

The operator site ID comes from the existing Registry receipt or approved
site metadata. The operator subject must come from the account service's
normal authenticated account/profile metadata and its documented subject
identity contract. Do not decode a session token or infer the subject from an
email address, display name or browser URL. If the normal metadata does not
expose the stable subject, ask the account-service owner for an approved
metadata path before configuring this feature. Canonical account identity
uses the verified issuer and subject representation accepted by Payments.

The expected Stripe platform identity comes from its normal approved account
settings metadata. The deployment operator supplies these values directly to
the runtime configuration through the approved configuration workflow; do not
copy actual values to a public commit, PR, screenshot or proof packet. The
review handoff records only whether configuration has been approved/applied.
