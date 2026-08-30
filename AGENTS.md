# Agent Contract

This public repository owns DinkusKit Payments, the open-source payment-provider
plugin for EmDash commerce sites. Assume every committed byte is immediately
public.

## Source priority

1. This file.
2. [docs/CHARTER.md](docs/CHARTER.md).
3. `.grilltrack/ledger.json`, maintained only through the GrillTrack CLI.
4. Current source, tests, and committed proof.

## Public-safe boundary

- Never commit credentials, environment files, webhook secrets, customer or
  tenant data, payment details, production configuration, private repository
  coordinates, or private operating rationale.
- The CLI-maintained `.grilltrack/ledger.json`, event log, and same-repository
  closed-track archives are public product-decision lineage. Keep them
  public-safe and do not import another repository's ledger or history.
- This repository has an independent Git root. Prior private code may inform
  behavior research, but reuse is source-by-source clean-room work with fresh
  tests and provenance.

## Product boundary

- DinkusKit Commerce owns authoritative price, sellability, cart and checkout
  orchestration, payment-attempt state, orders, receipts, and the provider port.
- DinkusKit Payments owns server-side processor selection, processor adapters,
  provider transport, webhook verification, and normalized provider results.
- Exactly one payment provider is active per store. Selection is server-owned;
  checkout requests cannot select a provider. Unknown providers fail closed,
  and there is no automatic fallback between processors.
- Stripe is the only provider permitted for demo implementation and support.
  The plugin may add isolated provider adapters later without changing
  Commerce's contract.
- Demo amounts are USD only, represented as integer minor units plus an
  explicit currency code. Non-USD requests fail before provider contact. There
  is no currency conversion.
- This repository does not own catalog pricing, carts, orders, stock,
  fulfillment, shipping, storefront UI, or secret storage.

## Working rules

- Product decisions flow through GrillTrack before implementation.
- Changes use focused branches and pull requests with tests and proof after the
  initial public scaffold.
- ClawSweeper is review evidence, not merge authority. Findings are adjudicated
  before changes are routed.
- Package publishing, deployment, live payment traffic, production mutation,
  secrets or permissions changes, and merges require explicit human approval.
