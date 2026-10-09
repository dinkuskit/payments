# Route authentication qualification

Scope: Payments issue #27, based on `22cd40442caa2c01876482fe0e1da07e4dfb086a`.
The Registry bundle remains admin-only; its exact public bypass list is empty.
Hosted JWT and provider-signature endpoints remain a separate surface.

## Verification

Using Node 22.23.2 and the locked dependencies:

- Node suite: 117 passed, including declaration completeness, actual pinned
  EmDash Registry-ID derivation, production public-only dispatcher rejection,
  exact hosted path generation and every scoped endpoint's anonymous denial.
- Both TypeScript targets passed; repository audit passed.
- Hosted workerd suite: 16 passed, including forged/malformed notification
  rejection without durable writes, cross-store signed-notification rejection,
  provider isolation and durable lookup/reconciliation behavior.
- Worker dry-run build, official plugin validation and plugin build passed.
- Built-plugin workerd suite: 3 passed, including anonymous 401,
  insufficient-role 403, explicit built private metadata and admin token-scope
  denial. This uses the real framework dispatcher independently of Access.
- Mutation check: temporarily removing `public: false` from the real plugin
  makes the declaration suite fail with `must declare an explicit public
  boolean`; restoring it passes all seven focused tests.
- `git diff --check` and GrillTrack validation passed.

`bin/verify-payments full` passed every stage before its new final plugin test
used an incorrect object-shaped manifest assertion. The framework emits a route
array. After correcting that assertion, `npm run test:plugin-runtime` passed
all three tests. No product code was changed for that correction.

ACP implementation was independently inspected and repaired: concrete route
paths and the actual framework identity check replaced incomplete identity
coverage; hosted webhook constants now drive dispatch as well as documentation;
additional production-dispatch and workerd denial regressions were added.
The ACP worker reached terminal completion with cleanup confirmed. Its earlier
native-binding failure was resolved by using the repository's pinned Node.

## Limits and next slice

No live provider calls, Registry publication/installation, Access changes,
deployment or account changes occurred. Existing signed webhooks only wake
reconciliation; authoritative provider lookup remains required before Commerce
can mark paid. Payments never owns orders.

The smallest next qualification is genuine installation of the status-only
artifact with signed release acquisition, consent, installed hashed identity,
artifact hash and private-route denials. The seeded harness does not prove that
flow. Purchase qualification additionally needs the account/service bridge,
Commerce integration, selected test provider and explicit sandbox authorization.
See [route contract](../../../docs/route-auth.md).

Independent exact-source review and maintainer approval remain delivery gates;
this verification record does not grant merge authority.
