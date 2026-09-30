# Checkout Sessions adapter

Payments implements Commerce `CheckoutPaymentPort` for Stripe hosted Checkout
Sessions. Commerce remains authoritative for attempts, orders, and receipts.
This slice does not edit Commerce.

## Contract fixture

`@dinkuskit/commerce` is unpublished. Types are consumed through
`src/commerce/checkout-port.ts`, a types-only fixture of
`PaymentRequest`, `PaymentSession`, `PaymentOutcome`, and
`CheckoutPaymentPort`.

Recorded Commerce source identity:
`git:1cb55c756ef746bcb042b9679dc43b57e67bcb0d`
(`github:dinkuskit/commerce/pull/29`, published head). Checkout port and
Money types are unchanged from `7a054ea6e7a148dd0e1039ec138d967f02431ceb`.
`PaymentSession.createdAt` and `expiresAt` are Unix epoch seconds.
Existing onboarding times stay milliseconds.

## Behavior

- One immutable server-selected merchant Stripe binding. Direct charges use
  the connected-account `Stripe-Account` context.
- USD only, positive safe-integer string minor units, card only, 1800-second
  window. Returned session fields use provider `created` and `expires_at`
  only when both are safe integers and `expires_at === created + 1800`.
- `ensureSession` detaches a canonical validated request before the first
  await and persists exact transport params (lines in Commerce order, amount,
  window, return URLs, site, account, idempotency key, and pinned
  `expires_at`) **before** provider contact. Concurrent writers share that
  claim. Replay reads the record, not the current caller object or current
  service configuration. Fingerprints compare canonical values; line order
  is significant.
- The same key is retried for at most 23 hours. After that, Payments does not
  create again. Stripe may prune idempotency results after 24 hours.
- `lookup` never creates. Missing mappings and readiness denial return
  `unknown`. This adapter does not emit `not-created`; absence is not a
  durable terminal creation fence across delayed, in-flight, or restart
  creates.
- New checkout uses the readiness-gated `GET /v1/checkout-binding`. Existing
  attempts use `GET /v1/existing-binding` / `existingBinding`, which keep the
  original recipient after readiness regresses.
- Webhooks verify the original `Uint8Array` with Stripe
  `constructEventAsync` (WebCrypto) before any event field is read. Connected
  account events require signed `event.account`. The `Stripe-Account` header
  is only an extra consistency check and cannot replace missing signed
  identity. A verified event queues a durable wake for the matching attempt. The
  SQLite wake queue is tested across replay and eviction; its Commerce
  consumer is a later integration dependency. Paid is never
  taken from the event. Failed durable wake is not HTTP 200. Raw event,
  customer, and payment payloads are not stored.

## Feasibility limits

These are tested conservative limits, not weakened contract outcomes.

1. **Stripe `expires_at` is a requested timestamp; `created` is Stripe's
   clock.** Commerce requires `expiresAt === createdAt + 1800`. Stripe
   documents `expires_at` as 30 minutes to 24 hours after creation and does
   not guarantee that pair. When the provider window is not exact 1800,
   Payments persists session ID and URL so it will not create again, returns
   `unknown`, and never substitutes claim time. Later retrieve drift from
   the stored provider timestamps fails closed.
2. **Malformed session IDs and credentialed or non-`checkout.stripe.com`
   URLs fail closed.** A valid session ID is stored even when the URL is
   rejected, so a later retrieve can recover without a second create.
3. **`Session.url` is null after terminal statuses.** Commerce still needs
   the original redirect URL. Payments returns the first stored URL and does
   not invent one.
4. **Expired + unpaid is not terminal unpaid.** Stripe documents
   `complete` as possibly still processing, and a PaymentIntent can remain
   `processing` or later `succeeded` after the Session object expires.
   `expired-unpaid` requires an authoritative `canceled` PaymentIntent whose
   latest charge is proven absent (`latest_charge: null`, confirmation not
   attempted) or expanded with status `failed`. Pending, unknown, and unexpanded charge IDs or
   omitted `latest_charge` stay `unknown`. Stripe documents that a canceled
   PaymentIntent makes no additional charges; this slice does not list all
   historical charges.
5. **`payment_status=paid` without a `succeeded` PaymentIntent stays
   `unknown`.** Commerce paid requires a payment identity we can prove.
6. **`not-created` is not emitted.** Commerce treats it as a terminal
   creation fence. This adapter has no atomic permanent tombstone that
   excludes delayed or in-flight creates across readiness races and restart,
   so it returns `unknown` instead of inventing terminal certainty.

7. **A lost response beyond the retry bound stays `unknown`.** Without a
   mapped session ID, lookup cannot prove absence or safely replay after
   idempotency retention. No replacement session is created.

## Provenance

Otta research was pinned at `7c63e6c2b21927b4760d396cc79da321de131f15` for
behavior lessons only: verify signatures before reading event fields, fail
closed on amount/currency/account mismatch, and do not treat retryable
transport as terminal. No Otta source was copied. There is no `@otta-sh`
dependency. LICENSE at the research snapshot was MIT, copyright 2026
Vedanshu; unused here because no Otta code was adapted.

Primary Stripe sources:

- https://docs.stripe.com/api/idempotent_requests
- https://docs.stripe.com/api/checkout/sessions/create
- https://docs.stripe.com/api/checkout/sessions/retrieve
- https://docs.stripe.com/api/checkout/sessions/object
- https://docs.stripe.com/api/payment_intents/object
- https://docs.stripe.com/api/payment_intents/cancel
- https://docs.stripe.com/api/events/object
- https://docs.stripe.com/webhooks/signature
- https://docs.stripe.com/connect/webhooks
- https://docs.stripe.com/connect/direct-charges

## Verification classes

| Class | What it proves | What it does not prove |
| --- | --- | --- |
| Synthetic SDK transport | Official `stripe` package + fake `HttpClient` request shape | Live Stripe network |
| Domain + HTTP tests | Recovery, mismatch, webhook identity, unknown vs terminal | Durable Object restart |
| Cloudflare workerd/SQLite | Mapping and binding survive eviction | Production deployment |
| Actual Stripe | Not run | Test-mode or live charges |
