# Independent acceptance findings

Initial candidate identity: `sha256:c8c3790989b9cf7eb84c1ccf02fff3112732fc3bdfadd4977f7213b54c5f8704` (manifest below).

| File | SHA-256 |
| --- | --- |
| src/checkout/sessions.ts | 63732d0ce20457375c8ef00f1003296cf5b354bd8812dfe9fde5b58090cb6d35 |
| src/checkout/webhook.ts | 6a88616c07390c554cd132be96bea71ea980563fb431371fa2762267bd8c722f |
| src/stripe/checkout.ts | 449f8d2756c797e5034069f1897044e0ddcd6930aca6202f825511d39f1c949c |

Classified as required fixes before delivery:

- Terminal fencing: a synthetic lookup returned `not-created`, then ensureSession for the same attempt returned `open` and created a session. Absence and readiness denial cannot establish a terminal creation fence.
- Session identity: a synthetic provider returned created=1800000002, but the candidate reported createdAt=1800000000. Provider timestamps must be authoritative and immutable.
- Request identity: detach the validated request before awaits and persist all exact create parameters, including return URLs, rather than replay current caller/configuration values.
- Recipient identity: require signed event.account; an unsigned transport header cannot supply missing signed identity.
- Terminal unpaid: distinguish an absent latest charge from an unexpanded or unknown charge before using canceled status as proof.

A delayed lost-response retry recovered the original synthetic session within provider idempotency retention. This is synthetic transport evidence; actual Stripe traffic was not run.

The parent independently checked structural type compatibility against Commerce #29 at 1cb55c756ef746bcb042b9679dc43b57e67bcb0d. Checkout port and Money types are unchanged from the initially recorded source. No broad Commerce tests or source changes were performed.

These are acceptance findings, not a duplicate formal review dispatch. Required fixes were sent to the same ACP implementation owner. Formal review remains pending with the existing review rail owner.

Repair status (same draft, not a new formal review): the four required
fixes plus canceled-PI charge-state distinction were implemented against
this draft. Compatibility identity now records Commerce #29 published head
`1cb55c756ef746bcb042b9679dc43b57e67bcb0d`. See `PROOF.md` and
`docs/checkout-sessions.md` for the conservative limits. No live Stripe.

Final parent corrections and adjudication:

- Accepted and fixed: documented Stripe cs_test_/cs_live_ ID prefixes and
  hosted URL fragments must pass without relaxing host/credential checks.
- Accepted and fixed: provider cannot shift the pinned requested expiry,
  even when its returned pair is exactly 1800 seconds.
- Accepted and fixed: line minor values must be strings before transport.
- Accepted and fixed: a pending charge is not terminal unpaid.
- Rejected: missing mapping as proof of not-created; the adapter deliberately
  returns unknown because no permanent terminal fence exists.
- Deferred: actual Stripe timing proof, the Commerce wake consumer, and
  external formal review. These are stated limits, not clean-review claims.

Final source identity and hashes are in `final-source-sha256.json`. The
parent verified repository standards, source intent, provenance, the
Payments checks, and the unchanged Commerce contract independently.
