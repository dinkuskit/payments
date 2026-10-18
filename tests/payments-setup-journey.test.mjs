import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createPaymentsPlugin } from "../src/plugin.ts";
import {
  REGISTRY_CONNECT_URL,
  REGISTRY_ISSUER,
  REGISTRY_SCOPE,
} from "../src/registry/connection.ts";
import {
  BETA_INSTALLED_PLUGIN_ID,
  BETA_REGISTRY_SLUG,
  PAYMENTS_SETUP_JOURNEY,
  STABLE_INSTALLED_PLUGIN_ID,
  STABLE_REGISTRY_SLUG,
  inspectPaymentsSetupScreen,
  resolvePaymentsSetupTarget,
  runPaymentsSetupJourney,
} from "../src/registry/manifest.ts";

function createMemoryStore() {
  const values = new Map();
  let revision = 0;
  const access = (prefix) => ({
    async get(key) {
      return values.get(prefix + key)?.value ?? null;
    },
    async getVersioned(key) {
      return values.get(prefix + key) ?? null;
    },
    async compareAndSet(key, expected, value) {
      if ((values.get(prefix + key)?.revision ?? null) !== expected) {
        return { applied: false };
      }
      values.set(prefix + key, {
        value: structuredClone(value),
        revision: String(++revision),
      });
      return { applied: true };
    },
    async compareAndDelete(key, expected) {
      if (values.get(prefix + key)?.revision !== expected) {
        return { applied: false };
      }
      values.delete(prefix + key);
      return { applied: true };
    },
  });
  return { kv: access("kv:"), settings: access("secret:"), values };
}

test("resolvePaymentsSetupTarget resolves both stable and beta Registry installations and rejects unknown IDs", () => {
  assert.equal(PAYMENTS_SETUP_JOURNEY.tag, "@running");
  assert.deepEqual(PAYMENTS_SETUP_JOURNEY.acceptedInstalledPluginIds, [
    "r_3brsc2on3bu673rn",
    "r_sffx6l4z6mpqliki",
  ]);

  const betaTarget = resolvePaymentsSetupTarget("https://beta-store.example", BETA_REGISTRY_SLUG);
  assert.equal(betaTarget.slug, "dinkus-payments-beta");
  assert.equal(betaTarget.installedPluginId, "r_sffx6l4z6mpqliki");
  assert.equal(
    betaTarget.statusUrl,
    "https://beta-store.example/_emdash/admin/plugins/r_sffx6l4z6mpqliki/status",
  );
  assert.equal(
    betaTarget.proofUrl,
    "https://beta-store.example/_emdash/api/plugins/r_sffx6l4z6mpqliki/store-proof",
  );

  const stableTarget = resolvePaymentsSetupTarget(
    "https://store.example",
    STABLE_INSTALLED_PLUGIN_ID,
  );
  assert.equal(stableTarget.slug, STABLE_REGISTRY_SLUG);
  assert.equal(stableTarget.installedPluginId, "r_3brsc2on3bu673rn");
  assert.equal(
    stableTarget.statusUrl,
    "https://store.example/_emdash/admin/plugins/r_3brsc2on3bu673rn/status",
  );

  assert.throws(
    () => resolvePaymentsSetupTarget("https://store.example", "r_untrustedpluginid"),
    /Unsupported Payments Registry plugin/,
  );
});

test("runPaymentsSetupJourney completes Connect -> Authorize -> Continue -> Check connection -> Connected: Stripe test mode for both stable and beta plugin IDs", async () => {
  for (const pluginId of [STABLE_INSTALLED_PLUGIN_ID, BETA_INSTALLED_PLUGIN_ID]) {
    const storeOrigin = "https://beta-store.example";
    const store = createMemoryStore();
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "journey-key", alg: "ES256" };
    let approved = false;
    let challenge = "";

    const plugin = createPaymentsPlugin({
      endpoint: { status: "https://payments.dinkuskit.com/v1/status" },
    });

    const ctx = {
      ...store,
      site: { url: storeOrigin },
      plugin: { id: pluginId, version: "0.2.9-beta.1" },
      http: {
        async fetch(url, init) {
          if (url === REGISTRY_CONNECT_URL) {
            const body = JSON.parse(init.body);
            assert.equal(
              body.callback_uri,
              `${storeOrigin}/_emdash/admin/plugins/${pluginId}/status`,
            );
            challenge = body.code_challenge;
            return Response.json({
              protocol_version: 2,
              site_id: "beta-site",
              connection_id: `conn-${pluginId}`,
              challenge: "public-challenge",
              expires_at: Date.now() + 590_000,
              expires_in: 600,
              interval: 1,
              verification_uri: `https://dinkuskit.com/account/connect?connection_id=conn-${pluginId}`,
            });
          }
          if (url.endsWith("/token")) {
            assert.equal(approved, true, "DinkusKit consent must occur before Continue");
            const body = JSON.parse(init.body);
            const digest = Buffer.from(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier)),
            ).toString("base64url");
            assert.equal(digest, challenge);
            const token = await new SignJWT({
              site_id: "beta-site",
              scope: REGISTRY_SCOPE,
            })
              .setProtectedHeader({ alg: "ES256", kid: "journey-key" })
              .setIssuer(REGISTRY_ISSUER)
              .setAudience("dinkus-payments")
              .setSubject("org-beta")
              .setIssuedAt(Math.floor(Date.now() / 1000))
              .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
              .sign(privateKey);
            return Response.json({
              access_token: token,
              token_type: "Bearer",
              site_id: "beta-site",
              expires_in: 300,
            });
          }
          if (url.endsWith("/jwks.json")) {
            return Response.json({ keys: [jwk] });
          }
          if (url === "https://payments.dinkuskit.com/v1/status") {
            return Response.json({
              state: "ready",
              mode: "test",
              bindingRef: "binding-beta",
              connectionEvidence: {
                provider: "stripe",
                mode: "test",
                result: "verified",
                accountRef: "acct_synthetic",
              },
            });
          }
          throw new Error(`Unexpected URL in setup journey test: ${url}`);
        },
      },
    };

    const user = { id: "admin-1" };
    const invokeAdmin = async (input) =>
      plugin.routes.admin.handler({ user, input }, ctx);

    const result = await runPaymentsSetupJourney({
      storeOrigin,
      pluginIdOrSlug: pluginId,
      driver: {
        loadStatusPage: () => invokeAdmin({ type: "page_load", page: "/status" }),
        clickAction: (actionId) => invokeAdmin({ type: "block_action", action_id: actionId }),
        authorizeAtDinkusKit: async (verificationUrl) => {
          assert.equal(
            verificationUrl,
            `https://dinkuskit.com/account/connect?connection_id=conn-${pluginId}`,
          );
          const proofRes = await plugin.routes["store-proof"].handler(
            { input: { connection_id: `conn-${pluginId}` } },
            ctx,
          );
          assert.equal(proofRes.status, 200);
          const controlEntry = await store.kv.getVersioned("state:registry-v2-control");
          await store.kv.compareAndSet("state:registry-v2-control", controlEntry.revision, {
            ...controlEntry.value,
            nextPollAt: 0,
          });
          approved = true;
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.target.installedPluginId, pluginId);
    assert.deepEqual(result.stepsExecuted, [
      `open:/_emdash/admin/plugins/${pluginId}/status`,
      "click:connect",
      "authorize:dinkuskit",
      "click:continue",
      "click:check",
    ]);
    assert.equal(result.finalInspection.bannerTitle, "Connected: Stripe test mode");
    assert.equal(result.finalInspection.connectedStripeTestMode, true);
    assert.equal(result.finalInspection.hasConnectPaymentsStep, true);
    assert.equal(result.finalInspection.hasPlaceTestOrderStep, true);
    assert.equal(result.finalInspection.hasSecretLeak, false);

    // Re-running on an already-connected store goes straight from load -> Check connection
    const secondRun = await runPaymentsSetupJourney({
      storeOrigin,
      pluginIdOrSlug: pluginId,
      driver: {
        loadStatusPage: () => invokeAdmin({ type: "page_load", page: "/status" }),
        clickAction: (actionId) => invokeAdmin({ type: "block_action", action_id: actionId }),
      },
    });
    assert.equal(secondRun.ok, true);
    assert.deepEqual(secondRun.stepsExecuted, [
      `open:/_emdash/admin/plugins/${pluginId}/status`,
      "click:check",
    ]);
  }
});

test("inspectPaymentsSetupScreen flags leaked secret material", () => {
  const inspection = inspectPaymentsSetupScreen({
    blocks: [
      { type: "header", text: "Payment setup" },
      { type: "banner", title: "Connected: Stripe test mode" },
      {
        type: "section",
        text: "Connect payments: Connected: Stripe test mode. Test card payments work at checkout. sk_test_1234567890abcdef",
      },
      { type: "section", text: "Place a test order: Not complete." },
    ],
  });
  assert.equal(inspection.hasSecretLeak, true);
});
