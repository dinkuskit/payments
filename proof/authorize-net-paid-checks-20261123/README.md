# Authorize.net paid checks (deepsec findings G1-03, G1-04, G1-05, G1-06, G1-14, G1-16)

Decision: `payments-authorize-net-paid-twice-044`, reopened and locked again on 2026-11-23 (the owner approved
on 2026-11-23): the paid-twice line is built now, and the two-tab sandbox test is this change's proof.

## Pictures (23 Nov 2026)

`renderSetupScreen` output from this branch's source, drawn with EmDash's own `BlockRenderer`
(`@emdash-cms/blocks` 1.5.0) and the admin stylesheet (`@emdash-cms/admin/dist/styles.css`), then captured with
Playwright's Chromium by `render.mjs` (`node proof/authorize-net-paid-checks-20261123/render.mjs` from the
repository root). The Block Kit JSON sits beside them. Synthetic values only: no store, DinkusKit.com, Payments
service or Authorize.net account was contacted.

- `paid-twice-1440.png` and `paid-twice-390.png`: an Authorize.net TEST store's Payment setup page after one
  checkout was paid twice. Below the usual status banner it says **This checkout was paid twice**, with the amount,
  both transaction numbers, which one the order was made from, and that the owner refunds the other by hand.

## Two-tab sandbox test

The locked decision makes a real Authorize.net sandbox run the proof that two tabs cannot both pay one checkout
once each tab gets the same card form, and that the line appears if they ever do. That run needs a deployed
Worker and the sandbox merchant login, so it is done after merge on the owner's go; its result is added to the
pull request.
