# Release authority revocation across tag, workflow-connection approval wait, and Registry publishing handoffs

Date: 2026-10-31.
Repository: `dinkuskit/payments`.
Base: `17131a7463e9f09144bf1bda815901a5f879c3c3` (merged over initial base `30d48d0d70ee8b91bd8f5f6f1af141c51ff4645d`).
Branch: `oracle-fix/authority-revocation-at-final-effect-20261031-134545-d339`.

## Authorization lifetime decision (Option 1)

Creating a release tag or waiting for workflow-connection approval does **not** grant irrevocable downstream publishing authority. Human repository write authority remains revocable across every workflow and approval handoff through final GitHub Release creation and final EmDash Registry publication:

1. **Tag producer boundary (`release.yml` -> `jobs.release`)**: `cut-beta`, `add-fix`, `promote`, and `publish-merged-release` re-verify `github.triggering_actor`'s current repository permission (`admin`, `maintain`, or `write`) immediately before each branch push, release PR write, and tag push. Every App-pushed `vX.Y.Z-beta.N` and `vX.Y.Z` tag is created as an **annotated Git tag object** carrying `Release-Actor: <login>`.
2. **Tag verification and GitHub Release boundary (`release.yml` -> `jobs.release-tag`)**: `verify-release-tag --require-actor` runs on both automatic tag `push` events and manual `retry-publish` dispatches. When `--actor` is omitted on an automatic tag `push`, `resolveTagActor` reads `Release-Actor` exclusively from an annotated `tag` object (`%(objecttype) == "tag"`, rejecting lightweight tags pointing to commits so commit messages cannot forge provenance). `verifyWriteAuthority` re-verifies that human actor's current write permission before `gh release create` and before writing `release_actor` to `$GITHUB_OUTPUT`.
3. **Final EmDash Registry boundary (`emdash-release.yml` -> `jobs.publish`)**:
   - After install, unit tests, typecheck, plugin build, provenance attestation, and listing media staging, `.github/scripts/ensure-emdash-workflow-connection.mjs` runs `ReleaseServiceClient.waitForWorkflowConnection` (`@emdash-cms/registry-client/release-service`) with the audience-bound GitHub OIDC token, completing any up-to-30-minute pending workflow-connection approval wait **before** the final repository permission check runs.
   - Only **after** the workflow connection is `"connected"` does `emdash-release.yml` mint a fresh read-only GitHub App installation token (`permission-contents: read` only, zero write capability; minting post-wait also avoids App token expiry) and run `node scripts/release-flow.mjs verify-authority --actor "$RELEASE_ACTOR"`.
   - Immediately afterward, `emdash-cms/emdash/apps/release-action@45b542c016d35c7a88a590dce8e600e2384c13a9` runs with `wait-for-approval: "false"` and `timeout-minutes: "2"` (enforced by `verifyEmDashWorkflowContract` in `scripts/release-authority-proof.mjs`). Because the workflow connection is already `"connected"` and `stopOnApproval` is `true`, no 30-minute approval wait can outlive `verify-authority`.

## 1. Real subprocess + bare-origin Git push + annotated tag handoff traces

Executed via `node --import tsx --test tests/release-flow.test.mjs` (`test_revoked_between_enqueue_and_publish_yields_zero_effects`), driving real `node scripts/release-flow.mjs` child processes, real `git push --atomic origin ...` against a `git init --bare` `origin.git` repository, and fresh per-job `git clone` checkouts.

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
$ node scripts/release-flow.mjs verify-release-tag --ref refs/tags/v0.2.9 --require-actor --github-output $SANDBOX/revoked.out
HTTP: GET /repos/dinkuskit/payments/collaborators/alice/permission [token=app-write-token] -> 200 (permission=read)
exit: 1
stderr: Refusing to publish v0.2.9: alice no longer has write access to dinkuskit/payments (permission "read").
github_output_written: false
github_releases_created: 0
```

### 1c. Forged lightweight tag pointing to a commit whose message contains `Release-Actor: alice`

```text
$ git -C $SANDBOX/origin.git for-each-ref --format=%(objecttype) refs/tags/v0.2.10-beta.1
commit

$ node scripts/release-flow.mjs verify-release-tag --ref refs/tags/v0.2.10-beta.1 --require-actor
exit: 1
stderr: Refusing to publish v0.2.10-beta.1: "(empty)" is not a GitHub login whose write access can be checked.
http_requests: 0
```

## 2. Scoped production-path delegated Registry publishing owner (`emdash-cms/emdash/apps/release-action@45b542c016d35c7a88a590dce8e600e2384c13a9`) + unmodified `gh` CLI + live GitHub API & approval-wait revocation traces

Executed against:
- **Unmodified upstream `emdash-cms/emdash/apps/release-action@45b542c016d35c7a88a590dce8e600e2384c13a9`** (`apps/release-action/dist/index.js`, `sha256: e210c47e65583df0b792074257a0ff7d7bcd0cf4e8192ec60233f883fc28e34c`) fetched into ephemeral scratch `/tmp` and deleted after run;
- **Real `.github/scripts/prepare-emdash-release.mjs`**, **`scripts/registry-release-media.mjs`**, and **`.github/scripts/ensure-emdash-workflow-connection.mjs`**;
- **Unmodified system `gh` CLI** (`gh version 2.96.0 (2026-07-02)` — no replacement `gh` executable) querying **live `https://api.github.com/repos/dinkuskit/payments/collaborators/{username}/permission`** using a real `{ "contents": "read" }` GitHub App installation token (Traces 2a and 2b), plus a scoped local TLS release-service harness (`https://127.0.0.1:<port>`, `NODE_EXTRA_CA_CERTS`, TLS verification enabled) so zero production Registry records are mutated.

### 2a. Allowed maintainer (`saariuslystoned`) across pending workflow-connection wait -> live `api.github.com` check -> real `release-action@45b542c016d35c7a88a590dce8e600e2384c13a9` publication

```text
# Step 1: Preflight workflow-connection wait completes pending -> connected BEFORE authority-token / verify-authority:
$ node .github/scripts/ensure-emdash-workflow-connection.mjs \
    --service-url https://127.0.0.1:58917 \
    --publisher-did did:plc:ekk4pjmkh3k3ql2kfoex3qt4 \
    --slug dinkus-payments-beta \
    --timeout-minutes 30
exit: 0
stdout:
  ::add-mask::[REDACTED_OIDC_JWT]
  Approve this GitHub workflow to continue: https://127.0.0.1:58917/publisher?connection=01JGWK9B7R3M2N4P5Q6R7S8T9V
  ::add-mask::[REDACTED_OIDC_JWT]
  EmDash workflow connection ready for dinkus-payments-beta (dinkuskit/payments/.github/workflows/release.yml).

# Step 2: Post-wait authority re-verification using unmodified `gh` CLI + live GitHub REST API ({ "contents": "read" } App token):
# Live REST probe: GET https://api.github.com/repos/dinkuskit/payments/collaborators/saariuslystoned/permission -> HTTP 200 ("admin")
$ node scripts/release-flow.mjs verify-authority \
    --actor saariuslystoned \
    --effect "publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry"
exit: 0
stdout: {"ok":true,"actor":"saariuslystoned","permission":"admin","effect":"publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry"}

# Step 3: Unmodified pinned emdash-cms/emdash/apps/release-action@45b542c016d35c7a88a590dce8e600e2384c13a9 (dist/index.js)
# invoked with INPUT_WAIT-FOR-APPROVAL=false, INPUT_TIMEOUT-MINUTES=2:
$ node $SCRATCH/release-action/index.js
exit: 0
stdout:
  ::add-mask::[REDACTED_OIDC_JWT]
  ::add-mask::[REDACTED_OIDC_JWT]
  ::add-mask::[REDACTED_OIDC_JWT]
  ::add-mask::[REDACTED_OIDC_JWT]
  ::add-mask::[REDACTED_OIDC_JWT]
  ::add-mask::[REDACTED_OIDC_JWT]
  Submitted release intent 01JGWK9C8S4N3P5Q6R7S8T9V0W
  ::add-mask::[REDACTED_OIDC_JWT]
  Release intent 01JGWK9C8S4N3P5Q6R7S8T9V0W entered published
  Published at://did:plc:ekk4pjmkh3k3ql2kfoex3qt4/com.emdashcms.experimental.package.release/dinkus-payments-beta:0.2.9-beta.1 (bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi)

# Recorded OIDC + Release Service HTTPS trace across Steps 1 & 3:
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/workflow-connections [idempotency-key=github-connection-41215001-dinkus-payments-beta, poll=1] -> 200 (status=pending)
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/workflow-connections [idempotency-key=github-connection-41215001-dinkus-payments-beta, poll=2] -> 200 (status=connected)
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/workflow-connections [idempotency-key=github-connection-41215001-dinkus-payments-beta, poll=3] -> 200 (status=connected)
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/staged-artifacts [slot=package, content-type=application/gzip, bytes=17208, checksum=bciqa5nayths76sj...] -> 200
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/staged-artifacts [slot=provenance, content-type=application/json, bytes=152, checksum=bciqenlan3atnovn...] -> 200
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/staged-artifacts [slot=icon, content-type=image/webp, bytes=48260, checksum=bciqou4mpm5dxb5n...] -> 200
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/staged-artifacts [slot=screenshots[0], content-type=image/jpeg, bytes=63504, checksum=bciqhqp4aqldjckw...] -> 200
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/release-intents [idempotency-key=github-run-41215001, selector=dinkus-payments-beta@0.2.9-beta.1] -> 200 (intent=01JGWK9C8S4N3P5Q6R7S8T9V0W, state=publishing)
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  GET /v1/release-intents/01JGWK9C8S4N3P5Q6R7S8T9V0W?publisher=did%3Aplc%3Aekk4pjmkh3k3ql2kfoex3qt4 -> 200 (state=published)
  stagedArtifactCount: 4
  submittedIntentCount: 1
```

### 2b. Non-writer (`octocat`) after pending workflow-connection wait -> live `api.github.com` via unmodified `gh` CLI blocks `release-action`

```text
# Step 1: Preflight workflow-connection wait completes pending -> connected:
$ node .github/scripts/ensure-emdash-workflow-connection.mjs \
    --service-url https://127.0.0.1:58917 \
    --publisher-did did:plc:ekk4pjmkh3k3ql2kfoex3qt4 \
    --slug dinkus-payments-beta \
    --timeout-minutes 30
exit: 0
stdout:
  ::add-mask::[REDACTED_OIDC_JWT]
  Approve this GitHub workflow to continue: https://127.0.0.1:58917/publisher?connection=01JGWK9B7R3M2N4P5Q6R7S8T9V
  ::add-mask::[REDACTED_OIDC_JWT]
  EmDash workflow connection ready for dinkus-payments-beta (dinkuskit/payments/.github/workflows/release.yml).

# Step 2: Post-wait authority re-verification using unmodified `gh` CLI + live GitHub REST API ({ "contents": "read" } App token):
# Live REST probe: GET https://api.github.com/repos/dinkuskit/payments/collaborators/octocat/permission -> HTTP 200 ("read")
$ node scripts/release-flow.mjs verify-authority \
    --actor octocat \
    --effect "publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry"
exit: 1
stderr: Refusing to publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry: octocat no longer has write access to dinkuskit/payments (permission "read").

# Step 3 (emdash-cms/emdash/apps/release-action@45b542c016d35c7a88a590dce8e600e2384c13a9): NOT INVOKED
  releaseActionInvoked: false
  stagedArtifactCount: 0
  submittedIntentCount: 0
```

### 2c. Dynamic revocation **during** the pending workflow-connection approval wait (`alice`: `write` -> `read` mid-poll) blocks `release-action`

```text
# Pre-wait state: alice holds "write" when workflow-connection preflight begins:
  GET /repos/dinkuskit/payments/collaborators/alice/permission [permission-contents:read] -> 200 (permission=write)
  preWaitAuthorityCheck: {"ok":true,"actor":"alice","permission":"write","effect":"enter workflow-connection preflight"} (exit: 0)

# Step 1: ensure-emdash-workflow-connection.mjs enters status=pending; alice is downgraded write -> read BEFORE poll=2 returns status=connected:
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/workflow-connections [idempotency-key=github-connection-41215003-dinkus-payments-beta, poll=1] -> 200 (status=pending)
  [mid-wait state transition] collaborator alice downgraded write -> read while workflow-connection is pending
  GET /oidc?audience=https://127.0.0.1:58917 -> 200 (masked OIDC token issued)
  POST /v1/workflow-connections [idempotency-key=github-connection-41215003-dinkus-payments-beta, poll=2] -> 200 (status=connected)

# Step 2: verify-authority runs AFTER workflow-connection completes, sees permission="read", and aborts before release-action:
$ node scripts/release-flow.mjs verify-authority \
    --actor alice \
    --effect "publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry"
  GET /repos/dinkuskit/payments/collaborators/alice/permission [permission-contents:read] -> 200 (permission=read)
exit: 1
stderr: Refusing to publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry: alice no longer has write access to dinkuskit/payments (permission "read").

# Step 3 (emdash-cms/emdash/apps/release-action@45b542c016d35c7a88a590dce8e600e2384c13a9): NOT INVOKED
  releaseActionInvoked: false
  stagedArtifactCount: 0
  submittedIntentCount: 0
```

## 3. Repository verification

- `npm run verify:quick`: `300/300` unit tests passed (`26/26` in `tests/release-flow.test.mjs`, including all 15 `release-authority-proof` scenarios `(a)`–`(o)` plus the HTTPS OIDC + `ReleaseServiceClient` pending-wait revocation suite), `tsc --noEmit` + `tsconfig.plugin.json` clean, `public_repository_contract=clean`.
- `npm run changeset:check -- --base main`: passed (`.changeset/authority-revocation-at-final-effect.md`).
- `actionlint .github/workflows/release.yml .github/workflows/emdash-release.yml`: exit `0`.
- `git diff --check`: exit `0`.

## Gates

No tag, release, production Registry upload, workflow dispatch, secret mutation, or PR merge was performed by this validation. The live GitHub probe performed read-only `GET /repos/dinkuskit/payments/collaborators/{username}/permission` requests with a `{ "contents": "read" }` App installation token, and `emdash-cms/emdash/apps/release-action@45b542c016d35c7a88a590dce8e600e2384c13a9` executed solely against the loopback TLS release-service harness.
