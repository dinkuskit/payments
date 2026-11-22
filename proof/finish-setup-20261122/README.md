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

## Checks

- `tests/registry-connection.test.mjs`: Finish setup offered only when DinkusKit.com says so; one press saves this plugin's key and session and reads status in at most ten bridge calls; `owner_approval_required` falls back to the Authorize link and Continue; `connect_commerce_first` and other refusals save nothing; the connected-to line uses the plugin's own key, only at store-passes; uninstall cancels only this plugin's key.
- `tests/registry-runtime.test.ts` (compiled plugin in EmDash's runtime test host): the same Finish setup press within ten bridge calls, the connected-to line, and the `plugin:uninstall` hook sending `POST /api/store-keys/cancel`.
- `npm test` 312 pass, `npm run test:plugin-runtime` 37 pass, `npm run typecheck` clean.
- Registry bundle `backend.js`: 41,780 bytes on main, 47,156 bytes here. The manifest now lists the `plugin:uninstall` hook.
