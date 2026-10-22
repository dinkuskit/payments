---
"@dinkuskit/payments": minor
---

Payment setup page reads payment status with a fresh pass traded from the store key on every load, the way checkout does, so it shows the current answer after its 5-minute DinkusKit sign-in lapses and to every store admin. Paste the store key from DinkusKit.com's Set up Commerce box into the new Store key setting, as for Ship. Sign in again now appears only when Payments isn't connected for the store or a Stripe change (Set up or resume Stripe, provider identity, recovery) needs it; a missing or refused store key is named instead. The hosted Payments Worker accepts the store's checkout pass on `GET /v1/status` (deploy it before releasing this plugin).
