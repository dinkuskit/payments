# Payments route authentication

## Registry plugin: one exact public proof route

EmDash 1.2 supports `public: boolean` plus `permission`; it has no `admin`
classification field. Every Payments plugin route must explicitly declare
`public`. Private routes also declare a permission. The current routes are:

| Method | Installed Registry path | Access | EmDash authorization |
| --- | --- | --- | --- |
| POST | `/_emdash/api/plugins/r_3brsc2on3bu673rn/admin` | Keep protected | `public: false`, `plugins:manage` |
| GET | `/_emdash/api/plugins/r_3brsc2on3bu673rn/store-proof` | Exact public exception for ownership proof | `public: true`, redacted short-lived receipt |

`src/registry/manifest.ts` exports `registryRouteManifest`, derived from the
same route object as `src/plugin.ts`. Its `publicRoutes` contains only
`/_emdash/api/plugins/r_3brsc2on3bu673rn/store-proof`. If an operator separately
authorizes Access configuration, only that exact GET route may bypass it for
website ownership verification. Keep the admin route and callback
`/_emdash/admin/plugins/r_3brsc2on3bu673rn/status` protected. Never add a
plugin-wide or `/_emdash/api/plugins/*` bypass. Checkout does not change this
boundary; there is no Registry shopper or webhook route in this slice.

The publisher DID in `emdash-plugin.jsonc` and slug `dinkus-payments` derive the
opaque Registry installation ID above. EmDash's `makeRegistryPluginId` uses
`r_` plus the first 16 lowercase base32 characters of SHA-256 over
`publisherDid + "\n" + slug`. The test uses the pinned framework implementation
and checks the package metadata. A changed publisher or slug requires a fresh
manifest and installed-state check. The ID identifies a package; it does not
prove that the package is installed on a site.

The shared-store Registry client uses that exact derived identity for its
callback and proof paths. Native-slug or slug-seeded installations do not
satisfy this client contract. The package publisher/slug identity is single-sourced
in `src/registry/identity.ts`, verified against pinned EmDash derivation and
package metadata. The website must register the same exact paths. Read the actual
`_plugin_state.plugin_id`, `registry_publisher_did` and `registry_slug` before
applying a site's route configuration.

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

## Installation qualification

The route repair was exercised through EmDash 1.2.0's actual Registry installer
with its upstream synthetic authoritative-record fixture. The installer checked
the official artifact checksum, archive, package identity, declared access and
public-route consent, then persisted the derived ID, publisher DID and slug.
The real local website consent returned to the hashed callback and fetched the
hashed public proof route; the installed plugin exchanged the token and checked
Payments status. See the shared-store consumer proof for hashes and limits.

This is local installer and consumer proof, not live signed PDS publication or
production DNS/Access qualification. The older seeded harness covers only
post-install sandbox behavior. A sandbox purchase still needs a verified
store/provider binding, Commerce checkout/wake/reconciliation integration and
an explicitly authorized test provider. Processor setup, Commerce integration
and live service configuration remain outside this consent/status consumer.
