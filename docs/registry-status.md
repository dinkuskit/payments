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
endpoint. Processor setup and Commerce's paid TEST-order confirmation remain
unavailable, so the overall state remains **Not ready to sell**. Explicit reconnect replaces expired consent;
there is no silent refresh or provider selection from the browser.

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

This is seeded post-install Registry state: it writes the normal
`registry/dinkus-payments/0.0.0/` artifacts and an active `source=registry`
row, then loads them through the normal local runtime. It is not installer
proof. In particular, it does not provide authoritative publisher/release
records, consent receipts, Registry publication, deployment, account
connection, or provider traffic.

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

The committed source tests prove the private status contract and official
runtime host behavior. The reusable harness records fresh artifact hashes in
each explicitly supplied external run directory; no generated proof packet is
committed here. This seeded harness alone proves neither Registry publication nor actual
installer verification; the separately recorded actual installer run covers
the local installation path with the limits described above.

Hosted Worker and plugin typechecks are separate because importing EmDash's
browser declarations into the Worker compilation introduces incompatible
ambient Web Crypto types. The unchanged baseline passes using the same added
dependencies; both target checks pass with the separation.
