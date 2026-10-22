---
"@dinkuskit/payments": minor
---

Connect now gives the Payments plugin its own DinkusKit store key, so nothing is pasted: DinkusKit.com hands the key over at the end of Connect, the plugin keeps it in its encrypted Connect setting, and the status page uses it to read payment status. The Store key setting is gone. A missing or unknown key asks for Connect again, and a store whose Commerce plugin is not connected yet is told to connect Commerce first. Needs DinkusKit.com with per-plugin keys deployed first; stores that pasted a key press Connect again once.
