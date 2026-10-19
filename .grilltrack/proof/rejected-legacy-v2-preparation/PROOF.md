# Rejected legacy TEST operation: source-only proof

Base: `b92ec308eda74c2dfff8c2deca574bf2e17ff654`.
Scope: one disabled-by-default operator action prepares a v2 operation for a
server-configured rejected legacy binding. No live configuration, deployment,
provider request or recovery execution was performed.

## Behavior

The authenticated, bodyless POST is additionally bound to the deployment's
operator/site, exact binding, original snapshot fingerprint/failure, six-request
rejection attestation, approved country, expected current platform and expiry.
It performs only an identity GET, rechecks the original snapshot transactionally,
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

Final full verification results are recorded below before delivery. The complete
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

Final verification: `bin/verify-payments full` PASS — 270 unit tests, 35 Worker
runtime tests, 26 plugin runtime tests; TypeScript, repository audit, Worker and
plugin builds, plugin validation and built identity checks passed. All runtime
source and test hashes match the final verified clean snapshot. The runtime
logs contain expected synthetic refusal diagnostics; test verdicts are passing.

Review handoff uses the pushed immutable base/head tuple. Comprehensive OpenClaw
and native ClawSweeper results are recorded on the PR and retained in the local
run evidence. Their completion is not implied by this verification record.
