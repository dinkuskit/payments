# Business country

Accounts v2 needs `identity.country` before `configuration.merchant`. The store
owner picks it on Payment settings (`payments-business-country-047`), in TEST and
LIVE alike, for every store. There is no operator list and no store cap.

## Owner choice

- While the store has no Stripe connection, Payment settings shows a
  **Business country** select and a **Set up Stripe** submit. The owner picks
  the country where the business is registered.
- The options are the countries where Stripe opens accounts without an invite
  or extended-network review (`src/business-country.ts`, from stripe.com/global).
  "Choose a country" comes first; nothing is preselected.
- Payments never infers a country from IP, hosting, currency, email, the
  browser, or Commerce's store or shipping countries. Payments works without
  Commerce, so it does not read Commerce settings.
- Once saved, Payment settings shows the country read-only ("Business country:
  <name>. Stripe can't change it.") with **Set up or resume Stripe**.
- Authorize.net stores are never asked: the owner brings an existing merchant
  account whose country the acquirer already set.

## Hosted service

`POST /v1/connect` accepts either no body or exactly `{"country":"XX"}` with a
listed code (at most 64 bytes). Any other body or query is `unexpected_input`.

- A new Stripe connection without a listed country is refused with
  `merchant_country_required` before any state or provider call, so nothing is
  created.
- The country is saved in the connection's `creationCountry` before the create
  POST and sent as `identity.country`. It is fixed from then on: retries resend
  the same country under the same idempotency key, and a different requested
  country is ignored. Stripe does not let an account change country.
- An attempt that may have reached Stripe without a country (a saved platform
  scope or creation failure but no saved country) is never given one; it reads
  `recovery_required`.
- A saved account resumes and reads status without a country.
- `GET /v1/status` adds `businessCountry` (the saved code, or `null` while none
  is saved) only for the server-selected Stripe provider and only when the
  request carries `X-Dinkus-Payments-Include: business-country`. Released
  plugins decode status strictly and never send that header; an older Worker
  ignores it, and the plugin then shows the plain setup button.

Stripe remains authoritative for eligibility. A listed country Stripe still
refuses is recorded as a creation failure like any other.

## Removed

The operator-only TEST bindings `STRIPE_TEST_MERCHANT_COUNTRY_SITES` and
`STRIPE_TEST_MERCHANT_COUNTRY_CONFIG` (16-store cap), the
`STRIPE_TEST_LEGACY_V2_RECOVERY` attestation and the
`/v1/connect/reconcile-legacy-rejection` route are gone. No real stores existed,
so no compatibility path was kept. Delete those variables from the Worker after
deploying this change.
