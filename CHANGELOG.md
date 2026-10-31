# @dinkuskit/payments

## 0.5.0

### Minor Changes

- [#106](https://github.com/dinkuskit/payments/pull/106) [`266e5e4`](https://github.com/dinkuskit/payments/commit/266e5e437df00db276d4752501be593792b5ec93) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Payment settings asks a store with no Stripe connection for its business country (from Stripe's supported countries) before Set up Stripe, in test and live mode, so any store can set up Stripe without DinkusKit support. The hosted service saves the country before creating the Stripe account and no longer reads operator-configured test countries; the support-only legacy test recovery route is removed. Authorize.net setup is unchanged.

- [#108](https://github.com/dinkuskit/payments/pull/108) [`5400688`](https://github.com/dinkuskit/payments/commit/5400688aa68629ea5054e5707fcc9fee15abc1e5) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Add clearer Registry listing copy, setup and FAQ sections, relevant search
  keywords, a branded icon, an initial-setup screenshot, and a DinkusKit website
  link while retaining the source repository link. Explain Commerce setup and
  test-versus-live payment readiness. Carry the listing files into both release
  staging paths.
  
  Carry listing images through the existing delegated release service with
  checksummed source records and no-clobber GitHub release assets. Keep build
  provenance and approval checks, and verify the published images alongside the
  bundle.

- [#86](https://github.com/dinkuskit/payments/pull/86) [`6b5dc1f`](https://github.com/dinkuskit/payments/commit/6b5dc1ffc87e7b7ba831d55c35fa55b734e54721) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Put the Payments admin page in a "Dinkus Payments" sidebar folder and label it "Payment settings". The page path stays `/status`.

### Patch Changes

- [#87](https://github.com/dinkuskit/payments/pull/87) [`8bec82f`](https://github.com/dinkuskit/payments/commit/8bec82f73814b24565b8b87487851f4724dd39a1) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Validate winning Authorize.net attempt records inside the session-creation transaction and rethrow `attempt_mismatch` on concurrent mismatched calls.

- [#95](https://github.com/dinkuskit/payments/pull/95) [`e38dcc7`](https://github.com/dinkuskit/payments/commit/e38dcc767b615f37b88afb6cd320b6679fb94478) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Keep the last 20 Authorize.net transactions notified for a checkout instead of only the latest. A shopper declined on one card who pays with another stays paid even when the declined try's notice arrives last, a checkout reads unpaid only when every try is unpaid, and a try the provider cannot answer for right now keeps the checkout open without hiding a later paid try.

- [#100](https://github.com/dinkuskit/payments/pull/100) [`d9cdee6`](https://github.com/dinkuskit/payments/commit/d9cdee68be8e5b470d5e564bfea1672485d6eb2a) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Authorize.net shoppers reach the card form through a Payments pay page that posts a fresh form token. Authorize.net opens its form only for a POST, and a token lasts 15 minutes, so the old link could not open it. A declined shopper can retry at once (duplicate window 0), and the checkout stays open until it ends. Unpaid becomes final only after the last card form can no longer be used, and fraud holds stay undecided. Hosted service change; Commerce is unchanged.

- [#105](https://github.com/dinkuskit/payments/pull/105) [`fcad5de`](https://github.com/dinkuskit/payments/commit/fcad5ded1b12ec687868302bd66881e92c04153f) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Build and test against EmDash 1.4.0 (plugin CLI 0.13.5, plugin test 0.2.11). The Payments plugin and the Payments Worker do not change; the reference article now names EmDash 1.4.0.

- [#104](https://github.com/dinkuskit/payments/pull/104) [`4c567a1`](https://github.com/dinkuskit/payments/commit/4c567a1291f3491a9aebd4b6c316e391f0dd9b7a) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Payment settings tells a store with no Stripe account that owners who already have Stripe can sign in during setup to reuse their details (Stripe's networked onboarding). Payments does not attach an existing account through Connect OAuth.

- [#110](https://github.com/dinkuskit/payments/pull/110) [`4bdcb3e`](https://github.com/dinkuskit/payments/commit/4bdcb3e470f0c42522f7310822d0c7ac2f42e7f6) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Publish the Registry icon and screenshots through the EmDash release-action
  from emdash-cms/emdash#4467, so a new release carries its listing artwork.

- [#109](https://github.com/dinkuskit/payments/pull/109) [`a6bf910`](https://github.com/dinkuskit/payments/commit/a6bf9100259541f94025917e0d2c1bbe64ec6e99) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Centre the Registry icon on a transparent 256 × 256 square so the listing's
  square crop shows the whole Payments logo.

## 0.4.0

### Minor Changes

- [#82](https://github.com/dinkuskit/payments/pull/82) [`0572f9c`](https://github.com/dinkuskit/payments/commit/0572f9cdd758481948190fea882204c234b6714f) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Connect now gives the Payments plugin its own DinkusKit store key, so nothing is pasted: DinkusKit.com hands the key over at the end of Connect, the plugin keeps it in its encrypted Connect setting, and the status page uses it to read payment status. The Store key setting is gone. A missing or unknown key asks for Connect again, and a store whose Commerce plugin is not connected yet is told to connect Commerce first. Needs DinkusKit.com with per-plugin keys deployed first; stores that pasted a key press Connect again once.

## 0.3.0

### Minor Changes

- [#76](https://github.com/dinkuskit/payments/pull/76) [`7371c80`](https://github.com/dinkuskit/payments/commit/7371c80ee0ea23b9c6bee5f89de4958dd605434c) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Payment setup page reads payment status with a fresh pass traded from the store key on every load, the way checkout does, so it shows the current answer after its 5-minute DinkusKit sign-in lapses and to every store admin. Paste the store key from DinkusKit.com's Set up Commerce box into the new Store key setting, as for Ship. Sign in again now appears only when Payments isn't connected for the store or a Stripe change (Set up or resume Stripe, provider identity, recovery) needs it; a missing or refused store key is named instead. The hosted Payments Worker accepts the store's checkout pass on `GET /v1/status` (deploy it before releasing this plugin).

## 0.2.10

### Patch Changes

- [#64](https://github.com/dinkuskit/payments/pull/64) [`bc44f09`](https://github.com/dinkuskit/payments/commit/bc44f098ff43280c8c4c51f4e99c4cd9dc9892e7) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Add a disabled-by-default, operator-scoped action that preserves a rejected legacy TEST binding's history and prepares one v2 operation without creating an account. Add explicit confirmation through the existing Registry session; validate and preserve the stored start, matched record and audit digest internally.

## 0.2.9

### Patch Changes

- [#51](https://github.com/dinkuskit/payments/pull/51) [`c5193c6`](https://github.com/dinkuskit/payments/commit/c5193c64daa02b16925b2e0666be4017aad9fff3) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Implement the locked `release-beta-cut-071` release process for `@dinkuskit/payments`:
  
  - Accept both the stable (`dinkus-payments` -> `r_3brsc2on3bu673rn`) and beta (`dinkus-payments-beta` -> `r_sffx6l4z6mpqliki`) EmDash Registry installation identities in the plugin runtime, route manifests, and callback/store-proof contract with `dinkuskit.com`.
  - Add the `@running` Payments setup journey (`src/registry/setup-journey.ts` and `docs/payments-setup-journey.md`) that opens Payment setup, connects with DinkusKit.com in Stripe test mode, clicks `Check connection`, and verifies `Connected: Stripe test mode`.
  - Rework `.github/workflows/emdash-release.yml`, `.github/workflows/release.yml`, `.github/workflows/changeset-check.yml`, `.github/workflows/preview.yml`, `.github/scripts/*`, `scripts/release-flow.mjs`, and `RELEASING.md` to match `release-beta-cut-071` (manual beta cuts, beta-gated release PR promotion, dedicated release GitHub App authentication, OIDC + `actions/attest-build-provenance` + `emdash-cms/emdash/apps/release-action` delegated Registry publishing with PDS record checksum verification and no stored PDS credentials, `< 131072`-byte sandbox bundle check, and `v0.2.8` baseline tag documentation).

- [#56](https://github.com/dinkuskit/payments/pull/56) [`8415c8c`](https://github.com/dinkuskit/payments/commit/8415c8c79a41bf983596b67a7b57e9ab122e7ed2) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Keep connection diagnostics in the recovery-required state after a consumed country repair, matching connection status and preserving the recorded failure detail.

- [#58](https://github.com/dinkuskit/payments/pull/58) [`e523b48`](https://github.com/dinkuskit/payments/commit/e523b48356e1c71b9740516c0b9b4671f53cbef1) Thanks [@saariuslystoned](https://github.com/saariuslystoned)! - Payment setup page: returning from DinkusKit's Approve finishes sign-in on its own and shows the real payment connection; Continue pressed early waits out DinkusKit's short poll interval instead of showing the same screen; a lapsed 5-minute page sign-in shows the last checked result with its time; a refused Stripe setup names its known reason instead of "not confirmed"; when Stripe needs more information the page points to Set up or resume Stripe, which lists what is missing.
