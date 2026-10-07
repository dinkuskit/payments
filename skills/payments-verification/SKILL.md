---
name: payments-verification
description: Run the canonical Payments repository gate and distinguish local proof from production readiness.
---

# Payments verification

Install the locked dependencies with `npm ci`. Use the Node version recorded
in `.nvmrc` and the current package/toolchain contract.

```sh
bin/verify-payments quick
bin/verify-payments full
```

The default is `quick`. Both modes resolve the repository from the script path,
so an absolute invocation also works from another directory.

`quick` runs deterministic provider/webhook tests, typechecking, and the public repository audit.
`full` adds workerd runtime tests and the Wrangler build dry-run.
Success exits 0 and prints `verify-payments: <mode> passed`; unsupported modes
exit 64. A failed child command stops the gate with a non-zero exit.

Use quick during edits and full before delivery. Keep the complete command
output as proof and report the first failing check; do not relax assertions or
label fixture transport as live provider proof. Browser/runtime dependencies
must be installed before the full gate.

These checks use local or synthetic fixtures. They do not authorize publishing,
deployment, live payment traffic, or production mutations, and do not establish
an installed release's compatibility beyond the profiles actually exercised.

If Vitest or the sandbox bundler reports a missing platform-native binding,
repeat the locked install with a compatible npm and `--include=optional`.
This task was verified with Node 22.23.2 and npm 10 after the host npm 11
install omitted native runtime dependencies. Preserve the lockfile and pins.
