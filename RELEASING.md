# Releasing `@dinkuskit/payments`

This document describes the automated release pipeline for `@dinkuskit/payments` (`dinkus-payments` and `dinkus-payments-beta` in the EmDash Registry), locked by GrillTrack decision `release-beta-cut-071` (`dinkuskit/dinkuskit` `docs/plans/release-process.md`).

---

## Overview (`release-beta-cut-071`)

Releases are driven by [Changesets](https://github.com/changesets/changesets), manual beta cuts to `dinkus-payments-beta`, live-store `@running` user-journey verification against the shared beta store, and GitHub Actions authenticated via the dedicated release GitHub App (`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` — never `GITHUB_TOKEN` for tag pushes, release PR creation, or downstream workflow triggers):

| Stage | Workflow | Trigger | Output |
| --- | --- | --- | --- |
| **1. PR Changeset Check** | `.github/workflows/changeset-check.yml` | Every PR to `main` | Verifies `.changeset/*.md` is present (`node .github/scripts/check-changeset.mjs`) |
| **2. PR Preview** | `.github/workflows/preview.yml` | Every same-repo PR to `main` | Publishes an ephemeral preview tarball via [pkg.pr.new](https://pkg.pr.new) |
| **3. Cut Beta (Manual)** | `.github/workflows/emdash-release.yml` | Manual `workflow_dispatch` on `main` | Computes `x.y.z-beta.N` from pending changesets + highest beta tag/Registry version, tags `vx.y.z-beta.N`, and publishes `dinkus-payments-beta@x.y.z-beta.N` (`r_sffx6l4z6mpqliki`) to the EmDash Registry |
| **4. Verify Beta on Live Beta Store** | `dinkuskit-live-test` skill + `src/registry/setup-journey.ts` | After cutting beta | Installs `dinkus-payments-beta@x.y.z-beta.N` on the shared beta store and runs all `@running` journeys (Payments setup, Commerce setup, Stripe test-card checkout, Authorize.net sandbox checkout) |
| **5. Promote Beta to Release PR (Manual)** | `.github/workflows/release.yml` (`workflow_dispatch`) | Manual `workflow_dispatch` with `beta_version` + `proof_ref` | Verifies the recorded beta pass and that `main` has not gained new changesets since `vx.y.z-beta.N`, then opens/updates the `ci: release vX.Y.Z` PR on `changeset-release/main` |
| **6. Stable Release + EmDash Registry Publish** | `.github/workflows/release.yml` (`push` to `main`) -> `.github/workflows/emdash-release.yml` (`workflow_call`) | Merging the ClawSweeper-reviewed `ci: release` PR | Tags `vX.Y.Z`, creates the GitHub Release from `CHANGELOG.md`, and publishes `dinkus-payments@X.Y.Z` (`r_3brsc2on3bu673rn`) to the EmDash Registry |

No Changesets `pre.json` mode is used, no beta is cut on ordinary merges to `main`, and no release PR is opened until a recorded beta pass is supplied.

---

## Prerequisites from `release-beta-cut-071`

### 1. Stable and Beta EmDash Registry Plugin IDs

EmDash derives the installed plugin ID via `makeRegistryPluginId(publisherDid, slug)` (`SHA-256("${publisherDid}\n${slug}")`, lowercase RFC 4648 base32 without padding, first 16 chars prefixed with `r_`). With publisher DID `did:plc:ekk4pjmkh3k3ql2kfoex3qt4` (`emdash-plugin.jsonc`):

| Channel | EmDash Registry Slug | Derived Installed Plugin ID | Admin Status Callback Path | Public Store-Proof Path |
| --- | --- | --- | --- | --- |
| **Stable** | `dinkus-payments` | `r_3brsc2on3bu673rn` | `/_emdash/admin/plugins/r_3brsc2on3bu673rn/status` | `/_emdash/api/plugins/r_3brsc2on3bu673rn/store-proof` |
| **Beta** | `dinkus-payments-beta` | `r_sffx6l4z6mpqliki` | `/_emdash/admin/plugins/r_sffx6l4z6mpqliki/status` | `/_emdash/api/plugins/r_sffx6l4z6mpqliki/store-proof` |

Both `src/registry/identity.ts`, `src/registry/manifest.ts`, `src/registry/connection.ts`, and `src/plugin.ts` accept `r_3brsc2on3bu673rn` (`dinkus-payments`) and `r_sffx6l4z6mpqliki` (`dinkus-payments-beta`), dynamically binding `callback_uri` and `store-proof` to the active installed plugin ID while failing closed on any unknown plugin ID.

### 2. Baseline Tag `v0.2.8`

Before cutting the first post-`0.2.8` Changesets release, the `0.2.8` baseline commit on `main` must carry the baseline git tag `v0.2.8` so Changesets and changelog diffs have a clean starting point:

```bash
# Run once by a maintainer (or via the release GitHub App) on the 0.2.8 baseline commit before the first release cut:
git tag v0.2.8 <0.2.8-commit-sha>
git push origin refs/tags/v0.2.8
```

### 3. `@running` Payments Setup Journey

The live-store gate includes the `@running` Payments setup journey defined in [`src/registry/setup-journey.ts`](src/registry/setup-journey.ts) and [`docs/payments-setup-journey.md`](docs/payments-setup-journey.md):

1. Install or open the Payments plugin on the store (`/_emdash/admin/plugins/r_sffx6l4z6mpqliki/status` for `dinkus-payments-beta`, or `/_emdash/admin/plugins/r_3brsc2on3bu673rn/status` for `dinkus-payments`).
2. Connect Payments with `DinkusKit.com` in Stripe test mode (`Connect` -> `Authorize Payments at DinkusKit` -> `Continue`).
3. Click `Check connection`.
4. Verify the banner reads `Connected: Stripe test mode`, the `Connect payments` step reads `Connected: Stripe test mode. Test card payments work at checkout.`, the `Place a test order` step is rendered, and no tokens or secrets appear in the UI or network payloads.

---

## Step-by-Step Release Process

### 1. Authoring a Pull Request

Every PR targeting `main` must include a changeset file under `.changeset/*.md` (enforced by `.github/workflows/changeset-check.yml`):

```bash
npm run changeset
```

Select the appropriate semver bump (`patch`, `minor`, or `major`), write a clear summary for `CHANGELOG.md`, and commit the generated `.changeset/<name>.md` file.

### 2. Cutting a Beta (`dinkus-payments-beta@x.y.z-beta.N`)

When one or more changesets are on `main` and ready for beta verification:

1. Trigger **Publish to EmDash Registry** (`.github/workflows/emdash-release.yml`) via `workflow_dispatch` on `main` (leave `version` blank to automatically calculate the next `x.y.z-beta.N`).
2. `node scripts/release-flow.mjs cut-beta` computes `x.y.z` from the pending `.changeset/*.md` files on `main` and sets `N` to `1 + max(existing vx.y.z-beta.* git tags, published dinkus-payments-beta Registry versions)`.
3. The workflow tags `vx.y.z-beta.N` on `HEAD` using the release GitHub App token, stages `dist/emdash-release` via `node .github/scripts/prepare-emdash-release.mjs --version x.y.z-beta.N`, validates that `dist/sandbox/plugin.mjs` is `< 131072` bytes, publishes `dinkus-payments-beta@x.y.z-beta.N` to the EmDash Registry, and verifies indexing via `node .github/scripts/verify-registry-release.mjs`.

### 3. Verifying the Beta on the Shared Beta Store

Install `dinkus-payments-beta@x.y.z-beta.N` (`r_sffx6l4z6mpqliki`) on the shared beta store (alongside the current `dinkus-commerce-beta`) and run all `@running` user journeys via `dinkuskit-live-test`:

- **Payments setup journey**: install/open `dinkus-payments-beta`, connect with `DinkusKit.com` in Stripe test mode, click `Check connection`, and verify `Connected: Stripe test mode`.
- **Commerce setup journey**: configure store settings and seed demo catalog.
- **Stripe test-card checkout journey**: complete checkout and verify the order reaches `paid`.
- **Authorize.net sandbox checkout journey**: complete checkout and verify the order reaches `paid`.

Record the passing proof reference (run URL, artifact path, or summary) naming `x.y.z-beta.N`.

### 4. Promoting the Verified Beta to a `ci: release` PR

Trigger **Release** (`.github/workflows/release.yml`) via `workflow_dispatch` on `main` with:

- `beta_version`: the verified beta version (e.g. `0.2.9-beta.1`)
- `proof_ref`: the recorded `@running` journey pass reference naming `beta_version`

The workflow verifies that:

1. `beta_version` matches the target version `x.y.z` computed from pending `.changeset/*.md` on `main`.
2. Tag `v<beta_version>` exists and `main` has not gained any new changeset or commit since `v<beta_version>` was cut (if `main` gained a new changeset after the pass, cut and verify the next beta first).
3. `dinkus-payments-beta@<beta_version>` is indexed in the EmDash Registry.
4. `proof_ref` names `beta_version`.

It then runs `npm run release:version` (`changeset version && npm install --package-lock-only --ignore-scripts`) and opens/updates the `ci: release vX.Y.Z` PR from `changeset-release/main` using the release GitHub App token.

### 5. Reviewing and Merging the `ci: release` PR

1. Run `@clawsweeper review` on the `ci: release vX.Y.Z` PR and wait for ClawSweeper + CI checks to pass.
2. Merge the `ci: release vX.Y.Z` PR into `main`.
3. On merge, `.github/workflows/release.yml` verifies the `Release-Beta-Proof` record, tags `vX.Y.Z`, creates the GitHub Release from `CHANGELOG.md`, and invokes `.github/workflows/emdash-release.yml` (`workflow_call`) to publish `dinkus-payments@X.Y.Z` (`r_3brsc2on3bu673rn`) to the EmDash Registry and verify indexing.
4. After both stable plugins (`dinkus-commerce` and `dinkus-payments`) are published, install them on the production demo store (`https://demo.dinkuskit.com`) and re-run the `@running` journeys to confirm the live demo.

---

## Required Secrets & Variables

Configure the following in the GitHub repository settings (**Settings -> Secrets and variables -> Actions**):

| Name | Kind | Required For | Description |
| --- | --- | --- | --- |
| `RELEASE_APP_ID` | Secret | Beta tags, `ci: release` PRs, stable tags/releases | App ID for the dedicated release GitHub App (`contents: write`, `pull-requests: write`, `issues: write`) |
| `RELEASE_APP_PRIVATE_KEY` | Secret | Beta tags, `ci: release` PRs, stable tags/releases | Private key (PEM) for the dedicated release GitHub App |
| `EMDASH_PDS_HANDLE` | Secret | EmDash Registry publish | AT Protocol handle corresponding to `publisher` (`did:plc:ekk4pjmkh3k3ql2kfoex3qt4`) in `emdash-plugin.jsonc` |
| `EMDASH_PDS_PASSWORD` | Secret | EmDash Registry publish | AT Protocol password / app password for `EMDASH_PDS_HANDLE` |
| `EMDASH_PDS_SERVICE` | Secret *(optional)* | EmDash Registry publish | Custom PDS service URL if not using the default Bluesky PDS |
| `EMDASH_REGISTRY_URL` | Variable *(optional)* | EmDash Registry publish & verify | Defaults to `https://emdash-registry.pages.dev` |

---

## Sandbox Bundle Size Requirement (`< 131072` bytes)

The EmDash Registry enforces a strict `131,072`-byte (128 KiB) limit on the compiled sandbox bundle (`dist/sandbox/plugin.mjs`). Both `npm run build` / `npm run plugin:build` (`scripts/build-plugin.mjs`) and `.github/scripts/prepare-emdash-release.mjs` check the byte count of `dist/sandbox/plugin.mjs` and fail if it reaches or exceeds `131072` bytes.
