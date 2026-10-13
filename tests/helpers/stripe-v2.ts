export function stripeV2Account(id = "acct_fixture", ready = true) {
  return { object: "v2.core.account", id, livemode: false, applied_configurations: ["merchant"],
    configuration: { merchant: { applied: true, capabilities: { card_payments: { status: ready ? "active" : "pending" }, stripe_balance: { payouts: { status: ready ? "active" : "pending" } } } } },
    requirements: { entries: [] } };
}
export function stripeV2Link(id = "acct_fixture") {
  return { object: "v2.core.account_link", account: id, livemode: false,
    url: `https://accounts.stripe.com/r/${id}#alu_test_synthetic`, expires_at: new Date(Date.now() + 600_000).toISOString() };
}
