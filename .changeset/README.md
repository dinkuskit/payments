# Changesets (`@dinkuskit/payments`)

Every pull request must declare its version bump in a changeset file under `.changeset/`.

## `0.x` bump policy

While `@dinkuskit/payments` is in `0.x`:

- **`patch`** — bug fixes only (`fixes = patch`).
- **`minor`** — everything else (`everything else = minor`, including features, contract updates, and breaking `0.x` changes).
- **`major`** — not used during `0.x`.
- **Explicit empty changeset** — allowed for non-release changes (docs, tests, CI, or repo-only chores) via `npx changeset --empty`.

## Version source and git tags

- The single source of truth for the package and EmDash plugin version is `package.json` (currently `0.2.8`). `emdash-plugin.jsonc` omits `version` so `@emdash-cms/plugin-cli` reads it from `package.json`.
- Git tags use the `vX.Y.Z` format (for example `v0.2.8`, `v0.3.0`).
- Tagging starts at `v0.2.0`; earlier pre-`0.2.0` versions are untagged.

## Adding a changeset

```sh
npx changeset
# or for changes that should not trigger a release:
npx changeset --empty
```

See [RELEASING.md](../RELEASING.md) for the full release pipeline (changeset per PR -> beta publish -> demo-store E2E gate -> release PR -> merge = tag + GitHub Release + EmDash Registry publish).
