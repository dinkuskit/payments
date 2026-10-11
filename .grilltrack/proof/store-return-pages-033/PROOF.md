# Per-store checkout return pages

Decision: `payments-store-return-pages-033` (github:dinkuskit/payments/pull/37).

## Accepted scope

Every checkout returns to the store's own pages instead of one fixed
dinkuskit.com page: Stripe `success_url`
`https://<store>/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
Authorize.net return `https://<store>/checkout/success`, cancel
`https://<store>/cart`. `<store>` comes only from the `site_origin` claim
DinkusKit.com signs into the store's pass from its Connect-checked store record.
The maintainer chose this over Commerce sending its own address on 2026-10-11.
No receipt route: order details stay in Commerce, and the store key never
reaches Payments.

## Implementation

- `src/hosted/auth.ts`: optional `site_origin` claim, accepted only as an exact
  https origin as `URL.origin` writes it; anything else refuses the pass.
- `src/checkout/return-pages.ts`: builds the pages from the verified origin, or
  throws `store_origin_missing`.
- `src/cloudflare/worker.ts`: the store's Durable Object builds the pages when a
  checkout starts; lookups, wakes and webhooks take none.
  `CHECKOUT_SUCCESS_URL` and `CHECKOUT_CANCEL_URL` are removed.
- `src/checkout/sessions.ts` and `src/authorize-net/checkout.ts`: return pages
  are needed only to start a new attempt; retries reuse the pinned ones.
- `src/hosted/http.ts`: `store_origin_missing` maps to 409 after crossing RPC.

## Verification

`bin/verify-payments full` passed on the candidate: 176 Node tests, 18
Cloudflare runtime tests, 3 built-plugin runtime tests, typechecks, repository
audit, Worker dry run, plugin validate and build. Before the runtime tests were
given a store address, the three runtime checkout tests failed with
`store_origin_missing`, proving the fixed pages are gone.

- `tests/auth.test.mjs`: good origins (with and without a port) become
  `siteOrigin`; empty, http, trailing slash, path, query, user info, uppercase
  host, default port, non-http scheme, over-long, number, array and null are
  refused.
- `tests/checkout-sessions.test.mjs`: a new attempt without pages fails with
  `return_pages_missing` before any write or provider call; a retry without
  pages reuses the pinned ones.
- `tests/authorize-net.test.mjs`: no hosted payment starts without pages; an
  existing one resumes.
- `tests/runtime/merchant-http.test.ts`: through the real Worker, a pass
  without the claim gets 409 `store_origin_missing` and a malformed one 401,
  both before any Stripe call; a signed pass sends Stripe that store's
  `success_url` and `cancel_url`.
- `tests/runtime/checkout-sessions.test.ts`: the Durable Object sends the
  store's pages to Stripe and keeps them across eviction and replay.

## Deploy order

DinkusKit.com must be deployed with the `site_origin` claim before this Worker,
or new checkouts stop with `store_origin_missing`.
