# Connection diagnostics country-repair regression

Scope: partial resolution of [Payments #55](https://github.com/dinkuskit/payments/issues/55), limited to the state mismatch described in [the review comment](https://github.com/dinkuskit/payments/issues/55#issuecomment-6251156021).

Base: `4981f78a9a717bb790a3948e3a936d7c47816111`.

## Behavior

A synthetic Accounts-v2 connection started one second ago has no processor account, a consumed `creationCountryRepair`, and a preserved normalized failure. Before the fix, `status()` returns `recovery_required` and `diagnostics()` returns `connecting`. The new regression failed on that exact difference before the implementation changed.

The diagnostics state now includes the same country-repair guard as status. The regression verifies the complete diagnostics result, including the preserved failure, and asserts unchanged serialized storage, zero writes, and zero calls to every provider method. Existing HTTP authorization, no-input, strict-decoder, and legacy read-only tests remain unchanged.

## Verification

Node: `22.23.2`, as pinned in `.nvmrc`.

- Red: `node --import tsx --test --test-name-pattern="recent consumed country repair" tests/onboarding-diagnostics.test.mjs` — failed with actual `connecting`, expected `recovery_required` before the fix.
- Green: `node --import tsx --test tests/onboarding-diagnostics.test.mjs tests/merchant-country.test.mjs` — 19 passed.
- `npm run typecheck` — passed.
- `bin/verify-payments full` — passed: 251 unit tests, 33 Worker runtime tests, 22 plugin-runtime tests, typecheck, repository audit, Worker dry-run build, plugin validation/build, and registry build identity.

Verified source blobs:

- `src/hosted/connection.ts`: `ebe761bde25b0356096c5c9c3d24ef4bf9617abe`
- `tests/onboarding-diagnostics.test.mjs`: `cd993023133fde65cd18fb8fd65463fd37005405`
- `.changeset/repair-recovery-diagnostics.md`: `b37313148029057385d23e7874a86af832402a20`

Generated test logs remain local. The repository contract intentionally rejects generated `runs/` directories, so full verification uses a temporary copy of tracked source plus this change, with installed dependencies linked from the owned worktree. No production credentials or live provider calls are used.

## Boundaries

No diagnostics fields, new recovery endpoint, authorization behavior, storage normalization, UI copy, protocol, or retry behavior changed. No live connection, account, key, deployment, merge, or release action was performed. The broader owner recovery evidence endpoint remains deferred, and #55 remains open.
