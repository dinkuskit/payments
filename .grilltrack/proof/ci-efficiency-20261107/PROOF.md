# Full verifier build ordering

## Change and source

Base: `f3f4700388d46e34b55acf8b9b6bc90c5f4e01e1`.
The only executable change moves the existing build before quick checks in
[`bin/verify-payments`](../../../bin/verify-payments). Cold Node release-flow
tests already build the plugin when `dist/sandbox/plugin.mjs` is absent; full
verification previously built it again afterward. Quick and standalone tests
retain that fallback. No tests, dependency pins, runtime code, or workflow
selection change.

Candidate verifier SHA-256:
`7d6918ddc2f77a48c420b1a092ba7be0fb4b9889268faf06769d7bb3925a374c`.

## Local qualification

On Node 24.22.0 with locked dependencies, warmed tool caches, and initially
absent `dist`, this prefix passed:

```sh
npm run build
bin/verify-payments quick
npm run test:runtime
```

All 300 Node tests and 35 Worker tests passed, alongside typecheck and repository
audit. Snapshots immediately after build and after the prefix matched exactly:
all tracked file hashes, plus all 11 output files and two output directories
(paths, types, modes, sizes, and contents). SHA-256 digests:

- Tracked files: `da3953cc1821979020fb8250a03c56dc97434bbc8d7206441f6569aa22f24099`
- Complete `dist`: `4745cc70fa53dab3aeb0fa61207ec2902d3e83223a008967767a816ce57898d9`

Eight isolated command checks passed: the complete full path; build, unit,
Worker, and identity failures propagate their status and stop later stages;
quick success/failure and unknown-mode behavior match the base. These use
command stubs and do not substitute for real test execution.

An unchanged-base local full run passed Node/Worker checks but only 20/34
Registry cases; one unchanged warm Registry diagnostic repeated that result.
The first failure was an existing five-second two-host test timeout. Its cause
is unresolved. The candidate Registry suite has not run locally. There is no
local full-pass or performance claim.

## Pending hosted comparison and tradeoff

Qualify the same full command with baseline/candidate/candidate/baseline runs,
fresh output and matched tool-cache policy. Require all 369 existing cases,
at least one second and 2% lower median elapsed time, and no more than 5% CPU
regression where CPU is available. Record hosted CPU unavailability explicitly.
Separate verifier time, allocated job time, and workflow elapsed time; neither
component savings nor workflow timing establish billing savings.

Full mode now pays for the build before a failing quick check, and build errors
surface earlier. This preserves fail-fast propagation while changing failure
order. Warm runs with existing output may avoid no extra build. Registry
validation and real isolated runtime checks remain mandatory.

Docs impact: not applicable; internal verification only. The empty changeset
does not request a package version bump. Hosted full qualification, performance
measurement, and exact-head review remain pending.
