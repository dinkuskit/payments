# Bounded onboarding diagnostic design

Base: c1ee16de2e3a00e3a3b6e78943106f3ad96a53ae.
Scope: expose only this authenticated merchant/site's account-create outcome; no provider inspection or platform-wide identity.

## Interface and invariants

- Retain an optional sanitized account-creation failure on the existing connection record: a closed category enum, optional allowlisted HTTP status, and bounded timestamp. Categories: authentication, permission, platform_required, rate_limited, provider_unavailable, transport_unknown, unknown. Never store a raw error/message/body/header/key/account ID/URL in this diagnostic.
- Preserve owner, bindingRef, startedAt and exact Stripe idempotency key. Record only at the existing explicit createAccount catch; no added provider calls or automatic retry. Clear unresolved failure on successful account-ID persistence. Legacy records without evidence are unobserved, not reconstructed.
- Add GET /v1/connect/diagnostics with existing payments:admin authentication and site/owner checks. It reads only local connection state, makes zero provider calls, rejects body/query, returns no-store. Output exposes state/mode, a processor-account-present boolean, evidence observed/unobserved, and sanitized last failure; no account IDs, binding IDs or platform identity.
- Leave /v1/status and existing /v1/connect response keys unchanged for installed0.2.1 compatibility. The new Registry release carries diagnostics outside its existing strict status projection and validates the diagnostic DTO before display. Fetch diagnostics only where useful for connecting/recovery states; absence404 or transport failure remains explicitly unobserved.
- Fix connecting/recovery UI wording so an authenticated grant is not described as missing. Do not offer or perform automatic retry/reset/attach. Keep explicit setup action and existing23-hour safety boundary.

## Rollout and proof

Prepare Registry0.2.2; deploy reviewed hosted code first (backward-compatible existing routes), then publish/install new Registry artifact. Deployment/publication/install/provider retry are owner gates and not part of source execution. Historical swallowed failure cannot be recovered. After deployment, diagnostics reads alone report legacy evidence unobserved. Only a separately authorized single same-binding setup attempt can generate new diagnostic evidence; stop and inspect it rather than repeatedly clicking.

Synthetic tests must prove closed redaction of arbitrary errors, category mapping, no provider requests from diagnostics, tenant/owner denial, unchanged binding/idempotency and no automatic retries, old status schema equality, legacy unobserved state, unavailable diagnostics fallback, and compiled-plugin rendering. No actual provider/browser/account operation in this slice.
