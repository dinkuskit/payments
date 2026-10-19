---
"@dinkuskit/payments": patch
---

Add a disabled-by-default, operator-scoped action that preserves a rejected legacy TEST binding's history and prepares one v2 operation without creating an account. Add explicit confirmation through the existing Registry session; validate and preserve the stored start, matched record and audit digest internally.
