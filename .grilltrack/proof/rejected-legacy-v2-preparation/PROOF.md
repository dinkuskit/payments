# Rejected legacy TEST operation: source-only proof

Base: `b92ec308eda74c2dfff8c2deca574bf2e17ff654`.
Scope: one disabled-by-default operator action prepares a v2 operation for a
server-configured rejected legacy binding. No live configuration, deployment,
provider request or recovery execution was performed.

## Behavior

The authenticated, bodyless POST is additionally bound to the deployment's
operator/site, exact binding, original start and failure, six-request
rejection attestation, approved country, expected current platform and expiry.
It captures its audit digest internally, performs only an identity GET, rechecks the complete original snapshot transactionally,
preserves the original record and evidence digest, and returns a prepared receipt.
It never calls account creation or link creation. Subsequent normal setup is a
separate action. Duplicate preparation cannot restart the operation's clock.
The existing diagnostics response shape is unchanged.

## Verification

The six initial regression tests failed on the base because the capability did
not exist, then passed with the implementation. Focused tests cover single-use
preparation, explicit later setup, principal/policy/evidence/snapshot denials,
platform failure, concurrency, restart replay and late old-operation callbacks.
A real workerd Durable Object test verifies the actual Worker wiring, one fixed
identity GET, protected stored history, no account creation, denied other
principals and stable replay. HTTP tests cover admin scope and rejection of body,
query, anonymous and playground requests.

The initial head was reviewed clean by OpenClaw and native ClawSweeper. The completed operator path below passed full verification and is submitted for fresh exact-head reviews. The complete
source is verified in a clean temporary snapshot because the repository audit
intentionally rejects local `runs/` evidence directories; that rule was not changed.

## Remaining gates

The evidence digest is a trusted operator attestation, not an automated Stripe
history search. A separately approved live operation must verify active source,
original stored snapshot, intended Sandbox and country, and absence of unfenced
old executables. Tests protect the current code's async writes; they do not alter
an older deployed executable. No production or browser evidence is claimed.

Merge, deployment, policy configuration, transition invocation and any later
account-creation action remain separate owner decisions. No generic reset,
rollback, storage API or deferred read-only recovery endpoint was added.

Final verification: `bin/verify-payments full` PASS — 274 unit tests, 36 Worker
runtime tests, 27 plugin runtime tests; TypeScript, repository audit, Worker and
plugin builds, plugin validation and built identity checks passed. All runtime
source and test hashes match the final verified clean snapshot. The runtime
logs contain expected synthetic refusal diagnostics; test verdicts are passing.

Review handoff uses the pushed immutable base/head tuple. Comprehensive OpenClaw
and native ClawSweeper results are recorded on the PR and retained in the local
run evidence. Their completion is not implied by this verification record.

## Operator-path completion

The source-scope adjudication replaces the unavailable external fingerprint
prerequisite with internal capture of the full matching record and an audit
digest, preserving all exact target/attempt predicates and transaction/race
checks. Pre-invocation admission now matches those predicates rather than a
previously exported byte snapshot; unrelated fields present at invocation are
preserved. Any field drift during platform I/O refuses the write. No fingerprint
or generic storage endpoint was added.

The existing Registry-held session consumer now has an explicit review/confirm
preparation action and a separate prepared result. It sends only the fixed
bodyless/queryless POST, rechecks the admin/session/site/subject and shows no
credential. No automatic Setup follows. Tests compose the production plugin
route with the signed hosted handler and a real Durable Object; a separate
compiled plugin test covers EmDash dispatcher, HTTP and encrypted settings
bridges. These are synthetic tests, not installed live-store or provider proof.

The final operator-path full verification also passed TypeScript, repository
audit, Worker/plugin builds, plugin validation and build identity checks. Runtime
source and tests match the verified clean snapshot. The new real-DO composition
checks the fixed preparation POST, original-history preservation, stable replay,
wrong-admin and expired-session refusal. The compiled EmDash test checks the
confirmation, encrypted-session consumer, bounded reply and zero implicit Setup.

## Exact-source review and CI test isolation

Feature source `5cea218f2bf835bd6cd4c193017a43c1f2050a75` received clean
comprehensive P3 OpenClaw review (request
`req-20261019T193839Z-397297512958`) and native ClawSweeper high-confidence
ready review (run `39312683393`, comment `6275519938`). These reviews do not
claim that the old head's CI was green: its public-contract run `39312624496`
exposed a six-scenario existing compiled test exceeding its shared five-second
timeout, then leaking mock timing into two following cases. The test-only
follow-up splits those scenarios into independent tests with identical
assertions and the unchanged default per-test timeout. All 32 compiled tests
then passed locally. The production source is unchanged from the reviewed
feature head; the final commit receives its own CI and exact-head reviews.
