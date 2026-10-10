# Stripe test mode checkout

This repository is intentionally test-mode-only. The Worker constructs Stripe
with `mode: "test"` and rejects any key that does not begin with `sk_test_`.
`STRIPE_API_KEY` and `STRIPE_WEBHOOK_SECRET` are host secret bindings; neither
belongs in source, Wrangler vars, Commerce requests, or storefront code.

## Payments setup

1. Configure the test-only host bindings:
   - `STRIPE_API_KEY`: a Stripe test secret key (`sk_test_…`).
   - `STRIPE_WEBHOOK_SECRET`: the signing secret (`whsec_…`) for the test
     webhook endpoint.
2. Configure the non-secret Worker vars from `wrangler.jsonc`, including
   `CHECKOUT_SUCCESS_URL` and `CHECKOUT_CANCEL_URL`.
3. Authenticate as the store owner and call `POST /v1/connect` with no query
   parameters and no body. Payments creates a Stripe Connect Standard test
   account, returns a Stripe-hosted onboarding link, and persists the
   server-owned `bindingRef`. Repeat the call to resume setup; do not accept an
   account ID from checkout input.
4. Register the test webhook URL
   `/v1/webhooks/stripe` in Stripe for the connected test account. Stripe
   events must carry the connected account in the signed `account` field.
   Payments verifies the raw request bytes and `STRIPE_WEBHOOK_SECRET`, checks
   the site, binding, account, mode, session, and amount, then only queues a
   reconciliation wake. Commerce must perform the authoritative lookup before
   reporting paid.

The proof script can also use an explicitly supplied test connected account
with `STRIPE_TEST_ACCOUNT_ID`. It never prints the key or webhook secret.

Run the deterministic proof without provider contact:

```sh
node --import tsx scripts/stripe-test-mode-proof.mjs
```

Run the real test-mode creation proof only when an `sk_test_…` key and a test
connected account are intentionally available:

```sh
STRIPE_API_KEY=… STRIPE_TEST_ACCOUNT_ID=acct_… \
  node --import tsx scripts/stripe-test-mode-proof.mjs --run
```

The creation proof prints the hosted URL and non-secret `cs_test_…` ID, then
confirms the pre-payment authoritative lookup is `open`/unpaid. Stripe does
not create or expose the Checkout Session's PaymentIntent until the hosted
customer flow pays, so the script intentionally stops there.

After paying that hosted URL with a Stripe test card, run the lookup-only proof
with the printed ID:

```sh
STRIPE_API_KEY=… STRIPE_TEST_ACCOUNT_ID=acct_… \
  node --import tsx scripts/stripe-test-mode-proof.mjs --lookup cs_test_…
```

Lookup-only retrieves the Session and PaymentIntent through the same
authoritative Payments lookup path and passes only for paid USD 100. It
reconstructs only this proof script's transient attempt; it does not mark a
Commerce order paid. Neither mode uses live mode or deploys.

## Commerce follow-up (not in this repository)

Commerce remains the authority for prices, payment attempts, reconciliation,
orders, receipts, and the final paid decision. The Commerce source owner still
needs to:

- configure the demo's Payments binding for `demo.dinkuskit.com` to the
  server-owned `bindingRef` returned by Payments, using the `stripe` provider
  and `test` mode; do not let the guest request select a provider or total;
- wire the existing `dinkus.checkout` flow in
  `checkout/guest/prepare`, `checkout/guest/start`, and
  `checkout/guest/status` to the Payments `/v1/checkout/session` and
  `/v1/checkout/lookup` contract;
- consume Payments wakes through `/v1/checkout/wakes` and
  `/v1/checkout/wakes/ack`, call lookup during reconciliation, and acknowledge
  only after Commerce has durably settled the result;
- preserve `unknown` as a hold/retry state. A signed webhook is not proof of
  payment, and Commerce must require the Payments `paid` result with matching
  amount and currency.

The exact Commerce contract is in its checkout payment port and
`dinkus.checkout` implementation; this repository does not edit that
repository.

## Template-store follow-up (not in this repository)

The template-store owner still needs to:

- keep the guest cart implementation in `src/features/guest-cart/*` and the
  cart page at `src/pages/cart.astro` authoritative for cart contents, while
  disabling checkout only when the Commerce Payments binding is unavailable
  (`PAYMENTS_UNAVAILABLE`);
- call Commerce's guest prepare/start flow from the cart checkout action and
  redirect only to the validated Payments Checkout Session URL;
- keep `src/pages/checkout/success.astro` and
  `src/pages/checkout/cancel.astro` as return pages. The success page must
  display a pending/verification state until Commerce reconciliation reports
  paid; it must not infer payment from query parameters or a browser return;
- add repeatable browser coverage for cart → hosted test Checkout → return →
  Commerce status, plus an explicit production-build test proving any
  development-only payment shortcut is unavailable in production.

The development-only offline gateway and browser harness described in the
referenced `otta.sh` work belong in Commerce/template-store, if adopted; they
must not be added to Payments or used to establish paid status here.

## Boundary lessons from the referenced work

The EmDash sandbox `AbortSignal` RPC problem from `otta.sh` applies to
`ctx.http.fetch` calls. This Worker uses Stripe's official fetch HTTP client
inside workerd and has no `ctx.http` RPC transport, so that workaround is not
copied. If the host later wraps Payments transport in RPC, add real workerd
tests for request and response-body deadlines before changing the transport.
