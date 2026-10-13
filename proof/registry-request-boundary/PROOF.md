# Registry authorization request boundary

Base: 8c4cb37ad358547be331681e6e82d0ede518824d (Registry 0.2.3).
Prepared version: 0.2.4. Publication, installation and live verification are separate gates.

## Reproduction and change

A compiled new-grant Continue performs nine bridge calls to verify and save
authorization, then previously began an immediate status read. That read's
settings lookup is bridge call eleven. A synthetic ten-call guard reproduces
`status_read_session` at exactly that call. The new request boundary returns
authorization-saved UI after nine calls. A separate explicit Check succeeds
in five calls for a ready status, reading the actual persisted session and
leaving storage unchanged. No processor request is made by Continue.

The test uses the real Registry instance identifier and real encrypted
settings/KV bridges. A separate roundtrip test verifies two renewals and
restarts without altering the stored session or binding. Existing tests
retain signature/owner/expiry/host-policy and diagnostics coverage.

## Evidence limits

The installed EmDash Cloudflare runner sets `limits.subRequests=10` on the
Worker Loader module. Cloudflare documents custom limits per invocation,
service-binding calls as subrequests, and that configured limits are not
enforced in local development:

- https://developers.cloudflare.com/dynamic-workers/usage/limits/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits
- https://developers.cloudflare.com/workers/wrangler/configuration/#limits

The earlier local probe completed twenty bridge calls. It therefore cannot
rule out a deployed limit; the enforced test models that documented contract.
Its matching failure stage is evidence for the request-boundary problem, not
a captured production limit exception. The live underlying exception remains
unconfirmed until observed or the reviewed change is installed and verified.

No key values, stored credentials, raw exceptions or provider response bodies
were inspected. No resource limits or cryptographic/ownership checks changed.
No hosted Worker source/config changed; rollout is Registry-only.

## Verification

`bin/verify-payments full` passes with Node22.23.2: 198 Node tests, 30 hosted
Worker tests, 14 compiled Registry tests, both TypeScript targets, repository
audit, Worker dry build and official plugin validation/build.

The rebuilt hosted Worker SHA-256 remains
`e6f51756c27a6bd74c7d4a3b58567e9c1f268681ef2b24cf6ee21bbdbfdc3e7b`;
production config remains
`fe2f0ae9b11b30bedc9e4352ca0135b377202c664eff50a59dbc9896f30f57bf`.
Both match the preceding deployed release byte-for-byte.
