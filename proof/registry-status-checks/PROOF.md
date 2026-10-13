# Registry status-check repair proof

Base: `cfb7214198e53e6786a699f3de1cfec6708f29de` (Registry 0.2.2).
Prepared version: Registry 0.2.3. No publication or installation is implied.

## Reproduced behavior and repair

Two compiled-runtime regression tests fail on the base and pass with this change:

- A completed-grant Check consumes a successful status/diagnostics response, then
  incorrectly starts a second status sequence. An unavailable second response
  erases the successful result with an indefinite checking message. The repair
  reuses the first result; exactly one JWKS/status/diagnostics sequence is observed.
- A bridge failure on the control-state read after successful diagnostics is
  swallowed into the same checking message. The repair returns a terminal failed
  check, with `status_recheck_control`, no stale readiness, and no setup action.

Compiled tests also inject initial control, saved-session, verification, status
transport, malformed status, and HTTP 503 failures. Each reports only the observed
fixed stage, permits an explicit fresh check, and omits exception text and response
content. A following successful check clears the failure. Optional diagnostics
remain best-effort; existing tests cover unavailable/invalid diagnostics, expiry,
wrong users, and HTTP host policy. No check initiates processor setup.

## Validation

`bin/verify-payments full` passes on Node 22.23.2:

- 198 Node tests;
- 30 hosted Worker tests;
- 12 compiled Registry runtime tests;
- both TypeScript targets, repository audit, hosted dry build, official Registry
  validation/build and build-identity check.

Toolchain: EmDash and Cloudflare adapter 1.2.0, plugin-test 0.2.8,
plugin-cli 0.13.3, Vitest 4.1.11, Wrangler 4.144.0.
Synthetic state only; no credentials or provider calls.

## Limits and rollout

The historical live failure's underlying cause remains unconfirmed. These tests
prove the duplicated request and misleading failure projection, not the cause of
an earlier production exception. An independent local budget probe completed 20
bridge reads with the default runner configured for 10 subrequests; counting RPCs
against that limit is not validated causal evidence. The limit is unchanged.

Only fixed stage names and, for unsuccessful status responses, integer HTTP status
are exposed. No raw errors, response bodies, tokens, account IDs or stored values
are included. The output is per invocation and not persisted.

The rebuilt hosted `worker.js` SHA-256 is
`e6f51756c27a6bd74c7d4a3b58567e9c1f268681ef2b24cf6ee21bbdbfdc3e7b`.
Production config SHA-256 is
`fe2f0ae9b11b30bedc9e4352ca0135b377202c664eff50a59dbc9896f30f57bf`.
Both match the preceding hosted release byte-for-byte. No hosted source or
configuration changed. Rollout needs the reviewed Registry package published and
installed; a hosted redeployment is unnecessary. Reviews, merge, publication,
installation and live E2E are separate completion gates.
