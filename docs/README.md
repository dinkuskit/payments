# Documentation

- [Charter](CHARTER.md): ownership, provider topology, demo limits, and initial
  delivery boundary.
- [Feature map](../FEATURE_MAP.md): planned feature ownership and exclusions.
- [Hosted connections](hosted-connections.md): accepted merchant setup, local
  API contract, tests, and the remaining registry/account integration.
- [Existing Stripe account scope](existing-stripe-account-scope.md): proposed
  Connect OAuth flow for attaching an existing Stripe account, readiness rules,
  1:1 store binding, and historical lookup safety (`dinkuskit/payments#89`).
- [Checkout sessions](checkout-sessions.md): Commerce port fixture, durable
  Stripe session mapping, webhook wake rules, and feasibility limits.
- [Route authentication](route-auth.md): exact installed Registry and hosted paths,
  signature and scoped authorization, and the exact public store-proof exception.
- [Store TEST readiness](store-test-readiness.md): approved two-provider launch
  qualification and mandatory per-store TEST-purchase agreement.
- [Payment setup decision](payment-setup-decision.md): approved one-screen flow,
  independent connection and TEST-order checks, research, and remaining design.
- [Test order check](test-order-check.md): when **Place a test order** completes,
  the `testOrder` status field, and its limits.
- [Registry setup and proof](registry-status.md): account consent, encrypted
  session/status behavior, actual local installation proof and seeded harness limits.
- [CLI specification](CLI-SPEC.md): `dinkus-payments` command-line client for
  the hosted API, its output contract, non-goals, and locked decisions.
