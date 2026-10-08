# Registry status candidate

The local `dinkus-payments` candidate is a private, read-only EmDash sandbox
page. It reports `availability: "unavailable"` and `status: null`; it has no
account-connect action, provider selection, external request, or Registry
publication.

The production-boundary proof uses `@emdash-cms/plugin-test@0.2.8`. Its runtime
host builds the source with the official plugin CLI, loads the built bundle in
workerd, validates the Block Kit page, and verifies `401` unauthenticated and
`403` insufficient-role responses. The shared account authentication flow
is implemented by the DinkusKit website for Inventory. Payments issuance and
refresh integration remain separate work; this candidate does not invoke it.

The proof bundle is kept under `.grilltrack/work/registry-status-20261008/`.

## Local verification

`bin/verify-payments full` passed on Node 22.23.2: 98 Node tests,
11 hosted workerd tests, both TypeScript targets, repository audit, hosted
Worker dry-run, official plugin validation/build and two plugin runtime tests.
`npm run plugin:bundle` also passed. No credentials or live providers were used.

The compiled runtime is 645 bytes, SHA-256
`282b85ee4227014b5fb4744a4375d9454bea4bad892da091ec46b93fc04e5c99`.
The local tarball SHA-256 is
`b79a536f7bd611decaa1874b40556fac3de9f1b48d09e169fc09baf690039db5`.
This proves official local packaging and built-bundle workerd dispatch; it does
not prove Registry publication, remote installation, connected account setup,
or a rendered browser screenshot.

Hosted Worker and plugin typechecks are separate because importing EmDash's
browser declarations into the Worker compilation introduces incompatible
ambient Web Crypto types. The unchanged baseline passes using the same added
dependencies; both target checks pass with the separation.
