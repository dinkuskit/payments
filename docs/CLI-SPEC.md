# `dinkus-payments` CLI Specification

Status: Draft, not locked. Needs a GrillTrack decision before it is treated as a contract.

An unpublished scaffold executable implements this draft against the hosted
Payments API; see [Implementation status](#implementation-status). The shape
follows the locked DinkusKit Inventory CLI specification (global flags, JSON
envelope, plain records, exit codes, configuration precedence, and credential
handling). Where this CLI differs, the difference and its reason are stated in
[Differences from the Inventory CLI](#differences-from-the-inventory-cli).
Examples are contract transcripts with fictional IDs, not runtime proof.

## Name and purpose

Executable: `dinkus-payments`

Package: `@dinkuskit/payments` (private, unpublished)

One-liner: inspect one site's Payments connection and checkout state, and start
or resume provider onboarding, through the same authenticated API that the
registry plugin and Commerce use.

`dinkus-payments` is a client, not a second payments engine. It holds no
provider credentials, never talks to a payment provider directly, never selects
a provider, and never decides whether a payment succeeded. Every answer comes
from the hosted Payments service.

## Implementation shape

```text
bin/dinkus-payments.mjs          executable entrypoint
src/cli/kernel.mjs               shared DinkusKit CLI kernel (kept byte-identical across repositories)
src/cli/spec.mjs                 command tree, flags, help text, examples
src/cli/commands.mjs             command behavior and formatting
src/client/payments-client.mjs   authenticated HTTP client and response-shape checks
tests/cli/                       node:test tests, run by npm test
```

Plain ESM JavaScript with zero runtime dependencies, parsed with strict
`node:util.parseArgs`, so it runs from a checkout without a build step. The
package manifest maps `"bin": { "dinkus-payments": "./bin/dinkus-payments.mjs" }`.
The manifest's `files` list is pinned to `dist` by the repository audit, so a
packed artifact would not contain the CLI yet; publishing is out of scope and
needs human approval (see [Open questions](#open-questions)).

## Usage

```text
dinkus-payments [global flags] <command> [arguments]
dinkus-payments [global flags] <noun> <verb> [arguments]
```

`-h` and `--help` show help for the deepest named command and ignore every
other argument; `dinkus-payments help <command>` does the same. `--version`
prints only the installed version to stdout. Both exit `0` and send nothing.

## Command tree

```text
dinkus-payments status
dinkus-payments connect (--dry-run | [--no-input] --confirm <site-id>)

dinkus-payments binding show <binding-ref>

dinkus-payments checkout lookup --request <file|->

dinkus-payments wakes list <binding-ref> [--limit <1-100>]
```

| Command | Service call | Token scope | Kind |
| --- | --- | --- | --- |
| `status` | `GET /v1/status` | `payments:admin` | read |
| `connect --dry-run` | `GET /v1/status` | `payments:admin` | read (preview) |
| `connect` | `POST /v1/connect`, no body or query | `payments:admin` | mutation |
| `binding show` | `GET /v1/existing-binding?bindingRef=...` | `payments:checkout` | read |
| `checkout lookup` | `POST /v1/checkout/lookup` | `payments:checkout` | read-only lookup |
| `wakes list` | `GET /v1/checkout/wakes?bindingRef=...[&limit=...]` | `payments:checkout` | read |

The service authenticates every call; possessing the executable grants nothing.

### Read commands

- `status` reports the site's connection `state`, `mode`, and `bindingRef`
  (absent while disconnected), the client version, and a `nextAction` the CLI
  derives from the state. The service checks the provider live; the CLI never
  caches or infers readiness.
- `binding show <binding-ref>` reads the stored recipient for existing
  attempts: `bindingRef`, `providerId`, `stripeAccountId`, `mode`. It answers
  even when new checkout is not ready, because reconciliation must keep the
  original recipient. Readiness for new checkout is `status`.
- `checkout lookup --request <file|->` asks Payments for the normalized outcome
  of one Commerce `PaymentRequest`: `unknown`, `open`, `paid`,
  `expired-unpaid`, or `not-created`. Lookup never creates a checkout session.
  The request is read from a file or from stdin (`-`), checked locally to be a
  JSON object with string `attemptId` and `bindingRef` (1-200 characters) and
  at most 1 MiB, then sent byte-for-byte. Payments validates everything else.
- `wakes list <binding-ref>` lists unacknowledged payment wakes
  (`eventId`, `attemptId`, `bindingRef`, `deliveryGeneration`, `wokeAt` in
  epoch milliseconds), oldest first. Listing does not consume or acknowledge
  anything. `--limit` is a whole number from `1` to `100`; when omitted the
  service default (`25`) applies.

### Mutation command: `connect`

`connect` starts provider onboarding for the site or resumes it. On first use
the service persists a new binding for the authenticated owner and starts
provider account creation; later calls resume the same binding and return a
fresh one-use onboarding link while setup is unfinished. It never creates a
second binding, never switches owner, account, or mode, and accepts no caller
input.

The flow mirrors the Inventory preview/confirmation pattern, with the site id
as the confirmation value because the service has no preview endpoint:

1. `connect --dry-run` reads `GET /v1/status` and reports the current state,
   an `effect` code, a one-line summary, and `confirmation.value` (the site
   id). Nothing is sent.
2. A real run either asks the operator on a terminal to type the site id after
   showing the same preview on stderr, or takes `--confirm <site-id>`.
3. With `--no-input`, a real run requires `--confirm`. A missing or different
   value exits `4` before any request.
4. `--dry-run` and `--confirm` cannot be combined (exit `2`).

| Current state | `effect` | What connect would do |
| --- | --- | --- |
| `disconnected` | `create_binding` | Create the binding, start account creation, return an onboarding link |
| `connecting` | `retry_account_creation` | Retry creation under the same binding and idempotency identity |
| `setup_required`, `action_required` | `issue_onboarding_link` | Return a fresh one-use onboarding link |
| `ready` | `no_change` | Re-verify and return `ready` without a link |
| `checking` | `recheck_provider` | Re-check the provider; a link only if setup is still needed |
| `recovery_required` | `no_change_recovery_required` | Nothing; the 23-hour creation retry window has passed and a human must recover the binding |

The CLI sets the shared lifecycle flag around the `POST`, so Ctrl-C before the
send exits `4` with nothing sent, and Ctrl-C after it reports an unknown
outcome and exits `3`. After the send:

- a terminal answer is `outcome: "committed"` with a `receipt`;
- no answer, a timeout, or a `5xx` is `outcome: "unknown"` (exit `3`);
- an answer outside the contract, including an onboarding link that is not
  `https` or carries credentials, is `outcome: "unknown"` (exit `5`) and the
  link is not printed;
- `400`, `401`, and `403` mean the service refused it; nothing changed.

Unlike Inventory, there is no command ID or local pending store: `connect` is
idempotent per site, so the recovery for an unknown outcome is to run `status`
and, if needed, `connect` again.

The onboarding link is a short-lived, single-use, sensitive link. The CLI
prints it once to stdout and a reminder to stderr to open it only as the
merchant for that site. It is never written to a file or config.

## Global flags

| Flag | Contract |
| --- | --- |
| `-h`, `--help` | Show context-appropriate help; ignore other arguments. |
| `--version` | Print only the installed version. |
| `--endpoint <url>` | Payments service base URL. `https` only (`http` for `localhost`, `127.0.0.1`, `[::1]`). No credentials, query, or fragment. No built-in default. |
| `--site <id>` | Site id sent as `x-dinkus-site`. Required for every service call; 1-200 printable characters without spaces. The service rejects a site that differs from the token's signed site claim. |
| `--profile <name>` | Select a non-secret profile from config files. |
| `--json` | Emit exactly one JSON document to stdout. Mutually exclusive with `--plain`. |
| `--plain` | Emit stable tab-separated `key=value` records. Mutually exclusive with `--json`. |
| `--no-input` | Never prompt. Missing input or confirmation fails closed. |
| `--no-color` | Disable color (the CLI currently prints none). `NO_COLOR` and `TERM=dumb` do the same. |
| `--timeout <duration>` | Network timeout such as `1500ms`, `15s`, `1m` (default `15s`, maximum `10m`). For `connect`, a timeout is an unknown outcome, never an assumed failure. |

## Command flags

| Command | Flag | Contract |
| --- | --- | --- |
| `connect` | `--dry-run` | Read status, print the preview and confirmation value, send nothing. |
| `connect` | `--confirm <site-id>` | Send only if the value equals the resolved site id. |
| `checkout lookup` | `--request <file\|->` | Required. PaymentRequest JSON file (relative to the working directory) or `-` for stdin. With `--no-input`, `-` requires piped stdin. |
| `wakes list` | `--limit <1-100>` | Most wakes to return. Leading zeros and fractions are rejected. |

There is no `--token` flag and no generic `--force`.

## Output contract

Default output is concise human text on stdout. Prompts, previews shown before
a prompt, reminders, and diagnostics go to stderr. A `rejected` result prints
`rejected: <code> (<message>)` to stdout like any other result; other errors
print only `dinkus-payments: <message>` to stderr. Piped stdin never causes a
prompt. Human output and stderr show control characters from the service,
other than newline and tab, as `\uXXXX` escapes so service text cannot drive
the terminal.

`--json` emits one versioned document and nothing else on stdout:

```json
{
  "schema": "dinkuskit.payments.cli/v1",
  "command": "status",
  "outcome": "ok",
  "context": { "siteId": "site_demo" },
  "data": {
    "clientVersion": "0.0.0",
    "connection": { "state": "ready", "mode": "test", "bindingRef": "stripe_binding_demo" },
    "nextAction": "none"
  }
}
```

The envelope always contains `schema`, `command` (dot-joined path, such as
`binding.show`), `outcome`, and `context`. `context.siteId` is always present
once resolved; `binding show` and `wakes list` add `bindingRef`, and
`checkout lookup` adds `bindingRef` and `attemptId` from the request.

| `outcome` | When | Body |
| --- | --- | --- |
| `ok` | Successful read | `data` |
| `preview` | `connect --dry-run` | `data: { connection, effect, summary }`, `confirmation: { value }` |
| `committed` | `connect` answered | `receipt: { connection, onboarding?: { url, expiresAt }, nextAction }` |
| `unknown` | `connect` sent but unanswered or unreadable | `unknown: { reason, next }` |
| `rejected` | A `409` business answer | `rejection: { code, message }` |
| `error` | Any other failure | `error: { code, message }` |

`warnings` (an array of `{ code, message }`) may accompany any outcome, for
example `unrecognized_state` when the service reports a state this client does
not know. `nextAction` is one of `none`, `connect`, `open_onboarding_link`,
`retry_status`, `escalate`, or `unknown`. Field values from the service are
passed through unchanged: `expiresAt` and `wokeAt` are epoch milliseconds, and
checkout session `createdAt`/`expiresAt` are epoch seconds.

`--plain` writes one record per line; each starts with `schema`, `command`,
and `outcome`, then the command's fields in this order. Tabs, newlines,
carriage returns, and backslashes in values are escaped as `\t`, `\n`, `\r`,
and `\\`. Missing values are empty.

| Command | Plain fields after the head |
| --- | --- |
| `status` | `clientVersion state mode bindingRef nextAction` |
| `connect --dry-run` | `state mode bindingRef effect confirmation` |
| `connect` | `state mode bindingRef url expiresAt nextAction` |
| `binding show` | `bindingRef providerId stripeAccountId mode` |
| `checkout lookup` | `attemptId paymentOutcome totalCurrency totalMinor sessionId redirectUrl createdAt expiresAt paymentId` |
| `wakes list` | one record per wake: `eventId attemptId bindingRef deliveryGeneration wokeAt`; no lines when empty |
| rejected or error | `code message` |

JSON and plain field names are compatibility surfaces once this draft is
locked. New optional fields may be added within v1; changing meaning or types
needs a new schema version. Human text is not a parsing interface.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Successful read, dry-run preview, or committed `connect`. |
| `1` | Business rejection (`409`), a `400` refusal from the service, or a route the service does not serve (`404`). Nothing changed. |
| `2` | Invalid usage, missing site or endpoint, invalid non-secret config, malformed `--request`, or invalid `--limit`. Nothing was sent. |
| `3` | Service, network, or timeout failure (`5xx`, unreachable), or an unknown `connect` outcome. |
| `4` | Missing or malformed `DINKUS_PAYMENTS_TOKEN`, `401`, `403`, a declined or missing confirmation, or Ctrl-C before a send. |
| `5` | The response broke the contract: non-JSON body, wrong shape, mismatched `bindingRef` or `attemptId`, a redirect, or `405`. |

HTTP mapping in detail:

| Service answer | Exit | `outcome` |
| --- | --- | --- |
| `2xx` within the contract | `0` | `ok` / `committed` |
| `2xx` outside the contract | `5` | `error` (`unknown` for `connect`) |
| `3xx` | `5` | `error`; the CLI never follows redirects with credentials |
| `400` with a JSON error code | `1` | `error` |
| `401` | `4` | `error`; the message names the scope and site to check |
| `403` | `4` | `error` |
| `404` with a JSON error code | `1` | `error`; check `--endpoint` and the service version |
| `405` | `5` | `error` |
| `409` with a JSON error code | `1` | `rejected` |
| any other `4xx` without a JSON error code | `5` | `error` |
| `5xx`, network failure, timeout | `3` | `error` (`unknown` for `connect`) |

## Configuration and authentication

Non-secret configuration precedence:

```text
flags > process environment > project config > user config
```

- Flags: `--endpoint`, `--site`, `--profile`.
- Environment: `DINKUS_PAYMENTS_ENDPOINT`, `DINKUS_PAYMENTS_SITE`,
  `DINKUS_PAYMENTS_PROFILE`. Empty values are ignored.
- Project config: `.dinkuskit/payments.json` in the working directory.
- User config: `$XDG_CONFIG_HOME/dinkuskit/payments/config.json` (or
  `~/.config/dinkuskit/payments/config.json`).
- There is no built-in endpoint or site.

A config file is a JSON object with optional `endpoint` and `site`, plus an
optional `profiles` map whose entries override them:

```json
{
  "endpoint": "https://payments.example.invalid",
  "profiles": { "demo": { "site": "site_demo" } }
}
```

Config files are rejected (exit `2`) if any key looks like a secret (`token`,
`secret`, `password`, `authorization`, `credential`, `api_key`, `cookie`). An
unknown `--profile` is a usage error.

The credential comes only from `DINKUS_PAYMENTS_TOKEN`, supplied by the
caller's secret manager or shell. There is no `--token` flag, no token in
config, and no token in the endpoint URL. A missing value exits `4` naming the
variable; a value containing spaces or line breaks also exits `4`. Neither the
token nor the `Authorization` header is ever printed. Every request sends
`Authorization: Bearer <token>` and `x-dinkus-site: <site>`, and redirects are
not followed.

The token is a signed DinkusKit account token for one site. `status` and
`connect` need the `payments:admin` scope; `binding show`, `checkout lookup`,
and `wakes list` need `payments:checkout`. The service, not the CLI, maps the
token to the merchant and site.

## Examples

Fictional endpoint and IDs throughout.

```sh
# 1. Check the connection state.
dinkus-payments --endpoint https://payments.example.invalid --site site_demo status

# 2. The same, for a script.
dinkus-payments --site site_demo status --json

# 3. Preview what connect would do. Nothing is sent.
dinkus-payments --site site_demo connect --dry-run

# 4. Connect interactively: shows the preview, then asks you to type site_demo.
dinkus-payments --site site_demo connect

# 5. Connect from automation after reviewing the dry run.
dinkus-payments --site site_demo connect --no-input --confirm site_demo --json

# 6. Show the stored recipient for an existing binding.
dinkus-payments --site site_demo binding show stripe_binding_demo

# 7. Look up an attempt's payment outcome from a file.
dinkus-payments --site site_demo checkout lookup --request payment-request.json

# 8. The same request piped through stdin.
cat payment-request.json | dinkus-payments --site site_demo checkout lookup --request - --json

# 9. List up to 10 unacknowledged wakes as plain records.
dinkus-payments --site site_demo wakes list stripe_binding_demo --limit 10 --plain

# 10. Use a profile from .dinkuskit/payments.json.
DINKUS_PAYMENTS_PROFILE=demo dinkus-payments status
```

Example 3 prints:

```text
dry run: nothing was sent.
site: site_demo
state: disconnected (test mode)
binding: none
connect would: create a new binding for this site, start provider account creation, and return a one-use onboarding link.
to connect: rerun without --dry-run and type the site id, or pass --no-input --confirm site_demo
```

Example 5 prints, when onboarding is unfinished:

```json
{
  "schema": "dinkuskit.payments.cli/v1",
  "command": "connect",
  "outcome": "committed",
  "context": { "siteId": "site_demo" },
  "receipt": {
    "connection": { "state": "setup_required", "mode": "test", "bindingRef": "stripe_binding_demo" },
    "onboarding": { "url": "https://connect.stripe.com/setup/s/example", "expiresAt": 1791500300000 },
    "nextAction": "open_onboarding_link"
  }
}
```

## Differences from the Inventory CLI

- **Confirmation value.** Payments has no preview endpoint, so the confirmation
  value is the site id instead of an opaque, expiring preview token. It proves
  which site the operator meant; the service still decides what happens.
- **No command IDs or pending store.** `connect` is idempotent per site, so an
  unknown outcome is resolved by `status` and, if needed, another `connect`.
  There is no `commands` noun.
- **Site from config is allowed for `connect`.** Inventory requires mutation
  context as flags. Here the typed or `--confirm` site id must equal the
  resolved site, which binds the mutation to an explicit site either way.
- **Context.** `context` holds `siteId` (plus `bindingRef` or `attemptId` where
  the command names them); there is no pool or location.
- **Status data.** `status` returns the service's connection object plus a
  derived `nextAction`.

## Non-goals

- **No wake acknowledgement.** `POST /v1/checkout/wakes/ack` is deliberately
  not exposed. Commerce acknowledges a wake only after its own authoritative
  reconciliation; an operator acknowledgement could hide a payment that still
  needs reconciling.
- **No checkout-session creation.** `POST /v1/checkout/session` is deliberately
  not exposed. Commerce owns attempts, amounts, and session creation through
  the payment port; the CLI only looks up existing outcomes.
- No readiness-gated `GET /v1/checkout-binding` command; `status` reports
  readiness and `binding show` reads the stored recipient.
- No provider selection, provider switching, owner transfer, account deletion,
  or binding recovery. `recovery_required` is escalated to a human.
- No live-mode activation; the service is test-mode only.
- No direct provider calls, provider secrets, or webhook handling.
- No refunds, captures, payouts, orders, receipts, carts, or prices.
- No caching of status, onboarding links, or payment outcomes.
- No package publication or deployment.

## Implementation status

| Command | State | Hosted API used |
| --- | --- | --- |
| `status` | Wired | `GET /v1/status` |
| `connect` | Wired | `GET /v1/status` (preview), `POST /v1/connect` |
| `binding show` | Wired | `GET /v1/existing-binding` |
| `checkout lookup` | Wired | `POST /v1/checkout/lookup` |
| `wakes list` | Wired | `GET /v1/checkout/wakes` |

No command is planned without an API; every command in the tree is wired.
Tests in `tests/cli/` use a fake transport plus a local `127.0.0.1` server for
the executable. They cover help and version at each depth, single-document
JSON, plain escaping, the stdout/stderr split, credential non-disclosure,
exit codes `0`-`5`, required site and endpoint, config precedence and secret
rejection, fail-closed `--no-input` and confirmation for `connect`, the
lifecycle flag around the send, unknown outcomes after a send, and piped
stdin. They do not prove a real identity issuer, deployed service, or provider.

End-of-input (Ctrl-D) at the interactive `connect` prompt is a refusal: nothing
is sent and the CLI exits `4`.

## Open questions

These need a GrillTrack decision before the draft is locked:

1. Whether the site id is an acceptable `connect` confirmation value, or the
   service should add a preview endpoint with an opaque confirmation.
2. Whether `nextAction` and the `effect` codes are part of the v1 contract.
3. Whether `binding show` should also expose the readiness-gated
   `GET /v1/checkout-binding`.
4. Packaging: the audited `files` list is `dist` only, so the CLI is not in a
   packed artifact. Shipping it needs an approved manifest change.
