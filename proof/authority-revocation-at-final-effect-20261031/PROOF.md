# Release authority revocation across tag and Registry publishing handoffs

Date: 2026-10-31.
Repository: `dinkuskit/payments`.
Base: `30d48d0d70ee8b91bd8f5f6f1af141c51ff4645d`.
Branch: `oracle-fix/authority-revocation-at-final-effect-20261031-134545-d339`.

## Authorization lifetime decision (Option 1)

Creating a release tag does **not** grant irrevocable downstream publishing authority. Human repository write authority remains revocable across every workflow handoff through final GitHub Release creation and final EmDash Registry publication:

1. **Tag producer boundary (`release.yml` -> `jobs.release`)**: `cut-beta`, `add-fix`, `promote`, and `publish-merged-release` re-verify `github.triggering_actor`'s current repository permission (`admin`, `maintain`, or `write`) immediately before each branch push, release PR write, and tag push. Every App-pushed `vX.Y.Z-beta.N` and `vX.Y.Z` tag is created as an **annotated Git tag object** carrying `Release-Actor: <login>`.
2. **Tag verification and GitHub Release boundary (`release.yml` -> `jobs.release-tag`)**: `verify-release-tag --require-actor` runs on both automatic tag `push` events and manual `retry-publish` dispatches. When `--actor` is omitted on an automatic tag `push`, `resolveTagActor` reads `Release-Actor` exclusively from an annotated `tag` object (`%(objecttype) == "tag"`, rejecting lightweight tags pointing to commits so commit messages cannot forge provenance). `verifyWriteAuthority` re-verifies that human actor's current write permission before `gh release create` and before writing `release_actor` to `$GITHUB_OUTPUT`.
3. **Final EmDash Registry boundary (`emdash-release.yml` -> `jobs.publish`)**: `release.yml` forwards `release_actor: ${{ needs.release-tag.outputs.release_actor }}` and explicit `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` secrets (no `secrets: inherit`) to `emdash-release.yml`. After install, unit tests, typecheck, plugin build, provenance attestation, and listing media staging—immediately before `emdash-cms/emdash/apps/release-action`—`emdash-release.yml` mints a read-only GitHub App installation token narrowed to `permission-contents: read` (zero write capability) and runs `node scripts/release-flow.mjs verify-authority --actor "$RELEASE_ACTOR"`. Access revoked during the build window aborts the job before `release-action` executes.

## 1. Real subprocess + bare-origin Git push + executable `gh` handoff traces

Executed via `node --import tsx --test tests/release-flow.test.mjs` (`test_revoked_between_enqueue_and_publish_yields_zero_effects`), driving real `node scripts/release-flow.mjs` child processes, real `git push --atomic origin ...` against a `git init --bare` `origin.git` repository, fresh per-job `git clone` runners, and an executable `gh` binary over loopback HTTP enforcing token scopes (`app-write-token` vs read-only `app-contents-read-token`).

### 1a. Allowed end-to-end chain (`alice` holds `write`)

```text
$ node scripts/release-flow.mjs cut-beta --actor alice
HTTP: GET /repos/dinkuskit/payments/collaborators/alice/permission [token=app-write-token] -> 200 (permission=write)
exit: 0
stdout: {"shouldCut":true,"currentVersion":"0.2.8","targetVersion":"0.2.9","version":"0.2.9-beta.1","betaVersion":"0.2.9-beta.1","betaTag":"v0.2.9-beta.1","releaseBranch":"release/0.2.9","slug":"dinkus-payments-beta","changesetCount":1,"movedBranch":"","droppedBranches":"","betaSha":"e9e0e5705e616de36225e793920d2462f79dd78e"}

$ git -C $SANDBOX/origin.git cat-file -p refs/tags/v0.2.9-beta.1
object e9e0e5705e616de36225e793920d2462f79dd78e
type commit
tag v0.2.9-beta.1
tagger Release Bot <release-bot@example.invalid> 1793458052 -0400

Release v0.2.9-beta.1

Release-Actor: alice

# Fresh tag-checkout clone (automatic push event: no --actor flag passed):
$ node scripts/release-flow.mjs verify-release-tag --ref refs/tags/v0.2.9-beta.1 --require-actor --github-output $SANDBOX/beta.out
HTTP: GET /repos/dinkuskit/payments/collaborators/alice/permission [token=app-write-token] -> 200 (permission=write)
exit: 0
stdout: {"version":"0.2.9-beta.1","tag":"v0.2.9-beta.1","tagSha":"e9e0e5705e616de36225e793920d2462f79dd78e","releaseBranch":"release/0.2.9","releaseMode":"beta","slug":"dinkus-payments-beta","githubReleaseCreated":false,"releaseActor":"alice"}
$GITHUB_OUTPUT:
  version=0.2.9-beta.1
  tag=v0.2.9-beta.1
  release_mode=beta
  slug=dinkus-payments-beta
  release_actor=alice
  github_release_created=false

# Final pre-publish check in emdash-release.yml using permission-contents: read App token:
$ node scripts/release-flow.mjs verify-authority --actor alice --effect "publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry"
HTTP: GET /repos/dinkuskit/payments/collaborators/alice/permission [token=app-contents-read-token] -> 200 (permission=write)
exit: 0
stdout: {"ok":true,"actor":"alice","permission":"write","effect":"publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry"}

# Promote -> squash-merge -> publish-merged-release pushes annotated stable tag v0.2.9:
$ node scripts/release-flow.mjs publish-merged-release --actor alice
HTTP: GET /repos/dinkuskit/payments/collaborators/alice/permission [token=app-write-token] -> 200 (permission=write)
exit: 0
stdout: {"tagPushed":true,"resumed":false,"version":"0.2.9","tag":"v0.2.9","releaseBranch":"release/0.2.9","releaseSha":"2778884b093de3dca09c129a399d4d0763529ea0","betaVersion":"0.2.9-beta.1","betaSha":"e9e0e5705e616de36225e793920d2462f79dd78e","consumedChangesets":[".changeset/add-feature.md"]}

$ git -C $SANDBOX/origin.git cat-file -p refs/tags/v0.2.9
object 2778884b093de3dca09c129a399d4d0763529ea0
type commit
tag v0.2.9
tagger Release Bot <release-bot@example.invalid> 1793458054 -0400

Release v0.2.9

Release-Actor: alice
```

### 1b. Revoked after tag push, before automatic `verify-release-tag` runs (`alice` downgraded to `read`)

```text
# Fresh tag-checkout clone checks out refs/tags/v0.2.9 after alice's permission changed to "read":
$ node scripts/release-flow.mjs verify-release-tag --ref refs/tags/v0.2.9 --require-actor --github-output $SANDBOX/revoked.out
HTTP: GET /repos/dinkuskit/payments/collaborators/alice/permission [token=app-write-token] -> 200 (permission=read)
exit: 1
stderr: Refusing to publish v0.2.9: alice no longer has write access to dinkuskit/payments (permission "read").
github_output_written: false
github_releases_created: 0
```

### 1c. Revoked during `emdash-release.yml` build/test window right before Registry publish

```text
# 1. verify-release-tag passes while alice still holds "write", creating GitHub Release v0.2.9 and outputting release_actor=alice:
$ node scripts/release-flow.mjs verify-release-tag --ref refs/tags/v0.2.9 --require-actor --github-output $SANDBOX/allowed-stable.out
HTTP: GET /repos/dinkuskit/payments/collaborators/alice/permission [token=app-write-token] -> 200 (permission=write)
HTTP: GET /repos/dinkuskit/payments/releases/tags/v0.2.9 [token=app-write-token] -> 404 (missing)
HTTP: POST /repos/dinkuskit/payments/releases [token=app-write-token] -> 201 (tag=v0.2.9)
exit: 0
$GITHUB_OUTPUT:
  version=0.2.9
  tag=v0.2.9
  release_mode=stable
  slug=dinkus-payments
  release_actor=alice
  github_release_created=true

# 2. alice's repository permission drops to "read" while emdash-release.yml installs, tests, builds, attests, and stages media:
$ node scripts/release-flow.mjs verify-authority --actor alice --effect "publish dinkus-payments@0.2.9 to EmDash Registry"
HTTP: GET /repos/dinkuskit/payments/collaborators/alice/permission [token=app-contents-read-token] -> 200 (permission=read)
exit: 1
stderr: Refusing to publish dinkus-payments@0.2.9 to EmDash Registry: alice no longer has write access to dinkuskit/payments (permission "read").
# Job aborts immediately before emdash-cms/emdash/apps/release-action runs (0 Registry publishes).
```

### 1d. Forged lightweight tag pointing to a commit whose message contains `Release-Actor: alice`

```text
$ git -C $SANDBOX/origin.git for-each-ref --format=%(objecttype) refs/tags/v0.2.10-beta.1
commit

$ node scripts/release-flow.mjs verify-release-tag --ref refs/tags/v0.2.10-beta.1 --require-actor
exit: 1
stderr: Refusing to publish v0.2.10-beta.1: "(empty)" is not a GitHub login whose write access can be checked.
http_requests: 0
```

## 2. Live read-only GitHub REST API trace against `dinkuskit/payments`

Verified live against `https://api.github.com/repos/dinkuskit/payments/collaborators/{username}/permission` using a short-lived GitHub App installation token scoped strictly to `{"contents":"read"}` (matching `permission-contents: read` in `.github/workflows/emdash-release.yml`, granting zero write capability; token kept strictly in child process memory and never printed):

```json
{
  "repository": "dinkuskit/payments",
  "tokenScope": {
    "contents": "read"
  },
  "restProbes": [
    {
      "endpoint": "GET /repos/dinkuskit/payments/collaborators/saariuslystoned/permission",
      "httpStatus": 200,
      "permission": "admin"
    },
    {
      "endpoint": "GET /repos/dinkuskit/payments/collaborators/octocat/permission",
      "httpStatus": 200,
      "permission": "read"
    }
  ],
  "cliRuns": [
    {
      "command": "node scripts/release-flow.mjs verify-authority --actor saariuslystoned --effect \"publish dinkus-payments@0.5.0 to EmDash Registry\"",
      "exitCode": 0,
      "stdout": "{\"ok\":true,\"actor\":\"saariuslystoned\",\"permission\":\"admin\",\"effect\":\"publish dinkus-payments@0.5.0 to EmDash Registry\"}",
      "stderr": ""
    },
    {
      "command": "node scripts/release-flow.mjs verify-authority --actor octocat --effect \"publish dinkus-payments@0.5.0 to EmDash Registry\"",
      "exitCode": 1,
      "stdout": "",
      "stderr": "Refusing to publish dinkus-payments@0.5.0 to EmDash Registry: octocat no longer has write access to dinkuskit/payments (permission \"read\")."
    }
  ]
}
```

## 3. Repository verification

- `npm run verify:quick`: `299/299` unit tests passed (`25/25` in `tests/release-flow.test.mjs`, including all 15 `release-authority-proof` scenarios `(a)`–`(o)`), `tsc --noEmit` clean, `public_repository_contract=clean`.
- `npm run changeset:check`: passed (`.changeset/authority-revocation-at-final-effect.md`).
- `actionlint .github/workflows/release.yml .github/workflows/emdash-release.yml`: exit `0`.
- `git diff --check`: exit `0`.

## Gates

No tag, release, Registry upload, workflow dispatch, secret mutation, or PR merge was performed by this validation. The live GitHub probe performed two read-only `GET /repos/dinkuskit/payments/collaborators/{username}/permission` requests with a `{ contents: "read" }` App installation token.
