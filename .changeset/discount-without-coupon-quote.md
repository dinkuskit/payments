---
"@dinkuskit/payments": minor
---

A discounted checkout no longer needs Commerce's old coupon quote. Coupons are their own plugin now, and Commerce works out the discount per line itself: Payments still checks that no line's discount is above its subtotal and that every sum agrees, then charges each line's net amount and the frozen shipping. A pricing snapshot that still carries the old `coupon` quote is refused like any unknown key.
