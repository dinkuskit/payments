# Direction and research alignment proof — 2026-10-26

Repository: `dinkuskit/payments`. Source base: `2b9e65213429876015fda16c4669e96de300b759`.
Branch: `codex/rea-alignment-20261026`; the PR head carries this proof.
Owner: core alignment writer; review and merge remain separate.

## Scope and sources

This change updates documentation and research entrypoints. Product behavior,
provider authority, accepted locks and decision ledgers are unchanged. It does
not install user-global skills, deploy, publish a release or authorize a merge.

Source fidelity was checked against the organization
[vision](https://github.com/dinkuskit/.github/blob/36aab690a7ef66dc119aab70e258ea979c54841a/VISION.md)
and [scope and planning](https://github.com/dinkuskit/.github/blob/36aab690a7ef66dc119aab70e258ea979c54841a/ROADMAP.md),
then this repository's charter, current source and linked decisions. New public
text contains no private research paths or copied research artifacts. Existing
status limitations are retained; this documentation is not runtime proof.

## Verification

- `git diff --check`: passed.
- New local Markdown targets resolve; linked organization sources were read at
  the revision above. The diff is limited to the declared docs, bootstrap,
  proof and, where required, an empty changeset.
- `bash -n scripts/agent-skills`: passed. ShellCheck has no new findings
  versus the base script (existing codes: 1007, 2115).
- Ran `./scripts/agent-skills` twice with `AGENT_SKILLS_CACHE_DIR` and
  `CURSOR_SKILLS_DIR` pointed at disposable directories. Cold and cached
  installs passed; the second installation produced identical file hashes and
  preserved an unrelated target file.
- Compared every installed file with its immutable Git blob: seven skills
  retain `5c8476507b0a83e4aef6b54f2e5dfdca2105b6db`; only `emdash-commerce` uses
  `23f2bb1208b3baa7aedaa87faec00395f9bdd061`. Its full four-file tree includes
  both referenced Markdown documents. See [machine-readable results](bootstrap-result.json).

Reproduce the bootstrap check in a disposable directory:

```sh
scratch=$(mktemp -d)
AGENT_SKILLS_CACHE_DIR="$scratch/cache" CURSOR_SKILLS_DIR="$scratch/skills" ./scripts/agent-skills
AGENT_SKILLS_CACHE_DIR="$scratch/cache" CURSOR_SKILLS_DIR="$scratch/skills" ./scripts/agent-skills
```

The source trees in the cache are retained at the two recorded commits. Compare
installed trees with `skills/<name>` there; no product or global install is used.

- `npm run audit:repo`: passed.
- Empty changeset parsed by the repository changeset validator.
- Decision 042 remains locked and unbuilt; this change touches neither the
  existing Stripe proposal branch nor its decision ledger.

Stripe's [payment-method-domain list](https://docs.stripe.com/api/payment_method_domains/list)
and [direct-charge Checkout](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted)
documentation were checked on 2026-10-26. They document domain collections and
connected-account targeting. They do not establish blanket account eligibility
or prove safe multi-site support in this repository. The README retains those
limits while recording the conditional direction to reconcile #89/#90 before
lock or implementation. Historical issue text and the proposal branch are unchanged.
