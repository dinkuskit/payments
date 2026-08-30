# Vision

DinkusKit Payments gives an EmDash store one understandable, replaceable
payment-provider connection without moving checkout authority out of DinkusKit
Commerce.

The first complete proof uses Stripe in test mode and USD from end to end.
Commerce calculates the amount and owns the attempt, order, and receipt.
Payments performs the processor operation, verifies processor callbacks, and
returns a normalized result. A missing, unknown, unhealthy, or incompatible
provider fails closed.

After the demo application is proven, additional currencies and processor
adapters may be grilled independently. The plugin never converts currency,
silently changes providers, or treats a browser-supplied total as authoritative.
