# Test order check

Approved 2026-10-11. Decision: `payments-test-order-check-034`. It refines how
[one payment setup screen](payment-setup-decision.md) (029) and the setup
screen (031) learn about Commerce's paid TEST order. The
[store TEST readiness agreement](store-test-readiness.md) (028) still applies.

## When the step is complete

**Place a test order** is complete when both of these are true for the store's
current payment connection:

1. Stripe or Authorize.net confirmed a TEST checkout as paid through Payments'
   own provider lookup.
2. Commerce acknowledged that checkout's payment notice. Commerce acknowledges
   a paid checkout's notice only after it has saved the paid order bound to that
   checkout, so the acknowledgement is Commerce's confirmation that the order
   exists in Orders.

A webhook or a shopper's return to the store never counts on its own.
Commerce needs no change: it already acknowledges notices this way on its
five-minute background check.

## What the step says

| State | Text |
| --- | --- |
| Connected, no paid TEST order yet | Place an order on your store and pay with a Stripe test card. This step completes when Stripe confirms the payment and Commerce saves the order. |
| Paid, notice not yet received | Stripe confirmed a paid TEST order of $12.00 on Oct 11, 2026 at 2:31 PM UTC. Waiting for Stripe's payment notice to reach Payments. |
| Paid, Commerce not yet confirmed | Stripe confirmed a paid TEST order of $12.00 on Oct 11, 2026 at 2:31 PM UTC. Waiting for Commerce to save it; Commerce checks for payment notices every 5 minutes. |
| Complete | Stripe confirmed a paid TEST order of $12.00 on Oct 11, 2026 at 2:31 PM UTC, and Commerce saved it. You'll find it in Orders, marked TEST. |

Authorize.net stores see its name instead of Stripe's. Before a connection
exists the step asks the owner to connect payments first. The overall result
stays **Not ready to sell** while Payments runs only in TEST mode, because
**Connect payments** still needs a verified live connection (029).

## How it works

- When a Payments lookup or checkout call first gets a paid outcome from the
  provider, the store's Payments Durable Object keeps a small record of that
  checkout: binding, provider, receiving account, amount and time. Later paid
  answers for the same checkout keep the first time.
- Payment notices and Commerce's acknowledgements are already stored for each
  checkout. Only notices for the same checkout, binding, TEST mode and
  receiving account count.
- Authenticated `GET /v1/status` adds `testOrder` only when such a record exists
  for the current connection. A checkout Commerce has confirmed wins over a
  newer one that is still waiting; otherwise the newest paid one is shown.

```json
{
  "provider": "stripe",
  "total": { "currency": "USD", "minor": "1200" },
  "paidAt": 1791729065000,
  "state": "recorded"
}
```

`state` is `awaiting_notice`, `awaiting_commerce` or `recorded`. `paidAt` is
milliseconds since the epoch. The Registry setup page's strict status reader
accepts `testOrder` only in TEST mode with a binding, and only from the
provider the connection evidence names. Browser input never reaches it.

The record is tied to the provider, receiving account and binding, so a new
connection or a different receiving account starts the step over (028).
Payments cannot count Commerce's orders; "exactly one order" comes from
Commerce writing one order per checkout.

## Limits and deploy notes

- The step depends on the store's five-minute Commerce background check. A
  store without its Cron Trigger stays at "Waiting for Commerce to save it",
  just as its missed payments would.
- Deploy the Payments Worker together with this version of the setup page. An
  older setup page rejects the new field and shows "Checking Payments setup"
  once a test order exists.
- No order number is shown: that would need a new Commerce call and bundle
  bytes Commerce does not have to spare.

## Research

Checked 2026-10-11.

| Platform | What it does | Takeaway |
| --- | --- | --- |
| Shopify | Asks merchants to place a test order during setup and after changing payment settings ([test orders](https://help.shopify.com/en/manual/checkout-settings/test-orders)). | A test order is the setup proof; payment changes mean testing again. |
| WooCommerce (WooPayments) | Marks test-mode orders on the order page and in emails ([testing](https://woocommerce.com/document/woopayments/testing-and-troubleshooting/testing/)). | The order itself is marked TEST in Orders, as Commerce does. |
| BigCommerce | Pay with the Test Payment Gateway, then check the order in Orders ([testing settings](https://support.bigcommerce.com/articles/Public/Testing-Shipping-Tax-and-Payment-Settings)). | The proof is the order landing in Orders. |
| Stripe | Webhooks are required for fulfillment because shoppers do not always return ([fulfill orders](https://docs.stripe.com/checkout/fulfillment)); check webhooks before going live ([go-live checklist](https://docs.stripe.com/get-started/checklist/go-live)). | Count the order only once the notice path delivered it to Commerce. |

None of these documents a payments page that completes itself automatically,
so this check is stricter than they are, as 028 and 029 chose.
