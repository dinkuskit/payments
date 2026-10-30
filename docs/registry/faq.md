## Can I use Payments without Commerce?

The current released setup uses DinkusKit Commerce. Standalone Payments is
planned work, not a feature of this listing.

## Does a successful test mean I can take live payments?

No. **Connected: Stripe test mode** describes a test connection. Real customer
payments require a qualified live connection and completed merchant setup.
Verify the hosted service's availability and the store's current readiness;
the plugin's installation alone proves neither.

## Can I connect Authorize.net here?

Authorize.net adapter work exists, but this listing does not promise a
released, verified Authorize.net onboarding workflow. Follow the documented
Stripe test path.

## Does Payments create my storefront or manage shipping?

No. Your site provides the storefront, Commerce owns products and orders, and
[DinkusKit Ship](https://plugins.emdashcms.com/plugins/@dinkuskit.com/dinkus-ship)
provides the separate shipping-label workflow. Ship is not required to test a
payment.

## Where can I get help or contribute?

Start with the [Payments guide](https://dinkuskit.com/docs/reference/payments).
For bugs, source code and contributions, visit
[DinkusKit Payments on GitHub](https://github.com/dinkuskit/payments).
If the plugin is useful, a star helps other EmDash developers find it.
