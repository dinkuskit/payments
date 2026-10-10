# Contributing

DinkusKit Payments is developed in focused pull requests after its initial
public scaffold.

1. Start from current `main` on a dedicated branch.
2. Keep one product or infrastructure slice per pull request.
3. Grill and lock product behavior before implementation.
4. Add tests for observable behavior.
5. Run `bin/verify-payments full`.
6. State scope, proof, and explicit non-goals in the pull request.

Never include credentials, API keys, webhook secrets, tokens, payment details,
customer or tenant data, or private operating rationale in source, tests, logs,
screenshots, issues, or proof. Non-secret production deploy settings may be
committed, including Cloudflare account ID, custom domains/routes,
auth issuer/audience/JWKS URL, return URLs, and `workers_dev`,
`preview_urls`, or observability flags. Keep secrets in Cloudflare Worker
secrets.
