---
"@dinkuskit/payments": patch
---

Make Authorize.Net `ensureSession` resolve stored attempts authoritatively instead of unconditionally returning `"open"`, preventing paid or expired sessions from being reported as open on retry.
