---
---

CI only: the release PR's version step copies the new version into package-lock.json and changes nothing else, instead of re-resolving the lockfile with `npm install --package-lock-only` (which pruned a record and blocked the Payments 0.3.0 release PR).
