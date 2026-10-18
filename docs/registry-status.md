# Registry setup and proof

The local `dinkus-payments` candidate presents an authenticated **Payment setup**
page with **Connect payments** and **Place a test order** steps. Connect starts
shared-store v2 account consent. The website reads the short-lived public
store-proof route, returns to the installed Registry callback, and the initiating
admin can exchange the approved grant and check Payments status. PKCE and the
short-lived ES256 session are stored using EmDash's encrypted secret setting.

The installed identity is `r_3brsc2on3bu673rn`. Its exact callback and public
proof paths are documented in [route authentication](route-auth.md). All other
Registry admin access remains authenticated and permission-gated. Network
requests use the canonical account API and the production status endpoint
`https://payments.dinkuskit.com/v1/status`; local proof can inject a local
endpoint. The plugin declares network access to exactly `dinkuskit.com` (consent
and signing keys) and `payments.dinkuskit.com` (status); EmDash refuses any host
not listed exactly. **Place a test order** completes once the provider confirmed
a paid TEST checkout and Commerce saved its order, as described in
[test order check](test-order-check.md). Selling still needs a verified live
connection, so the overall state never reads **Ready to sell** in TEST mode; see
[setup status wording](#setup-status-wording). Explicit sign-in replaces expired
consent; there is no silent refresh or provider selection from the browser.

The official plugin runtime verifies Block Kit and admin role boundaries. An
additional real local `handleRegistryInstall` run validated the official
artifact checksum, archive, identity, declared access and public-route consent,
persisted the publisher/slug/derived ID, and completed website consent, the
hashed callback, token exchange and status HTTP200 through the installed plugin.
This uses the upstream synthetic authoritative-record helper and localhost
artifact allowance; it does not prove live signed PDS acquisition, publication,
production Access configuration or provider traffic. See the
[shared-store consumer proof](../.grilltrack/proof/payments-shared-store-consumer-032.md).

## Reusable seeded post-install proof harness

The repository includes a disposable local harness for repeating the built
artifact proof without putting generated output in this repository:

```bash
# Use the Node version in .nvmrc. Run these commands from this checkout.
npm ci --ignore-scripts
npm run proof:registry-status -- prepare /tmp/payments-registry-status-NEW --port 4387
cd /tmp/payments-registry-status-NEW/host
npm start
```

Keep that host running in a foreground terminal. In a second terminal:

```bash
# From this checkout, using the same Node version:
npm run proof:registry-status -- verify /tmp/payments-registry-status-NEW
```

`prepare` requires an absolute, new, externally located run directory and
generates the host, official plugin tarball, extracted backend, and proof files
there. It rejects repository paths, existing directories, unsafe directory
names, and ports outside 1024–65535. `verify` seeds local D1/R2 state with the
actual packaged backend, reloads it through the EmDash sandbox runtime, compares
stored bytes to the tarball/backend SHA-256, and checks admin `200`, subscriber
`403`, and anonymous `401` using an in-memory cookie jar. It never prints or
persists session cookies. Stop the foreground host with Ctrl-C; the harness
does not kill unrelated processes or clean shared caches.

Browser recipe: open `http://127.0.0.1:4387/fixture-role?role=admin`,
then `http://127.0.0.1:4387/_emdash/admin/plugins/dinkus-payments/status`, and capture
desktop at 1440×1000 CSS pixels and mobile at 480×844 CSS pixels. The page
must show the two setup steps, unavailable connection explanation, unconfirmed
Commerce TEST order, overall not-ready state, and a Connect control. This slug-seeded harness does not qualify the account
consent flow, whose registered callback uses the derived installed ID. Repeat
with `fixture-role?role=subscriber` for the permission error. `anonymous` is covered by the
HTTP verifier and should redirect through the normal login boundary. The
fixture only permits the fixed roles on loopback and is not a deployable
production authentication adapter.

This is seeded post-install Registry state for `0.2.8` release preparation: it
writes the normal `registry/dinkus-payments/0.2.8/` artifacts and an active
`source=registry` row, then loads them through the normal local runtime. It is
not installer proof. In particular, it does not provide authoritative
publisher/release records, consent receipts, Registry publication, deployment,
account connection, or provider traffic (actual Registry publication and live
deployment have not occurred and remain separate human approval gates).

EmDash 1.2.0's normal authoritative reader uses HTTPS-only SSRF-safe fetch;
loopback/private PDS addresses are rejected. Registry client's direct PDS
reader also rejects HTTP endpoints before fetching records. EmDash's exported
`installRegistryAuthoritativeFixture` replaces that reader with supplied
records, so it does not prove signed CAR acquisition. The artifact downloader's
development allowance for localhost does not relax the PDS reader. The actual local installer proof described above uses that upstream fixture
while retaining artifact verification and consent gates. Live signed PDS
acquisition remains a separate qualification. This seeded harness changes
neither the verifier nor the install-consent path.

## Local verification

Run `bin/verify-payments full` for Node tests, hosted workerd tests, both
TypeScript targets, the repository audit, hosted Worker dry-run, official
plugin validation/build, and plugin runtime tests. `prepare` additionally
runs the official bundle command. The harness needs no credentials or live
providers.

The committed source tests prove the authenticated private status contract
and official runtime host behavior. The reusable harness records fresh artifact
hashes in each explicitly supplied external run directory; no generated proof
packet is committed here. This seeded harness alone proves neither Registry
publication nor actual installer verification; the separately recorded actual
installer run covers the local installation path with the limits described
above.

Hosted Worker and plugin typechecks are separate because importing EmDash's
browser declarations into the Worker compilation introduces incompatible
ambient Web Crypto types. The unchanged baseline passes using the same added
dependencies; both target checks pass with the separation.

## Processor setup (0.2.2 preparation)

After DinkusKit authorization, an unconnected Stripe account has a separate
**Set up or resume Stripe** action. This sends a bodyless authenticated request
to the same configured Payments origin at `/v1/connect`. It obtains a fresh
Stripe-hosted setup link without storing the link in plugin settings or KV.
**Check connection** rereads verified Payments status after the merchant returns.
The grant and the return from Stripe do not prove processor readiness. TEST
verification continues to mean TEST only. Expired authorization requires an
explicit DinkusKit reconnect; no credentials are entered in this screen.

This release is prepared locally, not published or deployed by this change.
Synthetic compiled-runtime proof is in `proof/registry-onboarding/PROOF.md`.

## Account-creation diagnostics (0.2.2 preparation)

For a processor connection still connecting or requiring recovery, the Registry
reads `/v1/connect/diagnostics` separately from `/v1/status`. This authenticated,
merchant/site-owned GET only reads local state. It returns no account or binding
identifiers and never calls Stripe. Old hosts returning 404 leave the normal
status visible, with failure detail explicitly unavailable.

An explicit account-create failure records only a closed category, an optional
allowlisted HTTP status and a timestamp. Raw errors and provider material are
never retained. Historical swallowed errors remain unobserved. Successful
account-ID persistence clears the unresolved diagnostic. No diagnostic read or
page load retries account creation, changes the binding, or extends the existing
23-hour safety window. The existing connect and status response shapes remain
compatible with Registry 0.2.1.

## Registry status-check failures (0.2.3 preparation)

Registry 0.2.3 reports a completed status-read failure as **Payments setup check
failed**, with a fixed support code identifying the observed stage: reading the
connection or saved authorization, verifying authorization, fetching or decoding
status, or rechecking the connection after diagnostics. Only the stage and an
HTTP status when available are exposed. Error messages, response bodies, stored
values, tokens and account identifiers are never included in these codes.

A failed check does not imply a missing grant or trigger processor setup. It
offers an explicit Check connection action and does not display earlier readiness
as current. Check and Continue reuse an already completed status result instead
of issuing a second status sequence. Optional unavailable diagnostics still leave
a successfully verified status intact. These changes identify a failing stage;
they do not establish the cause of a particular historical failure or change the
sandbox resource limit.

## Authorization request boundary (0.2.4 preparation)

After a new grant is verified and saved, Continue now confirms **Your DinkusKit
authorization was saved** and offers **Check connection**. It does not read
processor status in that same request or imply a processor account is ready.
The explicit check (or a later page load) reads the stored authorization and
verifies it before fetching status. Already completed grants still use one
status sequence per Check/Continue action.

The new-grant path uses nine bridge calls. Combining it with status made the
first saved-session read call eleven, exceeding the installed sandbox runner's
configured ten-subrequest limit under per-call enforcement. A limit-enforced
compiled test reproduces that failure stage and verifies the split succeeds;
local Worker Loader does not enforce the configured limit, so this is not by
itself proof of the historical production exception. No resource limit or
encryption, signature, binding, or race guard is changed.

## Setup status request budget (0.2.5 preparation)

The setup action verifies the stored session once, then reuses that verified
authority for the same invocation's status read. Its control-state rechecks
before and after the setup request, after optional diagnostics, and before
returning a verified onboarding link remain in place. The longest supported
setup path now uses ten bridge calls, including best-effort diagnostics.

If a failure occurs after the setup POST was initiated, the screen says setup
was requested and its result is unconfirmed. It does not claim that no setup
was attempted, show an unverified link, or automatically retry the request.
The merchant should check connection status before deciding whether to resume.
A missing link alone does not prove no account was created.

## Optional TEST platform identity (0.2.6 preparation)

A separate manual action can check the deployed Stripe platform identity.
It is restricted by existing authorization, stored ownership and a disabled-by-default
deployment operator allowlist. Regular status/setup actions do not trigger it.
The response contains a normalized match result and historical failure facts;
it contains no platform account ID or credential. See
[the diagnostic contract](provider-identity-diagnostic.md).

## Setup status wording

The page's own DinkusKit sign-in only reads status for this page. Checkout never
uses it: Commerce trades its own store key. So the page separates three cases.

| What the page knows | Banner | Connect payments | Place a test order |
| --- | --- | --- | --- |
| Payments verified a Stripe TEST connection | **Connected: Stripe test mode** (no alert) | Connected: Stripe test mode. Test card payments work; real payments need a live Stripe connection. | As in [test order check](test-order-check.md) |
| This page's sign-in expired, belongs to another admin or store, or Payments refused it | **Payment status not checked** (no alert) | Not checked. Select **Sign in again**; checkout doesn't use this sign-in. | Not checked |
| Anything else, including nothing connected | **Not ready to sell** (alert) | Unchanged | Unchanged |

**Sign in again** runs the same Connect flow with the same site binding. It
never offers **Set up or resume Stripe**, which still appears only after a
successful status read without verified Stripe evidence. Nothing here changes
what a connection is or how it is verified (037).

## Setup page after DinkusKit's Approve (0.2.9 preparation)

DinkusKit's Approve sends the owner back to the status page, so a page load with
a pending sign-in now polls the token endpoint (when DinkusKit's poll interval
has passed) instead of waiting for Continue. Continue pressed inside that
interval waits it out, up to 10 seconds, then polls; a poll DinkusKit has not
approved yet says so plainly.

A new grant now reads status in the same request with the token it just
verified: one extra status fetch, no second JWKS fetch and no diagnostics, so
the new-grant path is exactly ten bridge calls. Check connection adds
diagnostics when the status is connecting or recovery required.

Each Check connection or page-load status read stores that status (one KV write,
no token) for the admin who read it. When the page's own 5-minute sign-in has
lapsed for that same admin and store, the page shows that status with
"Last checked <time>" and Sign in again. Another admin still sees
"Payment status not checked".

When `POST /v1/connect` refuses with `merchant_country_required` or
`payments_service_unconfigured`, both of which create nothing, the page names
that reason. Any other refusal still reads as unconfirmed, and no other
response text reaches the page.
