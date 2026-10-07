# Checkout Sessions adapter

Payments implements Commerce `CheckoutPaymentPort` for Stripe hosted Checkout
Sessions. Commerce remains authoritative for attempts, orders, and receipts.
This slice does not edit Commerce.

## Contract fixture

`@dinkuskit/commerce` is unpublished. Types are consumed through
`src/commerce/checkout-port.ts`, a fixture of
`CurrentPaymentRequest`, `LegacyExact1800PaymentRequest`, `PaymentRequest`,
`PaymentSession`, `PaymentOutcome`, and `CheckoutPaymentPort`.

Recorded Commerce source identity:
`git:70419ae55c4f73354e3f0eda08b09bbc85368000`
(`checkout-pricing-payments-handoff.md`, qualified pre-release Commerce pin;
not merged or published).
`PaymentSession.createdAt` and `expiresAt` are Unix epoch seconds.
Existing onboarding times stay milliseconds.

## Behavior

- One immutable server-selected merchant Stripe binding. Direct charges use
  the connected-account `Stripe-Account` context.
- USD only, positive safe-integer string minor units, card only.
- Current payment requests specify `paymentWindow: { minSeconds: 1800, maxSeconds: 1860 }`.
  Legacy requests specify `paymentWindowSeconds: 1800`.
- Returned session fields use provider `created` and `expires_at`
  only when both are safe integers, `expires_at === requestedExpiresAtSeconds`,
  and duration `expires_at - created` satisfies the frozen policy:
  inclusive `1800..1860` for current requests, and exact `1800` for legacy requests.
- For new current claims, `ensureSession` detaches a canonical validated request before the first
  await and persists exact transport params (lines in Commerce order, amount,
  window policy, return URLs, site, account, idempotency key, and pinned
  `requestedExpiresAtSeconds = Math.floor(claimedAtMs / 1000) + 1860`) **before**
  provider contact. Concurrent writers share that claim. Replay reads the record,
  not the current caller object or current service configuration. Fingerprints compare
  canonical values; line order is significant.
- Unclaimed legacy requests return `unknown` immediately without contacting the provider.
  Existing historical legacy claims safely default policy to exact 1800 and remain recoverable.
- Current requests may carry the exact
  `dinkuskit.commerce.checkout-pricing/v1` snapshot. Payments validates the
  complete USD arithmetic, ordered original lines, frozen shipping identity and
  optional coupon quote, then stores and fingerprints the complete snapshot
  before provider contact. Pricing-bearing legacy requests are rejected.
- Priced Stripe charges use each positive merchandise whole-line net as one
  quantity-one item, with the original catalog quantity retained in its
  description, plus one frozen shipping item. Zero-net merchandise and free
  shipping are omitted. More than 100 positive mapped items is rejected
  before provider contact; this conservative Stripe item limit is not
  truncation or fallback.
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
 identity. A verified canonical event ID queues an immutable, event-keyed wake
 with its matching site, binding, attempt, account, and mode. The attempt-only
 SQLite wake table remains for historical/legacy work. An internal bounded
 consumer acknowledges only the exact event after an explicit authoritative
 reconciliation success; false, unknown, pending, or thrown results remain
  retryable. Overlapping consumers for one live Durable Object/store are
  serialized around the whole batch, including the awaited reconciliation
  callback; the conditional ACK reports success only when one SQLite row
  changes. This is an in-memory live-object guard, not exactly-once delivery
  across a crash, restart, or separate host. Its Commerce consumer is a later
  integration dependency, with no hosted consume endpoint. Paid is never
  taken from the event. Failed durable wake is not HTTP 200. Raw event,
  customer, and payment payloads are not stored.

## Feasibility limits

These are tested conservative limits, not weakened contract outcomes. This
pricing adoption used synthetic official-SDK transport only; it has no real
Stripe, Registry installation, deployment, activation, publication, or
production acceptance proof.

1. **Stripe `expires_at` is a requested timestamp; `created` is Stripe's
   clock.** Commerce PR37 permits provider duration `1800..1860` seconds for current
   requests, accommodating up to 60 seconds of provider clock delay or transport
   latency while ensuring at least 30 minutes (1800s) of active window. Stripe
   documents `expires_at` as 30 minutes to 24 hours after creation. When the provider
   window is not within `1800..1860` (or exact 1800 for legacy), Payments persists
   session ID and URL so it will not create again, returns `unknown`, and never
   substitutes claim time. Later retrieve drift from the stored provider timestamps
   fails closed.
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

The complete priced claim also stores the versioned, exact whole-line transport
input before the provider await. Missing or inconsistent mapping data cannot
authorize another create. More than100 positive mapped items (including
shipping) fails before storage/provider contact. Internal shipping configuration
IDs/revisions stay in the durable snapshot and are not rendered on Stripe.

The pinned compiled-package synthetic proof is reproducible with
`node --import tsx scripts/verify-commerce-pricing-package.mjs <pinned-commerce.tgz> <emdash-package-directory>`
(the default exact historical EmDash `1.0.1` peer), or with the explicit
compatibility mode
`node --import tsx scripts/verify-commerce-pricing-package.mjs <pinned-commerce.tgz> <emdash-1.2.0-package-directory> --emdash-peer=1.2.0`.
Only `1.0.1` and `1.2.0` are accepted; the peer manifest version must match
the selected mode before the Commerce archive is extracted or any provider
fixture is created. When the selected peer's runtime closure is available,
either mode verifies the same immutable qualified Commerce source
`git:70419ae55c4f73354e3f0eda08b09bbc85368000` and npm archive SHA-256
`38c1c6b59ad37db506986dc9de72fa53f601f7c66d5df53a1c39e9ca3c351730`,
intercepts every transport, and proves canonical order/coupon settlement after
SQLite reopen.

The `1.2.0` result is synthetic package compatibility only. It is not proof of
an installed EmDash host, PluginContext, migrated Core, Registry/backend/schema
handoff, Template HTTP/JWT/SQLite/wake behavior, deployment, or live provider
traffic. Those require a forthcoming qualified Commerce 1.2 archive and the
corresponding installed-host proof.
See `.grilltrack/proof/checkout-pricing/PACKAGED-BEHAVIOR.json` for outcomes and
explicit host/auth/provider fidelity limits.
