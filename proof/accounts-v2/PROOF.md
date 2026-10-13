# Accounts v2 migration proof

Base: e91b6d64c768cae42cfb18cb16f1e18c5d96e174.
Candidate: Registry0.2.7 and corresponding hosted Worker, not deployed by this lane.

The owner approved the bounded Accounts v2 migration and official Stripe skills.
Full Dashboard, Stripe fee collection/negative balance liability, direct charges,
existing IDs, hosted onboarding and the payment/Commerce contract stay fixed.
Skill provenance and intentional scope precedence are documented in
`docs/accounts-v2-migration.md` and `skill-provenance.json`.

The wire tests verify API Endive v2 JSON creation/read/link requests, no legacy
account-type parameter, no invented customer/recipient/person data, capability
and requirement readiness, timestamp expiry and strict v2 Stripe URL handling.
Checkout has an explicit regression for its unchanged Dahlia API/card contract.

Recovery tests prove no provider I/O for unresolved legacy operations,
platform-bound v2 retries, preservation of existing saved IDs, and owner-change
fences before and after creation. All fixtures are synthetic and provider calls
are injected; no real credentials or provider data are used.

The compiled Registry setup-budget regression uses a v2 hosted URL, checks the
verified link survives, and retains exactly ten bridge calls. Existing rejection,
expiry, status and payment-runtime tests remain required.

Live onboarding/E2E is a coordinator/browser rollout gate, not a local proof
claim. No account policy, provider, deployment, publication or merge action was
performed by the source worker. Existing unknown creation outcomes require
explicit reconciliation and never auto-migrate to a fresh API operation.

Local final verification: `npm run verify:full` passed with 211 unit tests,
31 hosted runtime tests and 20 compiled Registry tests. Typecheck, public
repository audit, Worker dry-run build, plugin validation and build passed.
Node: 22.23.2. No provider requests or deployment were performed.
