# Contributing

DinkusKit Payments is developed in focused pull requests after its initial
public scaffold.

1. Start from current `main` on a dedicated branch.
2. Keep one product or infrastructure slice per pull request.
3. Grill and lock product behavior before implementation.
4. Add tests for observable behavior.
5. Run `bin/verify-payments full`.
6. State scope, proof, and explicit non-goals in the pull request.

Never include credentials, webhook secrets, payment details, customer or tenant
data, or production configuration in source, tests, logs, screenshots, issues,
or proof.
