# Registry processor onboarding proof

Source base: `0ddd167a583e2bf2378ccd655b13d89b1f63c272`.
Task branch: `codex/payments-registry-onboarding-20261013`.

The Registry grant remains separate from processor setup. An explicit setup action uses the existing encrypted session, verifies issuer/audience/site/scope/admin and requests the configured hosted origin's `/v1/connect` with a bodyless POST. The Stripe link is returned only for an eligible response, HTTPS `connect.stripe.com` setup path, bounded future expiry, unchanged initiating session, and matching status mode/binding. Links are not persisted. The subsequent status check, not a Stripe redirect, determines readiness. Existing TEST/live messaging remains intact.

Synthetic unit and official compiled-runtime tests cover setup/resume, transport shape, non-persistence, unsafe links, malformed replies, expiry, wrong admin, insufficient role and service errors. No external Stripe account or live endpoint was used. `verification.log` records the pinned Node 22.23.2 full verification.

Prepared release identity is 0.2.1; publishing and deployment have not occurred. Parent owns independent exact-head review and any later delivery. Browser/live merchant onboarding remains unproven and gated.

## Verification results

- `npm exec --yes --package=node@22.23.2 -- npm ci`: passed; npm reported five existing high-severity dependency advisories. Dependency changes were outside this slice.
- Pinned Node `bin/verify-payments full`: passed (192 unit tests, 29 Workers runtime tests, 8 official compiled-runtime tests), including typecheck, repository audit, dry-run Worker bundle and Registry manifest/build.
- `unit-final.log`: 13 Registry connection tests passed after strict rejection of explicit HTTPS port 443 was added.
- `typecheck-final.log`: passed after final source edits.
- `compiled-final.log`: 8/8 official-runtime tests passed after strengthening the Check assertion; no missing fixture responses.

An initial compiled test failed because its fixture supplied one JWKS response while setup plus status recheck require two; the fixture was corrected. Expected denial tests can emit caught Worker errors in logs; passing assertions are the proof boundary.

Captured command logs retain output text with trailing whitespace normalized for Git hygiene.
