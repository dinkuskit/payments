# DinkusKit Payments public scaffold proof

## Accepted lock

The initial repository reserves `dinkuskit/payments`, package
`@dinkuskit/payments`, and EmDash plugin ID `dinkus-payments`. It establishes
one server-owned active provider per store, an adapter-ready plugin with Stripe
as the sole demo provider, and a USD-only demo currency allowlist.

Commerce remains authoritative for price, checkout totals, payment-attempt
state, orders, receipts, and the payment-provider contract. Payments owns
processor selection and adapters, Stripe transport, webhook verification, and
normalized results. Unknown providers and non-USD amounts fail before provider
contact; there is no provider fallback, browser provider selection, or currency
conversion.

## Implementation

- Public ownership and safety contract: `AGENTS.md`
- Product and initial delivery boundary: `docs/CHARTER.md`
- Package and demo identity: `package.json`
- Planned feature ownership: `FEATURE_MAP.md`
- Public repository audit: `scripts/repo-contract.mjs`
- Local and CI verifier: `bin/verify-payments` and
  `.github/workflows/repo-contract.yml`
- Durable public decision lineage: `.grilltrack/ledger.json` and
  `.grilltrack/events.jsonl`

The scaffold intentionally contains no `src/` implementation, Stripe SDK,
credentials, webhook endpoint, processor calls, or runtime dependency.

## Verification

Executed with Node `22.23.2`:

```text
bin/verify-payments full
```

Result:

- repository contract test: 1 passed, 0 failed;
- public repository audit: `public_repository_contract=clean`;
- manifest pins the confirmed package, plugin, provider, and currency shape;
- implementation dependencies and `src/` code are absent.

Ledger validation:

```text
python3 /home/smoky/.codex/skills/grilltrack/scripts/grilltrack_ledger.py \
  --project /home/smoky/Developer/repos/dinkuskit/payments validate
```

Result: `valid`.

## Renderer and fidelity

This is a repository and architecture-contract slice, so faithful evidence is
the real package manifest, public documentation, deterministic audit output,
and Git source. It does not claim runtime payment, Stripe, webhook, Commerce,
or storefront behavior.

## Review and delivery

Exact-source standards and source-intent review is pending the local immutable
commit. GitHub creation and push are separately authorized but remain pending
until that review closes cleanly.
