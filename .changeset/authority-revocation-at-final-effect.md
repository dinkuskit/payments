---
---

Guard authority-revocation-at-final-effect across the entire release chain: record `Release-Actor` on annotated release tags, enforce `--require-actor` on automatic and manual `verify-release-tag` runs before GitHub Release creation, and re-verify the release actor's write access via a read-only App token right before EmDash Registry publication.
