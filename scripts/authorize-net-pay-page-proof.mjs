#!/usr/bin/env node
// Sandbox proof for the Authorize.net pay page (payments-authorize-net-pay-page-045, issue #99). Real network
// I/O to apitest.authorize.net; every provider call is counted. Prints no credential, token or session secret.
import { writeFileSync } from "node:fs";
import {
  AUTHORIZE_NET_SANDBOX_URL,
  authorizeNetEndpoints,
  createAuthorizeNetFetchTransport,
  createAuthorizeNetGateway,
  createAuthorizeNetPaymentPort,
} from "../src/authorize-net/checkout.ts";
import { createHostedHandler } from "../src/hosted/http.ts";
import { authorizeNetPayPagePath } from "../src/hosted/manifest.ts";

if (process.argv[2] !== "--run") {
  console.log("pay-page-proof: DRY-RUN PASS (not run; pass --run to contact the sandbox)");
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

const providerCalls = [];
const real = createAuthorizeNetFetchTransport({ endpoint: endpoints.api });
const transport = { request: body => { providerCalls.push(Object.keys(body)[0]); return real.request(body); } };
const gateway = createAuthorizeNetGateway({ apiLoginId, transactionKey, merchantCurrency: "USD", mode: "test", transport });
const records = new Map();
const store = { transaction: fn => fn({ read: id => structuredClone(records.get(id) ?? null), write: (id, value) => records.set(id, structuredClone(value)) }) };
let offsetMs = 0;
const now = () => Date.now() + offsetMs;
const siteId = "pay-page-proof";
const origin = "https://payments.proof.invalid";
const portFor = portSiteId => createAuthorizeNetPaymentPort({
  gateway, siteId: portSiteId, hostedUrl: endpoints.hosted, store, now,
  returnUrl: "https://example.com/checkout/success", cancelUrl: "https://example.com/checkout",
  payPageUrl: `${origin}${authorizeNetPayPagePath(portSiteId)}`,
});
const handle = createHostedHandler({
  authenticate: async () => { throw new Error("no pass on the pay page"); },
  service: () => { throw new Error("unused"); },
  authorizeNetPayPage: (pageSiteId, sessionId) => portFor(pageSiteId).payPage(sessionId),
});

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${name}: ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}
const attemptId = `q${String(Date.now()).slice(-10)}`;
const opened = await portFor(siteId).ensureSession({
  attemptId, bindingRef: "proof-binding", lines: [], total: { currency: "USD", minor: "100" },
  paymentWindow: { minSeconds: 1800, maxSeconds: 1860 }, paymentMethods: ["card"],
});
report("checkout session from the sandbox", opened.outcome === "open" && providerCalls.length === 1,
  `calls=${providerCalls.length}; ${providerCalls.join(",")}`);
if (opened.outcome !== "open") process.exit(1);
const { sessionId, redirectUrl } = opened.session;
const [secret] = sessionId.split(".");
report("session is a pay page link without the token", redirectUrl === `${origin}${authorizeNetPayPagePath(siteId)}/${sessionId}` &&
  !redirectUrl.includes(records.get(attemptId).token));
const visit = path => handle(new Request(`${origin}${path}`));
const firstToken = records.get(attemptId).token;

let before = providerCalls.length;
const wrongSecret = await visit(`${authorizeNetPayPagePath(siteId)}/${secret.replace(/./, c => (c === "0" ? "1" : "0"))}.${attemptId}`);
report("wrong secret refused before any provider call", wrongSecret.status === 404 && providerCalls.length === before, `status=${wrongSecret.status}`);
const otherSite = await visit(`${authorizeNetPayPagePath("another-store")}/${sessionId}`);
report("other store's path refused before any provider call", otherSite.status === 404 && providerCalls.length === before, `status=${otherSite.status}`);

const fresh = await visit(`${authorizeNetPayPagePath(siteId)}/${sessionId}`);
const freshHtml = await fresh.text();
report("allowed visit posts the stored token, no new call", fresh.status === 200 && freshHtml.includes(`value="${firstToken}"`) &&
  providerCalls.length === before, `status=${fresh.status}`);

offsetMs = 11 * 60_000;
before = providerCalls.length;
const refreshed = await visit(`${authorizeNetPayPagePath(siteId)}/${sessionId}`);
const refreshedHtml = await refreshed.text();
const secondToken = records.get(attemptId).token;
report("allowed visit after 11 minutes mints a new sandbox token", refreshed.status === 200 && providerCalls.length === before + 1 &&
  providerCalls.at(-1) === "getHostedPaymentPageRequest" && secondToken !== firstToken && refreshedHtml.includes(`value="${secondToken}"`),
  `status=${refreshed.status}; calls=${providerCalls.length - before}`);
report("Commerce's session unchanged after the refresh",
  JSON.stringify((await portFor(siteId).ensureSession({ attemptId, bindingRef: "proof-binding", lines: [], total: { currency: "USD", minor: "100" },
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 }, paymentMethods: ["card"] })).session) === JSON.stringify(opened.session));
writeFileSync("pay-page-proof.html", refreshedHtml);
console.log("pay page saved: pay-page-proof.html (open it in a browser; it posts to test.authorize.net)");

offsetMs = 31 * 60_000;
before = providerCalls.length;
const expired = await visit(`${authorizeNetPayPagePath(siteId)}/${sessionId}`);
report("ended checkout sent back to the store before any provider call", expired.status === 303 &&
  expired.headers.get("location") === "https://example.com/checkout" && providerCalls.length === before, `status=${expired.status}`);
console.log(`provider calls in total: ${providerCalls.length} (${providerCalls.join(", ")})`);
process.exitCode = failed ? 1 : 0;
