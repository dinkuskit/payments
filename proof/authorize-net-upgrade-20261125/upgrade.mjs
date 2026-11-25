// Records written by an older Payments, then read by this branch's code.
// Usage: node --import tsx proof/authorize-net-upgrade-20261125/upgrade.mjs <old checkout.ts> <new checkout.ts>
const [oldPath, newPath] = process.argv.slice(2);
const Old = await import(oldPath), New = await import(newPath);
const siteId = "store-a";
const payment = (attemptId) => ({
  attemptId, bindingRef: "bind-one",
  lines: [{ catalogItemId: "sku", quantity: 1, name: "Item", unitPrice: { currency: "USD", minor: "1200" } }],
  total: { currency: "USD", minor: "1200" }, paymentWindow: { minSeconds: 1800, maxSeconds: 1860 }, paymentMethods: ["card"],
});
const paidTry = { responseCode: 1, transactionStatus: "settledSuccessfully", authAmount: "12.00", settleAmount: "12.00" };
const declinedTry = { responseCode: 2, transactionStatus: "declined", authAmount: "12.00", settleAmount: "12.00" };
const records = new Map(), transactions = {}, state = { clock: 1_800_000_000_000, reads: [], mints: 0 };
function port(M) {
  const gateway = M.createAuthorizeNetGateway({ apiLoginId: "synthetic-login", transactionKey: "synthetic-transaction-key", merchantCurrency: "USD", mode: "test",
    transport: { request: async body => {
      if (body.getTransactionDetailsRequest) {
        const id = body.getTransactionDetailsRequest.transId; state.reads.push(id);
        const found = transactions[id]; if (!found) throw new Error("provider timeout");
        const invoiceNumber = await M.buildAuthorizeNetInvoiceReference(siteId, found.attemptId);
        return { messages: { resultCode: "Ok" }, transaction: { order: { invoiceNumber }, ...found.body, transId: id } };
      }
      state.mints += 1; return { messages: { resultCode: "Ok" }, token: `token-${state.mints}` };
    } } });
  return M.createAuthorizeNetPaymentPort({ gateway, siteId, hostedUrl: M.AUTHORIZE_NET_HOSTED_SANDBOX_URL,
    returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout",
    payPageUrl: "https://payments.example/v1/pay/authorize-net/store-a", now: () => state.clock, paidTwice: () => {},
    store: { transaction: fn => fn({ read: id => structuredClone(records.get(id) ?? null), write: (id, v) => records.set(id, structuredClone(JSON.parse(JSON.stringify(v)))) }) } });
}
const say = (...a) => console.log(...a);
const old = port(Old);
// A: a checkout with one declined try, written by the old code.
const a = await old.ensureSession(payment("attempt-a"));
transactions["201"] = { attemptId: "attempt-a", body: declinedTry }; old.recordTransaction("attempt-a", "201");
// B: a checkout whose paid try was noted but not yet looked up.
const b = await old.ensureSession(payment("attempt-b"));
transactions["301"] = { attemptId: "attempt-b", body: paidTry }; old.recordTransaction("attempt-b", "301");
// C (main only): a paid checkout that then took 21 more payments.
const many = typeof old.checkLateTry === "function";
if (many) {
  await old.ensureSession(payment("attempt-c"));
  transactions["400"] = { attemptId: "attempt-c", body: paidTry }; old.recordTransaction("attempt-c", "400");
  await old.lookup(payment("attempt-c"));
  for (let id = 401; id <= 421; id++) { transactions[id] = { attemptId: "attempt-c", body: paidTry }; old.recordTransaction("attempt-c", String(id)); await old.checkLateTry("attempt-c", String(id)).catch(() => {}); }
  say("old code, C: alsoPaid", records.get("attempt-c").alsoPaid.length, "| openTries", JSON.stringify(old.openTries("attempt-c")), "| recheck", await old.recheck("attempt-c"));
}
say("stored by old code:", [...records.keys()].join(", "), "| record keys of A:", Object.keys(records.get("attempt-a")).sort().join(","));
// Upgrade: the same stored records, read by this branch.
const next = port(New);
const pageA = await next.payPage(a.session.sessionId);
say("new code, A pay page:", pageA.action, pageA.action === "post" ? "(card form)" : pageA.url);
const lookB = await next.lookup(payment("attempt-b"));
say("new code, B lookup:", lookB.outcome, lookB.paymentId);
const pageB = await next.payPage(b.session.sessionId);
say("new code, B pay page:", pageB.action, pageB.url ?? "");
if (many) {
  const before = state.reads.length;
  const done = await next.recheck("attempt-c");
  const c = records.get("attempt-c");
  say("new code, C recheck:", done, "| openTries", JSON.stringify(next.openTries("attempt-c")), "| paidId", c.paidId, "| alsoPaid", c.alsoPaid.length, "| provider reads during recheck", state.reads.length - before);
  const again = state.reads.length; await next.recheck("attempt-c");
  say("new code, C second recheck reads:", state.reads.length - again);
}
