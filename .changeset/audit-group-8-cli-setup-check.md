---
"@dinkuskit/payments": patch
---

The command-line tool treats `--profile constructor`, `toString` and other names it inherits from JavaScript as unknown profiles, and rejects a profile that is not a JSON object. Its timeout now covers the whole reply, so a reply that stalls after its headers is reported as a timeout (exit 3), and `connect` reports it as an unknown outcome that is safe to repeat. The setup check's leak scan now also catches a DinkusKit store key (`dk_store_`).
