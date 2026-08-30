# Repository Hygiene

The root is a small public lobby. Product depth belongs under `docs/`,
deterministic helpers under `scripts/`, tests under `tests/`, and public product
decisions plus curated evidence under `.grilltrack/`.

Forbidden material includes environment files, credentials, webhook secrets,
payment details, customer or tenant data, SQL/data exports, private plans or
proof, imported repository history, local agent shelves, and generated run
directories.

Run `npm run audit:repo` before every commit. The audit is intentionally
value-blind: it checks public-safe paths and manifest identity without printing
file contents.
