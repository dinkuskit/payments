#!/usr/bin/env node
import {
  AUTHORIZE_NET_SANDBOX_URL,
  authorizeNetEndpoints,
  createAuthorizeNetGateway,
  transactionOutcome,
} from "../src/authorize-net/checkout.ts";
import { createAuthorizeNetWebhookHandler } from "../src/authorize-net/webhook.ts";

const required = [
  "AUTHORIZE_NET_API_LOGIN_ID",
  "AUTHORIZE_NET_TRANSACTION_KEY",
  "AUTHORIZE_NET_SIGNATURE_KEY",
];
const missing = required.filter(name => !process.env[name]);
const mode = "test";
const endpoints = authorizeNetEndpoints(mode);

if (process.argv[2] !== "--run") {
  console.log("sandbox-proof: DRY-RUN PASS (not run; pass --run to contact the sandbox)");
  process.exit(0);
}

const checks = [];
async function check(name, action) {
  try {
    await action();
    console.log(`${name}: PASS`);
    checks.push(true);
  } catch {
    console.log(`${name}: FAIL`);
    checks.push(false);
  }
}

function assertSandboxTarget() {
  if (mode !== "test" || endpoints.api !== AUTHORIZE_NET_SANDBOX_URL ||
      new URL(endpoints.api).host !== "apitest.authorize.net" ||
      new URL(endpoints.hosted).host !== "test.authorize.net") {
    throw new Error("sandbox_target_mismatch");
  }
}

try {
  assertSandboxTarget();
  if (missing.length) throw new Error("missing_credentials");
  console.log("sandbox target: PASS");
  checks.push(true);
} catch {
  console.log("sandbox target: FAIL");
  process.exitCode = 1;
  process.exit();
}

function merchantAuthentication() {
  return {
    name: process.env.AUTHORIZE_NET_API_LOGIN_ID,
    transactionKey: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
  };
}

async function post(body) {
  const response = await fetch(endpoints.api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("sandbox_transport");
  return response.json();
}

async function authenticateTestRequest() {
  const body = await post({
    authenticateTestRequest: { merchantAuthentication: merchantAuthentication() },
  });
  if (body.messages?.resultCode !== "Ok") throw new Error("sandbox_authentication_failed");
}

let transactionId;
const invoiceNumber = `proof${Date.now()}`.slice(-20);

await check("authenticateTestRequest", authenticateTestRequest);

const gateway = createAuthorizeNetGateway({
  apiLoginId: process.env.AUTHORIZE_NET_API_LOGIN_ID,
  transactionKey: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
  mode,
});

await check("Accept Hosted token", async () => {
  const result = await gateway.createHostedPayment({
    attemptId: invoiceNumber,
    total: { currency: "USD", minor: "100" },
    returnUrl: "https://sandbox-proof.example.invalid/return",
    cancelUrl: "https://sandbox-proof.example.invalid/cancel",
  });
  if (!result.token) throw new Error("missing_hosted_token");
});

await check("sandbox transaction and authoritative lookup", async () => {
  // This direct create is proof-only. The adapter remains Accept Hosted-only.
  const created = await post({
    createTransactionRequest: {
      merchantAuthentication: merchantAuthentication(),
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: "1.00",
        payment: {
          creditCard: {
            cardNumber: "4111111111111111",
            expirationDate: "2035-12",
            cardCode: "999",
          },
        },
        order: { invoiceNumber },
      },
    },
  });
  transactionId = created.transactionResponse?.transId;
  if (!/^[0-9]+$/.test(transactionId ?? "")) throw new Error("missing_transaction_id");
  const transaction = await gateway.getTransaction(transactionId);
  if (transactionOutcome(transaction, { minor: "100", currency: "USD" }) !== "paid") {
    throw new Error("transaction_not_paid");
  }
  if (transaction.amountMinor !== 100 || transaction.currency !== "USD") {
    throw new Error("transaction_amount_or_currency_mismatch");
  }
});

await check("webhook HMAC-SHA512", async () => {
  const body = new TextEncoder().encode(JSON.stringify({
    notificationId: `proof-${Date.now()}`,
    eventType: "net.authorize.payment.authcapture.created",
  }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(process.env.AUTHORIZE_NET_SIGNATURE_KEY),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const digest = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, body))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const handler = createAuthorizeNetWebhookHandler({
    signatureKey: process.env.AUTHORIZE_NET_SIGNATURE_KEY,
    seenEventIds: new Set(),
    wake: async () => {},
  });
  await handler(body, `sha512=${digest}`, "sandbox-proof-webhook");
  const tampered = new Uint8Array(body);
  tampered[0] ^= 1;
  await assertRejects(() => handler(tampered, `sha512=${digest}`, "sandbox-proof-tampered"));
});

if (transactionId) console.log(`transaction-id: ${transactionId}`);
if (checks.some(value => !value)) process.exitCode = 1;

async function assertRejects(action) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error("expected_rejection");
}
