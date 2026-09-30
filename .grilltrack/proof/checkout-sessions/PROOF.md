# Checkout Sessions adapter proof

## Source

Repository: dinkuskit/payments.
Branch: codex/payments-checkout-sessions-20260930.
Base: 63d6f80e172f822bdf09ca0dc7cef9e0b420d073 (open Payments #3).
Commerce contract identity: git:1cb55c756ef746bcb042b9679dc43b57e67bcb0d
(published Commerce #29). Port and Money types unchanged from
git:7a054ea6e7a148dd0e1039ec138d967f02431ceb.
Otta research pin inspected only: 7c63e6c2b21927b4760d396cc79da321de131f15.
One focused draft PR is authorized, stacked on Payments #3. Formal review
is not dispatched by this owner; deployment and merge are not authorized.

## Implemented slice

- Types-only Commerce `CheckoutPaymentPort` fixture at
  `src/commerce/checkout-port.ts` with the published-head source identity.
- `existingBinding` / `GET /v1/existing-binding` for authenticated exact-ref
  reads that ignore new-checkout readiness.
- Durable SQLite attempt mapping in `PaymentConnection`. Canonical request
  and exact transport params are detached before the first await and
  persisted before Stripe contact. Replay uses the record.
- Official Stripe SDK Checkout Session transport: connected-account direct
  charges, card-only, pinned `expires_at`, fake `HttpClient` assertions.
- `ensureSession` / `lookup` return `unknown` on absence or readiness
  denial. `not-created` is not emitted. Provider timestamps are persisted
  and compared; an exact 1800-second pair is required to return session
  fields. Session ID and URL stay durable on window or URL mismatch.
- Raw `Uint8Array` webhook verification via `constructEventAsync` before
  field use. Connected-account events require signed `event.account`.
  Events only wake; failed wake is not success.

## Commands and results

Runtime: Node 22.23.2, as pinned in `.nvmrc`.

`npm ci --ignore-scripts`: exit 0.
`node node_modules/workerd/install.js`: exit 0.
`@rolldown/binding-darwin-arm64` native binding present. No package
lifecycle scripts from the lockfile were used as a substitute for
`ignore-scripts`.

`npx tsc --noEmit`: exit 0.

`node --import tsx --test tests/*.test.mjs`: 43 passed, 0 failed.
exit 0.

`npx vitest run`: 2 files, 3 passed. exit 0. A real local SQLite Durable
Object was evicted and resumed with the same Checkout Session mapping
and original window after readiness regression. The final runtime case also
loses a synthetic creation response, evicts the unmapped object, races two
recovery calls under the same persisted parameters/key, and observes one
synthetic processor operation. Replayed/out-of-order signed webhooks leave
one durable wake row after another eviction.

`npm run audit:repo`: `public_repository_contract=clean`. exit 0.

`npm run build` (`wrangler deploy --dry-run --outdir dist`): exit 0,
no deployment. Wrangler printed Stripe package sourcemap-missing notices
to stderr; those are dependency noise, not a build failure.

`npm audit --omit=dev`: 0 vulnerabilities. exit 0.

`git diff --check`: exit 0.

Parent acceptance probe (synthetic, not live Stripe):
`.grilltrack/work/checkout-sessions-20260930/parent-probe-repair.log`.
`terminal_fence` before=unknown after=open creates=1 violation=false.
`provider_timestamp` outcome=unknown for provider.created=1800000002
(inconsistent with requested expires_at + 1800).
`lost_response_after_delay` recovers the original session.

Raw local output:
`.grilltrack/work/checkout-sessions-20260930/verification.log`.
Tests intercept Stripe transport and use synthetic identities. They do
not contact Stripe or a live account issuer.

## Verification classes

| Class | Result |
| --- | --- |
| Synthetic Stripe SDK transport | Passed |
| Domain / HTTP / webhook tests | Passed |
| Cloudflare workerd/SQLite | Passed |
| Contract typing fixture | Passed (`tsc`) |
| Actual Stripe network | Not run, not allowed |

## Feasibility limits

Documented and tested in `docs/checkout-sessions.md`:

1. Stripe `created` is provider clock and `expires_at` is the requested
   timestamp. Commerce requires `expiresAt === createdAt + 1800`. Stripe
   does not document that pair. An inconsistent provider window stays
   `unknown` with durable session ID+URL. Timestamps are never invented
   from claim time. This is the remaining honest blocker for returning
   `open` against a real Stripe clock skew.
2. Malformed session IDs fail closed. Credentialed or non-Stripe URLs
   fail closed after a valid ID is stored.
3. `Session.url` is null after terminal statuses. The first stored
   redirect URL is returned; a URL is never invented.
4. Session `expired` + `unpaid` is not terminal unpaid. `expired-unpaid`
   requires a `canceled` PaymentIntent whose latest charge is proven
   absent (`null`) or expanded with status `failed`. Pending, unexpanded or
   omitted `latest_charge` stays `unknown`.
5. `payment_status=paid` without a `succeeded` PaymentIntent stays
   `unknown`.
6. `not-created` is not emitted. Absence and readiness denial are
   `unknown`.

## Provenance

Otta `packages/payments-stripe` was read for signature-ordering and
mismatch-test lessons. No Otta source was copied. No `@otta-sh` package
is a dependency. MIT attribution is unused because no Otta code was
adapted.

## Review and delivery

Parent acceptance findings were repaired in this draft. Official review
has not run and was not dispatched. The delegated writers did not publish. The parent independently verified
the result and owns the authorized draft PR. This is not formal review, a
release, or a clean closeout.

## Final parent verification

All checks returned exit 0 on Node 22.23.2: 43 Node tests, 3 workerd
tests, typecheck, structural compatibility with the recorded Commerce
source, dry-run build, repository audit, and diff check. Original failures
and repair outputs are retained in the ignored run packet. The final
workerd run reports only Stripe dependency sourcemap notices on stderr.

Four final acceptance regressions failed on the repaired candidate and
passed after small parent corrections: documented cs_test_ IDs/Stripe URL
fragments, pinned requested expiry, numeric line minor rejection, and
pending-charge unknown status. The restart/concurrency test initially
exposed an inaccurate retrieve fixture; it was corrected to return the
original provider metadata, and the complete runtime case then passed.

No actual Stripe traffic ran. The exact provider timestamp pair, expired
sessions with no provably terminal PaymentIntent, unacknowledged creates
beyond retry retention, and the Commerce wake consumer remain explicit
limitations. Formal review remains with the existing rail owner.
