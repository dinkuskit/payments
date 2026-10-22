# Production deployment

The production Worker is `dinkus-payments` in Cloudflare account
`cddb32366789cab1bdf4c25584dc1920`. Its custom domain is
`https://payments.dinkuskit.com`. The checked-in local configuration remains
`wrangler.jsonc` and deploys the separate `dinkus-payments-local` Worker.

This configuration is Stripe TEST mode only. Authorize.net sandbox credentials
are intentionally deferred.

## Deploy

Use the pinned Node version from `.nvmrc` and authenticate Wrangler to the
account out of band. Never put credentials in this repository:

```sh
npx wrangler login
npx wrangler secret put STRIPE_API_KEY --config wrangler.production.jsonc
# paste an sk_test_... value only when Wrangler prompts
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.production.jsonc
# paste the whsec_... value only when Wrangler prompts
npx wrangler deploy --config wrangler.production.jsonc
```

`STRIPE_API_KEY` must be a Stripe test secret key beginning with `sk_test_`.
`STRIPE_WEBHOOK_SECRET` must be the signing secret for the webhook below.
Secrets are owner-managed with `wrangler secret put`; neither value belongs in
vars, shell history, logs, or committed files.

The production non-secret values are in
`wrangler.production.jsonc`. The account identity contract is:

- issuer: `https://dinkuskit.com/account`
- audience: `dinkus-payments`
- JWKS: `https://dinkuskit.com/account/.well-known/jwks.json`

The onboarding return values currently land on `https://dinkuskit.com/account`.
Checkout returns go to each store's own pages: after paying,
`https://<store>/checkout/success?session_id={CHECKOUT_SESSION_ID}` (Authorize.net
returns to `https://<store>/checkout/success`), and after cancelling,
`https://<store>/checkout`. `<store>` is the web address DinkusKit.com checked when
the store connected and signs into the store's pass as `site_origin`; nothing in
a request can change it. A pass without it cannot start a checkout
(`409 store_origin_missing`), so DinkusKit.com must be deployed with that claim
before this Worker.

## Stripe webhook (event destination)

Store checkouts run on each store's connected account, so Stripe tells Payments
about a payment only through an event destination that listens to connected
accounts. Create it in the Stripe Dashboard under **Workbench > Webhooks**,
**Add destination**, with these settings:

- **Environment:** the same Stripe environment that issued `STRIPE_API_KEY`.
  Today that key belongs to a Stripe **Sandbox**, not to the account's
  **Test mode**, so switch to that Sandbox before adding the destination.
- **Events from:** **Connected accounts**.
- **Payload style:** **Snapshot**.
- **API version:** `2026-08-26.dahlia`, the version Payments pins for Checkout
  Sessions (`LEGACY_STRIPE_API_VERSION` in `src/stripe/onboarding.ts`).
- **Events:** only `checkout.session.completed`.
- **Endpoint URL:** this exact address:

```text
https://payments.dinkuskit.com/v1/webhooks/stripe
```

Then put the new destination's signing secret (it starts with `whsec_`) in
`STRIPE_WEBHOOK_SECRET` with `wrangler secret put` as shown above, and turn off
any older destination for the same URL so only one secret is in play.

Two settings fail silently, with no error anywhere:

- **Wrong environment.** A Sandbox has its own events and webhooks, separate
  from Test mode. A destination made in Test mode never hears a checkout that
  ran in the Sandbox, and the reverse is also true. Stripe shows no failed
  delivery because it never attempts one.
- **"Your account" instead of "Connected accounts".** A checkout on a store's
  connected account is that account's event, so a destination listening to
  your own account never receives it. Payments also refuses any event without
  the signed `account` field.

When the setup is right, the next paid TEST order turns the setup page's
**Place a test order** step to **Complete**. If it stays on "Waiting for
Stripe's payment notice", check the destination's event deliveries in the
same environment: no deliveries means one of the two settings above; HTTP 400
`invalid_signature` means `STRIPE_WEBHOOK_SECRET` does not match this
destination.

The Worker verifies the raw signature, TEST mode, connected account, site and
attempt metadata before queuing reconciliation. A webhook never marks an
order paid by itself. Commerce settles a payment whose shopper never returns
to the store only from these notices, so a store must not take real orders
until this destination works.

Payments reads only the event's `id`, `livemode` and `account`, and the
Checkout Session's `object`, `id`, `livemode` and `metadata`, so a destination left on a newer
or preview API version keeps working today. Move it to `2026-08-26.dahlia`
the next time anyone edits it, so a future Stripe version change cannot alter
those fields under Payments.

**Going live**, once Payments supports live mode, needs its own destination: the same settings in live mode
(Connected accounts, `checkout.session.completed`, the URL above) with its own
signing secret in the live Worker's `STRIPE_WEBHOOK_SECRET`. A TEST
destination or secret never carries live events.

## Post-deploy checks

The unauthenticated health route is:

```text
GET https://payments.dinkuskit.com/health
```

It should return HTTP 200 with `{"status":"ok","mode":"test"}`. The Registry
setup plugin reads the authenticated status route:

```text
GET https://payments.dinkuskit.com/v1/status
Authorization: Bearer <short-lived DinkusKit payments:admin JWT>
X-Dinkus-Site: <server-issued-site-id>
```

Without those headers, HTTP 401 is expected. The plugin supplies the endpoint
from its server-owned production configuration; it does not accept a browser
or site-provided endpoint. The request is server-to-server, so CORS is not
needed or enabled. Confirm an owner session reaches the status route and
receives a valid `{ state, mode: "test" }` response. A configured but
temporarily unavailable provider should be reported as a status/checking
state, not treated as ready.

Once a store has a provider-confirmed paid TEST checkout, the status response
adds `testOrder` ([test order check](docs/test-order-check.md)). The setup page
built from the same version reads it; an older build rejects the unknown field
and shows "Checking Payments setup", so deploy this Worker together with the
matching Registry plugin build.

Do not register `/health` or `/v1/status` as Stripe webhook URLs. Do not
deploy live keys, live mode, Authorize.net keys, or coupon changes.
