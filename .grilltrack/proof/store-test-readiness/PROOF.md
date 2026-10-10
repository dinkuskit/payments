# TEST-readiness decision record

This is documentation and CLI-maintained decision lineage only. Decision
`payments-store-test-readiness-028` remains locked; the readiness feature is not
implemented or qualified by this PR.

The approved agreement is represented in `docs/store-test-readiness.md` and the
ledger: both providers qualified before launch, Stripe first, one server-selected
provider, a mandatory per-store provider-confirmed TEST purchase yielding exactly
one visible paid Commerce order, no inventory gate, scoped proof invalidation,
persistent visibly TEST orders, and no real fulfillment/shipping. Schema,
protocol and critical-binding enumeration remain future design work.

Validation: GrillTrack CLI `validate`, repository audit and `git diff --check`
pass. The change relative to merged main contains only docs and decision lineage;
it changes no executable behavior. Existing ledger history is preserved.

Parent Payments PR #28 merged on 2026-10-09 at 12:11:43 UTC as
`00560f8c398e8af5850e555e6e52caf6611ac39c`, incorporating reviewed head
`4f170d7b9e692863d515bcac480cb1229fb51bb5`. The branch integrates that merge
without rewriting either decision commit. The recorded parent review remains
bound to its original immutable source; the historical human gate is not erased.

No provider traffic, feature implementation, deployment, credential/account
changes or PR #29 merge is authorized by this record. Required independent
reviews of this decision PR precede its maintainer merge gate.
