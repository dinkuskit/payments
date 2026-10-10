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
Checkout returns currently target
`https://dinkuskit.com/checkout/success` and
`https://dinkuskit.com/checkout/cancel`; the site owner must confirm those
Commerce pages exist before accepting customer traffic.

## Stripe test webhook

In the Stripe Dashboard's **Test mode**, register this exact endpoint:

```text
https://payments.dinkuskit.com/v1/webhooks/stripe
```

Subscribe only to:

```text
checkout.session.completed
```

Use the endpoint's generated `whsec_...` value for
`STRIPE_WEBHOOK_SECRET`. Stripe must send the connected-account context; the
Worker verifies the raw signature, TEST mode, connected account, site and
attempt metadata before queuing reconciliation. A webhook never marks an
order paid by itself.

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

Do not register `/health` or `/v1/status` as Stripe webhook URLs. Do not
deploy live keys, live mode, Authorize.net keys, or coupon changes.
