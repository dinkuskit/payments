---
"@dinkuskit/payments": minor
---

Authorize.net checkouts are decided from every try, and an extra payment reaches the owner. Payments reads a payment notice's real fields (`payload.id` and `merchantReferenceId`), keeps the first paid try for good, never lets a refund or another checkout's try hide it, and refuses a lookup that changes the checkout it names. Each checkout has one live card form at a time. When a checkout is paid more than once, the Payments page shows "This checkout was paid twice" with the transaction numbers for the owner to refund by hand.
