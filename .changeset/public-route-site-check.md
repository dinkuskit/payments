---
"@dinkuskit/payments": patch
---

Refuse a made-up store name on the public Authorize.net notice and pay page addresses before any store record is created. A site id must now be the shape DinkusKit.com issues (1-200 letters, digits, `-` or `_`). The store's pass, both public route matchers and the pay page link all apply the same check. The pay page session must also be well formed. Anything else answers 404 and leaves no empty store record behind.
