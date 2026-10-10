# Registry setup screen proof

Base: `164e3f2cd303426aed229363c8bf1e9f44d97785`; decision031 implements
only the unavailable-first setup screen under approved028/029 and evidence030.

## Behavior

The existing private admin route renders Connect payments, Place a test order,
and Not ready to sell. Browser input cannot supply connection or order facts.
The pure renderer decodes existing evidence and distinguishes Stripe TEST/live,
action-required/unknown and unsupported Authorize.net. Every case retains an
unconfirmed Commerce TEST order and overall not-ready state.

## Verification

Node22.23.2: 126 Node tests,16 hosted runtime tests, both TypeScript checks,
repository audit, Worker dry-run and plugin validation/build passed in full
verification. A wording change required two stale text assertions in the Node
suite, one plugin assertion and the proof verifier to be updated. Final plugin
runtime rerun passed3/3; final HTTP proof passed admin200/subscriber403/anonymous401.
No provider calls, credentials, publication or deployment.

The official packaged backend was loaded through EmDash1.2.0 seeded Registry
state. A normal seeded admin session visibly rendered the screen. CUA captures
at measured1440x1000 and480x844 CSS viewports show readable wrapped content and
no horizontal overflow. Subscriber session visibly returned403. Initial viewport
requests were scaled by the browser zoom; measured dimensions were corrected
before the final captures. No page content or styles were injected for proof.

This is seeded post-install runtime proof, not signed installer or real merchant
setup proof. Provider-specific render cases are unit-tested; production has no
authenticated site-bound Payments status adapter and no Commerce qualifying-order
reader. Those interfaces remain the next upstream dependencies. The screen does
not create actions, capabilities, checkout admission changes or readiness facts.

Screenshots remain in the local task proof run (not published). SHA-256:
- `desktop-exact.png`: `2508c846930017ed927c4882d1539d68616c97a823e07e0e50b34d17c9ba766d`
- `mobile-exact.png`: `4ae15229c914bef71797cdffd3f5e5d3f749e55d43d4417246e68dbacd03b214`
- `subscriber.png`: `94b03e7aafe5da72212a67426def852d67a97ed7bca811bbed18945a0cfa726c`

Packaged backend SHA-256: `912248c9221969294978bfb21d8f3f72b1f66f148fc5bd90af8d8bcaf06b784c`.
