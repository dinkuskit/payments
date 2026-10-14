# Explicit TEST merchant country

Base:647230a75047f2c6eb99c650852661d0fa12ac30.

A provider-observed HTTP400 `identity_country_required` identified the missing
country before merchant configuration. The source now accepts an explicitly
configured country for one authenticated TEST site, snapshots it into the
creation operation, and serializes `identity.country`. It adds no inferred
country or universal default. Other merchant identity fields remain hosted.

The exact legacy country-validation correction requires operator configuration
matching the stored binding/failure time, and then rechecks owner/site/platform
before saving country. It preserves binding/idempotency/start time, records a
repair receipt, and never falls back to a new key. Unconfirmed and mismatched
old operations stay blocked; a provider409 remains a failure with the same key.

Wire tests verify non-US serialization and unchanged payment ownership.
State tests cover missing/wrong-site configuration, immutable country, exact
known-failure admission, unknown and mismatched refusals, platform changes,
409 preservation, consumed-repair refusal after interruption or unknown outcome, concurrent repair exclusion, and saved-account behavior. A real Durable Object test checks
same-key serialization, persistence and eviction. All inputs are synthetic.

References:
- https://docs.stripe.com/api/v2/core/accounts/create
- https://docs.stripe.com/api-v2-overview#idempotency
- https://docs.stripe.com/api/idempotent_requests

The create reference documents country-required400 and changed-parameter409.
The v2 reference describes safe same-key replay within the same API/sandbox;
it does not guarantee acceptance of every changed payload. An eventual
operator-controlled retry must inspect the actual result and stop on refusal.
No live provider call, deployment, Registry publication or account mutation
was performed by this source lane.

Local validation: `npm run verify:full` passed221 unit,32 hosted runtime and
21 compiled Registry tests. Typechecks and public repository audit passed.
The compiled support-reference test proves exact fields, no extra requests or
state mutation, and refusal for another admin flow. Registry0.2.8 is required
for this owner-visible support output; country itself remains host-configured.

Review adjudication: accepted P2 (old-head OpenClaw request req-20261014T001447Z-267897328663). A persisted repair receipt now consumes the one authorized replay before provider I/O; an account-less consumed repair reports recovery and cannot issue another create. This also covers a lost response or concurrent Setup.
