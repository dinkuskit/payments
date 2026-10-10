# Repository Hygiene

The root is a small public lobby. Product depth belongs under `docs/`,
deterministic helpers under `scripts/`, tests under `tests/`, and public product
decisions plus curated evidence under `.grilltrack/`.

Forbidden material includes environment files, credentials, API keys, webhook
secrets, tokens, payment details, customer or tenant data, SQL/data exports,
private plans or proof, imported repository history, local agent shelves, and
generated run directories. Non-secret production deploy settings, such as the
Cloudflare account ID, custom domains/routes, auth issuer/audience/JWKS URL,
return URLs, and `workers_dev`, `preview_urls`, or observability flags, are
permitted in public configuration and deployment docs.

Run `npm run audit:repo` before every commit. The audit is intentionally
value-blind: it checks public-safe paths and manifest identity without printing
file contents.
