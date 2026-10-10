# Payments shared-store v2 consumer proof

Decision: `payments-shared-store-consumer-032`. Website contract reviewed at
`c0e871e3b2b63a511c78669cb78b29bd810c51f3`, merged with identical tree in website
PR21 (`f664a60b4fc4b8c35d7228dbb37c01c44292e768`).

## Implemented and verified

- Explicit Payments v2 Connect, same-origin public proof and owner-consent callback.
- PKCE verifier and five-minute ES256 token stored as an EmDash encrypted secret
  string. KV contains public metadata and a digest binding, never credentials.
- Canonical site/issuer/organization binding survives explicit reconnect. CAS
  revisions reject duplicate polls, stale asynchronous results and manual secret
  insertion. Only authorization_pending allows another exchange.
- Actual BlockKit actions and links; authenticated initiating administrator only.
- Server-owned status transport with X-Dinkus-Site and strict status decoder.
- Production default has no Payments endpoint. No provider setup or checkout
  request is made. Not ready to sell and unconfirmed Commerce TEST order remain.

## Deterministic verification

Clean source snapshot `npm run verify:full` passed: 136 Node tests, 16 Cloudflare
runtime tests, three built-plugin runtime tests, typechecks, repository path
contract, manifest validation, Worker dry-run and plugin build.
A subsequent real Worker run exposed unsupported redirect:error; requests now
use manual redirects and reject non-success responses. The ten focused consumer
regressions were rerun successfully after that correction. Final CI must cover
this exact candidate.

Ignored parent website build outputs trigger the repository's intentionally
value-blind path audit in the working checkout. Full verification used a clean
source snapshot containing only tracked and intended new public files; no audit
exclusion or cleanup was introduced.

## Real installed local proof

Official plugin bundle loaded through EmDash 1.2.0 Registry storage and its
Cloudflare Worker Loader sandbox. Website came from the immutable reviewed
source, built independently. A supported httpFetch test transport routes only
canonical account start/exchange/JWKS and a separately allowlisted reserved
Payments status host to real local handlers. It never returns canned receipts
or status. Synthetic merchant email sign-in and explicit Payments owner consent
were exercised in the browser. The website fetched the installed plugin's raw
proof, returned to the registered Payments callback, and the plugin exchanged
and verified the real ES256 token before receiving status HTTP200.

Observed: encrypted pending state and encrypted session; consumed proof HTTP404;
real status disconnected/test; zero processor calls. UI says no processor account
connected, processor setup unavailable, Not ready to sell, and Commerce TEST
order unconfirmed. Separate role probes: initiating admin200, other admin denied
session use, subscriber403, anonymous401.

Production default bundle was separately installed and verified; no test host
or test ports occur in that bundle and its endpoint remains unconfigured.

| Artifact | SHA256 |
| --- | --- |
| Default production backend | b19176f7704ac7a8e6d3e8654c23b4a2a537e52821f6edd72a28702c8fc4f145 |
| Explicit local-test backend | 8b398009f06d915371e4ba2b4860b75834798c07f0d020fa8e8e72c818e0f607 |
| Website contract | cb5dbc2729e9ac4f85058c7ae8a572ff8af0d1a643d84a7e1ab5d7ffe6c4eb6d |
| Website memory helper | 2cc2b4403f56e53be8d7a2311e05eebf634c77cb89ddfee8c496db80bb38d536 |
| Website memory fixture | 31476f3cbc617811f47b559d896730b37ce7012b4992356244286753b97b50cc |
| Independently built website entry | bdcae8c633c24891d098474e293b3ba51615166d71ec1929109ce45adaeb9011 |

Local evidence includes bundle separation JSON, real integration counters,
role-probe JSON, official package manifests, build/test logs and screenshots
of pending Connect, explicit consent, checked status and unconfigured default.
No token, verifier, cookie or encryption key is included in committed proof.

## Limits and review gate

Local seeded Registry installation is not public Registry distribution proof.
No production hostname, DNS/fetch qualification, live grant, processor call,
deployment or merge is authorized. The hosted Payments verifier has no online
revocation lookup: website revocation blocks new tokens, while existing signed
tokens expire within five minutes. Joint Inventory/Payments installed-consumer
proof remains separate. CI, comprehensive OpenClaw and native ClawSweeper must
qualify the immutable candidate before maintainer delivery.
