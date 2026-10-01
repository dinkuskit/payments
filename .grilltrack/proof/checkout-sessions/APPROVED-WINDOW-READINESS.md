# Approved payment window: adapter readiness

Status: **policy approved; dependent implementation waits for an immutable Commerce contract pin**.

## Exact ownership and starting state

Payments: sole source owner, branch `codex/payments-checkout-sessions-20260930`,
PR5 head `e401e36acbb5457a6a963f68d290c94d80025861`. Its history is preserved.
The current service/fixture still implements exact1800. No runtime/test change
was made during preparation. Prior timing model/decision/proof files remain
historical artifacts and are not rewritten as current implementation proof.

Bobby explicitly approved the inclusive provider-reported1800..1860-second
policy with the stated safeguards. Commerce owns its CLI decision amendment,
request shape and outcome validation. This readiness packet defines no
parallel port and selects no new type/property names.

Inspected Commerce owner source at `e3d398bde103d23417c7c1a954834dadf419ec4b`
still uses `paymentWindowSeconds:1800` and exact `expiresAt===createdAt+1800`.
No authoritative approved-window port commit/handoff was available at the
bounded inspection. That older source is not an implementation target for
the changed adapter.

## One bounded ACP repair after pin delivery

1. Receive the Commerce repository, exact commit/PR identity, public port
   files/hashes and decision amendment/proof. Verify the immutable bytes;
   consume its shape without guessing from the earlier proposal illustration.
2. Preserve e401e36 history. Use a focused owned follow-up/stack or normal
   append as the coordinator directs; no force push or history import.
3. Through native ACP, update the Payments types fixture from the approved
   Commerce identity and adapt validation/canonical fingerprint together.
   Persist one original claim with explicit
   `floor(claimedAtMs/1000)+1860` expiry and the exact request/key before
   provider contact. Accept only actual safe-integer provider timestamps,
   inclusive1800..1860 duration and exact stored requested expiry.
4. Reuse the7 timing-model checks as inputs to tests exercising real adapted
   source, with independent provider time at delays0/1/10/30/59/60/61,
   upper/subminimum bounds and clock skew. Preserve provider drift rejection.
   Adapt the explicit-expiry SDK regression to seed a claim+1860 deadline
   with1799/zero remaining at transport; keep the omission trap and same wire
   body/key/account assertions. Do not turn it into a successful default24h
   case. Keep lost-response and original-key replay/restart/concurrency proof.
5. Verify the approved port structurally, domain/SDK tests, relevant workerd
   durable mapping/recovery, typecheck, dry-run build and repository audit.
   Freeze full source/proof hashes and candidate PR identity for a fresh
   independent review owned by the coordinator. P1 remains required_fix
   until implementation and independent requalification.

## Invariants and exclusions

Never fabricate provider creation time, omit expiry, extend the original
deadline, alter retry parameters/key, replace the session or create on lookup.
First execution after60seconds or incompatible clock skew may remainunknown.
Timers, missing mapping and aged retry never establish terminal unpaid or
not-created and never authorize stock release. Inventory is unavailable for
v1. Refunds remain deferred; no customer/order/shipping policy changes.

No actual Stripe calls, merchant setup, account/secrets/DNS changes, payments,
deployment, merge or release. No rail-repair chat message or shared review
dispatch. No dependent ACP model job was launched without the contract pin.

Native readiness on the exact Payments owner worktree is green: Cursor ACP,
advertised `grok-4.6[effort=high,fast=true]`, approve-all with write/exec.
Both prior issue6 jobs completed with cleanupReady. Readiness receipt and
private authorization/routing trail stay in the ignored work packet.

**Next safe action:** coordinator supplies the Commerce owner's frozen
contract handoff; Payments then dispatches the one bounded native ACP repair.

## Subsequent worker-model instruction

The previous Grok readiness receipt is historical evidence only. Bobby
temporarily prohibited further Cursor Grok4.6/4.7 turns and prefers
GPT-5.6 Luna High. Installed native0.4.2 delegate exposes no model selector
and forces the earlier Grok route; prompt/UI settings cannot change it.
Do not launch another Cursor turn through that route. After the Commerce
pin arrives, verify an actually supported requested worker route or a
suitable permitted native alternative with write/exec readiness. Otherwise
report the exact blocker; no direct Codex implementation fallback.
No worker is running and no implementation or ownership change occurred.

## Candidate inspection update

Commerce37 candidate `d2960fa1110660d556bab7388283b06a8fdf9a09` now exposes the approved current/legacy union. `COMMERCE37-CANDIDATE-HANDSHAKE.md` records the exact inspected hashes and remaining consumer mismatch. This supersedes only the earlier observation that no candidate existed; final post-repair owner freeze is still pending. No source/test change or compatibility certification.
