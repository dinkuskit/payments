# Releasing `@dinkuskit/payments`

`@dinkuskit/payments` uses a locked two-stage release contract (`.grilltrack` milestone `release-beta-cut-071`) with Changesets and a dedicated beta EmDash Registry slug so every release is proven in a real EmDash beta store before stable publication.

## Release Identity

| Channel | EmDash Registry Slug | Installed Plugin ID (`derivePluginId`) | Package Version Format |
| --- | --- | --- | --- |
| **Beta** | `dinkus-payments-beta` | `r_sffx6l4z6mpqliki` | `X.Y.Z-beta.N` (e.g. `0.2.9-beta.1`) |
| **Stable** | `dinkus-payments` | `r_3brsc2on3bu673rn` | `X.Y.Z` (e.g. `0.2.9`) |

- Every release builds the Cloudflare sandbox artifact (`dist/sandbox/plugin.mjs`) and verifies that its size stays strictly under `128 KB` (`131,072` bytes).
- Historical git tags before `v0.2.8` are never backfilled; the stable tag baseline is `v0.2.8`.
- Every GitHub Actions `uses:` reference in `.github/workflows/*.yml` is pinned to a full 40-character commit SHA (enforced by `npm run audit:repo`).

## Delegated Registry Publishing (No Stored PDS Credentials)

Registry publishing uses GitHub OIDC, Sigstore build provenance (`actions/attest-build-provenance`), and the EmDash delegated release service (`emdash-cms/emdash/apps/release-action` targeting `https://releases.emdashcms.com`), so no Atmosphere/PDS handle or app-password secret is stored in this repository.

1. `.github/scripts/prepare-emdash-release.mjs` copies the audited Cloudflare sandbox prebundle (`dist/sandbox/plugin.mjs`) into an isolated temporary directory and invokes the official `emdash-plugin release prepare <slug@version>` command there, producing `.emdash-release/<slug>-<version>.tar.gz` plus the `publisher-did`, `bundle-file`, and `selector` outputs.
2. `actions/attest-build-provenance` signs build provenance over the prepared bundle tarball (`id-token: write`, `attestations: write`).
3. `emdash-cms/emdash/apps/release-action` submits the bundle and provenance to `https://releases.emdashcms.com` for `publisher-did` (`did:plc:ekk4pjmkh3k3ql2kfoex3qt4`).
4. Because the delegated release service can currently end successful publishes in `RELEASE_CONFLICT` ([`emdash-cms/emdash#4159`](https://github.com/emdash-cms/emdash/issues/4159)), the publish step uses `continue-on-error: true` and `.github/scripts/verify-registry-release.mjs` acts as the fail-closed gate by resolving the publisher PDS endpoint directly and verifying that the `com.emdashcms.experimental.package.release` record for `<slug>:<version>` carries the exact multihash checksum and byte size of the prepared tarball.

### One-Time Publisher Profile Setup (`dinkus-payments-beta`)

Before the first beta release can publish through the delegated release service, the repository owner must create and authorize the `dinkus-payments-beta` package profile under `@smokyco.bsky.social` (`did:plc:ekk4pjmkh3k3ql2kfoex3qt4`):

1. Stage a beta manifest directory from a built checkout:
   ```bash
   npm ci
   npm run build
   node .github/scripts/prepare-emdash-release.mjs --slug dinkus-payments-beta --version 0.2.9-beta.1 --out-dir /tmp/payments-beta-profile
   ```
2. Using the publisher's interactive `emdash-plugin` login session, create the package profile record:
   ```bash
   ./node_modules/.bin/emdash-plugin profile setup --dir /tmp/payments-beta-profile --yes
   ```
3. In the [EmDash release-service publisher dashboard](https://releases.emdashcms.com/publisher), choose **Authorize publishing** for `dinkus-payments-beta` (and `dinkus-payments` if not already authorized), then approve the `dinkuskit/payments` `.github/workflows/emdash-release.yml` workflow connection on its first run.

## Step 1: Every PR Includes a Changeset

Every pull request targeting `main` (except automated `ci: release` PRs on `changeset-release/main`) must add at least one `.changeset/*.md` file:

```bash
npm run changeset
```

Choose `patch` for fixes or `minor` for new features. For documentation, CI, or internal-only changes that should not bump the package version, create an explicit empty changeset (`npx changeset --empty`), which produces a `.changeset/*.md` file with empty frontmatter (`---\n---`) that satisfies `changeset-check.yml` and is excluded from version bump calculation.

Every PR also runs `.github/workflows/preview.yml` (`.github/scripts/publish-pkg-pr-new.mjs`) to publish an ephemeral tarball preview for that commit (or emit a `::notice::` and exit 0 if the `pkg-pr-new` GitHub App is not installed on the repository).

## Step 2: Cut Beta (`dinkus-payments-beta`)

Merging normal PRs to `main` does **not** automatically publish a beta or open a release PR.

When `main` has pending version-bumping `.changeset/*.md` files and you are ready to cut a beta:

1. Manually dispatch **Publish to EmDash Registry** (`.github/workflows/emdash-release.yml`) on `refs/heads/main` (leave `version` blank to auto-compute the next `X.Y.Z-beta.N`, or supply an explicit `X.Y.Z-beta.N` override).
   - Manual `workflow_dispatch` is gated by `.github/scripts/emdash-dispatch-gate.mjs` (`validateEmDashDispatchGate`) to `refs/heads/main` and `-beta.N` versions before minting any GitHub App token or performing Registry I/O. Manual stable dispatches and non-`main` dispatches are rejected immediately.
2. The workflow:
   - Computes the target `X.Y.Z` from pending changesets on `main` and determines the next `X.Y.Z-beta.N` across existing git tags and `dinkus-payments-beta` Registry versions (failing closed on Registry lookup or schema errors so duplicate beta numbers cannot be computed).
   - Tags the `main` commit `vX.Y.Z-beta.N` using the release GitHub App token (`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`).
   - Prepares `.emdash-release/dinkus-payments-beta-X.Y.Z-beta.N.tar.gz` via `emdash-plugin release prepare` with `slug: "dinkus-payments-beta"`, `name: "DinkusKit Payments (Beta)"`, and `version: "X.Y.Z-beta.N"`, while keeping the repository root `emdash-plugin.jsonc` at `dinkus-payments`.
   - Signs build provenance with `actions/attest-build-provenance`, submits the release to `https://releases.emdashcms.com` via `emdash-cms/emdash/apps/release-action`, and verifies the publisher PDS release record (`verify-registry-release.mjs`).

## Step 3: Run Beta Store `@running` Journeys

Install `dinkus-payments-beta@X.Y.Z-beta.N` in the EmDash beta store (`installedPluginId: r_sffx6l4z6mpqliki`) and run the `@running` verification journeys. Record the passing proof reference (CI run URL, proof artifact path, or signed verification summary naming `X.Y.Z-beta.N`).

## Step 4: Promote Verified Beta to a `ci: release` PR

Once `dinkus-payments-beta@X.Y.Z-beta.N` has passed the beta-store `@running` journeys:

1. Manually dispatch **Release** (`.github/workflows/release.yml`) on `main` with:
   - `beta_version`: `X.Y.Z-beta.N` (e.g. `0.2.9-beta.1`)
   - `proof_ref`: the recorded `@running` pass proof reference naming `X.Y.Z-beta.N`
2. The promotion gate verifies that:
   - `vX.Y.Z-beta.N` exists and points to the current `main` HEAD (no new changesets or commits landed on `main` after the beta was cut; if `main` advanced, cut and verify `beta.(N+1)` first).
   - `dinkus-payments-beta@X.Y.Z-beta.N` is published in the EmDash Registry (failing closed on Registry HTTP/network/malformed errors).
   - `proof_ref` names `X.Y.Z-beta.N`.
3. The workflow runs `npm run release:version` (`changeset version` + `npm install --package-lock-only --ignore-scripts`) and opens/updates the `ci: release vX.Y.Z` pull request from `changeset-release/main` with a `Release-Beta-Proof:` trailer binding the beta version, commit SHA, and proof reference.

## Step 5: Review and Merge `ci: release` PR to Publish Stable

1. Run `@clawsweeper review` on the `ci: release vX.Y.Z` PR.
2. When Ryan merges the `ci: release vX.Y.Z` PR into `main`, `.github/workflows/release.yml` runs on the `push` to `main`:
   - Verifies the `Release-Beta-Proof:` record, enforces that `git diff --name-only v<betaVersion> HEAD` contains only `package.json`, `package-lock.json`, `CHANGELOG.md`, and `.changeset/*.md`, and semantically verifies that `package.json` and `package-lock.json` only updated the package's own `version` field (`X.Y.Z`). Any source, workflow, dependency, script, or lockfile resolution modification since the approved beta tag aborts before tagging or publishing.
   - Creates and pushes git tag `vX.Y.Z` (or resumes cleanly if `vX.Y.Z` already exists on `HEAD` from a prior partial run).
   - Creates the GitHub Release for `vX.Y.Z` from the matching `CHANGELOG.md` section if not yet created.
   - Checks whether `dinkus-payments@X.Y.Z` is already indexed in the EmDash Registry, and if not yet indexed, delegates to `.github/workflows/emdash-release.yml` via `workflow_call` (which retains caller `github.event_name == 'push'` on `refs/heads/main` and passes `release_mode: stable` plus `version`) to prepare, attest, publish via the EmDash delegated release service, and verify `dinkus-payments@X.Y.Z` (`r_3brsc2on3bu673rn`).
