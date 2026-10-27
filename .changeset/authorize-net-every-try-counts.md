---
"@dinkuskit/payments": patch
---

Keep every Authorize.net transaction notified for a checkout instead of only the latest. A shopper declined on one card who pays with another stays paid even when the declined try's notice arrives last, and a checkout reads unpaid only when every try is unpaid.
