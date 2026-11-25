---
"@dinkuskit/payments": patch
---

Re-check live checkout state after in-flight Authorize.Net gateway calls in `lookup` and `payPage`, evict already-resolved tries first in `recordTransaction`, and add `docs/tla/AuthorizeNetCheckout.tla`.
