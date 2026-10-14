import { runInDurableObject } from "cloudflare:test";
import type { PaymentConnection } from "../../src/cloudflare/worker.js";
export async function configureStripeCountry(stub: DurableObjectStub<PaymentConnection>, siteId: string) {
  await runInDurableObject(stub, instance => {
    (instance as unknown as { env: { STRIPE_TEST_MERCHANT_COUNTRY_CONFIG?: string } }).env.STRIPE_TEST_MERCHANT_COUNTRY_CONFIG = JSON.stringify({siteId, country:"GB"});
  });
}
