# Releasing `@dinkuskit/payments`

DinkusKit Payments uses a locked Changesets release flow (decided 2026-10-13), modeled on EmDash's Changesets setup. Release workflows run under a dedicated release GitHub App and are isolated from builder-bot workflows.

## Flow summary

`changeset per PR -> beta -> demo-store e2e -> release PR -> merge = tag + Release + Registry publish`

1. **Changeset per PR** ([`.github/workflows/changeset-check.yml`](.github/workflows/changeset-check.yml), [`.github/workflows/preview.yml`](.github/workflows/preview.yml)):
   - Every pull request must include a `.changeset/*.md` file declaring its bump (or an explicit empty changeset via `npx changeset --empty`).
   - Pull requests also publish an ephemeral preview package via `npx pkg-pr-new publish`. If the `pkg-pr-new` GitHub App is not installed on the repository (`is not installed on or does not have access`), the workflow emits a `::notice::` annotation explaining that the App must be installed and exits `0` so PR checks still pass; any other `pkg-pr-new` failure still fails the job.
2. **Beta cut & publish** ([`.github/workflows/release-beta.yml`](.github/workflows/release-beta.yml)):
   - When changesets land on `main`, the release workflow cuts `x.y.z-beta.N` and publishes it to the EmDash plugin Registry under the separate build-time plugin slug/ID `dinkus-payments-beta` (set at build time via `scripts/release-flow.mjs`, never by editing the stable `dinkus-payments` ID in `package.json`), because the Registry has no prerelease filter and no true delete.
   - Beta numbers are never reused: `N` is computed as `max(existing beta git tags, existing dinkus-payments-beta versions on the EmDash Registry) + 1`.
   - The git tag `vx.y.z-beta.N` is reserved and pushed to `origin` **before** publishing to the EmDash Registry, and publish is guarded by a Registry check that skips publishing if `dinkus-payments-beta@x.y.z-beta.N` already exists.
3. **Demo-store install & E2E gate** ([`.github/workflows/release-beta.yml`](.github/workflows/release-beta.yml)):
   - `dinkus-payments-beta@x.y.z-beta.N` is installed **only** on the demo store (`vars.DEMO_STORE_URL`).
   - Triggers Ryan's E2E workflow against the demo store and waits for completion.
   - A passing E2E run automatically unlocks the final release PR; a failing E2E run blocks it.
4. **Release PR** ([`.github/workflows/release.yml`](.github/workflows/release.yml)):
   - After the E2E gate passes, `changesets/action` (authenticated as the dedicated release GitHub App) opens or updates the `changeset-release/main` pull request bumping `package.json`, `package-lock.json`, and `CHANGELOG.md`.
   - No GitHub Environment approval is used; **merging the Release PR is the human approval gate**.
5. **Merge = Tag + GitHub Release + Registry Publish** ([`.github/workflows/release.yml`](.github/workflows/release.yml)):
   - When the Release PR merge lands on `main` (no pending changesets and `package.json` version `>= 0.2.0`), `inspect` checks git tag `vX.Y.Z`, GitHub Release `vX.Y.Z`, and EmDash Registry presence (`dinkus-payments@X.Y.Z`) **separately**.
   - If any of the three is missing, `publish-release` runs in strict idempotent order, skipping any step already completed:
     1. Create/ensure git tag `vX.Y.Z` on `origin`.
     2. Ensure GitHub Release `vX.Y.Z` (created from that version's `CHANGELOG.md` section if missing).
     3. Query the EmDash Registry for `dinkus-payments@X.Y.Z` and build, bundle, and publish stable `dinkus-payments@X.Y.Z` (`emdash-plugin build`, `emdash-plugin bundle`, `emdash-plugin publish`) only if that version does not already exist on the Registry.
   - Runs are serialized via `concurrency` (`cancel-in-progress: false`).

## Retry safety & resumability

- **Stable release (`release.yml` + `scripts/release-flow.mjs`)**:
  - `inspectReleaseState` does **not** treat "git tag exists" as sufficient for `noop`. It inspects tag presence (`vX.Y.Z`), GitHub Release presence (`vX.Y.Z`), and EmDash Registry presence (`dinkus-payments@X.Y.Z`) independently, returning `mode=publish` whenever any step is incomplete (`release-pr-merged-untagged`, `resume-after-tag`, or `resume-after-github-release`) and `mode=noop` (`release-complete`) only when all three exist.
  - Each step in `publish-release` checks target state first and skips when already done, so re-running a failed workflow after a partial failure safely resumes from the first incomplete step without failing on duplicate tags, duplicate GitHub Releases, or immutable Registry versions.
- **Beta release (`release-beta.yml` + `scripts/release-flow.mjs`)**:
  - `computeNextBetaNumber` takes the maximum `N` across both git tags (`vX.Y.Z-beta.N`) and existing EmDash Registry versions for `dinkus-payments-beta` (`X.Y.Z-beta.N`) and adds `1`.
  - `cut-and-publish-beta` reserves and pushes `vx.y.z-beta.N` before calling `emdash-plugin publish`, and skips `emdash-plugin publish` if `dinkus-payments-beta@x.y.z-beta.N` is already on the Registry.

## Version source, `0.x` bump policy, and git tags

- **Version source**: `package.json` (currently `0.2.8`) is the single source of truth. `emdash-plugin.jsonc` omits `version` so `@emdash-cms/plugin-cli` reads it from `package.json`.
- **`0.x` bump policy**:
  - `patch`: bug fixes only (`fixes = patch`).
  - `minor`: everything else (`everything else = minor`).
  - `major`: disallowed while in `0.x`.
  - Explicit empty changeset (`npx changeset --empty`): allowed for non-release chores/docs/tests.
- **Git tags**: `vX.Y.Z` (for example `v0.2.8`, `v0.3.0`). Tagging starts at `v0.2.0`; earlier pre-`0.2.0` versions are untagged.

## Required repository infrastructure

### GitHub App

- Dedicated **Release GitHub App** (separate from the builder bot) installed on `dinkuskit/payments` with repository permissions:
  - `contents: write`
  - `pull-requests: write`

### Repository secrets

- `RELEASE_APP_ID` — App ID of the dedicated Release GitHub App.
- `RELEASE_APP_PRIVATE_KEY` — Private key (PEM) of the dedicated Release GitHub App, used with `actions/create-github-app-token`.
- `EMDASH_REGISTRY_TOKEN` — Authentication token/session credential for publishing `dinkus-payments` and `dinkus-payments-beta` to the EmDash plugin Registry.
- `DEMO_STORE_DEPLOY_TOKEN` — Token used by `release-beta.yml` to install `dinkus-payments-beta` on the demo store.
- `DEMO_STORE_E2E_TOKEN` — Token used by `release-beta.yml` (`e2e-gate`) to dispatch and watch Ryan's demo-store E2E workflow.

### Repository variables (`vars`)

- `DEMO_STORE_URL` — Base URL of the demo store where `dinkus-payments-beta` is installed and verified.
- `DEMO_STORE_SITE_ID` — Site identifier for the demo store installation target.
- `DEMO_STORE_E2E_REPO` — Repository (`owner/repo`) hosting Ryan's demo-store E2E workflow (defaults to `dinkuskit/payments` if unset).
- `DEMO_STORE_E2E_WORKFLOW` — Workflow filename or ID for the demo-store E2E suite (defaults to `demo-store-e2e.yml`).
