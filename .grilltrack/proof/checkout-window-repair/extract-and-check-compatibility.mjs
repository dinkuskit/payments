import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const rootDir = process.cwd();
const commerceDir = path.join(rootDir, ".grilltrack/work/checkout-sessions-20260930/commerce37-merged");
const outputDir = path.join(rootDir, ".grilltrack/work/checkout-sessions-20260930/compatibility");

fs.mkdirSync(outputDir, { recursive: true });

// 1. Verify exact source byte identities from commerce37-merged
const catalogTypesPath = path.join(commerceDir, "src/features/catalog/types.ts");
const checkoutTypesPath = path.join(commerceDir, "src/features/checkout/types.ts");

const expectedCatalogHash = "36198666a0f585caa02a290e319441d6be7b1a8234e03d09f7e072f5bc592784";
const expectedCheckoutHash = "aa77fb9b861e190f9cb23d511dcc27cd90984827eaba78435b2aeb9eaaefa687";

const catalogBytes = fs.readFileSync(catalogTypesPath);
const checkoutBytes = fs.readFileSync(checkoutTypesPath);

const actualCatalogHash = crypto.createHash("sha256").update(catalogBytes).digest("hex");
const actualCheckoutHash = crypto.createHash("sha256").update(checkoutBytes).digest("hex");

if (actualCatalogHash !== expectedCatalogHash) {
  throw new Error(`Catalog types hash mismatch: ${actualCatalogHash} !== ${expectedCatalogHash}`);
}
if (actualCheckoutHash !== expectedCheckoutHash) {
  throw new Error(`Checkout types hash mismatch: ${actualCheckoutHash} !== ${expectedCheckoutHash}`);
}

console.log("Verified input Commerce 37 source hashes match identity.json:");
console.log(`- catalog/types.ts: ${actualCatalogHash}`);
console.log(`- checkout/types.ts: ${actualCheckoutHash}`);

// 2. Extract narrow standalone types from the exact bytes
const catalogContent = catalogBytes.toString("utf8");
const checkoutContent = checkoutBytes.toString("utf8");

// Extract COMMERCE_CURRENCY_USD and Money from catalog/types.ts
const usdMatch = catalogContent.match(/export const COMMERCE_CURRENCY_USD = "USD" as const;/);
if (!usdMatch) throw new Error("Could not extract COMMERCE_CURRENCY_USD");

const moneyMatch = catalogContent.match(/export interface Money \{\n  currency: typeof COMMERCE_CURRENCY_USD;\n  minor: string;\n\}/);
if (!moneyMatch) throw new Error("Could not extract Money");

// Extract CartLine, CheckoutLine, and window/request/session/outcome/port from checkout/types.ts
const cartLineMatch = checkoutContent.match(/export interface CartLine \{ catalogItemId: string; quantity: number \}/);
const checkoutLineMatch = checkoutContent.match(/export interface CheckoutLine extends CartLine \{ name: string; unitPrice: Money \}/);

const windowBlockMatch = checkoutContent.match(
  /export const CURRENT_PAYMENT_WINDOW_MIN_SECONDS = 1800;[\s\S]*?lookup\(request: PaymentRequest\): Promise<PaymentOutcome>;\n\}/
);
if (!cartLineMatch || !checkoutLineMatch || !windowBlockMatch) {
  throw new Error("Could not extract checkout types block");
}

const extractedModuleContent = `/**
 * Standalone extracted public types module from Commerce PR 37 (commit ab37cd7f362f1c37cb1d321192abbbc48a623833).
 * Extracted exclusively from exact bytes of:
 * - src/features/catalog/types.ts (SHA256: ${actualCatalogHash})
 * - src/features/checkout/types.ts (SHA256: ${actualCheckoutHash})
 *
 * Contains only Money/USD, CartLine/CheckoutLine, and current/legacy/window/request/session/outcome/CheckoutPaymentPort.
 * No unrelated domain types or import closures included.
 */

${usdMatch[0]}

${moneyMatch[0]}

${cartLineMatch[0]}
${checkoutLineMatch[0]}

${windowBlockMatch[0]}
`;

const extractedModulePath = path.join(outputDir, "commerce-extracted-types.ts");
fs.writeFileSync(extractedModulePath, extractedModuleContent);
console.log(`Wrote extracted module: ${extractedModulePath}`);

// 3. Construct bidirectional assignability check module
const checkAssignabilityContent = `import type * as Commerce from "./commerce-extracted-types.js";
import type * as Payments from "../../../../src/commerce/checkout-port.js";

// Compile-time bidirectional type equivalence helpers
type Mutual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
type Check<T extends true> = T;

// Bidirectional checks for all public types
export type CheckUSD = Check<Mutual<typeof Commerce.COMMERCE_CURRENCY_USD, typeof Payments.COMMERCE_CURRENCY_USD>>;
export type CheckMoney = Check<Mutual<Commerce.Money, Payments.Money>>;
export type CheckCartLine = Check<Mutual<Commerce.CartLine, Payments.CartLine>>;
export type CheckCheckoutLine = Check<Mutual<Commerce.CheckoutLine, Payments.CheckoutLine>>;
export type CheckCurrentPaymentWindow = Check<Mutual<Commerce.CurrentPaymentWindow, Payments.CurrentPaymentWindow>>;
export type CheckPaymentWindowPolicyKind = Check<Mutual<Commerce.PaymentWindowPolicyKind, Payments.PaymentWindowPolicyKind>>;
export type CheckPaymentWindowBounds = Check<Mutual<Commerce.PaymentWindowBounds, Payments.PaymentWindowBounds>>;
export type CheckCurrentPaymentRequest = Check<Mutual<Commerce.CurrentPaymentRequest, Payments.CurrentPaymentRequest>>;
export type CheckLegacyExact1800PaymentRequest = Check<Mutual<Commerce.LegacyExact1800PaymentRequest, Payments.LegacyExact1800PaymentRequest>>;
export type CheckPaymentRequest = Check<Mutual<Commerce.PaymentRequest, Payments.PaymentRequest>>;
export type CheckPaymentRequestHandoff = Check<Mutual<Commerce.PaymentRequestHandoff, Payments.PaymentRequestHandoff>>;
export type CheckPaymentSession = Check<Mutual<Commerce.PaymentSession, Payments.PaymentSession>>;
export type CheckPaymentOutcome = Check<Mutual<Commerce.PaymentOutcome, Payments.PaymentOutcome>>;
export type CheckCheckoutPaymentPort = Check<Mutual<Commerce.CheckoutPaymentPort, Payments.CheckoutPaymentPort>>;

// Value-level bidirectional assignability proof
function bidirectionalAssignabilityProof(
  comPort: Commerce.CheckoutPaymentPort,
  payPort: Payments.CheckoutPaymentPort,
  comReq: Commerce.PaymentRequest,
  payReq: Payments.PaymentRequest,
  comOutcome: Commerce.PaymentOutcome,
  payOutcome: Payments.PaymentOutcome,
  comSession: Commerce.PaymentSession,
  paySession: Payments.PaymentSession,
) {
  // Commerce -> Payments
  const pPort: Payments.CheckoutPaymentPort = comPort;
  const pReq: Payments.PaymentRequest = comReq;
  const pOutcome: Payments.PaymentOutcome = comOutcome;
  const pSession: Payments.PaymentSession = comSession;

  // Payments -> Commerce
  const cPort: Commerce.CheckoutPaymentPort = payPort;
  const cReq: Commerce.PaymentRequest = payReq;
  const cOutcome: Commerce.PaymentOutcome = payOutcome;
  const cSession: Commerce.PaymentSession = paySession;

  return { pPort, pReq, pOutcome, pSession, cPort, cReq, cOutcome, cSession };
}
`;

const checkAssignabilityPath = path.join(outputDir, "check-assignability.ts");
fs.writeFileSync(checkAssignabilityPath, checkAssignabilityContent);
console.log(`Wrote assignability checker: ${checkAssignabilityPath}`);

// 4. Construct tsconfig for standalone typechecking
const tsconfigContent = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  files: [
    "commerce-extracted-types.ts",
    "check-assignability.ts",
  ],
}, null, 2);

const tsconfigPath = path.join(outputDir, "tsconfig.json");
fs.writeFileSync(tsconfigPath, tsconfigContent);

// 5. Typecheck with existing tsc
const logPath = path.join(outputDir, "typecheck.log");
try {
  const tscBin = path.join(rootDir, "node_modules/.bin/tsc");
  const stdout = execFileSync(tscBin, ["-p", tsconfigPath], { encoding: "utf8" });
  fs.writeFileSync(logPath, `TYPECHECK SUCCESSFUL:\n${stdout}\nEXIT CODE: 0\n`);
  console.log("TypeScript check passed with 0 errors! Log saved to typecheck.log");
} catch (error) {
  const errOutput = `${error.stdout || ""}\n${error.stderr || ""}\nEXIT CODE: ${error.status}\n`;
  fs.writeFileSync(logPath, errOutput);
  console.error("TypeScript check failed:", errOutput);
  process.exit(1);
}
