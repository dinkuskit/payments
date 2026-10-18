# Release-version inventory repair

## Scope and cause

Repository: `dinkuskit/payments`.
Base: `c5193c64daa02b16925b2e0666be4017aad9fff3`.
Branch: `codex/payments-beta-profile-20261017`.
Failing run: https://github.com/dinkuskit/payments/actions/runs/39090177426

The first manual beta run failed in version resolution before tagging or
publishing. `emdash-registry.pages.dev` no longer resolves. Current EmDash
uses `registry.emdashcms.com`, but its XRPC discovery catalog can return
`ListingUnavailable` for an unpublished profile. Catalog visibility therefore
cannot establish which version record keys are already occupied.

Sources:
- https://docs.emdashcms.com/plugins/registry-client/
- Installed `@emdash-cms/registry-lexicons` package release and listReleases schemas.
- Existing `.github/scripts/verify-registry-release.mjs` publisher-PDS verifier.

## Change

Version allocation and duplicate checks now resolve the publisher DID from
`emdash-plugin.jsonc` and read every page of its public
`com.emdashcms.experimental.package.release` records. The check validates record
URI, publisher, package and version identity and refuses failed requests,
malformed records or incomplete pagination. It does not use discovery visibility
as an empty-history signal. Workflow overrides for the retired endpoint were
removed. Release dispatch and promotion gates remain in place.

## Validation

Node: 22.23.2, matching `.nvmrc`.

- New regression tests failed against the old API implementation (2 failures).
- `node --test tests/release-flow.test.mjs`: 17 passed, 0 failed,
  including all 12 release-authority scenarios.
- `npm test` from a clean tracked-source snapshot: 248 passed, 0 failed.
- `npm run typecheck`: exit 0.
- `npm run audit:repo` from that snapshot: `public_repository_contract=clean`.
- `git diff --check`: exit 0.
- Live read-only `node scripts/release-flow.mjs plan-beta`: exit 0:

```json
{"shouldCut":true,"currentVersion":"0.2.8","targetVersion":"0.2.9","version":"0.2.9-beta.1","betaVersion":"0.2.9-beta.1","betaTag":"v0.2.9-beta.1","slug":"dinkus-payments-beta","changesetCount":1}
```

Local proof files under ignored `runs/` cause the public-layout test to refuse
the working checkout. The complete suite and audit were therefore rerun from a
clean copy of tracked source plus the new changeset, preserving the original
local proof without changing the audit.

## Gates

This proof covers source behavior and read-only live inventory, not a successful
publication. No tag, release or publishing approval was created by validation.
A main-branch retry requires the reviewed source to be merged by the owner.
