# Commerce37 candidate consumer handshake

Status: read-only preparation, **not a final owner-certified implementation pin**.
Commerce draft37: https://github.com/dinkuskit/commerce/pull/37
Candidate: `d2960fa1110660d556bab7388283b06a8fdf9a09`
Base36: `e3d398bde103d23417c7c1a954834dadf419ec4b`
Payments5: `e401e36acbb5457a6a963f68d290c94d80025861`, unchanged.

Public candidate source/docs were fetched through GitHub API at the exact
commit. No moving-branch source was used. This inspected candidate is not
selected as the dependent implementation pin: the core owner is repairing
constructor/guest admission and must freeze its replacement and proof.
No Commerce or Payments source/test changed, no ACP model job started, no
compiled compatibility or actual provider acceptance claim was made.

## Candidate public contract

`@dinkuskit/commerce/features/checkout` re-exports the kernel public API.
The kernel exports the current/legacy request types, handoff discriminant,
window-bounds helpers and constants. The public docs and source agree:

- Current request: own `paymentWindow:{minSeconds:1800,maxSeconds:1860}`;
  `paymentWindowSeconds` absent. New Commerce construction uses this shape.
- Legacy original: own `paymentWindowSeconds:1800`; `paymentWindow` absent.
  Both or neither field is invalid. Legacy requests are never rewritten.
- `paymentRequestHandoff` and `readFrozenPaymentWindowBounds` validate the
  precise field-presence discriminant and approved numeric policy.
- Outcomes retain the four-field PaymentSession and existing outcome union.
  Current provider durations accept inclusive1800..1860; legacy remains
  exact1800. Actual safe-integer timestamps and session-field equality stay
  authoritative. Unknown cannot release stock.
- The candidate documents explicit current claim+1860, unchanged parameters/
  key, no lookup-create,23-hour retry bound and60-second headroom limit.

## Exact consumer fit and remaining mismatch

| Surface | Candidate expectation | Payments at e401e36 | Repair implication after final pin |
| --- | --- | --- | --- |
| `PaymentRequest` | Current/legacy union | Only literal `paymentWindowSeconds:1800` | Consume owner union; reject mixed/missing/altered policy. No parallel port. |
| Validation and canonicalization (`sessions.ts:118,139`) | Preserve frozen shape | Rejects current field; canonicalizes every request to legacy | Detach and fingerprint each exact original variant; never convert a legacy replay. |
| New claim (`sessions.ts:304`) | Current claim+1860 | claim+1800 | Explicit current1860 request once before contact; never change old stored expiry/key/params. |
| Stored outcome (`sessions.ts:184`) | Current bounds; legacy equality | Exact1800 for every record | Persist/read frozen policy for new records; retain compatible legacy record interpretation and exact old fingerprint bytes. |
| Provider identity (`sessions.ts:212..214`) | Exact requested expiry and immutable actual fields | Already pins expiry/created/expires | Preserve these guards while changing the policy-specific duration acceptance. |
| Outcome/binding/transport | Same fields, amount, binding, card/USD | Existing mapping, official SDK, verified lookup | No contact/order/shipping ownership change required by this timing handshake. |
| Recovery and release | Same original tuple; unknown is not terminal | Lookup never creates; no not-created emission | Preserve conservative unknown, finite replay ceiling and Commerce release authority. |

Important legacy readback for the final owner handoff: the general docs pin
formula must apply to **current new claims**, never overwrite a pre-existing
legacy1800 tuple. Legacy type comments describe historical originals only.
Before implementing, confirm the final handoff's treatment of a historical
legacy Commerce request that has no Payments durable claim yet; do not
guess that it may be upgraded into a current claim or silently rewrite its
request/fingerprint. This is a bounded compatibility detail, not a request
to reopen Bobby's approved1800..1860 product policy.

The existing7 timing checks remain protocol-model evidence. After the final
pin, ACP must adapt real-service/domain/SDK/runtime cases for current bounds,
legacy replay, unsafe/missing/changed policy, independent provider latency/
skew, immutable expiry, lost response/restart and delayed first execution.
The explicit1799/zero SDK expiry test remains a no-omission safeguard and
will use an approved current claim without default24h fallback. No new tests
were added during this read-only handshake.

## Immutable byte evidence

| Candidate file | SHA-256 |
| --- | --- |
| docs/implementation/checkout-payment-window.md | 588965f9409fd0769d3965131bc39e965c525cfd4a0be070ed45cb4384db9a95 |
| src/features/checkout/index.ts | 824c0cd26c6512712f4b8b6c36ae905f7beecced2c61da7d276bf675e09bda39 |
| src/features/checkout/kernel/index.ts | ff1c9998ad29125f10478845115886ec22d97c7c3379b7afdceca8f35f55a907 |
| src/features/checkout/orchestrate.ts | 9e728c4289ecc7240d982f7b9e14260d3b900f8e731eca30de85eef81f816475 |
| src/features/checkout/payment-window.ts | ee5488bf0cb0866bc518ba670d5a0b62b9473e11fa76369303d356d327844c2c |
| src/features/checkout/types.ts | 8ac6008c889ee6d522339018f86b8bfdf4b04cc110d33ea47ae8453c446141ef |

The ignored packet also records exact Git blob hashes and byte counts.
These hashes identify the inspected candidate only; compare them to the
core owner's forthcoming final manifest rather than treating unchanged
contract bytes as final admission or guest-runtime qualification.

## Next safe action

Receive the core owner's post-repair immutable commit/PR, contract/source
manifest and compatibility/decision/proof handoff. Then verify the exact
bytes and dispatch one bounded native ACP repair. Cursor Grok4.6/4.7 remains
prohibited; GPT-5.6 Luna High is preferred, but installed native0.4.2 Cursor
currently exposes no model selector. Verify a supported requested or suitable
permitted alternative native lane at admission; no direct Codex code/test
fallback. No current or new model job runs in this preparation.

P1 remains required_fix pending implementation and independent requalification.
Payments rails are outside the reported restored-four set. No shared review
dispatch or clearance claim, rail-repair chat message, live Stripe, merchant
setup, payments, credentials, account/DNS change, deployment, merge or release.
Inventory remains unavailable for v1 and refunds deferred.
