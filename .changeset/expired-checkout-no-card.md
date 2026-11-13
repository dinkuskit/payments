---
"@dinkuskit/payments": patch
---

Let a shopper check out again after Stripe's payment page expires without a card ever being submitted. Stripe creates the payment only when the shopper confirms, so an expired, unpaid checkout with none could never be charged, but Payments answered "unknown" for it and the cart stayed stuck on "Checkout is still pending". It now answers "expired, not paid", and Commerce releases the checkout. When a card was tried, the careful check is unchanged.
