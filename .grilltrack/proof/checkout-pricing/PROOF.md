# Payments checkout pricing v1

Consumes Commerce's qualified pre-release source70419ae55c4f73354e3f0eda08b09bbc85368000 and exact pricing v1; CONTRACT-PIN.json records source/archive identities. Commerce48 was unmerged at adoption, no release/install/activation assumed. Commerce's local Mac D1 limitation remains; its full current-head CI passed.

## Behavior

Payments validates canonical positive USD totals, complete ordered pricing and quote arithmetic, normalized coupon selection and frozen free/flat shipping. Malformed/schema/window mismatches reject before claim or provider. The complete snapshot and fingerprint, mapping version and exact charge-line input are persisted before await. Replay/restart preserves original key, account, window, deadline and derived payload; incomplete/corrupted mapping stays unknown. Historical unpriced current/legacy fingerprints and request shapes remain compatible.

Positive whole-line net amounts become quantity1 charges with honest original quantity; positive shipping is charged once, without exposing internal configuration identities. No unit rounding, processor coupons or price/configuration reevaluation. More than100 mapped positive items is rejected before any attempt claim or provider call; no omitted lines. Zero-net merchandise plus shipping works; zero payable creates no fake provider/session.

## Proof

- Parent regressions: three failing tests against initial candidate, then passing after total/count/quote fixes. Raw red/green and all exit receipts retained in ignored .grilltrack/work/checkout-pricing-20261006/PARENT-regression-*.
- Focused:47 Node tests pass; full verification76 Node+9 workerd runtime tests pass, typecheck, unchanged public repository audit and dry Worker build pass. Final full receipt: PARENT-full-3.stdout/.stderr/.exit in ignored work directory (exit0). Stripe source-map warnings remain nonfatal.
- Workerd proof preserves separate historical-unpriced and priced paths. Priced case has nondivisible1149-cent net plus51-cent shipping; original snapshot and exact mapping survive lost create response, eviction and concurrent replay with unchanged idempotency/expiry, then lookup after readiness regression.
- Pinned npm behavior script passes five scenarios: nondivisible flat199, free150, offset250, shipping-only50, zero rejection. Four payable cases each reopen SQLite, preserve frozen shipping despite changed configuration, reconcile authoritative SDK result to exactly one canonical Commerce order and one coupon consumption. PACKAGED-BEHAVIOR.json is sanitized outcome evidence.

Reproduce the compiled package proof with Node22.23.2 and existing EmDash1.0.1 peer:

```sh
node --import tsx scripts/verify-commerce-pricing-package.mjs <pinned-commerce.tgz> <emdash-package-directory>
```

Script verifies exact archive SHA and peer version, blocks unexpected global fetch, intercepts every Stripe/Payments call, and keeps synthetic SQLite scratch only in ignored node_modules/.cache. It never weakens the public audit or commits database output. Packaged script output/exit: PARENT-package-closeout.* in ignored work.

## Limits

Synthetic principal/token and wholly intercepted SDK transport only. JWT cryptography, webhook and wake contracts retain existing separate tests. No installed host PluginContext, guest UI, Registry installation, scheduler/wake end-to-end delivery, actual Stripe TEST purchase, credential/grant/account change, deployment, activation, publication or merge proof. Dependency pins unchanged; no claim that existing dependency audit warnings were repaired. New Payments exact-head independent CI/OpenClaw/native qualification remains a separate gate.
