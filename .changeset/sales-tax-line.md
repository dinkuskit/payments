---
"@dinkuskit/payments": minor
---

Sales tax from Commerce. A checkout the Tax plugin priced carries `tax` on its pricing and on every line; Payments checks that the lines' tax is never more than the order's and that the total is net merchandise plus shipping plus tax, then charges the tax as one **Sales tax** line after shipping on Stripe's page and sends it as the transaction's `tax` on Authorize.net (also on every fresh card form the pay page mints). A checkout without tax is unchanged and keeps its fingerprint.
