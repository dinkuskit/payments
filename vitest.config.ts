import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      STRIPE_API_KEY: "sk_test_synthetic_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_synthetic_fixture",
      ONBOARDING_RETURN_URL: "https://accounts.example.invalid/stripe/return",
      ONBOARDING_REFRESH_URL: "https://accounts.example.invalid/stripe/refresh",
      CHECKOUT_SUCCESS_URL: "https://store.example.invalid/checkout/return",
      CHECKOUT_CANCEL_URL: "https://store.example.invalid/checkout/cancel",
    } },
  })],
  test: { include: ["tests/runtime/*.test.ts"], maxWorkers: 1 },
});
