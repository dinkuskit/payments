---
---

Guard authority-revocation-at-final-effect across the entire release chain: record `Release-Actor` on annotated release tags, enforce `--require-actor` on automatic and manual `verify-release-tag` runs before GitHub Release creation, complete any EmDash workflow-connection approval wait before minting the read-only App token, and re-verify the release actor's write access right before non-waiting `release-action` publication.
