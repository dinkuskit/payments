# One payment setup screen

Approved 2026-10-09. Decision: `payments-one-screen-setup-029`.
This additive decision depends on `payments-store-test-readiness-028`; it
preserves that agreement and its history. The feature is not implemented.

## Accepted merchant flow

One setup screen presents these steps:

1. **Connect payments.** Automatically check the selected provider's actual,
   supported connection and live-readiness signals.
2. **Place a test order.** Commerce confirms that a provider-confirmed TEST
   payment produced exactly one paid TEST order visibly present in its admin.
3. **Ready to sell.** Show this only when both checks pass.

These checks establish different facts. A successful TEST order does not verify
live connection readiness. A connected provider does not prove the Commerce
TEST purchase succeeded. Unsupported or unknown provider capabilities remain
incomplete; do not invent Stripe-like Authorize.net readiness signals.

Merchants do not perform a technical account-mapping task. Do not build an
elaborate sandbox-to-live account-equivalence or certification mechanism.

## Preserved requirements and ownership

The [store TEST readiness agreement](store-test-readiness.md) remains in force:
one Registry Payments plugin, both providers qualified before launch, Stripe
first and Authorize.net next, one server-selected provider per store, no
fallback, and a mandatory per-store TEST purchase. TEST orders persist in the
normal order list clearly marked TEST; no filter is required. They must not
trigger real fulfillment or shipping. Inventory verification is not a gate.

Provider, receiving-account and critical checkout/webhook binding changes
invalidate readiness and require retesting. Normal catalog, product and price
edits do not. Payments owns provider verification and configuration; Commerce
owns paid orders, admin visibility and checkout gating. This decision does not
transfer authority between them.

## Research and limits

Official documentation checked 2026-10-09. These are product documentation
surfaces, not a newly pinned runtime API contract. Provider-specific API version
and capability verification remain implementation prerequisites.

| Platform or provider | Evidence | Implication and limit |
| --- | --- | --- |
| Shopify | [Test orders](https://help.shopify.com/en/manual/checkout-settings/test-orders) supports simulated/test-mode orders. | Testing is an ordinary merchant setup action; this does not establish a universal mandatory launch gate. |
| WooCommerce Stripe extension | [Settings guide](https://woocommerce.com/document/stripe/setup-and-configuration/settings-guide/) shows account/webhook states separately for live and test connections. | Adopt understandable connection status; test connection success does not establish live connection success. |
| BigCommerce | [Payments connection documentation](https://support.bigcommerce.com/s/article/Connecting-with-BigCommerce-Payments?language=en_US) could not be fully retrieved (help-center loading/CSS error). | Coverage gap; make no mandatory-gate or readiness-parity claim from this source. |
| Authorize.net | [Testing guide](https://developer.authorize.net/hello_world/testing_guide.html) describes separate sandbox and production environments and credentials. | Do not infer a sandbox-to-live account-equivalence API or live readiness from a sandbox payment. |
| Stripe | [Accounts API](https://docs.stripe.com/api/accounts) exposes account information used for provider-specific connection assessment. | Verify the supported readiness fields and API version for the integration; this is not evidence of Authorize.net parity. |

**Adopt** automatic checks backed by supported provider signals. **Adapt** the
ordinary test-order workflow to the approved mandatory Commerce proof.
**Reject** elaborate sandbox/live certification and merchant account-mapping
work. **Defer** unsupported readiness parity until an actual provider API is
verified. These recommendations support the accepted flow; competitor behavior
does not replace the project's mandatory TEST requirement.

## Still design work

The exact readiness schema, authenticated protocol, critical-binding enumeration,
and ordinary TEST-to-live configuration revision semantics remain unresolved.
The transition must avoid an infinite retest loop; this document does not lock
a revision algorithm, account-equivalence rule, or exception to retesting.

Before implementation, verify Authorize.net's available connection signals,
resolve the bounded cross-repository contract with the Commerce owner, and
specify the ordinary mode transition. No Commerce changes, provider traffic,
credentials, deployment, live checkout enablement, or feature implementation
are authorized by this decision record. A later UI implementation needs visible
proof; this document is not a UI prototype or installed end-to-end proof.
