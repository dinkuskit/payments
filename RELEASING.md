# Releasing `@dinkuskit/payments`

`@dinkuskit/payments` uses a locked release contract (GrillTrack `release-beta-cadence-078` and `release-branches-079` in dinkuskit/dinkuskit) with Changesets and a dedicated beta EmDash Registry slug so every release is proven in a real EmDash beta store before stable publication. The model is OpenClaw's release process: betas and stable releases come from a `release/X.Y.Z` branch, so `main` never waits for a beta.

## Release Identity

| Channel | EmDash Registry Slug | Installed Plugin ID (`derivePluginId`) | Package Version Format |
| --- | --- | --- | --- |
| **Beta** | `dinkus-payments-beta` | `r_sffx6l4z6mpqliki` | `X.Y.Z-beta.N` (e.g. `0.2.9-beta.1`) |
| **Stable** | `dinkus-payments` | `r_3brsc2on3bu673rn` | `X.Y.Z` (e.g. `0.2.9`) |

- Every release builds the Cloudflare sandbox artifact (`dist/sandbox/plugin.mjs`) and verifies that its size stays strictly under `128 KB` (`131,072` bytes).
- Historical git tags before `v0.2.8` are never backfilled; the stable tag baseline is `v0.2.8`.
- Every GitHub Actions `uses:` reference in `.github/workflows/*.yml` is pinned to a full 40-character commit SHA (enforced by `npm run audit:repo`).
- All release buttons are on **Release** (`.github/workflows/release.yml`), pressed on `main`: `action: cut-beta`, `add-fix` and `promote`. A button run never publishes; it pushes a version tag, and that tag's run publishes (`vX.Y.Z-beta.N` to `dinkus-payments-beta`, `vX.Y.Z` to `dinkus-payments`). `.github/workflows/emdash-release.yml` is a `workflow_call`-only helper that only the tag run calls. DinkusKit Commerce and Ship run the same files, so all three plugins release the same way.

## Delegated Registry Publishing (No Stored PDS Credentials)

Registry publishing uses GitHub OIDC, Sigstore build provenance (`actions/attest-build-provenance`), and the EmDash delegated release service (`emdash-cms/emdash/apps/release-action` targeting `https://releases.emdashcms.com`), so no Atmosphere/PDS handle or app-password secret is stored in this repository.

1. `.github/scripts/prepare-emdash-release.mjs` copies the audited Cloudflare sandbox prebundle (`dist/sandbox/plugin.mjs`) into an isolated temporary directory and invokes the official `emdash-plugin release prepare <slug@version>` command there, producing `.emdash-release/<slug>-<version>.tar.gz` plus the `publisher-did`, `bundle-file`, and `selector` outputs.
2. `actions/attest-build-provenance` signs build provenance over the prepared bundle tarball (`id-token: write`, `attestations: write`).
3. `scripts/registry-release-media.mjs` validates that bundle and prepares a complete URL-source release record. It uploads content-addressed bundle and provenance files to the tag's GitHub Release without replacement. A rebuilt gzip with different bytes gets a different filename; an identical retry reuses its verified asset. Existing same-name assets must have identical bytes; conflicts fail closed. A missing beta release is created as a prerelease, while a missing stable release is an error because the preceding tag gate creates it. Listing images use raw URLs pinned to the same source commit and checksums computed from their bytes.
4. The pinned `emdash-cms/emdash/apps/release-action` receives only `release-file` and submits that record through the same OIDC workload, provenance verification and approval policy. The service fetches and validates the images before storing them as publisher PDS blobs. It does not receive a direct PDS credential.
5. Because the delegated release service can currently end successful publishes in `RELEASE_CONFLICT` ([`emdash-cms/emdash#4159`](https://github.com/emdash-cms/emdash/issues/4159)), the publish step uses `continue-on-error: true` and `.github/scripts/verify-registry-release.mjs` acts as the fail-closed gate. It resolves the publisher PDS endpoint and verifies the exact bundle checksum and size plus the expected icon, banner and screenshot checksums, byte sizes and MIME types.

The `publish-emdash` caller and reusable `publish` job request `contents: write`
solely for these release asset uploads, in addition to their existing OIDC and
attestation permissions. No App token or new secret is introduced. They do not
move tags, replace assets, or alter the publisher profile. A GitHub release
whose immutability policy refuses additional uploads fails rather than being
unlocked or recreated. Existing package-profile copy still requires its own
approved `update-package`; publishing a version does not overwrite it.

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
3. In the [EmDash release-service publisher dashboard](https://releases.emdashcms.com/publisher), choose **Authorize publishing** for `dinkus-payments-beta` (and `dinkus-payments` if not already authorized), then approve the `dinkuskit/payments` `.github/workflows/release.yml` workflow connection when the dashboard first asks. Both buttons (Cut beta and Promote) live on `release.yml`, and `.github/workflows/emdash-release.yml` is only ever called from it, so one connection covers both listings. A connection made earlier through `emdash-release.yml` (from before Cut beta moved to `release.yml`) is no longer used. The dashboard shows a pending connection only while a run's publish step is waiting for it, for up to 30 minutes. If that time runs out, press **Run workflow** with **Use workflow from** set to the version tag and `action: retry-publish`; don't re-run the old run, which reuses its expired request and fails with `WORKFLOW_CONNECTION_CONFLICT`. The connection was first approved for runs on `refs/heads/main`; publishes now run from version tags, so the first tag run asks again. Approve it for version tags (`refs/tags/*`). Also add a repository ruleset on `release/*` branches and `v*` tags that lets only the release GitHub App push, create or delete them.

## Step 1: Every PR Includes a Changeset

Every pull request targeting `main` (except automated `ci: release` PRs on `changeset-release/main`) must add at least one `.changeset/*.md` file:

```bash
npm run changeset
```

Choose `patch` for fixes or `minor` for new features. For documentation, CI, or internal-only changes that should not bump the package version, create an explicit empty changeset (`npx changeset --empty`), which produces a `.changeset/*.md` file with empty frontmatter (`---\n---`) that satisfies `changeset-check.yml` and is excluded from version bump calculation.

Every PR also runs `.github/workflows/preview.yml` (`.github/scripts/publish-pkg-pr-new.mjs`) to publish an ephemeral tarball preview for that commit (or emit a `::notice::` and exit 0 if the `pkg-pr-new` GitHub App is not installed on the repository).

## When to Cut a Beta

(`release-beta-cadence-078`.) Press Cut beta when a batch is worth giving a store: a finished feature, or a fix a store owner would notice. There is no calendar. Ordinary PRs merge to `main` with their changesets and ship nothing on their own. Docs, tests and CI-only changes never get a beta, and Cut beta refuses when nothing version-bumping has merged since the last release. One release is on test at a time. Pressing Cut beta while a `release/X.Y.Z` with no `vX.Y.Z` tag is on test re-cuts it (see Cut beta below), and Add fix to beta refuses to start a patch branch until that release is promoted. Every change, including a fix for a beta on test, is a normal PR to `main` that ClawSweeper reviews; no PR ever targets a release branch.

## Step 2: Cut Beta (`dinkus-payments-beta`)

Press **Run workflow** on **Release** with `action: cut-beta` (leave `beta_version` blank to auto-compute the next `X.Y.Z-beta.N`, or supply an explicit one).

- `X.Y.Z` is the version `main`'s pending changesets would release; `N` is one more than the highest `vX.Y.Z-beta.*` git tag or `dinkus-payments-beta` release record on the manifest publisher's PDS. This reads every page of the public `com.atproto.repo.listRecords` inventory, including versions not yet visible in the discovery catalog, and fails closed on lookup, identity, schema, or pagination errors.
- It runs the unit tests, typecheck and build, creates `release/X.Y.Z` at `main`'s newest commit, and tags `vX.Y.Z-beta.N` there with the release GitHub App token (`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`). `main` keeps taking merges from here on; they wait for the next release.
- A beta already on test is re-cut, never deleted by hand (`release-branch-recut-20261030`). If `main` still makes the same `X.Y.Z`, the App moves `release/X.Y.Z` forward to `main`'s newest commit (copies made by Add fix to beta are already on `main`) and tags the next beta there. If `main` now makes a new version, the App deletes the older unpromoted branch in the same atomic push (its beta tags stay) and cuts the new one. It stops with nothing pushed when nothing new has merged since that beta, when the branch holds a commit that is neither on `main` nor an Add fix copy, or while a `ci: release` PR for that release is open, or merged with `vX.Y.Z` not tagged yet. Released branches are never touched.
- The tag's run checks that the tag sits on `release/X.Y.Z`, then calls `.github/workflows/emdash-release.yml` with `release_mode: beta`. Its gate (`.github/scripts/emdash-dispatch-gate.mjs`, `validateEmDashDispatchGate`) allows only a `refs/tags/vX.Y.Z[-beta.N]` ref whose version and mode match, before any Registry I/O. It prepares `.emdash-release/dinkus-payments-beta-X.Y.Z-beta.N.tar.gz` via `emdash-plugin release prepare` with `slug: "dinkus-payments-beta"`, `name: "DinkusKit Payments (Beta)"` and `version: "X.Y.Z-beta.N"`, signs build provenance, submits the release to `https://releases.emdashcms.com`, and verifies the publisher PDS release record (`verify-registry-release.mjs`).

## Step 3: Run Beta Store `@running` Journeys

The beta tag's run starts them itself. Once the beta is published, its **Start the live journeys on the beta store** job presses **Live journeys** in [dinkuskit/live-journeys](https://github.com/dinkuskit/live-journeys/actions/workflows/live-journeys.yml) with `beta: dinkus-payments-beta X.Y.Z-beta.N`. That run waits for the Registry to offer the beta, updates the beta store (beta.sm0ky.dev, `installedPluginId: r_sffx6l4z6mpqliki`) to it in place, and runs the `@running` journeys there. Its run is named `Live journeys for dinkus-payments-beta X.Y.Z-beta.N`, and its page shows each journey's pass or fail and the plugin versions tested. When it passes, Step 5's `proof_ref` is that run's address followed by the beta version, for example `https://github.com/dinkuskit/live-journeys/actions/runs/<run id> (X.Y.Z-beta.N @running pass)`; the address alone has no version in it, and the promotion gate refuses a proof that doesn't name the beta. If an update asks for new permissions the run stops and its page says what was asked; update the plugin by hand from the store's Plugins page, then press Run workflow again with the same `beta`.

The press needs the `DINKUS_LIVE_JOURNEYS_TOKEN` org secret, shared by every dinkuskit plugin repo: a fine-grained GitHub token owned by dinkuskit whose only access is **Actions: Read and write** on `dinkuskit/live-journeys`. Without it the job fails after the publish, and the journeys can be started by hand with the same `beta` input.

## Step 4: A Fix Found on the Beta (Add Fix to Beta)

Merge the fix to `main` through its normal reviewed PR. Then press **Run workflow** with `action: add-fix`, `release_version: X.Y.Z`, and `fix_commit` set to the fix's merge commit on `main`. It copies that exact commit onto `release/X.Y.Z` (`git cherry-pick -x`, so the copy names its source) and tags the next `vX.Y.Z-beta.N`, whose run publishes it and starts the journeys again. It refuses a commit that isn't on `main`, one already on the branch, and one that doesn't copy cleanly; then nothing is pushed. A release-file fix is copied the same way, so the branch runs it too.

## Step 5: Promote Verified Beta to a `ci: release` PR

Once the newest beta on `release/X.Y.Z` has passed the beta-store `@running` journeys, press **Run workflow** with `action: promote`, `beta_version: X.Y.Z-beta.N` and `proof_ref` (the recorded `@running` pass naming `X.Y.Z-beta.N`). The gate verifies that `vX.Y.Z-beta.N` is the tip of `release/X.Y.Z` (if a fix was added since, promote that newer beta once it passes), that `vX.Y.Z` is not released yet, and that `dinkus-payments-beta@X.Y.Z-beta.N` is in the EmDash Registry (failing closed on Registry errors). It then runs `npm run release:version` (`changeset version`, then `scripts/sync-lock-version.mjs` copies the new version into `package-lock.json` and changes nothing else) on the branch, refuses if the branch's changesets make a different version, and opens or updates the one `ci: release vX.Y.Z` pull request to `main` from `changeset-release/main`. That PR carries only the version, the `X.Y.Z` CHANGELOG section and the removal of the changesets that release used, with a `Release-Beta-Proof:` trailer binding the beta version, commit SHA and proof. Changesets merged to `main` after the cut stay pending for the next release.

## Step 6: Review and Merge `ci: release` PR to Publish Stable

1. Run `@clawsweeper review` on the `ci: release vX.Y.Z` PR.
2. When Ronald merges it into `main` (squash or merge commit), Release runs on the `push` to `main`. It writes the same version, CHANGELOG section and changeset removals onto `release/X.Y.Z` and refuses to tag unless the branch then differs from the approved beta tag only in `package.json`, `package-lock.json`, `CHANGELOG.md` and `.changeset/*.md`, with `package.json` and `package-lock.json` changing only the package's own `version`. Then it tags `vX.Y.Z` on the branch. If the run stops after committing onto the branch but before the tag, re-run it: it resumes from that commit.
3. The `vX.Y.Z` tag's run checks the same thing again, creates the GitHub Release from the matching `CHANGELOG.md` section if missing, and calls `.github/workflows/emdash-release.yml` with `release_mode: stable` to prepare, attest and publish `dinkus-payments@X.Y.Z` (`r_3brsc2on3bu673rn`) when the Registry does not index it yet, and verify the Registry record against the bundle either way. If a tag run fails, re-run it or press **Run workflow** with **Use workflow from** set to the tag and `action: retry-publish`.

## A Bug in a Released Version

Merge the fix to `main`, then press **Run workflow** with `action: add-fix`, `release_version` set to the next patch (`X.Y.(Z+1)`) and `fix_commit` set to the fix's merge commit. With no `release/X.Y.(Z+1)` yet, it makes that patch branch from the `vX.Y.Z` tag, copies the fix and tags `X.Y.(Z+1)-beta.1`. Journeys, then Promote and the release PR as above. A patch branch takes only patch changesets; Promote refuses one whose changesets make a minor release. Patch branches work for versions released through release branches; a fix for an earlier release ships in the next release from `main`.
