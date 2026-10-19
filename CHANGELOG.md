# @dinkuskit/payments

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
