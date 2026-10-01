# Payments TEST event wakes proof

Decision: `payments-test-event-wakes-001`
Baseline: `75e5d43acbc39deee3127f924866cb9098f789b0`

## Accepted slice

The verified Payments-only slice retains canonical provider event IDs and
immutable site, binding, attempt, account, and mode associations. It stores
event-keyed durable wake rows with replay deduplication and acknowledgement
tombstones, while preserving the legacy attempt-only `checkout_wakes` rows.
The bounded internal consumer acknowledges exactly the event selected only
after successful reconciliation. Webhook verification and association checks
remain before persistence and provider acknowledgement; the callback is not
awaited by the webhook.

The callback receives a frozen detached snapshot, and acknowledgement uses a
separate frozen snapshot. The first candidate was rejected because a callback
could mutate `evt_one` to `evt_two`, return success, and acknowledge the newer
event without reconciling it. The tested repair prevents that: `evt_one` must
not acknowledge `evt_two`, and the newer event remains pending.

## Verification

Existing evidence was produced with Node `v22.23.2`; no runtime verification
was repeated for this documentation-only closeout.

- `npm test`: 59 tests passed.
- `npm run test:runtime`: 2 files and 3 tests passed.
- `npm run typecheck`: passed.
- `npm run audit:repo`: passed (`public_repository_contract=clean`).
- `npm run build`: Wrangler dry-run passed and exited without deployment.
- `git diff --check`: passed.
- Parent independently ran `bin/verify-payments full` under the provided
  Node `v22.23.2` path: exit 0. Evidence:
  `.grilltrack/work/test-wake-bridge-20261001/parent-full.raw.txt`.

Focused source tests cover canonical IDs, replay before and after
acknowledgement, distinct events for one attempt, exact association checks,
false/pending/unknown/throwing reconciliation retention, failed enqueue
handling, legacy-row preservation, tombstones across replay and Durable Object
eviction, and callback mutation protection.

## Review repair: accepted P2

The comprehensive exact-tuple review accepted one `REQUIRED_FIX P2` against
candidate `0aded231c1c5079ec83c3e41724ee70c3464a56f`: the retained legacy
`checkout_wakes` upsert used `DO NOTHING`, so a later distinct canonical event
did not refresh `woke_at`. No live consumer failure was observed; this was a
compatibility defect established by runtime regression.

The repair changes only the legacy upsert, after canonical event deduplication
and event-reuse rejection, to `DO UPDATE SET woke_at=excluded.woke_at`.
Canonical event rows remain immutable on replay, including `received_at`;
acknowledgement tombstones and exact callback/ACK association behavior remain
unchanged.

The real Cloudflare SQLite runtime regression produced 1 failing test on the
old candidate and 1 passing test after repair. It controlled enqueue times for
`evt_old`, distinct `evt_new`, and replay, and preserved an unrelated
historical attempt-only row and timestamp. Raw failure and passing evidence is
retained in
`.grilltrack/work/test-wake-bridge-20261001/p2-legacy-wake-refresh-20261001/`.

## Source references

Implementation and tests are in:

- `src/checkout/wakes.ts`
- `src/checkout/webhook.ts`
- `src/cloudflare/worker.ts`
- `tests/wakes.test.mjs`
- `tests/webhook.test.mjs`
- `tests/runtime/checkout-sessions.test.ts`
- `docs/checkout-sessions.md`

`source-manifest.sha256` records SHA-256 values for those modified source,
test, and documentation files. It intentionally excludes this proof file.
Fixtures and identifiers used by this proof are synthetic.

## Limits and deferred work

This slice does not provide a hosted consume endpoint, alarm or automatic
delivery scheduler, HTTP authentication for consumption, or a dependent
Commerce fixture/contract change. It does not prove actual provider payment
acceptance, closed-tab end-to-end completion, deployment, publishing, live
traffic, account or security changes, or secret changes. No provider
credentials, customer or merchant data, or production configuration are part
of this proof.
