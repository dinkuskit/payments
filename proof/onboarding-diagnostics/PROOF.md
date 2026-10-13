# Onboarding diagnostics source proof

Base: `c1ee16de2e3a00e3a3b6e78943106f3ad96a53ae`.
Branch: `codex/payments-onboarding-diagnostics-20261013`.
Design: [DESIGN.md](DESIGN.md).

This is a bounded repair of the existing hosted connection/onboarding behavior.
CLI-filtered GrillTrack reads confirmed the existing merchant-hosted-service-003,
merchant-stripe-onboarding-002 and connection-evidence-030 decisions; their current
status is needs_reverification. The explicit assigned source repair does not
reopen provider selection, pricing or account ownership, and claims no live
reverification. No ledger mutation was made.

The new local diagnostic stores only category/status/timestamp after the existing
account-create catch. It preserves the original owner, binding and startedAt;
success clears the failure. GET diagnostics validates ownership without calling
the legacy normalization writer or any provider operation. Registry diagnostics
are independently decoded and never replace the strict status response. Old
hosts and malformed diagnostics remain unobserved, while authenticated connecting
and recovery wording no longer describes the DinkusKit grant as missing.

Refinement: error classification uses actual Stripe error subclasses and an
explicit structured platform_account_required code. It never parses free-text
messages to guess a platform diagnosis. Arbitrary thrown values become observed
unknown; historic records without a captured exception remain unobserved.

Verification uses only synthetic fixtures and offline-cached dependencies with
Node 22.23.2. Full command output is retained in private operator evidence.
No production/provider/browser/network/credential action was performed.

## Results

- `npm exec --offline --yes --package=node@22.23.2 -- npm ci --offline`: passed from local cache.
- Pinned Node `bin/verify-payments full`: passed, including 197 unit tests, 29 Workers runtime tests, 9 official compiled-runtime tests, typecheck, repository audit, Worker dry-run build and Registry validation/build.
- Final targeted Workers run (`vitest run tests/runtime/connection.test.ts tests/runtime/merchant-http.test.ts`): 6 tests passed, including the additional durable restart and signed diagnostics HTTP assertions.
- Compiled Registry tests prove connecting/recovery wording, observed failure, 404 and invalid diagnostic fallback, and no implicit connect POST. Existing legacy status/connect tests remain passing.

External log hashes (SHA-256):

- `verification.log`: `dbec3eb2de84680609458c6a784a1aabba4b1292b726031509857d2a74f6e54c` (102305 bytes).
- `runtime-final.log`: `663fe566d2f535ccbe142bb8446e1a5b23a5b2211cec2b141f202bdbcbaa5bdc` (39992 bytes).

These are synthetic source/runtime proofs, not production deployment or provider evidence. No historical swallowed error can be reconstructed. Registry 0.2.2 and hosted source are prepared only; rollout and any new same-binding provider attempt remain owner-gated.
