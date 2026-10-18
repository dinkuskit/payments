---
"@dinkuskit/payments": patch
---

Payment setup page: returning from DinkusKit's Approve finishes sign-in on its own and shows the real payment connection; Continue pressed early waits out DinkusKit's short poll interval instead of showing the same screen; a lapsed 5-minute page sign-in shows the last checked result with its time; a refused Stripe setup names its known reason instead of "not confirmed".
