# Multi-Site TEST Merchant Country Configuration Proof

Base: `286aeac6ec280339ddc6b51501b3fd8b3c9fd1ef`
Branch: `codex/payments-multisite-country-20261015`

## Summary

This bounded additive fix introduces optional multi-site TEST merchant country configuration (`STRIPE_TEST_MERCHANT_COUNTRY_SITES`) to allow multiple explicit test sites to be configured with explicit merchant countries without retargeting or modifying existing legacy singleton configuration (`STRIPE_TEST_MERCHANT_COUNTRY_CONFIG`).

The implementation strictly maintains:
1. **Unchanged Legacy Singleton Logic**: The legacy `testMerchantCountry` parser remains untouched and handles singleton configuration, validation, and legacy 400 correction (`rejectedCreation`).
2. **Additive Multi-Site Parser**: `testMerchantCountrySites` parses and validates a JSON array of closed `{siteId, country}` entries with strict limits (max 8192 chars, max 16 entries, regex `/^[A-Za-z0-9_-]{1,200}$/`, uppercase 2-letter ISO alpha-2 country, duplicate rejection, and prohibition of extra keys or `rejectedCreation`).
3. **Composed Resolver (`resolveMerchantCountry`)**:
   - Absent or empty multi-site binding -> exact legacy resolver semantics.
   - Matching new site -> country only (no `rejectedCreation`). If legacy config also selects the same site, ambiguity is rejected (fails closed with `merchant_country_configuration_invalid`), even if the country is identical, ensuring known-400 corrections cannot be overridden.
   - Valid nonmatching site -> falls back to legacy configuration, preserving legacy singleton semantics and `rejectedCreation`.
   - Malformed present configuration (in either binding) fails closed.
   - No defaults or inferred country; immutable country/key/scope service gates in `src/hosted/connection.ts` are completely preserved.
4. **Cloudflare Worker Wiring**: `PaymentConnection` wires `resolveMerchantCountry(this.env.STRIPE_TEST_MERCHANT_COUNTRY_CONFIG, this.env.STRIPE_TEST_MERCHANT_COUNTRY_SITES, siteId)`.

## Owned Files Modified

- `src/hosted/merchant-country.ts`: Multi-site parser and composed resolver implementation.
- `src/cloudflare/secrets.d.ts`: Added optional `STRIPE_TEST_MERCHANT_COUNTRY_SITES?: string;` to `Env`.
- `src/cloudflare/worker.ts`: Wired `resolveMerchantCountry` into `PaymentConnection`.
- `tests/merchant-country.test.mjs`: Unit tests for multi-site parsing, fallback, ambiguity rejection, and fail-closed malformed handling.
- `tests/runtime/merchant-country.test.ts`: Real Durable Object runtime test for new site admission via `STRIPE_TEST_MERCHANT_COUNTRY_SITES` alongside legacy singleton correction and saved-account preservation across DO eviction.
- `docs/test-merchant-country.md`: Documentation for the optional additive binding, syntax, bounds, fallback semantics, and fail-closed conflict handling.
- `proof/multisite-country/PROOF.md`: This proof document.

## Test Artifacts & Regression

Generated run logs are kept outside this public checkout under the task coordinator proof root. The pre-implementation regression failed because the additive resolver did not exist; final full verification follows the parent cleanup.

## Synthetic Fixtures & Security

All test fixtures use synthetic site IDs and data (e.g. `site-alpha`, `site-beta`, `crypto.randomUUID()`). No actual or production site IDs, credentials, or live provider calls were used.

## Verification

Parent verification: `npm run verify:full` passed (224 unit at that run, 33 hosted runtime, 21 compiled Registry), then `npm test` passed 225 unit after adding refusal-before-I/O coverage. `node --import tsx --test tests/merchant-country.test.mjs` passed13 tests. Typecheck, public audit, Worker dry-run, plugin validation/build and GrillTrack validation passed. The first full run caught generated proof logs inside the public checkout; logs were preserved in the external coordinator proof root and clean full verification passed.

Registry plugin SHA256 remains `cd2b218636781c37be6e39dd515ea905b28fd61de5889b0cf43d585c782f007a`; manifest SHA256 remains `adc6c5ccf6bbf6f0d318e74a421a06dbbce3d947635b7d5795f5563f6710ce23`. No Registry version bump or publication is required. This is source/runtime-synthetic proof, not deployment or live behavior proof. Current-head CI/OpenClaw/native review must qualify the commit before activation.
