---
"@dinkuskit/payments": patch
---

Fix three edge-case bugs in Authorize.net checkout and status decoding:

- Prevent `payPage` from storing or handing out a new card form if a transaction notice arrives while checking earlier tries or minting a replacement token. Each checkout record now counts its payment notices (`notices`, absent on older records and read as 0), so a notice is seen even when the bounded try list rotates back to the same ids.
- Mark paid tries beyond the 20-item `alsoPaid` cap as settled so `openTries` and `recheck` converge cleanly instead of retrying indefinitely.
- Enforce `Number.isSafeInteger` on `paidTwice[].total.minor` in `decodeStatus`, matching `testOrder`.
