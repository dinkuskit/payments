# Payments route authentication

## Registry plugin: no public bypasses

EmDash 1.2 supports `public: boolean` plus `permission`; it has no `admin`
classification field. Every Payments plugin route must explicitly declare
`public`. Private routes also declare a permission. The only current route is:

| Method | Installed Registry path | Access | EmDash authorization |
| --- | --- | --- | --- |
| POST | `/_emdash/api/plugins/r_3brsc2on3bu673rn/admin` | Keep protected | `public: false`, `plugins:manage` |

`src/registry/manifest.ts` exports `registryRouteManifest`, derived from the
same route object as `src/plugin.ts`. Its `publicRoutes` is **`[]`**. There is
no Registry webhook or shopper endpoint today. Never add a plugin-wide or
`/_emdash/api/plugins/*` bypass. When checkout is off, keep all `/_emdash*`
behind Access. Enabling checkout does not make this admin route public.

The publisher DID in `emdash-plugin.jsonc` and slug `dinkus-payments` derive the
opaque Registry installation ID above. EmDash's `makeRegistryPluginId` uses
`r_` plus the first 16 lowercase base32 characters of SHA-256 over
`publisherDid + "\n" + slug`. The test uses the pinned framework implementation
and checks the package metadata. A changed publisher or slug requires a fresh
manifest and installed-state check. The ID identifies a package; it does not
prove that the package is installed on a site.

A native or seeded installation can use `dinkus-payments`, whose admin path is
`/_emdash/api/plugins/dinkus-payments/admin`. The existing status harness seeds
that identity; it does not prove the hashed Registry installation identity or
installation flow. Read the actual installed `plugin_states.plugin_id` and its
publisher/slug provenance before applying a site's route configuration.

EmDash's production dispatcher checks user permission, admin token scope and
session CSRF before invoking private handlers, independently of Access.
The production public-only dispatcher refuses private routes. The regression
suite rejects absent declarations and bare handlers, checks the actual built
route metadata, and exercises anonymous and insufficient-role denials.

## Hosted service: separate origin and authentication

These are hosted Worker routes, **not** `/_emdash/api/plugins/...` routes.
`src/hosted/manifest.ts` drives dispatch methods and JWT scopes. Browser input
cannot choose a provider or supply an authoritative quote; only the scoped
Commerce service is admitted to checkout operations.

| Method | Hosted path | Authentication |
| --- | --- | --- |
| POST | `/v1/connect` | `payments:admin` JWT |
| GET | `/v1/status` | `payments:admin` JWT |
| GET | `/v1/checkout-binding` | `payments:checkout` JWT |
| GET | `/v1/existing-binding` | `payments:checkout` JWT |
| POST | `/v1/checkout/session` | `payments:checkout` JWT |
| POST | `/v1/checkout/lookup` | `payments:checkout` JWT |
| GET | `/v1/checkout/wakes` | `payments:checkout` JWT |
| POST | `/v1/checkout/wakes/ack` | `payments:checkout` JWT |
| POST | `/v1/webhooks/stripe` | Stripe raw-byte signature |
| POST | `/v1/webhooks/authorize-net/{siteId}` | Authorize.net raw-byte HMAC-SHA512 |

The last two routes are public ingress with provider authentication, not
anonymous trust. `hostedPublicRouteManifest(siteId)` emits the two concrete
paths for the server-owned site ID, with method and signature requirement.
The `{siteId}` row above is explanatory: never copy a placeholder or wildcard
into Access. The helper accepts an unambiguous ASCII alphanumeric/underscore/
hyphen site segment; other identifiers require explicit path qualification.
Apply any approved hosted-origin rule separately from a store's Registry
bypass list. This change configures neither origin nor Access.

Webhooks validate original bytes and signed identity before durable effects.
A verified notification only queues reconciliation (Authorize.net can also
record the transaction reference). It never establishes paid state. Payments'
authoritative provider lookup returns normalized outcomes; Commerce owns the
reconciliation decision, attempts, orders and receipts. Stripe requires Session
and PaymentIntent evidence; Authorize.net uses `getTransactionDetails` and
checks store/attempt identity and amounts. Provider selection stays server-owned
with no cross-provider fallback.

## Next installation qualification

The seeded post-install harness proves bundle loading and private status
behavior, not signed Registry release acquisition or install consent. The
smallest next slice is a genuine installation of this status-only artifact:
verify approved signed publisher/release records, consent, installed hashed
identity, artifact hash and private-route denials. It needs a reachable signed
test release or an upstream verifier-preserving fixture; do not bypass the
HTTPS/SSRF reader or consent controls to simulate success.

A sandbox purchase then needs shared account issuance/refresh and a verified
store/provider binding, a functioning Registry-to-hosted-service bridge,
Commerce checkout/wake/reconciliation integration, and an explicitly selected
and authorized test provider. Those are absent from the current status-only
Registry bundle. Provider choice and sandbox traffic authorization remain
pending; this PR makes no installation or purchase claim.
