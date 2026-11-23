#!/usr/bin/env node
// Two-tab sandbox proof for payments-authorize-net-paid-twice-044 (deepsec finding G1-04). Real network I/O to
// apitest.authorize.net with the sandbox login; a person pays with Authorize.net's published sandbox test card
// in a browser. Prints no credential or token.
//
// A: two tabs open one checkout's pay page at once. Both must get the same card form; paying in both shows whether
//    Authorize.net takes a second payment on one form.
// B: the old behavior, two different card forms for one checkout. Paying in both shows whether a second payment
//    can go through, and that Payments then reports the checkout as paid twice with both transaction numbers.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  AUTHORIZE_NET_SANDBOX_URL,
  authorizeNetEndpoints,
  buildAuthorizeNetInvoiceReference,
  createAuthorizeNetFetchTransport,
  createAuthorizeNetGateway,
  createAuthorizeNetPaymentPort,
} from "../src/authorize-net/checkout.ts";
import { createHostedHandler } from "../src/hosted/http.ts";
import { authorizeNetPayPagePath } from "../src/hosted/manifest.ts";

if (process.argv[2] !== "--run") {
  console.log("two-tab-proof: DRY-RUN PASS (not run; pass --run to contact the sandbox)");
  process.exit(0);
}
const endpoints = authorizeNetEndpoints("test");
if (endpoints.api !== AUTHORIZE_NET_SANDBOX_URL || new URL(endpoints.hosted).host !== "test.authorize.net") {
  console.log("sandbox target: FAIL");
  process.exit(1);
}
const apiLoginId = process.env.AUTHNET_SANDBOX_API_LOGIN_ID;
const transactionKey = process.env.AUTHNET_SANDBOX_TRANSACTION_KEY;
if (!apiLoginId || !transactionKey) {
  console.log("sandbox credentials: FAIL (missing)");
  process.exit(1);
}
console.log("sandbox target: PASS");

const transport = createAuthorizeNetFetchTransport({ endpoint: endpoints.api });
const gateway = createAuthorizeNetGateway({ apiLoginId, transactionKey, merchantCurrency: "USD", mode: "test", transport });
const records = new Map();
const store = { transaction: fn => fn({ read: id => structuredClone(records.get(id) ?? null), write: (id, value) => records.set(id, structuredClone(value)) }) };
let offsetMs = 0;
const paidTwice = [];
const siteId = "two-tab-proof";
const origin = "https://payments.proof.invalid";
const port = createAuthorizeNetPaymentPort({
  gateway, siteId, hostedUrl: endpoints.hosted, store, now: () => Date.now() + offsetMs,
  returnUrl: "https://example.com/checkout/success", cancelUrl: "https://example.com/checkout",
  payPageUrl: `${origin}${authorizeNetPayPagePath(siteId)}`,
  paidTwice: (attemptId, record) => paidTwice.push({ attemptId, ids: [record.paidId, ...(record.alsoPaid ?? [])] }),
});
const handle = createHostedHandler({
  authenticate: async () => { throw new Error("no pass on the pay page"); },
  service: () => { throw new Error("unused"); },
  authorizeNetPayPage: (_siteId, sessionId) => port.payPage(sessionId),
});
const visit = sessionId => handle(new Request(`${origin}${authorizeNetPayPagePath(siteId)}/${sessionId}`)).then(response => response.text());
const tokenOf = html => /name="token" value="([^"]+)"/.exec(html)?.[1];
const ask = createInterface({ input: process.stdin, output: process.stdout });

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${name}: ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}

async function open(label, minor) {
  const request = {
    attemptId: `${label}${String(Date.now()).slice(-9)}`, bindingRef: "proof-binding", lines: [], total: { currency: "USD", minor },
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 }, paymentMethods: ["card"],
  };
  const opened = await port.ensureSession(request);
  if (opened.outcome !== "open") {
    report(`checkout ${label} opened in the sandbox`, false, opened.outcome);
    process.exit(1);
  }
  return { request, sessionId: opened.session.sessionId, invoice: await buildAuthorizeNetInvoiceReference(siteId, request.attemptId) };
}

/** Every sandbox transaction for one checkout, read from Authorize.net's own unsettled list. */
async function triesFor(invoice) {
  const body = await transport.request({ getUnsettledTransactionListRequest: {
    merchantAuthentication: { name: apiLoginId, transactionKey },
    sorting: { orderBy: "submitTimeUTC", orderDescending: false },
    paging: { limit: 1000, offset: 1 },
  } });
  const list = Array.isArray(body?.transactions) ? body.transactions : [];
  return list.filter(row => row?.invoiceNumber === invoice).map(row => ({ id: String(row.transId), status: row.transactionStatus }));
}

async function settle(label, checkout) {
  const tries = await triesFor(checkout.invoice);
  console.log(`checkout ${label} tries at Authorize.net: ${tries.map(t => `${t.id} ${t.status}`).join(", ") || "none"}`);
  for (const t of tries) port.recordTransaction(checkout.request.attemptId, t.id);
  const outcome = await port.lookup(checkout.request);
  const record = records.get(checkout.request.attemptId);
  return { tries, outcome, paid: record?.paidId ? [record.paidId, ...(record.alsoPaid ?? [])] : [] };
}

// Any ZIP but 46282 and 462xx: Authorize.net's sandbox declines 46282 and uses 462xx for AVS answers.
const card = "card 4111 1111 1111 1111, expiry 12/30, CVV 123, any name, 1 Test Street, Bellevue, WA, ZIP 98004, phone 425 555 0100";

// A: one card form per checkout.
const a = await open("a", String(100 + Math.floor(Math.random() * 90)));
const [tab1, tab2] = await Promise.all([visit(a.sessionId), visit(a.sessionId)]);
report("A: two tabs opened at once get the same card form", Boolean(tokenOf(tab1)) && tokenOf(tab1) === tokenOf(tab2));
writeFileSync("two-tab-A.html", tab1);
console.log(`\nA: open two-tab-A.html in TWO browser tabs. In tab 1 pay with the sandbox ${card}.`);
console.log("   Then in tab 2 pay the same way. Note what each tab shows.");
await ask.question("   Press Return here when both tabs show a result. ");
const resultA = await settle("A", a);
report("A: the checkout is paid", resultA.outcome.outcome === "paid", resultA.outcome.outcome);
report("A: one card form took one payment", resultA.paid.length === 1, `paid: ${resultA.paid.join(", ") || "none"}`);

// B: two different card forms for one checkout, as before this change.
const b = await open("b", String(100 + Math.floor(Math.random() * 90)));
const formB1 = await visit(b.sessionId);
// Move this run's clock past the form's 15 minutes so the next visit mints a second form. Both forms stay usable
// at Authorize.net, which counts real time.
offsetMs = 16 * 60_000;
const formB2 = await visit(b.sessionId);
report("B: two card forms for one checkout", Boolean(tokenOf(formB1)) && Boolean(tokenOf(formB2)) && tokenOf(formB1) !== tokenOf(formB2));
writeFileSync("two-tab-B-1.html", formB1);
writeFileSync("two-tab-B-2.html", formB2);
console.log(`\nB: open two-tab-B-1.html in one tab and two-tab-B-2.html in another. Pay in both with the sandbox ${card}.`);
await ask.question("   Press Return here when both tabs show a result. ");
offsetMs = 0;
const resultB = await settle("B", b);
const paidB = resultB.tries.length;
console.log(`B: Authorize.net took ${resultB.paid.length} payment(s) for one checkout from ${paidB} tr${paidB === 1 ? "y" : "ies"}`);
if (resultB.paid.length > 1) {
  report("B: Payments reports the checkout as paid twice, counting the first", resultB.outcome.paymentId === resultB.paid[0] &&
    paidTwice.some(notice => notice.attemptId === b.request.attemptId && notice.ids.join() === resultB.paid.join()), `paid: ${resultB.paid.join(", ")}`);
} else {
  report("B: the checkout is paid once", resultB.outcome.outcome === "paid" && resultB.paid.length === 1, `paid: ${resultB.paid.join(", ") || "none"}`);
}
ask.close();
process.exitCode = failed ? 1 : 0;
