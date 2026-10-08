#!/usr/bin/env node
import { createAuthorizeNetGateway } from "../src/authorize-net/checkout.ts";

const required = [
  "AUTHORIZE_NET_API_LOGIN_ID",
  "AUTHORIZE_NET_TRANSACTION_KEY",
  "AUTHORIZE_NET_SIGNATURE_KEY",
];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  console.error(`sandbox proof not run; missing ${missing.join(", ")}`);
  process.exitCode = 2;
} else if (process.argv[2] !== "--run") {
  console.log("sandbox proof is ready; pass --run to contact the Authorize.net sandbox");
} else {
  const gateway = createAuthorizeNetGateway({
    apiLoginId: process.env.AUTHORIZE_NET_API_LOGIN_ID,
    transactionKey: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
    mode: "test",
  });
  await gateway.createHostedPayment({
    attemptId: `proof-${Date.now()}`,
    total: { currency: "USD", minor: "100" },
    returnUrl: "https://sandbox-proof.example.invalid/return",
    cancelUrl: "https://sandbox-proof.example.invalid/cancel",
  });
  console.log("sandbox hosted-page request completed; token intentionally withheld");
}
