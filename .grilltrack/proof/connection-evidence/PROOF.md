# Provider connection evidence proof

Base: `260c0a6b4a058971bd1173321b7feed1aea35537`.
Decision: `payments-connection-evidence-030`, dependent on028/029.

`GET /v1/status` adds provider/mode/result/account reference evidence from the
existing Stripe lookup. Exact returned account match is required. Authorize.net
configured binding remains unsupported for verification, while legacy TEST
admission is preserved. No overall selling readiness or Commerce order proof is
claimed. Connect payloads retain their legacy shape, including the failed-create
race path. The decoder preserves absent legacy evidence and rejects contradictory
mode, account, provider and result combinations.

## Verification

On Node22.23.2, `bin/verify-payments full` passed: 123 Node tests, 16 hosted
runtime tests and 3 Registry runtime tests; both typechecks, repository audit,
Worker dry-run build, plugin validation/build passed. `git diff --check` and
GrillTrack validation passed. Tests use synthetic identities and mocked provider
responses; no provider calls or deployment occurred. No UI changed, so browser
proof is not applicable.

ACP produced the bounded implementation; independent parent inspection fixed a
connect error-path compatibility gap and rejected impossible Stripe decoder
results, then ran the complete verification. The initial worker runtime startup
failure was resolved with dependency installation under the pinned Node runtime.

PR23 consumer compatibility was inspected at immutable commit
`3d3cc03cd68b5870c60c34b1366c0818bef5940e`: `src/client/payments-client.mjs`
`assertStatus` checks required fields without rejecting additional keys and
`status()` returns the full response. No CLI files were modified.

## Limits

This proves the backend projection and decoder, not Registry service connection,
provider traffic, live readiness or a Commerce TEST order. Authorize.net
readiness verification remains unsupported. Decisions028/029 are not claimed
fully implemented. Canonical and native reviews must cover the final PR tuple
before the separate maintainer merge gate.
