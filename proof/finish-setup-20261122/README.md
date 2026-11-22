# Finish setup on Payment settings (step (b) of store-connect-order-135)

Decisions: `store-connect-approve-once-125`, `connect-payments-straight-to-stripe-132`,
`connect-shows-siblings-133`, `connect-uninstall-cancels-key-134` (DinkusKit.com ledger).

## Pictures (22 Nov 2026)

`renderSetupScreen` output from this branch's source, drawn with EmDash's own
`BlockRenderer` (`@emdash-cms/blocks`) and the admin stylesheet
(`@emdash-cms/admin/dist/styles.css`), then captured with Playwright's Chromium.
The Block Kit JSON for each picture sits beside it. Synthetic values only: no
store, DinkusKit.com or Payments service was contacted.

- `finish-setup.png`: a store DinkusKit.com already knows. The page says "Almost
  ready: this store is already connected to DinkusKit" and shows one
  **Finish setup** button.
- `after-finish-setup.png`: the page Finish setup returns. Payments has no Stripe
  account yet, so the page goes straight on to **Business country** and
  **Set up Stripe**, with the line "Connected to Acme Goods on DinkusKit.
  DinkusKit plugins on this store: Commerce, Payments and Ship."

## Authority chain against DinkusKit.com's own code

`authority-chain.mjs` runs this plugin's installed entry points (the Payment settings admin route, the
`store-proof` route and the `plugin:uninstall` hook) against DinkusKit.com's built
Worker from dinkuskit/dinkuskit#145, under that repository's merchant harness with
local D1 and KV. Lookup, finish, token, store passes, the connected-to read, key
cancel, Approve, Disconnect and Revoke are DinkusKit.com's real routes. Only three
things stand in: the transport (https://dinkuskit.com mapped to the local Worker),
the store address (DinkusKit.com's receipt read is answered by the real
`store-proof` route of whichever installation owns that address), and
the Payments Worker's status read (a stand-in that answers only after verifying the store pass against DinkusKit.com's published keys).

`authority-chain-trace.md` is the run's output, with keys and passes redacted. It
shows: the allowed store joining with its own key; an installation claiming
another store's address, a store no business connected, and another business's
owner all refused before any key; a page load or Continue during Finish setup
unable to take it over (Payments); uninstall cancelling only this plugin's key
while Commerce's and other stores' keys keep working; Disconnect (and Revoke)
needing the owner's Approve; and a store connected with the released plugin (main)
keeping its key and settings after the upgrade.

## Checks

- `tests/registry-connection.test.mjs`: Finish setup offered only when DinkusKit.com says so; one press saves this plugin's key and session and reads status in at most ten bridge calls; `owner_approval_required` falls back to the Authorize link and Continue; `connect_commerce_first` and other refusals save nothing; the connected-to line uses the plugin's own key, only at store-passes; uninstall cancels only this plugin's key.
- `tests/registry-runtime.test.ts` (compiled plugin in EmDash's runtime test host): the same Finish setup press within ten bridge calls, the connected-to line, and the `plugin:uninstall` hook sending `POST /api/store-keys/cancel`.
- `tests/registry-connection.test.mjs` also has "a Finish setup refusal or a lost reply ends that attempt, so Connect starts a new one at once" and "a page load while Finish setup waits on DinkusKit.com cannot take the connection over". Both fail on the previous head (`d2d73f8`) and pass now.
- `npm test` 314 pass, `npm run test:plugin-runtime` 37 pass, `npm run typecheck` clean.
- Registry bundle `backend.js`: 41,780 bytes on main, 47,156 bytes here. The manifest now lists the `plugin:uninstall` hook.
