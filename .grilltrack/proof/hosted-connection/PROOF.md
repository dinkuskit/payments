# Hosted Payments connection proof

## Source

Repository: dinkuskit/payments. Branch: codex/merchant-stripe-onboarding.
Base: 28b7773443e9bee0d9f56da2035eae1063681a4d.
Candidate identity: sha256:a5a2c85977cb23abdb93369c9a8cbbbd450b82d9961d51ae655e1d582597a61c (digest of source-sha256.txt).
Local verification snapshot preceding authorized draft-PR publication. No deployment.

## Implemented slice

- Verified shared-account token boundary with separate admin and checkout scopes.
- SQLite Durable Object storing one immutable merchant/store/Stripe binding.
- Stripe SDK Accounts v1 Standard creation with a stable idempotency identity.
- Resumable onboarding links and authoritative readiness without redirect-success assumptions.
- Exact-binding gate for NEW checkout; account changes and unknown status fail closed.
- Test-only Worker, empty identity/return configuration, and no deployment routes.

## Commands and results

Runtime: installed Node 22.23.2, as pinned in .nvmrc.

`bin/verify-payments full`: exit 0.

- Node tests: 12 passed, 0 failed.
- TypeScript: passed.
- Repository contract: clean.
- Cloudflare Vitest: 2 passed, 0 errors. A real local SQLite Durable Object
  was evicted and resumed with the same binding; no second account creation.
- Wrangler offline build: exit 0, --dry-run only, no deployment.
- Dependency audit after replacing the obsolete test package: zero reported
  vulnerabilities.
- `git diff --check`: passed.

Raw local output: .grilltrack/work/merchant-onboarding/verification.log and
dependency-audit-final.json. Tests intercept Stripe transport and use synthetic
signed identities. They do not contact Stripe or a live account issuer.

## Failures resolved and fidelity limits

The initial Node runtime bundled with another application could not load a
native test dependency; the repository-pinned installed Node runtime passed.
The first TypeScript run caught the reserved Durable Object connect method;
the RPC was renamed startOnboarding. The current Cloudflare test wrapper
reported an expected rejected RPC as an unhandled error; the ownership-denial
assertion now catches it inside the object while still invoking the actual
class method. The passing runtime run has no unhandled errors.

Stripe's package emits missing-source sourcemap warnings during local runtime
tests. Those warnings do not hide a test failure and remain in the raw log.

## Remaining acceptance

The first backend slice is tested. The full merchant experience is incomplete:
no registry plugin/admin client, shared account sign-in service or callback
pages, checkout-session adapter, webhooks, real Stripe test proof, or live
activation is claimed. The existing Commerce and Inventory workers retain
their own source ownership; this branch changed no files in those repos.

The fixed binding tuple is for the future Payments adapter. New-checkout
readiness must not block reconciliation of old attempts; the adapter must
retain and query their original recipient even after readiness regresses.

## Review and delivery

Official review has not run. No authoritative review enrollment/capability
source was available through the current tool inventory; no fallback review
was dispatched. The review-routing skill requires verified routing before
review. This is not a clean review or a complete GrillTrack closeout.
The owner subsequently authorized committing, pushing, and opening a draft PR
with review deferred while the review rails are repaired. No merge, deployment,
or live account mutation is authorized by that publication request.
