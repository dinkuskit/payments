# Rejected full-verifier build-order experiment

## Disposition

Rejected: the candidate removed one explicit plugin build but failed the
predeclared elapsed-time threshold. The original verifier is restored; the
experiment's empty changeset is removed. There is no performance or billing
improvement claim and no proposed runtime, test, or workflow change.

Baseline: `f3f4700388d46e34b55acf8b9b6bc90c5f4e01e1`.
Measured candidate: `8b99a48bdbccd9a601197bba355a47dcdf38ba5d`.
It moved the existing full build before quick checks, leaving standalone quick
behavior and all tests unchanged. Cold release-flow tests otherwise build the
missing plugin before the later canonical full build.

## Hosted result

The unchanged test-only `repo-contract.yml` workflow ran in B,C,C,B order.
Every run passed the same 300 Node, 35 Worker and 34 Registry cases.

| Run | Source | Full-verifier step |
| --- | --- | ---: |
| [B1](https://github.com/dinkuskit/payments/actions/runs/42384666969) | Baseline | 82 s |
| [C1](https://github.com/dinkuskit/payments/actions/runs/42385170313) | Candidate | 81 s |
| [C2](https://github.com/dinkuskit/payments/actions/runs/42385394203) | Candidate | 79 s |
| [B2](https://github.com/dinkuskit/payments/actions/runs/42385566401) | Baseline | 72 s |

Baseline median: **77 s**. Candidate median: **80 s**, **3 s / 3.90% slower**.
The required improvement was at least one second **and** 2%. Paired directions
disagreed: C1 was one second faster than B1; C2 was seven seconds slower than
B2. Explicit `npm run plugin:build` invocations fell from two to one; the real
Registry fixture's internal build remained. Removed work did not establish a
net timing benefit.

Each run used a fresh hosted checkout/VM and `npm ci`, with the unchanged
lockfile-keyed npm tarball cache. No `dist`, `node_modules`, or Vite compiler
artifacts were restored. Runner hardware and Registry timings varied; this
four-run experiment does not isolate the cause of that variation. Values are
rounded service step durations, not workflow elapsed time or billed usage.
CPU measurements were unavailable, so the local CPU criterion was unevaluated.

## Retained local evidence and limits

With Node 24.22.0, locked dependencies, warmed tool caches and initially absent
`dist`, `npm run build`, `bin/verify-payments quick`, then
`npm run test:runtime` passed all 300 Node and 35 Worker tests plus typecheck
and audit. Before/after snapshots matched all tracked file hashes and the
entire output tree: 11 files and two directories, including paths, types,
modes, sizes and contents. SHA-256 digests:

- Tracked files: `da3953cc1821979020fb8250a03c56dc97434bbc8d7206441f6569aa22f24099`
- Complete `dist`: `4745cc70fa53dab3aeb0fa61207ec2902d3e83223a008967767a816ce57898d9`

Eight isolated command checks confirmed failure propagation and unchanged
quick/unknown-mode behavior; command stubs did not replace real test execution.
The unchanged local full baseline and one warm Registry diagnostic each passed
only 20/34 Registry cases, beginning with a five-second two-host timeout. Its
cause remains unresolved; candidate Registry tests were not run locally.
Earlier DNS and missing public OpenSSL-configuration setup failures, and a
corrected proof-harness assertion, remain retained as failed attempts. None is
counted as a performance sample or hidden by a timeout/test change.

## Restoration

[`bin/verify-payments`](../../../bin/verify-payments) SHA-256 is restored to
`c9c2d3b3c66f002d55f7544920f9c0fb7428333935181d6a9dd6cbaf4c54723e`.
All tracked paths from the baseline match their original bytes and modes.
Only this experiment record differs from the baseline; no package bump,
source/test change, preview publication, or deployment is proposed.

Docs impact: not applicable; retained experiment evidence only.
