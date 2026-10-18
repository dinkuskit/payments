---
"@dinkuskit/payments": patch
---

Implement the locked `release-beta-cut-071` release process for `@dinkuskit/payments`:

- Accept both the stable (`dinkus-payments` -> `r_3brsc2on3bu673rn`) and beta (`dinkus-payments-beta` -> `r_sffx6l4z6mpqliki`) EmDash Registry installation identities in the plugin runtime, route manifests, and callback/store-proof contract with `dinkuskit.com`.
- Add the `@running` Payments setup journey (`src/registry/setup-journey.ts` and `docs/payments-setup-journey.md`) that opens Payment setup, connects with DinkusKit.com in Stripe test mode, clicks `Check connection`, and verifies `Connected: Stripe test mode`.
- Rework `.github/workflows/emdash-release.yml`, `.github/workflows/release.yml`, `.github/workflows/changeset-check.yml`, `.github/workflows/preview.yml`, `.github/scripts/*`, `scripts/release-flow.mjs`, and `RELEASING.md` to match `release-beta-cut-071` (manual beta cuts, beta-gated release PR promotion, dedicated release GitHub App authentication, OIDC + `actions/attest-build-provenance` + `emdash-cms/emdash/apps/release-action` delegated Registry publishing with PDS record checksum verification and no stored PDS credentials, `< 131072`-byte sandbox bundle check, and `v0.2.8` baseline tag documentation).
