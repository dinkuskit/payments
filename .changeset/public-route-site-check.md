---
"@dinkuskit/payments": patch
---

Refuse a malformed store name or session on the public Authorize.net notice and pay page addresses before any store record is looked up. A site id must now be the shape DinkusKit.com issues (1-200 letters, digits, `-` or `_`). The store's pass, both public route matchers and the pay page link all apply the same check. The pay page session must also be well formed. Anything else answers 404 without naming a store's Durable Object. A well-formed name is still passed to that store's object, which checks the session or the notice's signature as before; this change does not check whether a store exists.
