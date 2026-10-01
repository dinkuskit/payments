# Checkout expiry decision proposal

Status: **WAITING_FOR_HUMAN — proposed, not approved or implemented.**
Prepared 2026-09-30 for the Commerce decision owner and Payments source owner.
No live Stripe request ran. Existing Payments #5 remains unqualified for
executable Checkout Session creation. This packet does not resolve its P1.

## Exact source and finding

- Payments [draft #5](https://github.com/dinkuskit/payments/pull/5):
  `920443ed02d1d3afc60cd2aa02882b9097dccc9b`, base
  `63d6f80e172f822bdf09ca0dc7cef9e0b420d073`.
- Commerce [#31](https://github.com/dinkuskit/commerce/pull/31):
  `791882e5c44069810de9017fca48383886e5a606`, inspected read-only.
- Accepted formal finding: **P1 / required_fix**. Payments pins
  `floor(claimedAtMs / 1000) + 1800` before transport, then retries the
  same parameters. A later provider creation can make that expiry invalid.
  Fail-closed `unknown` is safety evidence, not successful creation evidence.

The prior local acceptance classified timing as deferred. The later formal
review supersedes that disposition with a required fix. The old tests remain
useful for durability, identity and reconciliation; they did not prove
Stripe expiry feasibility.

## Provider constraints and incompatibility

Stripe's [Session create API](https://docs.stripe.com/api/checkout/sessions/create)
documents an absolute `expires_at`, allowed from 30 minutes through 24 hours
after provider creation; omission defaults to 24 hours. Installed SDK 22.6.2
has the same limit and no relative expiry-duration create parameter.
The [Session update API](https://docs.stripe.com/api/checkout/sessions/update)
and installed `SessionUpdateParams` do not offer an expiry update.

The [limited-inventory guide](https://docs.stripe.com/payments/checkout/managing-limited-inventory)
describes the lower limit relative to current time. This proposal uses the
stricter creation-relative API/SDK wording; it does not assume a request
receipt timestamp equals the returned provider creation timestamp.

Let C be the claim second, P the provider creation second and E the pinned
expiry. The present request chooses E=C+1800. Stripe's documented minimum
requires E>=P+1800. If P=C+1, the requested duration is 1799 seconds.
Commerce also requires E=P+1800 exactly (`orchestrate.ts:105`). One expiry
chosen before P cannot meet that equality for two different possible P
values. No documented API mechanism inspected supplies the required relative
duration or permits a subsequent expiry correction.

## Recommended bounded change

Ask Bobby to approve **a provider-reported 30–31 minute session window**, with
the actual provider creation and expiry timestamps preserved. Sixty seconds
is a proposed product allowance, not a proven network latency bound or SLO.

Proposed Commerce-owned request shape (illustrative, not production code):

```ts
// Replace paymentWindowSeconds: 1800 with an explicit bounded policy.
paymentWindow: { minSeconds: 1800; maxSeconds: 1860 };
```

The corresponding outcome validation would require safe integer provider
timestamps and `1800 <= expiresAt - createdAt <= 1860`. It would still compare
session ID, redirect URL and both timestamps by value on every subsequent
outcome. Prices, binding, attempt identity, card-only USD and existing terminal
outcome checks remain authoritative.

Payments would persist `requestedExpiresAtSeconds=C+1860` with the entire
original create request and idempotency key before provider contact. It would
report only the returned provider timestamps, enforce the approved bounds
and exact requested expiry, and never manufacture `createdAt` or extend E.
For P in [C,C+60], the resulting duration lies in [1800,1860]. A successful
create could therefore be accepted without pretending the duration is exact.

## Retry, uncertainty and stock impact

- Keep one durable claim, exact parameters and one key per attempt. No reset
  of the deadline, replacement session, processor fallback or new key on retry.
- Stripe's [idempotency contract](https://docs.stripe.com/api/idempotent_requests)
  replays the first executed result with the same key and parameters. A
  validation failure is not a saved execution. Keys can be pruned after at
  least 24 hours. Preserve the current conservative 23-hour retry ceiling.
- A lost response after a successful creation can recover the original
  session within retention. A delayed first execution after C+60 can still
  fail the minimum. Replaying it cannot make the pinned expiry valid.
  Changing the retry deadline would violate the attempt invariant.
- The 10-second client timeout does not bound when Stripe executes a request.
  Clock skew also matters: P<C can yield a duration above 1860; that must be
  rejected without rewriting provider time. No arbitrary-delay or arbitrary-
  clock guarantee is claimed.
- Mapping-known reconciliation continues with authoritative reads and the
  original session fields, even after merchant readiness regresses. Lookup
  must never create. Missing mapping or an aged unacknowledged create stays
  `unknown`; elapsed time cannot establish `not-created` or unpaid.
- Commerce reserves managed stock before requesting payment. Confirmed
  expired-unpaid releases the reservation; confirmed payment retains it for
  the order. A timer or `unknown` must not release stock. The proposed window
  adds at most 60 seconds to the accepted provider duration; uncertainty can
  hold stock much longer, including indefinitely with current recovery rules.
  The proposal does not add an automatic hold timeout or a manual recovery
  authority. Bobby must accept that remaining limitation or request a separate
  recovery decision before qualification.
- Redirect suppression uses the real provider expiry. A local 30-minute timer
  cannot pretend the provider session is expired while it remains payable.
  The shopper is not guaranteed 30 minutes remaining after a delayed redirect.

## Rejected alternative

Create a sufficiently long session, then set expiry to `provider.created+1800`
before exposing its URL. This would preserve the current exact-duration
contract, but the documented update API and installed SDK do not support it.
The separate [expire API](https://docs.stripe.com/api/checkout/sessions/expire)
expires an open session at invocation; it is not a scheduled timestamp update.
Using a local alarm would add delivery/recovery and payment-race policy,
without proving exact provider expiry. Do not adopt it in this bounded slice.

Also reject rewriting `createdAt=expiresAt-1800`, omitting expiry and accepting
the 24-hour default, or sending changed parameters/new keys on retry. These
would hide provider truth or change locked duration/operation ownership.

## Exact decision and source ownership

| Owner | Affected decision/source | Proposed responsibility after approval |
| --- | --- | --- |
| Bobby / Commerce decision owner | `checkout-payment-window-004` | Explicitly replace exact 30 minutes with provider-reported 1800..1860 seconds; record the unresolved unknown/hold risk through GrillTrack. |
| Commerce source owner | `src/features/checkout/types.ts` (`PaymentRequest`), `orchestrate.ts` request construction and `validateOutcome`, checkout experience docs/tests | Own the bounded policy and its equality/reconciliation tests. Preserve `checkout-stock-hold-003` and `checkout-hosted-first-002`; do not add local-time stock release. |
| Payments source owner | `payments-checkout-sessions-001`; `src/commerce/checkout-port.ts`, `src/checkout/sessions.ts`, Stripe transport assertions, runtime tests and docs | Consume the newly approved Commerce port; pin claim+1860; validate actual bounds and immutable fields. Update proof through ACP only after the port/decision owner resolves the lock. |
| Inventory source owner | Existing reservation/release port | No change proposed. Commerce remains release authority; no inventory TTL or stock ledger change. |
| Coordinator / fresh independent review owner | Existing Payments #5 accepted P1 | Route exact-source review after any approved implementation and new proof. This packet does not dispatch a review or involve the rail-repair chat. |

Commerce's ledger is read-only in this lane. Its window decision depends on
stock-hold; stock-hold depends on hosted-first. Payments cannot approve or
silently supersede any of them. No dependent source implementation, push,
deployment or merge is part of this preparation.

## Synthetic evidence and next gate

Run from the Payments worktree on Node 22.23.2:

```sh
node --import tsx --test .grilltrack/proof/checkout-sessions/timing-feasibility.test.mjs
```

Seven checks pass. The first two exercise the unchanged actual Payments
service against a fake processor with an independent clock: aligned creation
opens; a one-second delayed creation and later retry remain unknown, identical
parameters, zero successful operations. The other checks exercise the proposed
protocol only, not an implemented Commerce or Payments contract.

| Provider creation delay from claim | Proposed duration | Proposed bounds | Current Commerce exact 1800 |
| --- | --- | --- | --- |
| 0 s | 1860 s | Accept | Reject |
| 1 s | 1859 s | Accept | Reject |
| 10 s | 1850 s | Accept | Reject |
| 30 s | 1830 s | Accept | Reject |
| 59 s | 1801 s | Accept | Reject |
| 60 s | 1800 s | Accept | Accept |
| 61 s | 1799 s | Processor rejects | Unusable |

Additional checks prove synthetic cached recovery after a lost response uses
one original operation and unchanged tuple; changed parameters fail; a
1861-second duration or malformed/subminimum pair is rejected. The processor
model encodes documented constraints and replay semantics. It neither measures
actual Stripe behavior nor supplies provider acceptance evidence.

Proof identity and results: `../.grilltrack/proof/checkout-sessions/TIMING-PROOF.md`.
Next gate: coordinator presents this exact change and remaining hold risk to
Bobby. If approved, the Commerce owner records/revises the decision and port,
then Payments implements against that exact identity via ACP. A fresh review
must adjudicate the P1; actual Stripe qualification needs separate explicit
authorization. Until then, keep #5 draft/unqualified and do not enable its
executable creation path. No runtime disable switch was implemented here.
