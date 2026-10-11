# Payments 0.1.0 release preparation

This prepares release metadata; it does not publish a package or deploy a service.
PR #39 was rebased onto main after PR #40 merged at
`802476ac5e3be9fa105693e3136295e3d4bab3d0`.

## Scope

Package, lockfile root identity, and EmDash manifest agree on version `0.1.0`.
The package public-release guard and CLI help expectation follow that version.
Dependency versions and production source are unchanged. The manifest describes
Stripe setup; Authorize.net connection checks remain unsupported in this build.

## Local verification

Pinned Node `22.23.2`: `npm ci`, `bin/verify-payments full`, and
`npm pack --dry-run --ignore-scripts --json` pass. The full suite includes
180 Node tests, 20 Worker tests, and 7 compiled Registry connection tests.
The denied-network test deliberately causes the host to report `Host not allowed`;
its fail-closed assertions pass.

The compiled plugin is 18,028 bytes with SHA-256
`4ae48f5f2981cd7c520b24bed42a9be83b17e733d22a16d5c0c0c68c94cc7f39`,
identical to the backend tested in PR #40. Manifest bytes change for release
metadata. EmDash/Cloudflare `1.2.0`, plugin-cli `0.13.3`, plugin-test `0.2.8`,
Vitest `4.1.11`, and Wrangler `4.144.0` remain pinned.

## Review and gates

CI, comprehensive Spark OpenClaw, and native ClawSweeper must cover the final
base/head tuple. Their immutable receipts and finding dispositions are recorded
in PR #39. Merge remains a maintainer decision. Registry/npm publication,
deployment, and live processor or merchant traffic require separate approval.
No tarball-install or live merchant journey is claimed by this local build proof.
