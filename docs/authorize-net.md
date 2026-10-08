# Authorize.net adapter

This is an isolated `authorize_net` adapter behind the same server-owned
provider selection boundary as Stripe. Stripe remains the reference adapter.
Commerce owns prices, USD integer minor-unit totals, attempt state, orders,
receipts, and the final payment decision.

## Implemented safety shape

- Accept Hosted is used; raw card fields are never accepted by this repository.
- The create request sends `authCaptureTransaction`, a decimal USD amount only
  at the transport edge, and the same bounded attempt identity in `refId` and
  `order.invoiceNumber`.
- Authorize.net's `getTransactionDetailsRequest` is the only source that can
  produce `paid` or terminal `unpaid`. A lost create response, a pending status,
  a browser return, and an unrecognized status remain `unknown`.
- `X-ANET-Signature` is verified as HMAC-SHA512 over the original request bytes.
  A verified webhook only wakes reconciliation. Event IDs have a replay fence;
  the webhook body never marks Commerce paid.
- Unknown providers fail closed and there is no fallback or checkout-request
  provider selection.

Authorize.net currently limits `refId` and `invoiceNumber` to 20 characters;
the adapter rejects identities that cannot fit rather than truncate them.

## Proof boundary

Mock proof uses an injected transport and contains no credentials. It covers
request shape, USD conversion, authoritative lookup, unknown outcomes, lost
creation responses, duplicate wake suppression, forged return URLs, signature
tampering/replay, and amount/currency mismatch.

Sandbox proof is a separate, not-yet-run path. It requires these process
environment variables, supplied out of band and never committed or printed:

```text
AUTHORIZE_NET_API_LOGIN_ID
AUTHORIZE_NET_TRANSACTION_KEY
AUTHORIZE_NET_SIGNATURE_KEY
```

The sandbox endpoint is
`https://apitest.authorize.net/xml/v1/request.api`. No live endpoint,
credentials, deployment, or live traffic is part of this change.
The opt-in proof command is:

```bash
node --import tsx scripts/authorize-net-sandbox-proof.mjs --run
```

Without `--run`, the script only checks readiness. It never prints the
credential values or the returned hosted token.

## Open decisions

- The checkout-window decision remains open for Accept Hosted tokens. The
  adapter does not invent a provider expiry or claim a Commerce payment window.
  Resolve this against the approved checkout-window design in issue #6 before
  enabling production checkout.
- Refund and void operations are intentionally not implemented here. They must
  follow issue #7's refund design once that contract is available.
- Credential storage and readiness ownership remain deployment decisions;
  this repository only defines the credential names needed by the sandbox
  proof path.

## Documentation checked

- [Accept Hosted](https://developer.authorize.net/api/reference/features/accept_hosted.html)
- [API reference: Get a Hosted Payment Page](https://developer.authorize.net/api/reference/index.html#accept-suite-get-a-hosted-payment-page)
- [API reference: Get Transaction Details](https://developer.authorize.net/api/reference/index.html#payment-transactions-get-transaction-details)
- [Webhooks](https://developer.authorize.net/api/reference/features/webhooks.html)
- [Testing guide](https://developer.authorize.net/hello_world/testing_guide/)
