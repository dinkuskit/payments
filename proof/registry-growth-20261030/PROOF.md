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
was performed. Source metadata does not update an existing package profile
automatically: preview and approve `emdash-plugin update-package` separately
for the stable listing. Artwork is release metadata and must go through the
approved publisher path. The pinned CLI's direct `publish` uploads listing
images separately; the existing delegated release workflow passes only the
bundle and provenance to its action. Its tarball contains runtime files, not
the listing images. Verify or extend the delegated action's image transport
before claiming that a release will display this artwork. Merely validating
the manifest does not prove that transport. Do not overwrite an existing
release version.

This work proves validated source and local packaging, not a newly indexed
listing, completed merchant onboarding or live-payment availability.
