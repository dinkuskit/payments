# Verifier Performance Optimization Proof — 2026-11-04

Repository: `dinkuskit/payments`
Branch: `codex/ci-performance-20261104`
Base: `3f31db55a28e9ce9f6e6ae2d0f88cc8228cfe549`
Measured source change: `15a3f584826b5cb9b17ff78082db965609a8df4a`; subsequent commits change only this proof.
Environment: macOS arm64, Node 24.22.0, npm 11.19.1. Timings are local, not hosted-Linux CI measurements.

## 1. Scope & Mechanism

Removed the redundant duplicate `npm run plugin:build` invocation from `bin/verify-payments` under `full` mode.

In `bin/verify-payments`:
1. `npm run build` runs `wrangler deploy --dry-run --outdir dist && npm run plugin:build`, compiling the plugin into `dist/registry` and `dist/sandbox`.
2. `npm run plugin:validate` performs read-only manifest and metadata validation without mutating any build artifacts.
3. The subsequent duplicate `npm run plugin:build` recompiled the identical plugin sources into the identical output paths.
4. Standalone measurement of the removed duplicate plugin build measured **1.549s wall time**, 2.51s user CPU, and 0.32s sys CPU in isolation.

Removing this redundant step eliminates the duplicate compile while preserving all checks, scripts, and build artifacts.

## 2. Output Identity

- **Same-Invocation Duplicate Build Identity (All 11 files match)**:
  Within a single run invocation, `npm run plugin:validate` is strictly read-only and mutates zero files in `dist/`. Re-running `npm run plugin:build` produces byte-for-byte identical output files across all 11 files in `dist/`.
- **Across-Full-Run Identity (10/10 functional files match; raw full-tree equality is FALSE)**:
  Comparing distinct full verifier runs (baseline vs candidate):
  - 10 of 11 files match byte-for-byte with identical SHA-256 digests (`plugin.mjs`: `200637888540cbc630059a1839c20942f39f92b4ef0df844aa14ce7464a3512d`, `manifest.json`: `a1bdd7a88b059e22e34a01cc17e6f5c69bb0c5a5b382a094ff5c1600c23bbc9f`).
  - Exactly one file differs: `dist/README.md`. As defined in `wrangler` (`node_modules/wrangler/wrangler-dist/cli.js:212437`), `wrangler deploy --dry-run` writes an ISO timestamp (`new Date().toISOString()`) into `dist/README.md` on each invocation.
  - Consequently, **raw full-tree equality is FALSE**. Functional 10-file equality is **TRUE** with this documented volatile timestamp exception.

## 3. Benchmark Measurements & Characterization

All runs completed with exit status `0`:
- **Warm Baseline Runs**: 63.623s, 67.775s (spread: 63.623s–67.775s; mean: 65.699s wall, 60.83s user, 19.95s sys)
- **Candidate Runs**: 62.138s, 62.939s (spread: 62.138s–62.939s; mean: 62.538s wall, 57.41s user, 18.94s sys)
- **Observed Difference**: -3.161s (-4.81% wall clock) and -3.42s (-5.62% user CPU). This is an observed two-sample mean difference across local warm runs, not a confident causal speedup guarantee across varied hardware or CI environments.
- **Removed Step Impact**: Standalone measurement of the removed duplicate build was 1.549s wall time.
- **Billing Disclaimer**: No cloud invoice savings or guaranteed whole-job CI bill claims are asserted.

## 4. Verification & Test Integrity

- **Minimal Edit**: Exactly one line removed from `bin/verify-payments` (`npm run plugin:build` under `full`). Source deletion remains unchanged.
- **Standalone Commands Intact**: All `package.json` scripts remain unchanged.
- **Offline Full Verifier**: `bin/verify-payments full` passed with exit code 0.
- **Individual Target Checks**: All 8 target checks executed standalone and passed with exit code 0:
  - `npm test` (300 passed)
  - `npm run typecheck`
  - `npm run audit:repo` (`public_repository_contract=clean`)
  - `npm run test:runtime` (35 passed)
  - `npm run build`
  - `npm run plugin:validate`
  - `node scripts/registry-build-identity.mjs`
  - `npm run test:plugin-runtime` (34 passed)
- **Total Tests**: 369 passed, 0 failed, 0 cancelled in each full run. The suite inventory and assertions are unchanged; no instrumented coverage metric was collected.
