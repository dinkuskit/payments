# Payments sidebar icon

This is the proof for payments#112, head `05e0a172a96c75ed402018417ed871602de645af`. It records what EmDash 1.4.0's admin draws for the Dinkus Payments sidebar entry with the Payments 0.5.0 bundle, and then with this PR's bundle.

## How the screenshots were made

1. **Packing.** Payments was packed at this PR's head with the official packager (`bundlePlugin` from `@emdash-cms/plugin-cli`). The template store's `scripts/prepare-playground-plugins.mjs` uses the same packager.
2. **Comparison.** The packed bundle was compared with the packed v0.5.0 bundle:
   - `backend.js` is byte-identical;
   - `manifest.json` differs only in `admin.pages[0].icon`, which is `activity` in v0.5.0 and `currency-circle-dollar` here.
3. **Builds.** Two dinkuskit/template-store Playground builds were made from main `299a796`, with `pnpm exec astro build --config astro.playground.config.mjs` and EmDash 1.4.0:
   - **before**: the Payments v0.5.0 bundle that main pins;
   - **after**: the same build with this PR's packed bundle in `.artifacts/playground-plugins/payments/package`.
4. **Capture.** Each build ran under `wrangler dev` on `https://127.0.0.1`. `shot.cjs` (Playwright Chromium, dark theme) then:
   - opened a fresh playground visitor store;
   - closed EmDash's welcome dialog;
   - cropped the sidebar's Plugins section;
   - clicked Dinkus Payments and cropped the section again with the folder open.

## Result

| | Folder closed | Folder open |
|---|---|---|
| Payments 0.5.0 (`activity`) | `before-closed.png`: plain folder icon | `before-open.png`: plain folder icon |
| This PR (`currency-circle-dollar`) | `after-closed.png`: dollar-coin icon | `after-open.png`: dollar-coin icon |

- Dinkus Commerce (storefront), Playground tour (compass) and Dinkus Ship (truck) look the same in both.
- The Payment settings entry inside the open folder is drawn as a text row with no icon in either build. So the folder row is where the page's icon shows: EmDash gives a folder the icon of its first page (`folder.iconName` in `@emdash-cms/admin` 1.4.0).
- The screenshots show only the local playground admin. They contain no store data, accounts or keys.
