# Authorize.net pay page proof

Scope: [Payments #99](https://github.com/dinkuskit/payments/issues/99), GrillTrack `payments-authorize-net-pay-page-045`. Base: main `ac29a29`.

No live provider, credential, deployment or store was touched. Provider calls below are synthetic: a stubbed transport in unit tests, and a stubbed `fetch` for `https://apitest.authorize.net/xml/v1/request.api` inside the Worker runtime test.

## Who can make Payments call Authorize.net

The pay page path is `/v1/pay/authorize-net/{siteId}/{sessionId}`. It is routed to that site's Durable Object, and the stored record must match all of the following before any provider call is made:

| Visit | Result | Provider calls |
| --- | --- | --- |
| Malformed session, wrong 128-bit secret, other attempt, uppercase secret, dot segments | 404 | 0 |
| Exact session sent to another site's path | 404 | 0 |
| Checkout started before the pay page (no stored session) | 404 | 0 |
| Checkout past `expiresAt` | 303 to the store's checkout | 0 |
| Live checkout, stored token under 10 minutes old | 200, posts the stored token | 0 |
| Live checkout, stored token 10+ minutes old | 200, posts a newly minted token | 1 `getHostedPaymentPageRequest` |
| Visit that crosses `expiresAt` during the transaction read | 303 to the store's checkout | read only, no mint |
| Visit that crosses `expiresAt` during the mint | 303 to the store's checkout; the token is neither shown nor stored | 1 |
| Paid, fraud-held or unreadable try | 303 to the store's success page | reads only |

Covered by `tests/authorize-net.test.mjs` (port level, every provider call counted) and `tests/runtime/authorize-net-pay-page.test.ts` (through `worker.fetch`, with wrong-secret, cross-site and expired visits making zero provider calls, and an allowed visit making exactly one `getHostedPaymentPageRequest` call).

## Checkouts stored before this change

Run on Node 24.22.0: a checkout was written by the adapter from main `ac29a29` (`git show ac29a29:src/authorize-net/checkout.ts`), then read by this branch's adapter over the same store.

```text
record written by main ac29a29: {"token":"hosted-token","transactionId":"123","createdAt":1800000000,"expiresAt":1800001860,"bindingRef":"bind-one","siteId":"store-a","amountMinor":"1200","currency":"USD","transactionIds":["123"]}
session from main: {"sessionId":"hosted-token","redirectUrl":"https://test.authorize.net/payment/payment?token=hosted-token","createdAt":1800000000,"expiresAt":1800001860}
same session after upgrade: true
lookup, declined try inside the window: open
lookup after a paid try: paid 123 session unchanged: true
pay page for an old checkout: {"action":"not_found"}
record after upgrade: {"token":"hosted-token","transactionId":"124","createdAt":1800000000,"expiresAt":1800001860,"bindingRef":"bind-one","siteId":"store-a","amountMinor":"1200","currency":"USD","transactionIds":["123","124"]}
```

Commerce sees the same session it stored, so `samePaymentSession` holds. Reconciliation and webhook transaction recording keep working, and the record gains no new fields. The same record is pinned as a unit test ("a checkout stored before the pay page keeps its session and still reconciles").

## Still to prove after deploy

A sandbox shopper opening the real Authorize.net form through the pay page, right away and 20 minutes later. That needs a Payments deploy (`--keep-vars`, quiet beta) and the Authorize.net sandbox run, both on Ronald's go.
