# Scope: Attach an Existing Stripe Account Through Connect

Status: **Proposed** (`payments-existing-stripe-account-043`, awaiting owner approval; no runtime code, Worker deployment, secret change, or live-mode change is authorized by this document).
Issue: [`dinkuskit/payments#89`](https://github.com/dinkuskit/payments/issues/89).

## Context and problem

Today, clicking **Set up or resume Stripe** on the **Payment settings** page (`POST /v1/connect`) always creates a **new** connected Stripe account via the Accounts v2 API (`POST /v2/core/accounts` plus `POST /v2/core/account_links` on `2026-09-30.endive`).

An owner who already sells through their own Stripe account cannot attach it: they would have to set up and verify a second Stripe account and live with split payouts, payment history, and dashboards. This matters even more under the standalone Payments direction (`payments-standalone-direction-042`, `dinkuskit/payments#88`), where plain EmDash sites also connect through Payments and many site owners already operate an existing Stripe account.

Hard constraints from issue #89 and [`docs/CHARTER.md`](CHARTER.md):

- Owners never paste a Stripe secret key into the hosted service or the EmDash plugin.
- The EmDash Registry plugin (`emdash-plugin.jsonc`) must not add `global_fetch_strictly_public`; outbound plugin HTTP stays restricted to `allowedHosts: ["dinkuskit.com", "payments.dinkuskit.com"]` within the 10-bridge-call sandbox budget per route invocation.
- No Worker deployment, secret change, or live-mode change without Ronald's explicit approval.
- Building waits until `smokyclub.com` is selling, unless Ronald says otherwise.

---

## 1. What Stripe currently supports for linking an existing account

### Pinned Stripe API versions in `@dinkuskit/payments`

`src/stripe/onboarding.ts` and `src/stripe/checkout.ts` pin two API versions on the official `stripe` Node SDK (`23.0.0`):

- **`ACCOUNTS_STRIPE_API_VERSION = "2026-09-30.endive"`**: used for Accounts v2 (`v2.core.accounts.create`, `v2.core.accounts.retrieve`, and `v2.core.accountLinks.create`).
- **`LEGACY_STRIPE_API_VERSION = "2026-08-26.dahlia"`**: used for v1 endpoints (`checkout.sessions.create`, `checkout.sessions.retrieve`, `paymentIntents.retrieve`, and `accounts.retrieveCurrent`).

### Accounts v2 (`2026-09-30.endive`) has no native flow for attaching an existing account

1. **`POST /v2/core/accounts` + `POST /v2/core/account_links` only onboard a newly created connected account.** Calling `v2.core.accounts.create` always mints a brand-new `acct_...` object, and `v2.core.accountLinks.create` (`use_case.type = "account_onboarding"`) only collects KYC for that new `acct_...`.
2. **Networked onboarding is not existing-account attachment.** Stripe's [Networked onboarding](https://docs.stripe.com/connect/networked-onboarding) lets an authenticated owner reuse verified legal-entity KYC fields from an existing Stripe account when onboarding a **new** connected account, but it still creates a second `acct_...` with separate balances, payouts, and history.
3. **Stripe explicitly documents OAuth as an Accounts v1 requirement.** Under [Connect and the Accounts v2 API — Accounts API v2 limitations](https://docs.stripe.com/connect/accounts-v2#accounts-api-v2-limitations) and [Accounts v1 support for new Connect integrations](https://docs.stripe.com/connect/accounts-v2/account-creation#when-you-might-still-need-accounts-v1-support), Stripe states:
   > *"You must use Accounts v1 in the following cases: Using OAuth to authenticate connected accounts."*

### Connect OAuth for Standard accounts (`2026-08-26.dahlia`) and deprecation status

Stripe documents three distinct deprecation boundaries across Standard accounts and OAuth:

| Mechanism | Official Stripe status | Implication for `dinkuskit/payments` |
| --- | --- | --- |
| Creating **new** accounts with `POST /v1/accounts` (`type: "standard"`, `"express"`, `"custom"`) | **Deprecated** ([Using Standard connected accounts](https://docs.stripe.com/connect/standard-accounts)) | Do **not** use for new accounts. Keep `POST /v2/core/accounts` (`2026-09-30.endive`) for **Create a Stripe account**. |
| Linking an **existing** standalone account via Connect OAuth (`GET https://connect.stripe.com/oauth/authorize` + `POST https://connect.stripe.com/oauth/token`) | **Supported** for attaching existing accounts ([Using OAuth with Standard accounts](https://docs.stripe.com/connect/oauth-standard-accounts), [Connect OAuth reference](https://docs.stripe.com/connect/oauth-reference), [Accounts v1 support](https://docs.stripe.com/connect/accounts-v2/account-creation)) | Use for **I already have Stripe** (`response_type=code`, `scope=read_write`, `client_id=ca_...`). |
| Authenticating API requests with OAuth `access_token` / `refresh_token` / `stripe_publishable_key` | **Deprecated** ([Connect OAuth reference](https://docs.stripe.com/connect/oauth-reference)) | Discard `access_token` and `refresh_token` after the token exchange. Persist only `stripe_user_id` (`acct_...`) and authenticate API requests with the platform secret key plus `Stripe-Account: acct_...`. |
| Stripe App Marketplace OAuth (`https://marketplace.stripe.com/oauth/v2/authorize`, `scope=stripe_apps`) | Supported for Dashboard Apps ([Stripe Apps OAuth 2.0](https://docs.stripe.com/stripe-apps/api-authentication/oauth)), but requires Marketplace app review and storing rotating 1h/1y bearer tokens per merchant | **Reject** for store payment processing; Connect OAuth with `Stripe-Account` avoids storing per-merchant bearer/refresh secrets. |

Additional Stripe platform rules for Connect OAuth:

- **Platform isolation ([OAuth changes for platform-controlled Standard accounts](https://docs.stripe.com/connect/oauth-changes-for-standard-platforms))**: Since June 2021, a Connect Platform requesting `scope=read_write` can attach an existing **standalone** Stripe account, as well as a Standard account not controlled by another platform. If the owner selects an account that is already platform-controlled by another Connect platform, Stripe prompts them during OAuth to create or select a standalone account.
- **Non-idempotent single-use authorization code ([Connect OAuth reference](https://docs.stripe.com/connect/oauth-reference))**: `POST https://connect.stripe.com/oauth/token` is not idempotent; exchanging the same `code` more than once revokes the connection. The hosted Worker must consume the `state` + `code` atomically once.
- **Dashboard prerequisites ([Accounts v1 support for new Connect integrations](https://docs.stripe.com/connect/accounts-v2/account-creation))**: In the Stripe Dashboard for the DinkusKit Connect platform, **Accounts v1 support** (`Settings > Developers > API Policies > Accounts v1 Support`) and **OAuth for Standard accounts** (`Settings > Connect > Onboarding options > OAuth`, configuring `client_id` `ca_...` and the hosted `redirect_uri`) must be enabled before live or test OAuth links work.

---

## 2. What changes on our side

### Does linking an existing account keep today's choices?

**Yes.** Attaching an existing standalone Stripe account via Connect OAuth preserves all four architectural choices in [`docs/accounts-v2-migration.md`](accounts-v2-migration.md) and [`docs/hosted-connections.md`](hosted-connections.md):

1. **Direct charges (`src/stripe/checkout.ts`)**:
   - `createStripeCheckout` already uses `LEGACY_STRIPE_API_VERSION = "2026-08-26.dahlia"` and passes `{ stripeAccount: stripeAccountId }` (`Stripe-Account: acct_...`) on `checkout.sessions.create`, `checkout.sessions.retrieve`, and `paymentIntents.retrieve`.
   - Connected-account webhooks (`src/checkout/webhook.ts`, `src/cloudflare/worker.ts`) verify the webhook payload signature and match `event.account`.
   - Direct charges and connected-account webhooks work identically on an OAuth-linked `acct_...` and an Accounts-v2-created `acct_...`. Neither `src/stripe/checkout.ts` nor `src/checkout/sessions.ts` changes its charge logic.
2. **Full Stripe Dashboard**:
   - An existing standalone/Standard Stripe account natively uses the full Stripe Dashboard (`dashboard.stripe.com`, equivalent to `dashboard: "full"` in v2 / `controller.stripe_dashboard.type: "full"` in v1).
3. **Stripe owning fees (`fees_collector: "stripe"`)**:
   - On direct charges with no `application_fee_amount`, Stripe deducts its standard processing fees directly from the connected merchant account (`controller.fees.payer: "account"` in v1 / `defaults.responsibilities.fees_collector: "stripe"` in v2).
4. **Stripe owning negative-balance liability and KYC (`losses_collector: "stripe"`)**:
   - Existing standalone/Standard accounts hold a direct service agreement with Stripe; Stripe collects KYC (`controller.requirement_collection: "stripe"`) and owns negative-balance liability (`controller.losses.payments: "stripe"` / `defaults.responsibilities.losses_collector: "stripe"`).

### What `/v1/status` reports for a linked existing account

The external `/v1/status` JSON schema stays unchanged (`state`, `mode`, `providerId`, `bindingRef`, `stripeAccountId`, `chargesEnabled`, `payoutsEnabled`, `onboardingComplete`, `readyForLiveCheckout`, `testOrder`), while `Connection.creationProtocol` distinguishes how the bound `acct_...` was attached:

- **`creationProtocol: "accounts_v2"` (created via "Create a Stripe account")**:
  - Kept unchanged. Readiness calls `stripe.v2.core.accounts.retrieve(accountId, { include: ["configuration.merchant", "requirements"] })` on `2026-09-30.endive` and requires `applied_configurations.includes("merchant")`, active `card_payments` and `stripe_balance.payouts`, and no `currently_due` or `past_due` user requirements.
- **`creationProtocol: "oauth_standard"` (attached via "I already have Stripe")**:
  - **Why `v2.core.accounts.retrieve` cannot be the sole readiness check for OAuth accounts**: Stripe documents in [Connect and the Accounts v2 API](https://docs.stripe.com/connect/accounts-v2) that *"v1 Accounts don't have configurations"* by default, and in [Use the Accounts v2 API in your existing integration](https://docs.stripe.com/connect/accounts-v2/migrate-integration) that a newly connected v1 account *"might require up to 10 minutes before you can use it with an Accounts v2 endpoint."*
  - **Readiness check for `oauth_standard`**: Call `stripe.accounts.retrieve(accountId)` (`GET /v1/accounts/:id`) on `LEGACY_STRIPE_API_VERSION = "2026-08-26.dahlia"` using the platform key and verify:
    - `account.object === "account"`, `account.id === expectedId`, and `account.deleted !== true`.
    - `chargesEnabled = account.charges_enabled === true && account.capabilities?.card_payments === "active"`.
    - `payoutsEnabled = account.payouts_enabled === true`.
    - `requirementsDue`: `account.requirements?.disabled_reason !== null` or non-empty `account.requirements?.currently_due` or `account.requirements?.past_due`.
    - `onboardingComplete = account.details_submitted === true && chargesEnabled && payoutsEnabled && !requirementsDue`.
  - **Resulting `/v1/status` projection**:
    - When `chargesEnabled && payoutsEnabled && onboardingComplete`: `state: "ready"`, `readyForLiveCheckout: mode === "live"`.
    - When the linked existing account still has pending verification or disabled capabilities in Stripe: `state: "pending_onboarding"`, `readyForLiveCheckout: false`. Unlike `accounts_v2`, the service does **not** call `v2.core.accountLinks.create` for `oauth_standard` accounts (Standard account holders manage verification directly in their own Stripe Dashboard).
    - When the owner revokes the platform in Stripe (`account.application.deauthorized` webhook or `GET /v1/accounts/:id` returns an authorization/permission error): `/v1/status` fails closed (`readyForLiveCheckout: false`, `state: "failed"`, `failureCode: "account_deauthorized"`), immediately blocking new checkouts (`GET /v1/checkout-binding` refuses with `409 connection_not_ready`).

---

## 3. Bindings and safety rules

### Rule A: An existing Stripe account must bind to at most one store (`1:1` uniqueness)

- **Why per-site Durable Objects alone do not prevent duplicate attachment**:
  - In `src/cloudflare/worker.ts`, each store has its own `PaymentConnection` Durable Object keyed by `JSON.stringify([mode, siteId])`.
  - Under `accounts_v2`, Stripe creates a fresh `acct_...` per store, so two stores never share an `acct_...`.
  - Under Connect OAuth, an owner could authorize the **same** existing `acct_...` for two different stores (`site_a` and `site_b`). Because `site_a` and `site_b` have separate SQLite Durable Objects, a local check inside one site DO cannot see the other store's binding.
- **Required cross-store uniqueness fence**:
  1. **Reject self-attachment of the platform account**: Before claiming an OAuth `stripe_user_id`, verify `stripe_user_id !== platformAccountId` (via `creationScope()`).
  2. **Atomic Account Claim Registry**: Add a mode-scoped Durable Object claim keyed by `JSON.stringify(["stripe-account-claim", mode, stripeAccountId])` (or a mode-scoped registry table) storing `{ stripeAccountId, mode, siteId, bindingRef, ownerAccountId, claimedAt }`.
  3. During OAuth callback completion (and before writing `stripeAccountId` to the store's `PaymentConnection` DO):
     - Request an atomic claim on `["stripe-account-claim", mode, stripeAccountId]` for `{ siteId, bindingRef, ownerAccountId }`.
     - If unclaimed, or already claimed by the **exact same** `{ siteId, bindingRef }`, the claim succeeds.
     - If already claimed by a different `siteId` or `bindingRef`, the claim fails closed with `409 stripe_account_already_bound`, and the store's `PaymentConnection` DO remains unbound (`stripeAccountId: null`).

### Rule B: A store can never switch accounts silently

- Once a store's `Connection` has `stripeAccountId !== null` (or has an in-flight `accountCreateStartedAt` operation under `accounts_v2`), its bound `stripeAccountId` is **immutable** for that `bindingRef`:
  - `POST /v1/connect` ("Create a Stripe account") refuses to create a new account if `stripeAccountId !== null` and refuses if an OAuth attach is in flight or completed.
  - `POST /v1/connect/oauth/start` ("I already have Stripe") refuses (`409 account_already_bound` or `409 account_create_in_progress`) if `stripeAccountId !== null` or `accountCreateStartedAt !== undefined`.
  - `GET /v1/connect/oauth/callback` re-reads the store's `Connection` inside a storage transaction before persisting the OAuth result. If `stripeAccountId` is already set to a different `acct_...`, or `owner` / `bindingRef` changed while the owner was on `connect.stripe.com`, the callback fails closed (`409 binding_account_immutable`) without overwriting the existing binding.
- Neither button on **Payment settings** can ever replace an already bound account. Any future account-replacement workflow would require a dedicated, support/owner-confirmed transition that mints a new `bindingRef` generation rather than mutating the existing `bindingRef` in place.

### Rule C: Fail-closed lookup must still recover payments made under an old binding

- **How checkout attempt recovery works today (`src/checkout/sessions.ts`)**:
  - Every `AttemptRecord` in `checkout_attempts` pins both `bindingRef` and `stripeAccountId` before contacting Stripe (`claim()`).
  - Every webhook wake row in `checkout_wake_events` pins `siteId`, `bindingRef`, `attemptId`, `stripeAccountId`, and `mode`.
  - `ensureSessionFor` (replay), `lookupFor`, and `lookupAttemptFor` call `existingBinding(principal, request.bindingRef)` (`GET /v1/existing-binding?bindingRef=...`) and `assertBinding(existing, binding, request, principal)`, which requires `existing.bindingRef === record.bindingRef && existing.stripeAccountId === record.stripeAccountId`.
- **Gap in single-row `connection_state` if a binding ever changes**:
  - Today, `connection_state (id = 1)` stores only a single `Connection` object, and `existingBinding(principal, bindingRef)` returns `null` whenever `record.bindingRef !== bindingRef`. If a store ever transitioned from `(bindingRef_1, acct_old)` to `(bindingRef_2, acct_new)`, `existingBinding(principal, "bindingRef_1")` would return `null` (`409 binding_not_found`), stranding in-flight and historical attempts under `bindingRef_1`.
- **Required durable binding history contract**:
  1. Add an append-only SQLite table `connection_bindings (binding_ref TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, site_id TEXT NOT NULL, mode TEXT NOT NULL, provider_id TEXT NOT NULL, stripe_account_id TEXT NOT NULL, creation_protocol TEXT NOT NULL, bound_at INTEGER NOT NULL, superseded_at INTEGER)` inside the store's `PaymentConnection` Durable Object.
  2. Whenever a `bindingRef` binds a `stripeAccountId` (via `accounts_v2` or `oauth_standard`), write or upsert its immutable `(binding_ref, owner_account_id, site_id, mode, provider_id, stripe_account_id, creation_protocol)` row in `connection_bindings` inside the same SQLite transaction as `connection_state`.
  3. **`checkoutBinding(principal, requestedBindingRef)` (`GET /v1/checkout-binding`)**: only admits the **active** `connection_state` record when `status.state === "ready"`. A superseded binding is never eligible for new checkouts.
  4. **`existingBinding(principal, bindingRef)` (`GET /v1/existing-binding`)**: resolves the active `connection_state` if `record.bindingRef === bindingRef && record.stripeAccountId !== null`, and otherwise looks up `bindingRef` in `connection_bindings` (enforcing exact `owner_account_id`, `site_id`, and `mode` equality).
  5. As a result, `lookupFor`, `lookupAttemptFor`, and webhook wake reconciliation continue to query Stripe with `{ stripeAccount: acct_old }` and recover terminal `paid` or `expired-unpaid` outcomes for payments created under any historical `bindingRef`.

---

## 4. Owner's flow on the Payment settings page

On the EmDash Admin **Payment settings** page (`/status`, rendered by `src/registry/setup.ts`):

1. **Step 1 — Sign in to DinkusKit (`payments:admin`)**:
   - Unchanged. The owner clicks **Sign in to DinkusKit**, approves the store connection on `dinkuskit.com`, and returns with a verified 5-minute `payments:admin` session token bound to `(accountId, siteId, origin)`.
2. **Step 2 — Choose how to connect Stripe (when `status.state === "disconnected"` and `stripeAccountId === null`)**:
   - When signed in and no Stripe account is bound yet, Step 2 (**Connect Stripe account**) renders two side-by-side action buttons in the `actions` block:
     - **Create a Stripe account** (`action_id: "setup_processor"`, `style: "primary"`)
     - **I already have Stripe** (`action_id: "attach_existing_stripe"`)
   - **If the owner chooses "Create a Stripe account"**:
     - Runs the existing `POST /v1/connect` Accounts v2 flow and renders the external link **Continue setup at Stripe** (`https://accounts.stripe.com/...`).
   - **If the owner chooses "I already have Stripe"**:
     - The plugin handler calls `connection.attachExistingProcessor(user)`, which uses the same 8-bridge-call budget as `setupProcessor`:
       1. Read `CONTROL_KEY` (`kv.getVersioned`)
       2. Read `STATE_SETTING` (`settings.getVersioned`)
       3. Verify `payments:admin` JWT against `REGISTRY_JWKS_URL` (`http.fetch`)
       4. Re-check `CONTROL_KEY` (`kv.getVersioned`)
       5. Call `POST https://payments.dinkuskit.com/v1/connect/oauth/start` (`http.fetch` with `Authorization: Bearer <token>` and `X-Dinkus-Site: <siteId>`)
       6. Re-check `CONTROL_KEY` (`kv.getVersioned`)
       7. Read `GET https://payments.dinkuskit.com/v1/status` (`http.fetch`)
       8. Final `CONTROL_KEY` check (`kv.getVersioned`)
     - `POST /v1/connect/oauth/start` verifies that `stripeAccountId === null` and no `accounts_v2` create is in flight, persists a short-lived (10-minute), single-use `oauthState` nonce on the store's `PaymentConnection` DO, and returns `{ state: "setup_required", mode, bindingRef, url, expiresAt }` where `url` is:
       `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=<ca_...>&scope=read_write&redirect_uri=https%3A%2F%2Fpayments.dinkuskit.com%2Fv1%2Fconnect%2Foauth%2Fcallback&state=<signed_state>`
     - The plugin validates the returned `https://connect.stripe.com/oauth/authorize` URL and renders the external link button **Connect existing Stripe account** (`target: { kind: "external", url }`).
     - No outbound plugin `fetch` ever targets `stripe.com`, so `allowedHosts` remains `["dinkuskit.com", "payments.dinkuskit.com"]` and `global_fetch_strictly_public` is never needed.
3. **Step 2b — Authorize on Stripe and return**:
   - The owner clicks **Connect existing Stripe account**, signs in on `connect.stripe.com`, selects their existing Stripe account, and authorizes the DinkusKit Connect platform.
   - Stripe redirects the browser to `GET https://payments.dinkuskit.com/v1/connect/oauth/callback?code=ac_...&scope=read_write&state=<signed_state>`.
   - The hosted Worker verifies the HMAC-signed `state` envelope, routes to the store's `PaymentConnection` DO, consumes the single-use `oauthState` nonce, exchanges `code` once via `POST https://connect.stripe.com/oauth/token` (`grant_type=authorization_code`), checks `livemode`, `scope === "read_write"`, and `stripe_user_id !== platformAccountId`, claims `(mode, stripe_user_id)` in the cross-store Account Claim Registry, writes `stripeAccountId` (`creationProtocol: "oauth_standard"`) + `connection_bindings`, and redirects to `ONBOARDING_RETURN_URL`.
4. **Step 2c & Step 3 — Check connection and Place a test order**:
   - Back on **Payment settings**, once `stripeAccountId` is bound, the dual initial buttons (**Create a Stripe account** / **I already have Stripe**) are no longer shown.
   - Clicking **Check connection** reads `/v1/status`:
     - If the existing account is fully enabled (`charges_enabled` and `payouts_enabled` with active `card_payments` and no due requirements), Step 2 marks `[DONE]` (`Stripe TEST account connected and ready`) and Step 3 (**Place a test order** -> **Verify test order**) becomes active.
     - If the existing account has outstanding verification in Stripe, Step 2 shows `[ACTION NEEDED]` (`Complete any remaining account verification in your Stripe Dashboard, then select Check connection`).
     - If the OAuth callback was refused because that `acct_...` is already bound to another store (`stripe_account_already_bound`), the store remains unbound (`stripeAccountId: null`) and **Payment settings** displays a clear refusal notice while keeping **Create a Stripe account** and **I already have Stripe** available.

---

## 5. Platform comparison and EmDash evaluation

| Platform | How existing Stripe accounts are attached | How new Stripe accounts are created | Account-switching & historical-order behavior | Source |
| --- | --- | --- | --- | --- |
| **WooCommerce Stripe Gateway** | Single **Create or connect an account** button redirects to `connect.stripe.com` OAuth (`scope=read_write`); manual API keys were deprecated in 2025 in favor of OAuth. | Same OAuth flow (or Stripe Networked Onboarding if the business is already connected to another platform). | Re-authenticating or disconnecting overwrites the active plugin connection settings in `wp_options`. | [Connecting to Stripe](https://woocommerce.com/document/stripe/setup-and-configuration/connecting-to-stripe/), [OAuth requirements](https://woocommerce.com/document/stripe/admin-experience/updated-requirements-for-stripe-plugin-mid-2025/) |
| **BigCommerce (Stripe OCS)** | **Connect with Stripe** button in **Settings › Payments** uses Connect OAuth (`connect.stripe.com/oauth/authorize`) to attach an existing Standard account. | Same **Connect with Stripe** button lets the merchant register a new Standard account during OAuth. | Switching accounts requires support or a backend connection reset when OAuth auto-selects a previously linked account. | [Connecting with Stripe OCS](https://support.bigcommerce.com/s/article/Connecting-with-Stripe-OCS) |
| **Shopify** | Shopify Payments creates an embedded platform-controlled account; attaching an existing standalone Stripe account as a secondary/regional gateway uses Stripe Connect OAuth. | Embedded onboarding via Shopify Payments (`Custom` / controller-managed account). | Gateway configuration is bound per store; historical payouts stay in the account that processed the charge. | [Third-party payment providers](https://help.shopify.com/en/manual/payments/third-party-providers) |
| **Stripe Connect (official docs)** | **Connect OAuth** (`GET /oauth/authorize` + `POST /oauth/token`) for existing standalone/Standard accounts; `Stripe-Account` header for direct charges. | **Accounts v2 API** (`POST /v2/core/accounts` + `POST /v2/core/account_links`) on `2026-09-30.endive`. | Direct charges live in the connected `acct_...`; platforms must pass `Stripe-Account: acct_...` matching the account that created the session. | [Accounts v2](https://docs.stripe.com/connect/accounts-v2), [OAuth Standard accounts](https://docs.stripe.com/connect/oauth-standard-accounts) |

### Adopt / Adapt / Defer / Reject decisions for EmDash Payments

- **Adopt — Connect OAuth (`response_type=code`, `scope=read_write`) + platform key `Stripe-Account` header for existing accounts**:
  - Matches WooCommerce, BigCommerce, and Stripe's documented exception for connecting existing accounts while keeping secret keys off merchant stores and discarding deprecated OAuth `access_token` / `refresh_token` credentials.
- **Adapt — Explicit two-button split ("Create a Stripe account" vs "I already have Stripe") on Payment settings**:
  - Instead of pushing new-account creation through legacy Standard OAuth (which Stripe marks deprecated for new accounts), keep Accounts v2 (`2026-09-30.endive`) for **Create a Stripe account** and use Connect OAuth (`2026-08-26.dahlia` v1 account readiness) exclusively for **I already have Stripe**.
- **Adapt — Cross-store 1:1 Account Claim Registry and append-only `connection_bindings` history**:
  - Unlike single-tenant WordPress (`wp_options`), hosted Payments isolates stores across per-site Cloudflare Durable Objects and routes connected-account webhooks by `event.account`. Enforcing a mode-scoped Account Claim Registry guarantees 1:1 store binding, and `connection_bindings` guarantees fail-closed lookup recovery across bindings.
- **Defer — Self-service account switching / disconnecting a bound store account**:
  - Once a store binds an `acct_...`, switching accounts has tax, payout, test-order, and in-flight checkout implications. Keep bindings immutable in this slice; scope explicit account replacement only if owner demand requires it later.
- **Reject — Pasting Stripe API keys or publishing a Stripe Marketplace App (`scope=stripe_apps`)**:
  - Manual keys violate the hosted security boundary, and Stripe App OAuth requires storing and rotating per-merchant bearer/refresh tokens instead of using Connect `Stripe-Account` direct charges.
