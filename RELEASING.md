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

## Step 1: Every PR Includes a Changeset

Every pull request targeting `main` (except automated `ci: release` PRs on `changeset-release/main`) must add at least one `.changeset/*.md` file:

```bash
npm run changeset
```

Choose `patch` for fixes or `minor` for new features. For documentation, CI, or internal-only changes that should not bump the package version, create an explicit empty changeset (`npx changeset --empty`), which produces a `.changeset/*.md` file with empty frontmatter (`---\n---`) that satisfies `changeset-check.yml` and is excluded from version bump calculation.

Every PR also runs `.github/workflows/preview.yml` (`npx pkg-pr-new publish`) to publish an ephemeral tarball preview for that commit.

## Step 2: Cut Beta (`dinkus-payments-beta`)

Merging normal PRs to `main` does **not** automatically publish a beta or open a release PR.

When `main` has pending version-bumping `.changeset/*.md` files and you are ready to cut a beta:

1. Manually dispatch **Publish to EmDash Registry** (`.github/workflows/emdash-release.yml`) on `refs/heads/main` (leave `version` blank to auto-compute the next `X.Y.Z-beta.N`, or supply an explicit `X.Y.Z-beta.N` override).
   - Manual `workflow_dispatch` is gated to `refs/heads/main` and `-beta.N` versions before minting any GitHub App token or performing Registry I/O. Manual stable dispatches and non-`main` dispatches are rejected immediately.
2. The workflow:
   - Computes the target `X.Y.Z` from pending changesets on `main` and determines the next `X.Y.Z-beta.N` across existing git tags and `dinkus-payments-beta` Registry versions (failing closed on Registry lookup errors so duplicate beta numbers cannot be computed).
   - Tags the `main` commit `vX.Y.Z-beta.N` using the release GitHub App token (`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`).
   - Stages an isolated EmDash release workspace (`dist/emdash-release`) with `slug: "dinkus-payments-beta"`, `name: "DinkusKit Payments (Beta)"`, and `version: "X.Y.Z-beta.N"`, while keeping the repository root `emdash-plugin.jsonc` at `dinkus-payments`.
   - Validates, bundles, and publishes `dinkus-payments-beta@X.Y.Z-beta.N` to the EmDash Registry, then verifies Registry indexing.

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
3. The workflow runs `npm run release:version` (`changeset version` + `registry-build-identity.mjs`) and opens/updates the `ci: release vX.Y.Z` pull request from `changeset-release/main` with a `Release-Beta-Proof:` trailer binding the beta version, commit SHA, and proof reference.

## Step 5: Review and Merge `ci: release` PR to Publish Stable

1. Run `@clawsweeper review` on the `ci: release vX.Y.Z` PR.
2. When Ryan merges the `ci: release vX.Y.Z` PR into `main`, `.github/workflows/release.yml` runs on the `push` to `main`:
   - Verifies the `Release-Beta-Proof:` record and enforces that `git diff --name-only v<betaVersion> HEAD` contains only `package.json`, `package-lock.json`, `CHANGELOG.md`, and `.changeset/*.md`. Any source or workflow modification since the approved beta tag aborts before tagging or publishing.
   - Creates and pushes git tag `vX.Y.Z` (or resumes cleanly if `vX.Y.Z` already exists on `HEAD` from a prior partial run).
   - Creates the GitHub Release for `vX.Y.Z` from the matching `CHANGELOG.md` section if not yet created.
   - Checks whether `dinkus-payments@X.Y.Z` is already indexed in the EmDash Registry, and if not yet indexed, delegates to `.github/workflows/emdash-release.yml` (`workflow_call`) to bundle, publish, and verify `dinkus-payments@X.Y.Z` (`r_3brsc2on3bu673rn`).
