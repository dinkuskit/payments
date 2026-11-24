---
"@dinkuskit/payments": patch
---

Harden four small spots found in the security audit. One malformed row in the payment-wake queue is now skipped on its own instead of stopping every batch behind it. An unexpected error (a runtime or platform failure) now answers `service_unavailable` instead of echoing its internal text, and Payments' own error codes pass through unchanged. The plugin now refuses a Payments status address with a port, matching the setup and provider-identity checks of the same address. The strict field-shape check compares key sets directly instead of joining names with a NUL character. The playground docs now say plainly that its unsalted IP hash keeps the raw address out of storage but is not secret.
