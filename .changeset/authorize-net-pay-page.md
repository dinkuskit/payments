---
"@dinkuskit/payments": patch
---

Authorize.net shoppers reach the card form through a Payments pay page that posts a fresh form token. Authorize.net opens its form only for a POST, and a token lasts 15 minutes, so the old link could not open it. A declined shopper can retry at once (duplicate window 0), and the checkout stays open until it ends. Unpaid becomes final only after the last card form can no longer be used, and fraud holds stay undecided. Hosted service change; Commerce is unchanged.
