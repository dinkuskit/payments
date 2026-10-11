# Test order check and status host access

Decisions: `payments-test-order-check-034` and `payments-status-host-access-035`.

## Accepted scope

**034.** **Place a test order** completes when, for the store's current payment
connection, Payments' own Stripe or Authorize.net lookup confirmed a TEST
checkout as paid and Commerce acknowledged that checkout's payment notice. The
maintainer chose "Stripe and Commerce" on a decision card on 2026-10-11. No
Commerce change, order number or new route. The overall result stays
**Not ready to sell** while Payments runs only in TEST mode.

**035.** The Registry plugin's allowed hosts are exactly `dinkuskit.com` and
`payments.dinkuskit.com`, the hosts of its server-owned endpoints. EmDash's
sandbox fetch (`@emdash-cms/cloudflare` `bridge-http`) refused
`payments.dinkuskit.com` for the built manifest, so the setup page could never
read `/v1/status` in a real store. The maintainer chose "In this PR" on a
decision card on 2026-10-11.

## Implementation

- `src/cloudflare/worker.ts`: `paid_test_checkouts` keeps the first time a
  lookup or checkout call got a provider-confirmed `paid` outcome, with binding,
  provider, receiving account and amount. `status` adds `testOrder` for the
  current connection, reading notice receipt and Commerce's acknowledgement from
  `checkout_wake_events` for the same checkout, binding, TEST mode and receiving
  account. A recorded checkout wins over a newer one still waiting.
- `src/hosted/connection.ts`: the optional `testOrder` status type.
- `src/registry/status.ts`: strict `testOrder` decoding, TEST mode with a
  binding and a matching provider only.
- `src/registry/setup.ts`: the step's texts for each state.
- `emdash-plugin.jsonc`: `payments.dinkuskit.com` added to `allowedHosts`.

## Verification

`bin/verify-payments full` passed on the candidate: 180 Node tests, 20
Cloudflare runtime tests, 3 built-plugin runtime tests, typechecks, repository
audit, Worker dry run, plugin validate and build (Registry bundle 18,028 bytes).

- `tests/runtime/test-order.test.ts`: a real Durable Object onboards, starts a
  Stripe TEST checkout and looks it up; once Stripe reports it paid, status
  shows `awaiting_notice`, keeps the first paid time across a second paid answer
  and eviction, moves to `awaiting_commerce` after a signed
  `checkout.session.completed` webhook, and to `recorded` after Commerce's
  exact acknowledgement. The Registry reader decodes that status unchanged and
  the setup step is complete. A second test shows that only the current binding
  and receiving account count, a recorded checkout wins over a newer waiting
  one, an acknowledgement under another account does not count, a different
  owner is refused, Authorize.net notices match by merchant ID, and nothing is
  recorded for a live binding.
- `tests/registry-status.test.mjs`: decoding accepts each state for Stripe and
  Authorize.net and rejects extra or missing keys, unknown providers or states,
  non-USD, zero, padded, numeric or unsafe amounts, bad times, live mode, a
  missing binding and a provider mismatch. The step texts are checked for each
  state, including amounts with thousands, midnight and noon. Browser input
  cannot complete the step.
- `tests/registry-connection.test.mjs`: the manifest's allowed hosts equal the
  hosts of the consent, signing-key and production status endpoints.
- `tests/registry-runtime.test.ts`: the built plugin declares both hosts.

## Deploy notes

Deploy the Worker together with the matching Registry plugin build; an older
build rejects `testOrder` and shows "Checking Payments setup". The step depends
on the store's five-minute Commerce Cron Trigger.
