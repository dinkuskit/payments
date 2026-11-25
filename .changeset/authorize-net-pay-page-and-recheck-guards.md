---
"@dinkuskit/payments": patch
---

Fix three edge-case bugs in Authorize.net checkout and status decoding:

- Prevent `payPage` from storing or handing out a new card form if a transaction notice arrives while checking earlier tries or minting a replacement token.
- Mark paid tries beyond the 20-item `alsoPaid` cap as settled so `openTries` and `recheck` converge cleanly instead of retrying indefinitely.
- Enforce `Number.isSafeInteger` on `paidTwice[].total.minor` in `decodeStatus`, matching `testOrder`.
