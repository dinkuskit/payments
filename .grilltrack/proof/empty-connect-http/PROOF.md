# Authenticated empty connect HTTP repair

## Accepted scope

Continue `merchant-hosted-service-003` unchanged, alongside the locked merchant
onboarding experience. Repair the existing server-to-server connect contract;
this is no registry release, identity service, Stripe activation, or installed
admin-readiness claim. Commerce retains checkout/order/receipt authority.

## Diagnosis and implementation

On the actual local workerd runtime, a POST with no supplied body arrived with
`request.body !== null`, while its first read was `done: true` and zero bytes.
The previous stream-presence guard returned `400 unexpected_input` for that
valid request. The handler now checks for content bytes without buffering them.
It accepts an exhausted stream, rejects the first content byte, and cancels the
reader. Authentication remains ahead of body inspection. Caller-supplied account,
provider, mode, callback URL, JSON, whitespace, and query parameters remain
rejected.

## Verification

- Failing-first Node regression: empty streams returned 400 before the repair.
- Node stream tests: empty and zero-byte streams accepted; content rejected
  immediately and canceled; unauthenticated input is not inspected.
- Workerd/SQLite HTTP test uses a test-only signed ES256 issuer and completely
  intercepted JWKS/Stripe transport. It proves connect/resume uses one account
  and binding; provider status establishes readiness; return-style success
  query cannot mark ready; outage produces checking; scope, site header, and
  different merchant are denied before provider contact.
- Full local gate uses Node 22.23.1: Node behavior, TypeScript, repository audit,
  workerd runtime, and offline Worker bundle. Host Node 24.21.0 could not load the
  native Rolldown binding due to macOS Team ID restrictions; switching to the
  established Node22 runtime resolved this environment issue without changing
  dependencies or source to bypass it.
- Existing workerd wake owner-denial tests emit caught application rejection
  diagnostics; the test runner exits successfully.

Synthetic readiness is mode TEST only. No real issuer, registry installation,
provider request, deployment, publication, account change, or merge occurred.
The changed Worker requires fresh exact-artifact proof; prior sealed Worker
receipts do not cover this change.

## Installed merchant connection gaps

Payments currently has only the hosted Worker backend. Its package exports no
EmDash descriptor or sandbox backend; there is no `emdash-plugin.jsonc`,
`src/plugin.ts`, Block Kit admin route, or registry bundle script. A real
installed path requires a fixed Payments host allowlist and private admin
route, the shared account application's authenticated session/token bridge,
authorized site grant, and authenticated return/refresh pages. EmDash admin
login alone does not confer a shared DinkusKit `payments:admin` token. Adding
an ad-hoc token input or trusting browser-selected identity would violate the
accepted normal merchant and issuer boundaries.

Authenticated return must restore the shared account session then GET status;
refresh must POST an empty connect request for the same signed site/owner and
use the short-lived returned link. Neither landing URL nor browser success
parameters confer readiness. These external pages and the issuer/session bridge
are not implemented by this backend repair.

## Real Stripe TEST handoff

Before an attended real TEST proof: provide the actual trusted shared issuer,
JWKS URL, service audience and authorized signed site/owner grant; approved TEST
Stripe platform secret and webhook secret in host secret bindings; approved
fixed HTTPS onboarding return/refresh and checkout success/cancel pages;
configured hosted service and webhook delivery under separate human deployment
approval; and the installed registry/admin client using that account bridge.
The operator must authorize TEST account creation/onboarding and the synthetic
purchase separately. Verify the exact Payments and Commerce artifacts, one
immutable recipient and session, webhook signature/wake/reconciliation,
canonical Commerce order/receipt, readiness regression, and replay/restart.
Do not write credentials, customer details, real account IDs, or tenant data
into this public proof. Live mode remains outside this scope.

## Current local result

`bin/verify-payments full` exited 0 on Node22.23.1: 79 Node tests,
10 workerd tests in four files, typecheck, public repository audit, and Worker
build all passed. `git diff --check` passed. Bundled Worker SHA-256:
`29c0837ae3fe0d6b2105942c103cc74cc25f52df6dec6a48d8f1023d708bee7e`.
This is the Payments artifact identity for this repair; it differs from the
prior `77c6fe...` sealed backend. Fresh Commerce integration against current
Commerce head is still required before claiming the whole installed path.
