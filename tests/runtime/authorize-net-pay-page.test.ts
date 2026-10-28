import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import worker from "../../src/cloudflare/worker";

const attemptId = "attempt-one";
const secret = "0123456789abcdef0123456789abcdef";
const sessionId = `${secret}.${attemptId}`;

function configuredEnv(provider = "authorize_net") {
  return {
    ...env,
    ACCOUNT_ISSUER: "https://accounts.example.invalid",
    ACCOUNT_AUDIENCE: "payments-runtime",
    ACCOUNT_JWKS_URL: "https://accounts.example.invalid/jwks",
    PAYMENT_PROVIDER: provider,
  };
}

async function seed(siteId: string, record: Record<string, unknown>) {
  const stub = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", siteId]));
  await runInDurableObject(stub, instance => {
    (instance as { ctx: { storage: { sql: { exec: (query: string, ...binds: unknown[]) => void } } } }).ctx.storage.sql.exec(
      "INSERT INTO authorize_net_attempts (attempt_id,value) VALUES (?,?)", attemptId, JSON.stringify(record),
    );
  });
}

test("the Worker serves a stored checkout's pay page by its session and nothing else", async () => {
  const siteId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await seed(siteId, {
    token: "stored-token", transactionId: null, createdAt: now, expiresAt: now + 1860, bindingRef: "binding_runtime", siteId,
    amountMinor: "1200", currency: "USD", sessionId, redirectUrl: `https://payments.example.invalid/v1/pay/authorize-net/${siteId}/${sessionId}`,
    tokenAt: now, returnUrl: "https://store.example/checkout/success", cancelUrl: "https://store.example/checkout",
  });
  const page = await worker.fetch(new Request(`https://payments.example.invalid/v1/pay/authorize-net/${siteId}/${sessionId}`), configuredEnv());
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-store");
  const html = await page.text();
  expect(html).toContain('<form method="post" action="https://test.authorize.net/payment/payment">');
  expect(html).toContain('name="token" value="stored-token"');

  const wrongSecret = await worker.fetch(new Request(`https://payments.example.invalid/v1/pay/authorize-net/${siteId}/${"f".repeat(32)}.${attemptId}`), configuredEnv());
  expect(wrongSecret.status).toBe(404);
  const otherSite = await worker.fetch(new Request(`https://payments.example.invalid/v1/pay/authorize-net/${crypto.randomUUID()}/${sessionId}`), configuredEnv());
  expect(otherSite.status).toBe(404);
  const stripeService = await worker.fetch(new Request(`https://payments.example.invalid/v1/pay/authorize-net/${siteId}/${sessionId}`), configuredEnv("stripe"));
  expect(stripeService.status).toBe(404);
});
