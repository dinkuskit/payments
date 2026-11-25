# Public-route site check (deepsec G5-09, G5-10, G5-11, G1-19)

The owner approved this scope on 2026-11-24.

## What this proves (25 Nov 2026)

`site-check-1440.png` and `site-check-390.png` put two runs of
`tests/runtime/public-route-site-check.test.ts` side by side: one on `main` (bd97232) and one on this branch.
`render.mjs` runs both and draws them (`node proof/public-route-site-check-20261125/render.mjs <main checkout>`).
The raw rows are in `trace-main.txt` and `trace-branch.txt`.

Every request goes through the real Worker entry (`src/cloudflare/worker.ts`) in workerd, via
`@cloudflare/vitest-plugin`, with the production Durable Object binding. The test wraps that binding to count
`getByName` and `idFromName` calls, and it counts calls to `apitest.authorize.net`. Each cell shows the HTTP status,
then Durable Object lookups, then Authorize.net calls, for that one request. All values are synthetic. No deployed
Worker, DinkusKit.com or Authorize.net account was contacted.

Shown:

- **Accepted:** the store's own pay page session still answers 200. It names one store object and makes one
  Authorize.net call, because the stored form token is old.
- **Malformed names and sessions are refused before any store object is named.** On main, each one named a store
  object (1). On this branch it names none (0) and answers 404. This holds on the pay page and on the notice
  address, for a percent-encoded name, a non-ASCII name, a 201-character name, and a malformed session.
- **Store passes:** a pass whose `site_id` has a space or a non-ASCII character was accepted on main (200, one
  store object). On this branch it is refused (401) before any store object is named. A UUID site id and a
  200-character site id are still accepted.
- **Unchanged, and limited on purpose:** a well-formed wrong session secret, the right session under another store,
  and a well-formed store name on a notice with a bad signature still reach that store's object. The object refuses
  them there (404 or 400), with no Authorize.net call. This change checks the shape of a store name. It does not
  check whether the store exists.

## Existing stores and data

- Nothing stored changes: no table, column or stored value is touched. Store objects keep their names
  (`["test", siteId]`).
- DinkusKit.com issues every site id as `crypto.randomUUID()`. Its connect code has refused any site id outside
  `^[A-Za-z0-9_-]{1,200}$` since that code was first written, and store identities are written only from those
  connection rows. The playground's site id is `playground`. So every pass that has been issued carries a site id
  this branch still accepts. The UUID row in the picture is that case.
- The status endpoint's new port check reads the configured Payments endpoint. The production endpoint,
  `https://payments.dinkuskit.com`, has no port.
