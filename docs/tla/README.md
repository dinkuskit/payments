# Authorize.Net Checkout Concurrency Model

`AuthorizeNetCheckout.tla` models the async store/gateway interleavings in
[`src/authorize-net/checkout.ts`](../../src/authorize-net/checkout.ts)
(`lookup`, `payPage`, and `recordTransaction`).

## Checked Invariants

| Invariant | Design Rule |
|---|---|
| `InvNoExpiredWhenPaid` | `lookup` never returns `expired-unpaid` if `paidId`, a newly notified transaction, or a refreshed form token (`settlesAt`) landed while `tries()` was in flight. |
| `InvNoCardFormWhenPaid` | `payPage` never renders a hosted card form (`post`) if `paidId` or a newly notified transaction landed while `tries()` or `createHostedPayment()` was in flight. |
| `InvNoPaidEvicted` | Within a bounded concurrent unread burst (`<= AUTHORIZE_NET_TRANSACTIONS_PER_ATTEMPT`), resolved transactions (`paidId`, `alsoPaid`, `settled`) are evicted before any unread transaction. |

## Running

```sh
npx --yes tla-ts docs/tla/AuthorizeNetCheckout.tla
```
