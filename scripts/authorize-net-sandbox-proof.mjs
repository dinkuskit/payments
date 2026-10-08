#!/usr/bin/env node
import {
  AUTHORIZE_NET_SANDBOX_URL,
  authorizeNetEndpoints,
  buildAuthorizeNetInvoiceReference,
  createAuthorizeNetGateway,
  transactionOutcome,
} from "../src/authorize-net/checkout.ts";
import { createAuthorizeNetWebhookHandler } from "../src/authorize-net/webhook.ts";

const credentialNames = {
  apiLoginId: "AUTHNET_SANDBOX_API_LOGIN_ID",
  transactionKey: "AUTHNET_SANDBOX_TRANSACTION_KEY",
  signatureKey: "AUTHNET_SANDBOX_SIGNATURE_KEY",
};
const credentials = Object.fromEntries(Object.entries(credentialNames).map(([key, name]) => [key, process.env[name]]));
const missing = Object.values(credentialNames).filter(name => !process.env[name]);
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
  } catch (error) {
    const diagnostic = error?.providerDiagnostic;
    if (diagnostic) {
      console.log(`${name}: FAIL resultCode=${diagnostic.resultCode ?? "unknown"} code=${diagnostic.code ?? "unknown"} text=${diagnostic.text ?? "unknown"}`);
    } else {
      console.log(`${name}: FAIL`);
    }
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
    name: credentials.apiLoginId,
    transactionKey: credentials.transactionKey,
  };
}

async function post(body) {
  const response = await fetch(endpoints.api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("sandbox_transport");
  const bodyValue = await response.json();
  if (bodyValue.messages?.resultCode === "Error") {
    const message = Array.isArray(bodyValue.messages.message) ? bodyValue.messages.message[0] : null;
    throw Object.assign(new Error("sandbox_request_rejected"), {
      providerDiagnostic: {
        resultCode: bodyValue.messages.resultCode,
        code: message?.code ?? null,
        text: message?.text ?? null,
      },
    });
  }
  return bodyValue;
}

async function authenticateTestRequest() {
  const body = await post({
    authenticateTestRequest: { merchantAuthentication: merchantAuthentication() },
  });
  if (body.messages?.resultCode !== "Ok") throw new Error("sandbox_authentication_failed");
}

let transactionId;
const proofSiteId = "sandbox-proof-site";
const proofAttemptId = `p${String(Date.now()).slice(-10)}`;
const invoiceNumber = await buildAuthorizeNetInvoiceReference(proofSiteId, proofAttemptId);

await check("authenticateTestRequest", authenticateTestRequest);

const gateway = createAuthorizeNetGateway({
  apiLoginId: credentials.apiLoginId,
  transactionKey: credentials.transactionKey,
  merchantCurrency: "USD",
  mode,
});

await check("Accept Hosted token", async () => {
  const result = await gateway.createHostedPayment({
    attemptId: proofAttemptId,
    siteId: proofSiteId,
    total: { currency: "USD", minor: "100" },
    returnUrl: "https://example.com/checkout/success",
    cancelUrl: "https://example.com/checkout/cancel",
  });
  if (!result.token) throw new Error("missing_hosted_token");
  if (result.identity !== invoiceNumber) throw new Error("invoice_reference_mismatch");
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
  const notificationId = `proof-${Date.now()}`;
  const body = new TextEncoder().encode(JSON.stringify({
    notificationId,
    eventType: "net.authorize.payment.authcapture.created",
  }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(credentials.signatureKey),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const digest = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, body))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const handler = createAuthorizeNetWebhookHandler({
    signatureKey: credentials.signatureKey,
    seenEventIds: new Set(),
    wake: async () => {},
  });
  await handler(body, `sha512=${digest}`, notificationId);
  await assertRejects(() => handler(body, `sha512=${digest}`, "sandbox-proof-mismatch"));
  const tampered = new Uint8Array(body);
  tampered[0] ^= 1;
  await assertRejects(() => handler(tampered, `sha512=${digest}`, notificationId));
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
