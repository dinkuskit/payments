---
name: payments-cli
description: Check a site's DinkusKit Payments connection with dinkus-payments, read the result correctly, and know when to stop and hand off to a human.
---

# Payments CLI

The mechanics live in the CLI and [the CLI spec](../../docs/CLI-SPEC.md);
`dinkus-payments <command> --help` is the reference. This skill covers judgment.

1. **Check status first.** Run
   `dinkus-payments --site <site-id> status --json`. Pass the endpoint with
   `--endpoint` or `DINKUS_PAYMENTS_ENDPOINT`, and the token only through
   `DINKUS_PAYMENTS_TOKEN` (`payments:admin` for `status` and `connect`,
   `payments:checkout` for `binding`, `checkout`, `wakes`).
2. **Read the result, not the prose.** Use `outcome`, `data.connection.state`,
   and `data.nextAction` from `--json`, plus the exit code. `ready` in `test`
   mode is not permission to take live payments. `checking` means the provider
   could not be verified right now; retry later instead of assuming ready.
3. **Preview before you connect.** Run `connect --dry-run --json` and read
   `data.effect`. Run a real `connect` only when the operator asked for it, with
   `--no-input --confirm <site-id>`. Give any onboarding link only to the
   merchant for that site; never store or log it.
4. **Treat unknown as unknown.** Exit `3` or `outcome: "unknown"` after
   `connect` means the result was not seen. Run `status` before anything else.
   `connect` is safe to repeat because it resumes the same binding.
5. **Escalate to a human, without retrying or working around it, when:**
   `nextAction` is `escalate` (`recovery_required`), exit `4` names a
   `connection_owner_mismatch`, a lookup is `rejected` with
   `request_mutation` or `binding_mismatch`, `wakes list` reports
   `wake_association_mismatch`, or any exit `5` (contract break). Do not
   acknowledge wakes or create checkout sessions; Commerce owns both.
6. **Never paste tokens.** Do not put a token in a flag, config file, command
   line, transcript, issue, or proof. If output ever shows a credential, stop
   and report it as a security problem.
