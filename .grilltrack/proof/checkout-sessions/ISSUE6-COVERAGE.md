# Issue 6 expiry coverage

Issue: [payments#6](https://github.com/dinkuskit/payments/issues/6).
Reviewed implementation baseline: `git:920443ed02d1d3afc60cd2aa02882b9097dccc9b`.
This change adds one regression and this evidence file. Production source and
Commerce's exact 1800-second contract are unchanged. The accepted timing P1
remains **required_fix**; no usable live-creation or repaired-P1 claim.

## Audit and added regression

Existing coverage already tests normal explicit expiry/key/account transport,
actual provider timestamp preservation and drift rejection, immutable
canonical retry params, lost response, concurrency, readiness regression,
and paid versus unproved terminal-unpaid classification. Those tests were
not duplicated. Cart/order/stock release authority remains with Commerce.

The missing case was a short remaining deadline through both the actual
checkout service and the official Stripe SDK. One new case in
`tests/stripe-checkout.test.mjs` seeds an immutable stored claim, supplies an
independent synthetic provider clock, and intercepts every HTTP request with
`Stripe.createFetchHttpClient`. Its controlled `Date.now()` sees 1799 seconds
remaining, then zero.

Wire assertions require `expires_at` to be present and equal to the original
stored value. Repeated ensure calls keep the exact serialized body, key and
connected-account header. The mock rejects the short expiry with HTTP400;
the service remains unknown, the stored expiry is unchanged and no session
mapping is invented. An omission trap would return a default24-hour synthetic
session if expiry were absent; the test proves that branch was never taken.

This protects a predecessor lesson rather than alleging that the current
adapter omits expiry. Stripe documents the omitted-expiry default as24 hours:
[Session create API](https://docs.stripe.com/api/checkout/sessions/create).
The test demonstrates intercepted local protocol behavior only.

## Execution and source identity

Implementation and the deterministic-clock fixture correction used native
Cursor ACP, advertised Grok4.6 high, effective approve-all write/exec, exact
isolated owner worktree. Both jobs report completed and cleanupReady. The
parent independently inspected the diff and ran `bin/verify-payments quick`
on Node22.23.2: **44 Node tests passed**, typecheck passed, repository audit
reported `public_repository_contract=clean`. `git diff --check` passed.

Only the added Stripe test changed. The previous3 workerd tests were not
rerun for this test-only patch; their earlier result applies to unchanged
production source, not this new regression. No build or deployment ran.

| File | SHA-256 |
| --- | --- |
| src/checkout/sessions.ts | 92e8b5b484e020ff0f6ce42f59141bf8eb34818705bcea0d17c3844df03de400 |
| src/stripe/checkout.ts | aebd79b922f8efe493d3116b2cebda77f6c6e29c7e8fe5a9e39ff0bafc996dec |
| tests/stripe-checkout.test.mjs | f008cbd756ca0e325a79c38c3a75b88c8daeb6eef114b1214827c01e9581e0a6 |

## Remaining decision

Commerce owns `checkout-payment-window-004` and the provider port. Its
current exact1800 invariant and immutable provider timestamps stay in force.
The prepared30–31-minute proposal is **unapproved**; this test does not adopt
it or qualify creation. Issue6 stays open until the owner-approved compatible
policy is implemented and verified across both repositories. Unknown is not
unpaid/not-created and cannot authorize stock release.

[Refund issue7](https://github.com/dinkuskit/payments/issues/7) remains a
deferred post-purchase decision, not a new launch blocker.
[Commerce issue33](https://github.com/dinkuskit/commerce/issues/33) owns the
contact/delivery contract; Payments will normalize verified provider facts
when that port exists. No refund or customer-policy implementation was added.

No live Stripe, credentials, Commerce/Inventory writes, review dispatch,
customer notifications, merge, release or deployment. Frozen timing proposal
files and the original source proof were not changed or included in this
regression publication. Native job receipts and raw parent output stay in
the ignored issue6 run packet; no private routing metadata is published.
