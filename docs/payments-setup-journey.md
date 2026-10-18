# Payments Setup Journey (`release-beta-cut-071`)

Per GrillTrack decision `release-beta-cut-071`, the `@running` live-store release gate includes the **Payments setup journey** alongside the Commerce setup and Stripe / Authorize.net checkout journeys.

## Accepted Registry Packages and Installed IDs

EmDash derives the installed plugin ID via `makeRegistryPluginId(publisherDid, slug)` where `publisherDid` is `did:plc:ekk4pjmkh3k3ql2kfoex3qt4` (`emdash-plugin.jsonc`):

| Channel | Registry Slug | Installed Plugin ID | Admin Status Callback Path | Public Store-Proof Path |
| --- | --- | --- | --- | --- |
| Stable | `dinkus-payments` | `r_3brsc2on3bu673rn` | `/_emdash/admin/plugins/r_3brsc2on3bu673rn/status` | `/_emdash/api/plugins/r_3brsc2on3bu673rn/store-proof` |
| Beta | `dinkus-payments-beta` | `r_sffx6l4z6mpqliki` | `/_emdash/admin/plugins/r_sffx6l4z6mpqliki/status` | `/_emdash/api/plugins/r_sffx6l4z6mpqliki/store-proof` |

## `@running` User Journey Specification

```gherkin
Feature: Merchant connects DinkusKit Payments in Stripe test mode

  @running
  Scenario: Merchant installs or opens Payments, connects with DinkusKit.com in Stripe test mode, clicks Check connection, and sees Connected: Stripe test mode
    Given the store admin is signed in to EmDash Admin on the beta store
    And the DinkusKit Payments plugin is installed from the EmDash Registry ("dinkus-payments-beta" -> "r_sffx6l4z6mpqliki", or stable "dinkus-payments" -> "r_3brsc2on3bu673rn")
    When the merchant opens the Payment setup page at "/_emdash/admin/plugins/<installedPluginId>/status"
    And the merchant connects the store with DinkusKit.com if not already authorized ("Connect" -> "Authorize Payments at DinkusKit" -> "Continue")
    And the merchant clicks "Check connection"
    Then the Payment setup banner reads "Connected: Stripe test mode"
    And the Connect payments step reads "Connect payments: Connected: Stripe test mode. Test card payments work at checkout."
    And the Place a test order step is visible
    And no raw tokens, PKCE verifiers, or Stripe keys appear in the page or network responses
```

## Programmatic Verification Helper

`src/registry/setup-journey.ts` exports:

- `PAYMENTS_SETUP_JOURNEY`: canonical metadata (`id`, `tag: "@running"`, accepted slugs, accepted installed plugin IDs, and expected banner/step copy).
- `resolvePaymentsSetupTarget(storeOrigin, pluginIdOrSlug)`: resolves the exact installed plugin ID (`r_sffx6l4z6mpqliki` or `r_3brsc2on3bu673rn`), admin status URL, and public store-proof URL.
- `inspectPaymentsSetupScreen(page)`: inspects the Block Kit response from the Payments admin route for the `Payment setup` header, `Connected: Stripe test mode` banner, `Connect payments` and `Place a test order` steps, available actions, and absence of secret/token leaks.
- `runPaymentsSetupJourney({ storeOrigin, pluginIdOrSlug, driver })`: executes the full setup journey (`open` -> optional `connect` / `authorizeAtDinkusKit` / `continue` -> `check`) and verifies the terminal `Connected: Stripe test mode` state.
