# Explicit EmDash peer compatibility mode

The Payments Worker has no EmDash dependency. This change affects only the
pinned Commerce package verifier and its usage documentation. Its default
peer remains EmDash 1.0.1; an explicit `--emdash-peer=1.2.0` selects the
published core target from the [official release](https://github.com/emdash-cms/emdash/releases/tag/emdash%401.2.0).

Both modes retain Commerce source `70419ae55c4f73354e3f0eda08b09bbc85368000`
and archive SHA256 `38c1c6b59ad37db506986dc9de72fa53f601f7c66d5df53a1c39e9ca3c351730`.
New results record the actual/requested peer, peer manifest and content hashes, original
Commerce identity, and synthetic proof boundary. Historical proof is unchanged.

The verifier pins complete published package content before extraction/import.
The SHA-256 input is JSON of all `[relativePath, fileSha256]` pairs sorted by
relative path. It covers every regular package file, including source maps;
only root `node_modules` is excluded as a separately qualified dependency
closure. Symlinked/non-regular package files are rejected.

| Published peer | Tarball SHA-256 | Package content SHA-256 |
| --- | --- | --- |
| [1.0.1](https://registry.npmjs.org/emdash/-/emdash-1.0.1.tgz) | `4541232693816e1f7500ac61b04198f8a560929751d3ad2bbf7cd662410d33f3` | `578ed9c8df94b72b7404fa99fce24702c40683f8999f8e10e868e4bd0d19ce28` |
| [1.2.0](https://registry.npmjs.org/emdash/-/emdash-1.2.0.tgz) | `2dcc64e596e4375990d9b2609abb694bcfc6ef0da1612cc2cfc145ca0cdf3c5c` | `17b41485d10c8a8040541fedf41ccb05543beae69d0a4d27a2f9063523f2a9ad` |

Both tarballs were obtained with lifecycle scripts disabled. Independent
digest generation covered 2,489 files for 1.0.1 and 2,551 for 1.2.0. The
historical installed peer exactly matched its published package files.

Parent verification on October 7, 2026:

- Default 1.0.1: all five coupon/shipping scenarios passed; payable cases
  retained snapshots and session mappings across SQLite reopen/replay, with
  one canonical order and coupon consumption. Zero total rejected before
  provider creation. Every provider transport was intercepted.
- Unsupported mode, mismatched peer, and extra arguments: failed before
  extraction/provider fixture setup.
- OpenClaw's unpinned-peer finding was accepted. A copied 1.0.1 peer with
  modified compiled code and unchanged manifest passed all five cases before
  repair; the same fixture failed the pinned content check after repair.
  Missing, added, and symlinked 1.2.0 package files also failed before
  extraction/import. Authentic 1.2.0 passed the content guard and still
  encountered the separately recorded missing-runtime-dependency limitation.
- `bin/verify-payments quick`, script syntax, and diff checks passed.
- The exact public EmDash 1.2.0 tarball was acquired with lifecycle scripts
  disabled. SHA256: `2dcc64e596e4375990d9b2609abb694bcfc6ef0da1612cc2cfc145ca0cdf3c5c`.
  Its package manifest is the correct name/version, but runtime import cannot
  resolve required `kysely` in this extracted peer. No 1.2 compatibility PASS
  or dependency installation is claimed.

Complete migration acceptance depends on the new qualified Commerce 1.2
source/schema/npm/Registry/backend handoff and original installed host proof.
The existing script intentionally cannot accept a replacement archive until
that immutable fixture is separately reviewed. Synthetic package cases do not
prove installed PluginContext, real JWT authority, public onboarding, scheduler
or wake delivery. No Worker/provider code, dependencies, lockfile, data,
historical decision/proof record, deployment, credential, grant or account
changed.
