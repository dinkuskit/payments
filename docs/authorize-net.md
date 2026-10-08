# Authorize.net adapter

This is an isolated `authorize_net` adapter behind the same server-owned
provider selection boundary as Stripe. Stripe remains the reference adapter.
Commerce owns prices, USD integer minor-unit totals, attempt state, orders,
receipts, and the final payment decision.

## Implemented safety shape

- Accept Hosted is used; raw card fields are never accepted by this repository.
- The create request sends `authCaptureTransaction`, a decimal USD amount only
  at the transport edge, and the same store-bound invoice reference in `refId`
  and `order.invoiceNumber`.
- Authorize.net's `getTransactionDetailsRequest` is the only source that can
  produce `paid` or terminal `unpaid`. A lost create response, a pending status,
  a browser return, and an unrecognized status remain `unknown`.
- Details responses provide `authAmount` and, when present, `settleAmount`;
  both are checked against the Commerce attempt amount. Details do not provide
  `currencyCode`, so the adapter uses the server-owned merchant currency
  configuration, currently restricted to USD, and fails closed for any other
  configured currency. Currency is never inferred from a shopper response.
- `X-ANET-Signature` is verified as HMAC-SHA512 over the original request bytes.
  After signature verification the Worker parses the store-bound invoice
  reference and rejects cross-store or malformed references before any
  transactionId storage, wake insertion, or paid lookup. Replay and wake
  identity are the signed `notificationId`; a caller event ID that does not
  match is rejected before wake. A failed wake stays retryable. The webhook
  body never marks Commerce paid.
- Unknown providers fail closed and there is no fallback or checkout-request
  provider selection.
- The Worker selects `PAYMENT_PROVIDER` from server-owned configuration. When
  it is `authorize_net`, the checkout port uses the test Accept Hosted endpoint,
  persists the hosted token and transaction mapping in the PaymentConnection
  Durable Object, and returns the Commerce hosted-session contract.
  `AUTHORIZE_NET_MODE` must remain `test`; live mode fails closed.
- `POST /v1/webhooks/authorize-net/{siteId}` verifies `X-ANET-Signature` and
  durable notification replay identity before waking reconciliation. A signed
  notification may attach a transaction identifier for later lookup, but it
  never establishes `paid`.

## Invoice reference format

Authorize.net limits `refId` and `invoiceNumber` to 20 characters and accepts
`[A-Za-z0-9._-]`. Payments encodes a store-bound reference instead of the raw
Commerce attempt id:

```text
{storeTag}.{attemptId}
```

Length budget (20 total; overflow fails closed, never truncates):

| Part | Size | Notes |
| --- | ---: | --- |
| `storeTag` | 8 | Lowercase hex of the first 4 bytes of `SHA-256(UTF-8 siteId)` |
| separator | 1 | Literal `.` |
| `attemptId` | 1..11 | Commerce attempt id; `[A-Za-z0-9._-]` |

Malformed or legacy bare attempt ids (no store tag) are rejected with no
durable writes. Colliding attempt ids across two stores cannot apply a validly
signed notification to the wrong store: the store tag in the signed body must
match both the URL `siteId` and the stored attempt's site before any
transactionId or wake write.

## Proof boundary

Mock proof uses an injected transport and contains no credentials. It covers
request shape, USD conversion, authoritative lookup, unknown outcomes, lost
creation responses, duplicate wake suppression after success, failed-wake retry,
signed-notification ID mismatch, forged return URLs, signature tampering/replay,
and amount/currency mismatch.

Sandbox proof is a separate, not-yet-run path. It requires these process
environment variables, supplied out of band and never committed or printed:

```text
AUTHNET_SANDBOX_API_LOGIN_ID
AUTHNET_SANDBOX_TRANSACTION_KEY
AUTHNET_SANDBOX_SIGNATURE_KEY
```

The sandbox endpoint is
`https://apitest.authorize.net/xml/v1/request.api`. No live endpoint,
credentials, deployment, or live traffic is part of this change.
The opt-in proof command runs on Node `22.23.2` from `.nvmrc`:

```bash
npm ci
node --import tsx scripts/authorize-net-sandbox-proof.mjs --run
```

`npm ci` must be run first. Without `--run`, the script prints a clear
`DRY-RUN PASS` notice and exits 0 without contacting the sandbox. With
`--run`, it prints only named PASS/FAIL checks and a non-secret transaction
identifier; it never prints credential values or the hosted token. The
script-only direct transaction uses the published sandbox test card solely to
prove lookup; the adapter itself remains Accept Hosted-only.

## Configuration

These are host secret bindings, never plugin settings or source:

```text
AUTHORIZE_NET_API_LOGIN_ID
AUTHORIZE_NET_TRANSACTION_KEY
AUTHORIZE_NET_SIGNATURE_KEY
```

Set `PAYMENT_PROVIDER=authorize_net` and keep `AUTHORIZE_NET_MODE=test` in
server-owned Worker configuration to exercise this path. Empty local
placeholders are provided in `.dev.vars.example`.
The server-owned connection binding stores the provider merchant identity in
`authorizeNetMerchantId`; it never stores it in Stripe's `stripeAccountId`
field. Stripe bindings use `stripeAccountId` only. Missing or cross-provider
identity fields fail closed.

## Open decisions

- Accept Hosted does not report a provider expiry. The test-only wiring uses
  the already-approved Commerce request window as the local hosted-session
  lease; it does not treat that lease as provider evidence. Resolve any
  production expiry policy against issue #6 before enabling production
  checkout.
- Refund and void operations are intentionally not implemented here. They must
  follow issue #7's refund design once that contract is available.
- The live endpoint and live credentials remain explicitly disabled. The
  credentialed sandbox proof is left for stack-pilot to run on its box against
  the wiring branch.

## Documentation checked

- [Accept Hosted](https://developer.authorize.net/api/reference/features/accept_hosted.html)
- [API reference: Get a Hosted Payment Page](https://developer.authorize.net/api/reference/index.html#accept-suite-get-a-hosted-payment-page)
- [API reference: Get Transaction Details](https://developer.authorize.net/api/reference/index.html#payment-transactions-get-transaction-details)
- [Webhooks](https://developer.authorize.net/api/reference/features/webhooks.html)
- [Testing guide](https://developer.authorize.net/hello_world/testing_guide/)
