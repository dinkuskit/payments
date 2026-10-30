# Payments Registry listing proof

Date: 2026-10-30. Base: `dbb3ea30932dc39fc3353fc86b997a86cc64a99a`.
Branch: `codex/registry-growth-20261030`. Scope: listing metadata, documentation
sections, listing artwork and the release staging needed to carry those files.

## What changed

- Replaced the setup/status summary with a task-oriented Stripe/Commerce
  description, added five search keywords, and linked the author to
  `https://dinkuskit.com` while retaining the repository link.
- Added description, installation and FAQ sections with setup documentation,
  sibling-plugin links and a modest GitHub star invitation.
- Added the existing Payments brand icon and an honest initial-setup screenshot.
- Both release staging paths now copy `docs/registry` and `assets/registry`.
  Without that change the source manifest's file references failed in the
  isolated release directory. The existing staging test checks identical
  section, icon and screenshot bytes for beta and stable staging.

No source under `src/`, hosted-service configuration, account settings,
permissions, slug, publisher, security contact or runtime routes changed.
The manifest's `capabilities`, `allowedHosts`, `admin`, `storage`, `publisher`,
`slug`, `repo`, `security` and `license` were deep-compared with the base and
are unchanged. Package versions were not edited.

## Checks

Node `v24.22.0`; pinned plugin CLI `0.13.5`, EmDash `1.4.0`.

- `./scripts/agent-skills` completed with the repository's pinned bundle.
- `npm ci --ignore-scripts` completed. It reported 19 existing dependency
  vulnerabilities; this change does not update dependencies.
- `npm run plugin:validate` passed.
- `npm run plugin:build` passed, including the sandbox size check.
- `npm run plugin:bundle` passed; package tarball is 16.8 KB.
- `node --test tests/release-flow.test.mjs`: 22 passed, including the
  official release preparation and 15 release-authority scenarios.
- After adding the final screenshot,
  `node --test --test-name-pattern='prepareRegistryWorkspace|prepare-emdash-release.mjs' tests/release-flow.test.mjs`
  rechecks the changed staging paths.
- The media transport pilot adds nine focused tests for source-record parsing,
  checksummed image inclusion, pre-upload input rejection, matching-asset reuse,
  conflict refusal, no-clobber uploads, upload races and missing beta releases.
  GitHub calls are mocked. The 22 release-flow tests, including the 15 authority
  scenarios, passed with the workflow's media step between attestation and the
  pinned release action. No upload or release was performed by these tests.
- The retry regression creates two valid gzip representations of the same
  USTAR bundle and validates both with the real bundle verifier. Under one
  tag they produce different SHA-256 package filenames; a third preparation
  with identical bytes reuses the second package and provenance assets.
  Mocked transport observes exactly two package uploads and one provenance
  upload, with no overwrite option. Same-name hash conflicts still fail.
- A full local media preparation also used the real validated Payments 0.4.0
  tarball and the actual icon/screenshot bytes with mocked GitHub transport.
  The real source-record parser accepted the result, two artifact uploads were
  simulated, and the record preserved the bundle's canonical network access.
  The provenance file was a fixture for transport only; no live signature or
  release-service publication is claimed.
- `npm run audit:repo` and `git diff --check` passed before commit.
- Section sizes: description 1,201 bytes / 1,199 graphemes; installation
  921 / 920; FAQ 1,326 / 1,326. Each is below 20,000 bytes / 2,000 graphemes.
  The short description is 88 graphemes. Five keywords are declared.

## Artwork provenance

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `assets/registry/payments.webp` | 14,454 | `45d977794d3f49d8d85fecd213371292f5be9caa1b2f862bd6e544c191afb64c` |
| `assets/registry/payment-setup-demo.jpg` | 63,504 | `783f8082c6912ac820ed77b7e2f7db1ae6eb1aab6c81dcae007aa48f4773c06f` |

The icon is copied unchanged from `dinkuskit/dinkuskit` source
`920aea3f012a14beb90d1be7264121dd7a8dd105`, path
`public/brand/payments.webp`. It is existing first-party brand artwork.

The screenshot is a real Chrome capture of the installed plugin page in
EmDash 1.4.0, using the repository's `scripts/registry-status-proof.mjs` host
with synthetic users and local SQLite/R2 state. First, the official bundle's
seeded post-install fixture passed the admin/subscriber/anonymous API checks
with HTTP 200/403/401. That is a local sandbox check, not Registry publication.

For the screenshot only, an external wrapper calls the public
`createPaymentsPlugin` factory with its existing `testOnly` loopback option,
the stable installed identity, a synthetic site URL, and an offline HTTP
adapter that refuses all service calls. EmDash renders the actual returned
Block Kit without DOM alteration. It displays **Payment setup**, **Not ready
to sell**, the unconnected account state, the unconfirmed test-order state,
and **Connect**. No connection button was pressed. The description labels the
image as a local demonstration with no account connected and no payment made.
The temporary wrapper is not distributed in the plugin.

## Publication boundaries

No registry update, release, deployment, live account connection or payment
was performed by this worker's source validation. The campaign separately
applied its approved stable profile copy; artwork still requires the reviewed
release path. Source metadata does not update an existing package profile
automatically: preview and approve `emdash-plugin update-package` separately
for the stable listing. Artwork is release metadata and uses the prepared
delegated media path described in `RELEASING.md`. The source record keeps
mandatory build provenance and declared access from the validated bundle;
images are checksummed URLs pinned to the source commit. The unchanged pinned
release action's `release-file` path and service materialization implement the
media transfer. This is source and mocked-transport proof, not an observed
published listing. Do not overwrite an existing release version.

The pilot requests **contents: write** only for the reusable publish job and
its caller to upload release assets with the existing job token. This is a
reviewable workflow-permission change requiring merge approval, not a live
account permission change. No new secret, App permission, PDS credential,
dependency or direct-publish bypass is introduced. Existing equal assets are
downloaded and byte-verified; different bytes fail closed. A missing beta
GitHub Release is created as a prerelease only after the existing tag gate;
stable release creation remains owned by that gate. GitHub immutability
restrictions fail closed rather than being disabled.

Upstream source checked at
[`06f911b54f387a1284c767187042d7e11f6044fc`](https://github.com/emdash-cms/emdash/tree/06f911b54f387a1284c767187042d7e11f6044fc):
`apps/release-action/src/run.ts`,
`packages/registry-client/src/release-service/source-record.ts`, and
`apps/release-service/src/publishing/materialize.ts`. The action accepts the
full URL-source record, the parser requires provenance, and the service
checks image bytes/MIME/dimensions before uploading PDS blobs.

This work proves validated source and local packaging, not a newly indexed
listing, completed merchant onboarding or live-payment availability.
