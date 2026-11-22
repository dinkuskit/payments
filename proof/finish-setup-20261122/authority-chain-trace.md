# Finish setup authority chain: Payments plugin against DinkusKit.com

Run 2026-11-22. Payments plugin: this branch at 6e58204. DinkusKit.com: built Worker from dinkuskit/dinkuskit#145 at ad88252, local D1 and KV. Released plugin for the upgrade check: main at 5f24f13. Keys and passes are redacted.

## 1. A store its business already connected joins with Finish setup
- PASS: the Payment settings page offers Finish setup, not Connect (["Finish setup"])
- PASS: pressing Finish setup goes straight to the business country and Set up Stripe (["Set up or resume Stripe","Check connection","Reconnect","Check provider identity"])
- PASS: Payments saved its own key, different from Commerce's (dk_store_[redacted])
- PASS: DinkusKit.com read the receipt from the store's own proof route
- PASS: the key trades for a checkout pass for this store
- PASS: the next load names the business and the plugins on the store (Connected to Acme Goods on DinkusKit. DinkusKit plugins on this store: Commerce and Payments. To disconnect one, open Your stores at DinkusKit.com.)
- PASS: the owner got the "joined your store" email (["Dinkus Payments joined your store on DinkusKit"])

## 2. Another business, or another address, gets nothing
- PASS: an installation claiming Acme's address, but not answering there, gets no key (Connect payments: Not complete. Your payment connection is unavailable, so it could not be checked. Connect your DinkusKit account to continue.)
- PASS: it was not shown a way past the owner either (["Connect"])
- PASS: Payments on Other Shop joins Other Shop's own business (Connected to Other Shop on DinkusKit. DinkusKit plugins on this store: Commerce and Payments. To disconnect one, open Your stores at DinkusKit.com.)
- PASS: Acme's Payments key cannot trade passes for Other Shop
- PASS: Other Shop's key cannot read Acme's connection
- PASS: a store no business connected shows Connect, not Finish setup (["Connect"])
- PASS: pressing Finish setup there anyway asks for Commerce first and saves nothing (Connect payments: Not complete. Connect the Commerce plugin first. Commerce registers this store with DinkusKit.com; then come back here and select Connect.)

## 3. A Finish setup in progress cannot be taken over by another page load
- PASS: a page load while DinkusKit.com reads the receipt says setup is still finishing (Connect payments: Not complete. Your DinkusKit sign-in is still finishing. Select Continue to check it again.)
- PASS: a Continue press then cannot take the connection over (Connect payments: Not complete. Your DinkusKit sign-in is still finishing. Select Continue to check it again.)
- PASS: and the Finish setup still completes with its key

## 4. Uninstall cancels only Payments' key
- PASS: Payments' key no longer trades any pass
- PASS: nor reads the connected-to details
- PASS: Commerce's key still works
- PASS: Other Shop's Payments key still works
- PASS: a reinstall shows Finish setup again (an uninstall is not a Disconnect) (["Finish setup"])
- PASS: and joins with a new key

## 5. After the owner's Disconnect or Revoke, only the owner's Approve brings Payments back
- PASS: Disconnect ended the key
- PASS: the page shows Connect, not Finish setup (["Connect"])
- PASS: a Finish setup press (an old page) gets the owner's Approve link, and no key (["Continue"])
- PASS: Continue before the owner approves keeps waiting (["Continue"])
- PASS: the owner's Approve sends them back to the plugin page (https://acme-goods.example/_emdash/admin/plugins/r_3brsc2on3bu673rn/status)
- PASS: after the owner's Approve, Continue finishes with a key (["Set up or resume Stripe","Check connection","Reconnect","Check provider identity"])
- PASS: after a Revoke, Finish setup again needs the owner's Approve (["Continue"])
- PASS: a waiting Finish setup keeps its Approve link on reload (["Continue"])
- PASS: another business's owner cannot approve it: Continue still waits, no key (303 /account/connect?connection_id=da14f105-fb6e-4feb-aecc-55bcf7cb7b39&error=ownership_conflict)

## 6. Upgrade: a store connected with the released plugin keeps working
- PASS: the released plugin (main) connected with the owner's Approve
- PASS: after the upgrade the same storage loads ready, with the same key (["Set up or resume Stripe","Check connection","Reconnect","Check provider identity"])
- PASS: the upgraded page shows the connected-to line and no Finish setup
- PASS: uninstalling the upgraded plugin cancels the key the released plugin saved
- PASS: and leaves that store's Commerce key working

All checks passed.
