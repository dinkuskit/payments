# Timing feasibility proof

Status: accepted P1 remains **required_fix**; owner decision proposal only.

Payments #5 source: `git:920443ed02d1d3afc60cd2aa02882b9097dccc9b`.
Commerce #31 source: `git:791882e5c44069810de9017fca48383886e5a606`.
No production source or existing test changed. No commit or push was made.
Hash manifest: `timing-identity.json`.

## Formal finding adjudication

Accepted: pre-request absolute expiry has no delay headroom and can fall below
Stripe's minimum. The exact current Commerce outcome invariant prevents
accepting a longer provider duration. Classified **required_fix**, superseding
the earlier local timing deferral. No clean-review or repaired-P1 claim.

Rejected: treating fail-closed unknown as usable creation proof; deriving a
provider creation timestamp from local expiry; assuming the client timeout
bounds remote execution; changing the pinned parameters/key on retry.

## Executed proof

Node 22.23.2:
`node --import tsx --test .grilltrack/proof/checkout-sessions/timing-feasibility.test.mjs`
Result: 7 passed, 0 failed, exit 0.
Raw output: `.grilltrack/work/checkout-sessions-20260930/timing-feasibility.log`.

The current service is actually imported for the aligned-clock control and
P1 reproduction. Its delayed first create at claim+1 returns unknown; a retry
at claim+11 returns unknown with identical parameters and zero successful
processor operations. Production transport is replaced with an independent
synthetic provider clock and documented minimum-expiry validation.

The candidate protocol model pins claim+1860, preserving actual provider
timestamps. It succeeds synthetically at delays 0/1/10/30/59/60 seconds, with
durations 1860/1859/1850/1830/1801/1800. The current Commerce equality predicate
is represented in the model from the pinned source; Commerce was not executed
or edited. Only delay60 also satisfies the present exact1800 contract.

A first execution at61 seconds fails. Cached replay after a lost successful
response recovers one operation at180 seconds without moving expiry. A
changed request under the executed key fails. A duration1861, subminimum
duration or noninteger creation time fails the candidate bounds.

These tests encode protocol constraints; they do not demonstrate actual
Stripe acceptance, latency, time alignment or a deployed integration.
Official references and the recommended/rejected strategy are in
`docs/checkout-timing-decision.md`. Stripe22.6.2 installed types were inspected
read-only: no relative create expiry and no update expiry parameter.

## Scope and remaining gate

The proposed 1800..1860 policy is not locked. Commerce owns the decision and
port. Payments owns the later adapter repair. Unknown stock holds, actual
provider qualification and the Commerce wake consumer remain unresolved.
No live traffic, credentials, Commerce/Inventory writes, runtime gate, review
dispatch, deployment or merge. Existing ACP implementation/repair jobs both
report completed/cleanupReady; no new job was launched for this preparation.
Next: coordinator presents the concrete proposal and hold risk to Bobby.

## Packet checks

Repository audit: `public_repository_contract=clean`, exit0.
`git diff --check`: exit0. GrillTrack CLI validation: exit0.
Hash manifest matches all listed files. Payments production source and
existing tests match the exact reviewed Git head. Ledger now records
`payments-checkout-sessions-001` as `needs_reverification` / `required_fix`
and `payments-checkout-window-proposal-002` as `proposed`. No choice locked.
