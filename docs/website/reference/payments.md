---
article: reference/payments
title: "Payments"
summary: "Understand the payment connection, test-order evidence, and Commerce handoff."
audience: "Store owners and developers"
product: "DinkusKit Payments"
version_scope: "Payments {{version}}"
---

## What Payments owns

Payments connects a store to its server-selected processor. It owns provider transport, verified webhooks, connection status, and normalized payment results. [Commerce](/docs/reference/commerce) owns prices, carts, checkout attempts, receipts, and orders. Payment status and a saved Commerce order are distinct pieces of evidence.

One provider is active per store. A shopper cannot select a processor in checkout input, and an unknown provider does not trigger fallback to another one. The inspected code includes Stripe and Authorize.net adapters, with USD integer minor units and no currency conversion. An adapter's presence does not qualify its owner setup or release.

## Release scope

This reference describes Payments `{{version}}`, released on the EmDash Registry as `dinkus-payments` on {{release_date}} (tag `v{{version}}`). It requires EmDash `1.2.0`. Changes merged after that release are not described here until they ship in a stable release.

The Registry plugin, hosted Payments service and DinkusKit account service have separate versions. A connected account does not prove that a particular plugin version is installed or that live payments are enabled.

## Connect and payment setup

Connect [Commerce](/docs/reference/commerce) first: Commerce's Connect makes the store at DinkusKit.com. Until it does, Payments says "Connect the Commerce plugin first."

Then open **Dinkus Payments > Payment settings** in the store admin to reach **Payment setup**, and press **Connect**. Select the **Authorize Payments at DinkusKit** link that appears and press **Approve** there. DinkusKit.com brings you back, the page checks your approval on its own, and it hands Payments its own store key. Nothing is pasted: the plugin keeps the key in its encrypted Connect setting and uses it to read payment status. Stores that pasted a key into the old Store key setting press Connect again once; that setting is gone.

If no processor is connected yet, the **Connect payments** step asks you to set up Stripe. First choose your **Business country**, the country where your business is registered, then press **Set up Stripe**. The list holds the countries where Stripe opens accounts. Stripe can't change an account's country, so the choice is fixed once setup starts and the page doesn't ask again; after that the button reads **Set up or resume Stripe**. Authorize.net stores are never asked, because their merchant account already has its country. If you already have a Stripe account, sign in to it during Stripe's setup and choose to reuse its details; Stripe copies your verified business details and bank, and the store gets its own Stripe account under the same login. Use the same button when Stripe needs more information; Stripe's setup lists what is missing. Press **Check connection** to read the current status.

A verified Stripe test connection shows **Connected: Stripe test mode**. Shoppers can then pay with Stripe test cards; real customer payments need a live Stripe connection. Until a check has run, the page shows "Payment status not checked", and "Not ready to sell" means a step is still incomplete.

If DinkusKit.com no longer knows the plugin's key, for example after Disconnect on DinkusKit.com, or the key belongs to another store, the page asks you to Connect again. Changing your Stripe setup needs a fresh DinkusKit sign-in on the page, through **Sign in again**; checkout does not use that sign-in.

One provider is active per store. Authorize.net connection checks are not supported in this release, so an Authorize.net connection cannot be verified on this page. Use the Stripe TEST path for the first test order.

## When a test order counts

The Payments setup step uses both conditions for the current payment connection:

1. Payments' own provider lookup confirms a TEST checkout is paid.
2. Commerce persists the paid checkout order and acknowledges that checkout's payment notice.

The owner journey also requires the matching #N (TEST) entry in Commerce Orders. Press Inspect #N and verify Status: Processing and Payment: Provider-paid. Acknowledgement from the checkout does not independently verify that the Orders screen displays the order.

A webhook wakes reconciliation; it is not a substitute for provider lookup. A shopper returning to the site is not payment confirmation. The evidence is tied to the provider, receiving account, and binding. Reconnecting to another receiving account requires fresh proof.

| `testOrder.state` | Meaning |
| --- | --- |
| `awaiting_notice` | Provider payment is confirmed; the corresponding notice has not arrived. |
| `awaiting_commerce` | Payment is confirmed; Commerce has not yet confirmed its saved order. |
| `recorded` | Commerce acknowledged the notice after persisting the paid checkout order; verify the separate Orders view. |

The amount includes `currency: "USD"` and integer `minor` text. `paidAt` is milliseconds since the epoch. The setup page accepts this evidence only for a TEST connection with a binding and the matching provider.

## Troubleshooting the handoff

If the page is waiting for Commerce, check that the site's scheduler is actually invoking Commerce's five-minute reconciliation hook. An activation hook in source is not proof that a deployed host has its Cron Trigger configured. Inspect the existing order before placing a replacement order.

If the page asks for Sign in again or Connect again, follow it, then press Check connection. The page's sign-in is separate from checkout's own store key. If the payment service cannot authenticate with Stripe, reconnecting the page does not repair the service-side problem; contact the operator.

Keep the setup page and hosted service contract compatible. The test-order contract notes that an older setup reader can reject the added field and remain in a checking state.

## Next steps

Follow [Complete and verify a test order](/docs/store-owners/test-order) after the selected installed release and test environment have been qualified. Developers should read the [Commerce reference](/docs/reference/commerce) for checkout authority.

## Sources

This article lives in the Payments repository, is reviewed with the code it describes, and was published from the `v{{version}}` tag. No provider transaction is run for this article; source links do not establish live-payment availability.

- [Release notes](https://github.com/dinkuskit/payments/releases/tag/v{{version}}) and [changelog](https://github.com/dinkuskit/payments/blob/v{{version}}/CHANGELOG.md)
- [Package identity](https://github.com/dinkuskit/payments/blob/v{{version}}/package.json) and [plugin manifest](https://github.com/dinkuskit/payments/blob/v{{version}}/emdash-plugin.jsonc)
- [Test-order contract](https://github.com/dinkuskit/payments/blob/v{{version}}/docs/test-order-check.md)
- [Registry status decoder](https://github.com/dinkuskit/payments/blob/v{{version}}/src/registry/status.ts)
- [Setup screen and recovery wording](https://github.com/dinkuskit/payments/blob/v{{version}}/src/registry/setup.ts)
- [Store TEST readiness agreement](https://github.com/dinkuskit/payments/blob/v{{version}}/docs/store-test-readiness.md)
- [Commerce acknowledgement conditions](https://github.com/dinkuskit/commerce/blob/7b9923d8dfd3bc83513efe5ac80cff0bd6656e12/src/features/checkout/wake.ts)
- [Commerce retryable Orders handoff](https://github.com/dinkuskit/commerce/blob/7b9923d8dfd3bc83513efe5ac80cff0bd6656e12/src/features/checkout/paid-orders.ts)
- [Current stable Payments Registry release](https://registry.emdashcms.com/xrpc/com.emdashcms.experimental.aggregator.getLatestRelease?did=did:plc:ekk4pjmkh3k3ql2kfoex3qt4&package=dinkus-payments)
