# Registry setup request budget

Base: ba6fc96a2bb228122cdc84fac218adb19cbc5c2f (Registry0.2.4).
Candidate: Registry0.2.5, not yet published or installed.

## Reproduction

The old setup path repeats the stored-session read and JWT/JWKS verification
inside its follow-up status call. With optional diagnostics it needs thirteen
bridge calls. A modeled ten-call guard rejects the optional diagnostics call
at eleven and then the mandatory connection recheck at twelve, reproducing
`status_recheck_control` without returning the already received setup link.
The setup POST is call five, so that later error cannot establish that no
processor action occurred. A missing URL is not proof that no account exists.

## Repair and safety

The follow-up status helper accepts only the exact session and owner binding
already verified by its caller within that invocation. No hash, signature,
issuer, audience, scope, owner or expiry check is removed from authentication.
Control-state rechecks before/after the setup request and before returning a
link remain in place, including the recheck after best-effort diagnostics.
The response binding/mode and onboarding URL validation are unchanged.

The longest setup path is now: control, session, JWKS, control, setup POST,
control, status GET, diagnostics GET, control, control (ten calls).
Existing bounded tests cover Continue in nine and a diagnostic Check in seven.

Post-request failures return an explicit setup-unconfirmed outcome. The UI
says setup was requested, withholds any unverified link, and offers Check
connection without an automatic retry or setup action.

The compiled regression checks the returned verified link, exact ten-call
sequence, one JWKS request, one setup POST, unchanged stored state, and the
subsequent seven-call status check. Additional compiled tests cover replacement
of the active flow during the setup request and after status, plus a failed
post-setup status read that must not claim no setup was attempted. Existing
tests retain expiry, caller, unsafe-URL and mismatched-mode cases.

The ten-call guard models the documented deployed limit; local Worker Loader
does not enforce it. No raw production exception, secret values, or provider
inventory was inspected. Live account creation remains unknown until the
coordinator's independent read-only inventory confirms it.

References: https://developers.cloudflare.com/dynamic-workers/usage/limits/
and https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits .

## Verification

`npm run verify:full` passed: 198 unit tests, 30 hosted Worker tests and
17 compiled Registry tests. `npm run plugin:bundle` passed.
The hosted Worker and production configuration remain byte-identical to base:

- `dist/worker.js`: e6f51756c27a6bd74c7d4a3b58567e9c1f268681ef2b24cf6ee21bbdbfdc3e7b
- `wrangler.production.jsonc`: fe2f0ae9b11b30bedc9e4352ca0135b377202c664eff50a59dbc9896f30f57bf

No deployment, publication, browser operation or provider request was performed.
