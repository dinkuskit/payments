---
"@dinkuskit/payments": patch
---

Keep the last 20 Authorize.net transactions notified for a checkout instead of only the latest. A shopper declined on one card who pays with another stays paid even when the declined try's notice arrives last, a checkout reads unpaid only when every try is unpaid, and a try the provider cannot answer for right now keeps the checkout open without hiding a later paid try.
