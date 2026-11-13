# Stripe line options and expired checkouts without a card (048, 049)

Recorded 13 Nov 2026 on branch `claude/project-thread-61agoo` from main `f3f4700`.

## 048: what Stripe's page shows per item

The exact `line_items` the Stripe SDK sends for one M tee, two L tees, one
sticker without options and $5 flat shipping (synthetic fetch transport, the
same official SDK the Worker uses; no Stripe account was contacted):

```text
line_items[0][quantity]=1
line_items[0][price_data][currency]=usd
line_items[0][price_data][unit_amount]=3400
line_items[0][price_data][product_data][name]=Wrong Turn Tee
line_items[0][price_data][product_data][description]=Size: M
line_items[1][quantity]=1
line_items[1][price_data][currency]=usd
line_items[1][price_data][unit_amount]=6800
line_items[1][price_data][product_data][name]=Wrong Turn Tee × 2
line_items[1][price_data][product_data][description]=Size: L
line_items[2][quantity]=1
line_items[2][price_data][currency]=usd
line_items[2][price_data][unit_amount]=1300
line_items[2][price_data][product_data][name]=Sticker
line_items[3][quantity]=1
line_items[3][price_data][currency]=usd
line_items[3][price_data][unit_amount]=500
line_items[3][price_data][product_data][name]=Shipping
line_items[3][price_data][product_data][description]=Flat shipping
```

Before this change the same tee lines read `Wrong Turn Tee (quantity 1)` with
description `Original catalog quantity: 1`, and a line could not carry a size.

Attempts claimed before this change (`stripe-whole-line-v1`) keep their
original wording: `tests/checkout-sessions.test.mjs` ("an attempt claimed
before line options retries with its original v1 Stripe parameters") stores a
v1 merchandise record as Payments 0.5.0 wrote it, loses the create response,
and shows the retry resending the v1 lines under the same idempotency key;
`tests/stripe-checkout.test.mjs` shows the Stripe adapter sending "Hat
(quantity 2)" / "Original catalog quantity: 2" for a v1 attempt and refusing
v1 lines presented as current.

## 049: expired with no PaymentIntent

`tests/checkout-sessions.test.mjs` ("an expired checkout where no card was
ever submitted is finished and not paid") shows lookup answering
`expired-unpaid` with no PaymentIntent read; a missing `payment_intent` field,
an open Session and a paid Session stay as before. Stripe's changelog entry
for API 2022-08-01, "Deferred PaymentIntent creation in Checkout Session
payment mode", says a PaymentIntent "is created when the Session is
confirmed" (https://docs.stripe.com/changelog/2022-08-01/deferred-paymentintent-checkout-session).
The three stuck test sessions on the reporting store were not read: this
session has no access to that store's Stripe account.

## Checks

`bin/verify-payments quick`: 306 tests pass, typecheck, repository contract clean.
`npm run test:plugin-runtime`: 34 pass.
