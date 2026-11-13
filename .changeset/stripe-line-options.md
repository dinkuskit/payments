---
"@dinkuskit/payments": patch
---

Show each item's chosen options on Stripe's payment page. A line from Commerce may carry `options`, such as "Size: M", which Stripe shows in grey under the item name in place of the old "Original catalog quantity" note. The name reads "Wrong Turn Tee", or "Wrong Turn Tee × 2" for two. Items without options get no grey line.
