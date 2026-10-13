# Optional TEST provider identity proof

Base: 7ecb6c1adb76eb87f7278446bedb659c4c39754c.
Candidate: Registry 0.2.6 plus optional hosted diagnostic, not deployed.

The diagnostic retains signed payments:admin authentication, requires the
stored owner/site and exact deployment operator account/site allowlist, and
refuses absent/invalid expected platform configuration before provider I/O.
No real configuration values are included in this repository.

The official Stripe client is constructed by the same factory as onboarding,
with the existing deployed credential. A fixed transport permits only one
GET /v1/account; it rejects alternate targets/context headers and removes
retryable transport error codes before the SDK sees them. Tests cover ECONNRESET
and EPIPE because maxNetworkRetries=0 alone does not suppress those SDK retries.
The returned provider ID is compared inside the consumer and never emitted.
The closed response decoder and UI reject unknown fields or malformed results.

Real Durable Object proof covers missing/malformed configuration, wrong
operator/site, mismatched stored owner/provider/mode and unchanged storage.
Synthetic provider tests cover match, mismatch, malformed payloads, HTTP
errors and closed connections. Compiled Registry proof covers the explicit
manual action, no identity request during ordinary Check, six bridge calls,
historical failure preservation, unavailable/raw response redaction and a
concurrent flow replacement.

Configuration, hosted deployment, Registry publication/installation and the
one real read remain separate approval gates. Current identity cannot establish
what happened during an older setup attempt; it never authorizes a retry.
See docs/provider-identity-diagnostic.md for metadata acquisition without token
decoding, including refusal when a normal metadata source is unavailable.

## Local verification

`npm run verify:full` passed: 203 unit tests, 31 hosted-runtime tests and
20 compiled Registry tests. `npm run plugin:bundle` prepares the 0.2.6 artifact.
All provider fixtures are synthetic; no live endpoint was invoked.
