# Compiled Registry connection CI proof

## Scope and source

Tests extend the connection contract through the locally compiled Payments
Registry plugin, EmDash 1.2.0, its production Cloudflare sandbox runner and
PluginBridge, real D1-backed settings/KV, and the authenticated admin dispatcher.
The account and Payments services return bounded synthetic replies. No provider
or account service is contacted. Base: `6d26fa59c7edd00b0165bbc6943a0d2247aa8028`.
The candidate identity is the commit containing this proof; CI binds its result
to the PR's current base/head. No production source or release metadata changed.

## Assertions

- Connect renders Continue and a consent link; its exact protocol fields,
  canonical installed callback identity, public receipt and PKCE challenge agree.
  The verifier stays in encrypted settings, outside UI and public KV.
- Continue exchanges the persisted verifier, validates an ES256 synthetic token
  against synthetic JWKS, writes the session through EmDash's conditional
  settings/KV bridge, and requests status with the verified token and site.
  The rendered screen says Stripe is connected for TEST payments only and
  remains Not ready to sell. A host restart preserves state and reads status.
- An expired session offers explicit reconnect without contacting services.
  Reconnect keeps canonical authority, replaces the flow and token, and makes
  the old public receipt return 404 without altering newer settings/KV.
- Concurrent Connect actions reserve one pending flow and emit exactly one
  service request. This reuses the shared-module concurrent-start scenario,
  now across real D1 compare-and-set operations and compiled invocations.
- Removing only the Payments status host from the test host's allowlist and
  restarting its runner rejects status before the synthetic transport. JWKS
  remains allowed, zero denied-host requests occur, and the encrypted session
  and control record are unchanged. Restoring the test policy makes status
  succeed. The production manifest/capabilities remain unchanged.

The host scheduled clock does not control Date.now inside the plugin isolate.
Timing fixtures change only `nextPollAt`/`expiresAt` in real D1. The compiled
plugin evaluates its normal guards; no domain functions, CAS, encryption,
authorization, or HTTP policy are mocked. A disposable encryption key and
synthetic signing material are generated only in test-worker memory. No raw
HTTP traces, tokens, verifiers, encryption keys, or storage dumps are retained.
The host-denial test can produce EmDash's expected `Host not allowed` stderr;
the asserted UI, request count and persisted state establish its outcome.

## Verification and regression

Use Node `22.23.2` from `.nvmrc`, `npm ci`, then `bin/verify-payments full`.
The existing full command and Repository contract CI already run this suite;
the full command now prints package/build identity, SHA-256 digests, emitted
sizes and resolved tool versions before running the workerd tests.

Fresh baseline full verification passed. Candidate full verification passed:
180 Node tests, 20 Worker runtime tests, and 7 compiled plugin tests, plus both
typechecks, repository audit, Worker dry-run build and plugin validation/build.

Controlled regression: temporarily remove only the session-expiry guard in
`src/registry/connection.ts` status, rebuild via the normal plugin-test config,
and run `npm run test:plugin-runtime -- --testNamePattern 'compiled expiry'`.
The expiry assertion fails because explicit reconnect is no longer rendered.
Restore the original source in a `finally` block; rerun the candidate full
verification. The regression is never committed.

Local compiled runtime: 18,028 bytes, SHA-256
`4ae48f5f2981cd7c520b24bed42a9be83b17e733d22a16d5c0c0c68c94cc7f39`.
Manifest digest is recorded by full verification and can vary when separately
approved release metadata changes. Resolved packages: EmDash/Cloudflare `1.2.0`,
plugin-cli `0.13.3`, plugin-test `0.2.8`, Vitest `4.1.11`, Wrangler `4.144.0`.
Package identity comes from the built manifest and package metadata, never an
assumption about an unpublished version.

## Limits and next gate

This proves a locally compiled plugin under the real sandbox bridges with
synthetic services. It does not prove installation of a Registry-published
release, a final tarball consumer, merchant consent with a hosted account,
Stripe/Authorize.net traffic, a paid order, or the merchant-to-label journey.
No publication, deployment, account change, live traffic or merge occurred.
Independent exact-head CI/OpenClaw/native ClawSweeper review is required before
Bobby's merge decision. Review receipts are delivery evidence, not a claim of
installed Registry or live merchant readiness.
