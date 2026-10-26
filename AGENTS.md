# Agent Contract

This public repository owns DinkusKit Payments, the open-source payment-provider
plugin for EmDash commerce sites. Assume every committed byte is immediately
public.

## Running GrillTrack

Run `./scripts/agent-skills` first; it installs the pinned SaariusSkills
skills into ignored `.cursor/skills/`. Use
`./scripts/grilltrack --project . validate` or `show` for ledger reads.
The CLI-only ledger rule remains in force. SmokySkills is enabled only after
maintainer access and an immutable commit pin are supplied.

In Claude Code cloud sessions `.claude/hooks/session-start.sh` checks Node
against `.nvmrc`, runs `npm ci` and `./scripts/agent-skills`, then reports
anything missing; read that report before running project scripts.

## Source priority

1. This file.
2. [docs/CHARTER.md](docs/CHARTER.md).
3. `.grilltrack/ledger.json`, maintained only through the GrillTrack CLI.
4. Current source, tests, and committed proof.

## Public-safe boundary

- Never commit credentials, environment files, API keys, webhook secrets, tokens,
  customer or tenant data, payment details, or private operating rationale.
- Non-secret production deploy settings may live in this public repository,
  including the Cloudflare account ID, custom domains/routes, auth
  issuer/audience/JWKS URL, return URLs, and `workers_dev`, `preview_urls`, or
  observability flags (for example in `wrangler.production.jsonc` or
  `DEPLOY.md`). Secrets remain Cloudflare Worker secrets and must never be
  committed.
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
- Stripe remains the reference provider, and `authorize_net` is the second
  approved isolated adapter (decision recorded 2026-10-07). The rationale is
  support for restricted-category merchants whose underwriters use the
  Authorize.net gateway. Each store still selects exactly one provider;
  selection is server-owned and unknown providers fail closed.
- Demo amounts are USD only, represented as integer minor units plus an
  explicit currency code. Non-USD requests fail before provider contact. There
  is no currency conversion.
- This repository does not own catalog pricing, carts, orders, stock,
  fulfillment, shipping, storefront UI, or secret storage.

## Reference article

`docs/website/reference/payments.md` is the Payments article on dinkuskit.com/docs
(GrillTrack decision `website-docs-from-plugin-releases-086` in
dinkuskit/dinkuskit). Change it in the same PR as any behavior, screen, route
or setup step it describes. Keep `version_scope: "Payments {{version}}"` and the
`{{version}}` and `{{release_date}}` placeholders: a stable release fills
them in and publishes the article, so main may describe changes that are not
released yet. Guides that span plugins live in dinkuskit/dinkuskit
`docs/updates/`; link that PR under **Docs impact**.

Reviewers, ClawSweeper included, record every PR's docs as one of:

- **Docs: up to date**: the PR updates the article to match, or the article
  already describes the change correctly.
- **Docs: missing**: the PR changes something the article describes, or should
  describe, without updating it. Report it as a P3 finding naming the section;
  it does not block the merge.
- **Docs: not applicable**: nothing an owner or developer sees changes (tests,
  CI, internal refactors).

## Working rules

- Product decisions flow through GrillTrack before implementation.
- Changes use focused branches and pull requests with tests and proof after the
  initial public scaffold.
- ClawSweeper is review evidence, not merge authority. Findings are adjudicated
  before changes are routed.
- Package publishing, deployment, live payment traffic, production mutation,
  secrets or permissions changes, and merges require explicit human approval.
