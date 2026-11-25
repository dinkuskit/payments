# Authorize.net checkout records survive the upgrade (25 Nov 2026)

This PR changes which list a paid Authorize.net try is kept in (`settled`) and when the pay page hands out a card
form. It adds one optional field, `notices`, a count of payment notices; a record without it counts as 0, and no
field is renamed or removed. This proof shows that checkout records written by older Payments code keep working
when this branch reads them.

`upgrade.mjs` runs the real payment port twice over one shared store: first the older `src/authorize-net/checkout.ts`
writes the records, then this branch's reads them. The store is in memory and passed through the same `store`
interface the Worker's Durable Object uses. Authorize.net is a synthetic transport; no account was contacted.

```sh
git worktree add ../payments-v0.5.0 v0.5.0
git worktree add ../payments-main 9d7479c
node --import tsx proof/authorize-net-upgrade-20261125/upgrade.mjs "$PWD/../payments-v0.5.0/src/authorize-net/checkout.ts" "$PWD/src/authorize-net/checkout.ts"
node --import tsx proof/authorize-net-upgrade-20261125/upgrade.mjs "$PWD/../payments-main/src/authorize-net/checkout.ts" "$PWD/src/authorize-net/checkout.ts"
```

The full output is in `trace.txt`. In short:

| Record written by | Checkout | Read by this branch |
| --- | --- | --- |
| v0.5.0 (latest stable) and main | A: one declined try | Pay page still serves the card form |
| v0.5.0 and main | B: a paid try noted, not yet looked up | Lookup returns paid, same payment id; pay page sends the shopper back |
| main | C: paid, then 21 more payments (main leaves try 421 open, so every recheck reads it again) | Recheck finishes: no open tries, first payment and the 20 listed extras unchanged, no further reads |

The control run (main writes, main reads) shows checkout C still stuck on main, so the difference is this branch.
