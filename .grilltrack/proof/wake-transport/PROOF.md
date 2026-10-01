# Authenticated wake transport

## Scope

This candidate implements the admitted Payments-only transport:

- `GET /v1/checkout/wakes?bindingRef=...&limit=...`
- `POST /v1/checkout/wakes/ack`

Both routes use the existing account JWT verifier and `payments:checkout`.
The worker derives site, account, and `mode: "test"` from trusted state,
validates the existing binding and original attempt association, and exposes
only Commerce's five-field `CommercePaymentWake`.

Canonical wake rows receive persisted `delivery_generation = 1` exactly once.
`received_at` remains the source of `wokeAt`; replay does not change either
value or reopen an acknowledged tombstone. The migration is additive and
keeps legacy attempt-only rows and all original attempt request, key, claim,
deadline, and provider timestamps unchanged. Exact ACK uses a synchronous
conditional update and accepts an already acknowledged row only after all
identity and context checks.

## Verification

- `npm test`: 66 passing Node tests.
- `npm run typecheck`: passing.
- `npm run test:runtime`: 3 files, 8 tests passing.
- `tests/runtime/wakes.test.ts`: real Durable Object SQLite list/ACK,
  default generation, legacy-row retention, attempt-field preservation, and
  eviction/reopen idempotency, authenticated principal-to-owner routing, and
  same-site different-subject rejection before disclosure or mutation.
- `bin/verify-payments full`: passing under Node `v22.23.2`; its constituent
  Node tests, runtime tests, typecheck, repository audit, and Wrangler dry-run
  build all passed.
- Focused and full raw command receipts are retained in the private candidate
  handoff; this curated public proof intentionally contains no ignored raw-log
  paths.
- Source identity is recorded in `source-manifest.sha256`.

The exact Commerce package hash was independently verified as
`cc76f8384ba86398fc367c635a263fb7bb01f10a7296bd6485d4e74fde56c200`.
Its exact wake declarations and packaged `reconcilePaymentWakes` closure were
inspected in ignored working proof. This is type/runtime-source compatibility
evidence, not proof of an installed Commerce consumer or live provider success.

## Deferred runtime gates

No service origin, outbound egress, account issuer/audience/JWKS consumer
capability, actual TEST site/binding/account, or durable scheduler owner was
supplied. No credentials, account, permission, deployment, provider traffic,
merge, push, or scheduler was created or changed.
