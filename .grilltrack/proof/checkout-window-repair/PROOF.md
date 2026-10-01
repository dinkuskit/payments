# Checkout payment window repair

Payments branch `codex/payments-checkout-sessions-20260930`, draft [PR5](https://github.com/dinkuskit/payments/pull/5), starting head `e401e36acbb5457a6a963f68d290c94d80025861`.
Commerce authoritative merge commit: `ab37cd7f362f1c37cb1d321192abbbc48a623833`, [PR37](https://github.com/dinkuskit/commerce/pull/37). The four normative files match the owner handoff byte hashes:

- `docs/implementation/checkout-payment-window.md`: `588965f9409fd0769d3965131bc39e965c525cfd4a0be070ed45cb4384db9a95`
- `src/features/checkout/types.ts`: `aa77fb9b861e190f9cb23d511dcc27cd90984827eaba78435b2aeb9eaaefa687`
- `src/features/checkout/payment-window.ts`: `ee5488bf0cb0866bc518ba670d5a0b62b9473e11fa76369303d356d327844c2c`
- `src/features/checkout/orchestrate.ts`: `9e728c4289ecc7240d982f7b9e14260d3b900f8e731eca30de85eef81f816475`

## Behavior

Current requests use only `paymentWindow:{minSeconds:1800,maxSeconds:1860}`. Mixed fields, neither field, altered bounds and extra policy keys fail before provider contact. New claims persist the detached original request fingerprint, policy, parameters, account, URLs, key and explicit `floor(claimedAtMs/1000)+1860` deadline before transport. Real provider timestamps must be positive safe integers, preserve the requested expiry exactly and have inclusive1800..1860 duration. Later responses preserve the mapped session and timestamps.

Historical records without a policy tag retain exact1800 validation and their original fingerprint bytes, deadline and key. Unclaimed legacy requests remain unknown without provider contact. Requests cannot switch policy on retry. Lookup never creates; the existing23-hour creation retry bound and terminal unpaid authority remain intact. Unknown, missing mapping and local expiry do not establish unpaid/not-created or authorize stock release.

## Verification

Parent verification on Node22.23.2: `bin/verify-payments full` passed with55 Node tests,3 workerd/SQLite tests, typecheck, repository audit and Wrangler dry-run build. `git diff --check` passed. The production source hashes stayed frozen during the final test/proof turn.

- Independent provider clock: delays0/1/10/30/59/60 produce valid1860/1859/1850/1830/1801/1800 durations. First execution at61 seconds is rejected, leaves an unmapped unknown claim and zero successful operations; retries retain the original deadline. Returned1799 and1861 durations also remain unknown.
- Lost successful reply: creation at provider+1, cached original-key replay at+180, one successful operation, identical parameters and unchanged actual timestamps. A new execution would have only1680 seconds remaining.
- Legacy cases: separately seeded records accept exact1800 and reject1859; no mapped record is reset. Original fingerprint/deadline/key and absent policy tag are preserved, with later ensure/lookup agreement. Policy mutation fails in both directions.
- Official Stripe SDK interception: explicit original expiry with1799 and zero seconds remaining, mockedHTTP400 =>unknown, null mapping, identical serialized body/key/account, and no24-hour omission fallback.
- Workerd: current policy survives SQLite eviction, concurrent lost-response recovery, readiness regression and duplicate/out-of-order verified webhook wake hints. Existing durable wake assertions are retained.
- Structural compatibility: `extract-and-check-compatibility.mjs` verifies exact Commerce checkout and Money source hashes, extracts only the public type closure and typechecks14 bidirectional type checks plus value assignability for the port, request, outcome and session.

Raw local logs under `.grilltrack/work/checkout-sessions-20260930/`: `window-parent-full.log`, `window-parent-compatibility.log`, `compatibility/typecheck.log`.

## Semantic regression

Original same-repository source at e401: provider clock at claim+1 sees1799 seconds remaining under the old claim+1800 policy. Provider rejects, service returnsunknown and no operation succeeds; the expectedopen assertion fails with exit1. Current actual source under the same independent clock uses claim+1860, returnsopen with1859-second actual duration and one operation; exit0. This is a captured semantic comparison, not a claim about first-turn test chronology.

Raw logs and exact original blob/hash identity: `regression/old-policy-p1-regression.log`, `regression/current-policy-repaired.log`, `regression/identity.json` in the ignored work packet. Copied baseline source comes only from this repository's e401 commit.

## Review adjudication and limits

Accepted: the original absolute expiry lacked delay headroom. The repaired contract/adapter provides bounded headroom while preserving provider truth and immutable replay. Parent inspection also accepted and corrected missing runtime wake coverage and expiry-derived timing fixtures.

Rejected: fabricating creation time, omitting expiry, resetting deadline/key/mapping, rewriting legacy originals, interpreting unknown as usable creation or unpaid proof, and unrelated service/store/authority changes.

The accepted formal P1 remains `required_fix` / needs_reverification pending fresh independent exact-source review. All provider evidence here is synthetic or intercepted; no actual Stripe traffic, deployment or merge ran. More than60 seconds of first-execution delay or incompatible clock skew can remain unknown. No Commerce wake consumer, manual ambiguous-create recovery, refunds or inventory release policy was added.

Earlier proposal/model/readiness files remain historical decision lineage. `checkout-sessions/timing-feasibility.test.mjs` and its manifest describe their recorded old Git identities and must be evaluated with those historical sources, not treated as current-source proof.
