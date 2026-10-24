---
"@dinkuskit/payments": patch
---

Validate winning Authorize.net attempt records inside the session-creation transaction and rethrow `attempt_mismatch` on concurrent mismatched calls.
