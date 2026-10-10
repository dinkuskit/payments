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

## Earlier seeded local proof (superseded for Registry identity)

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

## Accepted native finding and actual installer repair

Native review on `4b30263ff14b6df2f0e8c1a1f5c18f0a5627db6a` found native-slug
callback/proof constants inconsistent with the derived Registry identity.
Accepted as required_fix. Earlier slug-seeded proof did not qualify Registry
installation identity. Consumer and manifest now share a single identity;
regression tests and Access documentation bind the exact installed routes.

Paired website source: `6c38e938fe535ebe3ffa719edd2e7bf766be3171`.
Actual upstream `handleRegistryInstall` ran with `installRegistryAuthoritativeFixture`
synthetic records and official packaged bytes served on localhost using the
upstream development allowance. Checksum, archive, identity, record schema,
declared-access and public-route consent gates remained active. No live PDS
acquisition or provenance attestation is claimed (provenance absent-optional).
Persisted source=registry, publisher `did:plc:ekk4pjmkh3k3ql2kfoex3qt4`, slug
`dinkus-payments`, installed ID `r_3brsc2on3bu673rn`.

Browser signup/sign-in and explicit Payments consent returned to the hashed
callback. The website fetched the actual hashed proof route; one token exchange
and real status HTTP200 succeeded. Consumed proof404; encrypted session observed
without reading its value; initiating admin200/status checked, other admin200
without session authority, subscriber403 and anonymous401. Three JWKS calls,
two status200 calls including role verification, zero provider calls. UI remains
Not ready to sell, no processor connected and Commerce TEST order unconfirmed.

| Repair artifact | SHA256 |
| --- | --- |
| Official explicit-test tarball | 7851000b747cc4ace2c9c13dc98696eb26b8a655e29e49a91029a66009ee2774 |
| Explicit-test backend | a39ae08ccfeeec33ccdd2a4ef05fc9f5e7df7b4a680c9d1fa45e5d1a37fe608a |
| Installed identity JSON | f403560cddff267460db4ad00a45bf4f3cdd626b51c267910b3ddfb4755015b1 |
| Checked-status screenshot | 66c0815c7626b792411f7e4565389db46dbc9273297cfe5cde35078b8dd1366d |

Evidence is retained in local run `payments-registry-install-proof-20261010`:
installed-state.json, real-integration.json, registry-record-proof.json,
candidate-bundle and screenshots. Test bundle differences are explicit loopback
factory configuration and reserved status-host permission. Production defaults
remain unconfigured. Fresh exact-candidate external reviews are required.

Repair clean-snapshot full verification passed: 137 Node tests, 16 runtime tests,
three built-plugin tests, typechecks, repository audit, manifest validation,
Worker dry-run and plugin build. Production runtime contains no test host/ports.

## Overview documentation follow-up

Native review on `f9a0afead9f8eb10bbdb8c79680317ee3865bceb` accepted the
installed-route repair and behavior proof, then raised a late P3 for stale
README, documentation index and Registry-status overview wording. Accepted as
required_fix and corrected: the overview now describes Connect, account calls,
public proof, encrypted sessions, unconfigured production status and actual
local installer proof separately from the older seeded harness. Sixteen focused
route/status tests passed and the requested stale-phrase scan found no matches.
No runtime source, manifest or dependency changed; prior runtime proof remains
applicable. Exact-head CI and reviews are refreshed for this documentation fix.

Website PR22 merged as `f5dfac6dcdd313ca1bfd07a7c2e3200bf1892a99`; its tree
`fe15f93973d8c2d9aba91940a4e7051faf1e2453` equals reviewed head
`777844c7cd8e004f5166b88e7bb72c1435cf84b6`. Only ledger and proof files differ
from the paired-test website revision. The website dependency is satisfied.
