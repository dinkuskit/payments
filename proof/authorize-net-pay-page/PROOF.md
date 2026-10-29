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

## Real sandbox run (28 Oct 2026)

Run by Ronald's operator on his Mac, Node `v24.22.0`, a fresh clone of this branch at `25f428c`, with the DinkusKit Authorize.net sandbox keys entered without echo and unset afterwards. Both scripts use the real `fetch` transport against `https://apitest.authorize.net`; the pay page script drives the real port and the real hosted HTTP handler and counts every provider call.

`node --import tsx scripts/authorize-net-sandbox-proof.mjs --run`

```text
sandbox target: PASS
authenticateTestRequest: PASS
Accept Hosted token: PASS
sandbox transaction and authoritative lookup: PASS
webhook HMAC-SHA512: PASS
transaction-id: 120092836245
```

`node --import tsx scripts/authorize-net-pay-page-proof.mjs --run`

```text
sandbox target: PASS
checkout session from the sandbox: PASS (calls=1; getHostedPaymentPageRequest)
session is a pay page link without the token: PASS
wrong secret refused before any provider call: PASS (status=404)
other store's path refused before any provider call: PASS (status=404)
allowed visit posts the stored token, no new call: PASS (status=200)
allowed visit after 11 minutes mints a new sandbox token: PASS (status=200; calls=1)
Commerce's session unchanged after the refresh: PASS
pay page saved: pay-page-proof.html (open it in a browser; it posts to test.authorize.net)
ended checkout sent back to the store before any provider call: PASS (status=303)
provider calls in total: 2 (getHostedPaymentPageRequest, getHostedPaymentPageRequest)
```

The saved page, opened in Chrome, posted itself to `test.authorize.net` and showed the Authorize.net form titled "Secure Information" with a card payment form for $1.00. No card was entered and Pay was not pressed. A screenshot is kept on Ronald's Mac.

So at final I/O: the allowed visit refreshed a real sandbox token (one `getHostedPaymentPageRequest`), and wrong-secret, cross-site and ended visits made no provider call.

## Still to prove after deploy

The same flow through the deployed Payments Worker on payments.dinkuskit.com from a beta store checkout. That needs a Payments deploy (`--keep-vars`, quiet beta) on Ronald's go.
