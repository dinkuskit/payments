import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/plugin.ts";
import {
  ACCEPTED_INSTALLED_PLUGIN_IDS,
  BETA_INSTALLED_PLUGIN_ID,
  BETA_REGISTRY_SLUG,
  STABLE_INSTALLED_PLUGIN_ID,
  STABLE_REGISTRY_SLUG,
  acceptedRegistryInstallationIdentities,
  assertExplicitRegistryRouteAuth,
  betaRegistryInstallationIdentity,
  betaRegistryRouteManifest,
  isAcceptedRegistryPluginId,
  makeRegistryPluginId as derivePaymentsRegistryPluginId,
  parsePaymentsCallbackUri,
  registryInstallationIdentity,
  registryRouteManifest,
  resolveRegistryInstallationIdentity,
  verifyAcceptedRegistryInstallationIdentities,
  verifyRegistryInstallationIdentity,
} from "../src/registry/manifest.ts";
import { hostedHttpRoutes, hostedPublicRouteManifest } from "../src/hosted/manifest.ts";

test("Registry manifest is derived from explicit private route declarations", () => {
  assert.doesNotThrow(() => assertExplicitRegistryRouteAuth(plugin.routes));
  assert.deepEqual(registryRouteManifest.publicRoutes, [`/_emdash/api/plugins/${registryInstallationIdentity.installedPluginId}/store-proof`]);
  assert.deepEqual(registryRouteManifest.routes, [
    { name: "admin", path: `/_emdash/api/plugins/${registryInstallationIdentity.installedPluginId}/admin`, public: false, permission: "plugins:manage", methods: ["POST"] },
    { name: "store-proof", path: `/_emdash/api/plugins/${registryInstallationIdentity.installedPluginId}/store-proof`, public: true, methods: ["GET"] },
  ]);
  assert.equal(registryRouteManifest.installedPluginId, registryInstallationIdentity.installedPluginId);

  assert.deepEqual(betaRegistryRouteManifest.publicRoutes, [`/_emdash/api/plugins/${betaRegistryInstallationIdentity.installedPluginId}/store-proof`]);
  assert.deepEqual(betaRegistryRouteManifest.routes, [
    { name: "admin", path: `/_emdash/api/plugins/${betaRegistryInstallationIdentity.installedPluginId}/admin`, public: false, permission: "plugins:manage", methods: ["POST"] },
    { name: "store-proof", path: `/_emdash/api/plugins/${betaRegistryInstallationIdentity.installedPluginId}/store-proof`, public: true, methods: ["GET"] },
  ]);
  assert.equal(betaRegistryRouteManifest.installedPluginId, betaRegistryInstallationIdentity.installedPluginId);
});

test("route-auth coverage rejects missing declarations, bare handlers, and public/admin mismatch", () => {
  assert.throws(
    () => assertExplicitRegistryRouteAuth({ missing: { handler: async () => ({}) } }),
    /explicit public boolean/,
  );
  assert.throws(
    () => assertExplicitRegistryRouteAuth({ bare: async () => ({}) }),
    /explicit route configuration/,
  );
  assert.throws(
    () => assertExplicitRegistryRouteAuth({ admin: { public: true, handler: async () => ({}) } }),
    /admin route must be private/,
  );
  assert.throws(
    () => assertExplicitRegistryRouteAuth({ private: { public: false, handler: async () => ({}) } }),
    /permission/,
  );
});

test("Registry installation identity verifies both stable and beta derived IDs, not native slugs", () => {
  assert.equal(STABLE_INSTALLED_PLUGIN_ID, "r_3brsc2on3bu673rn");
  assert.equal(BETA_INSTALLED_PLUGIN_ID, "r_sffx6l4z6mpqliki");
  assert.deepEqual(ACCEPTED_INSTALLED_PLUGIN_IDS, ["r_3brsc2on3bu673rn", "r_sffx6l4z6mpqliki"]);
  assert.equal(acceptedRegistryInstallationIdentities.length, 2);

  for (const identity of acceptedRegistryInstallationIdentities) {
    assert.equal(verifyRegistryInstallationIdentity(identity), true);
    assert.equal(isAcceptedRegistryPluginId(identity.installedPluginId), true);
    assert.equal(resolveRegistryInstallationIdentity(identity.installedPluginId), identity);
    assert.equal(resolveRegistryInstallationIdentity(identity.slug), identity);
    assert.match(identity.installedPluginId, /^r_[a-z2-7]{16}$/);
    assert.equal(
      verifyRegistryInstallationIdentity({
        ...identity,
        installedPluginId: identity.slug,
      }),
      false,
    );
  }

  assert.equal(
    verifyRegistryInstallationIdentity({
      publisherDid: registryInstallationIdentity.publisherDid,
      slug: STABLE_REGISTRY_SLUG,
      installedPluginId: BETA_INSTALLED_PLUGIN_ID,
    }),
    false,
  );
  assert.equal(
    verifyRegistryInstallationIdentity({
      publisherDid: betaRegistryInstallationIdentity.publisherDid,
      slug: BETA_REGISTRY_SLUG,
      installedPluginId: STABLE_INSTALLED_PLUGIN_ID,
    }),
    false,
  );
  assert.equal(isAcceptedRegistryPluginId("r_untrustedpluginid"), false);
  assert.equal(resolveRegistryInstallationIdentity("r_untrustedpluginid"), null);
});

test("hosted public manifest emits exact signature-protected paths on the hosted surface", () => {
  const routes = hostedPublicRouteManifest("site_test");
  assert.deepEqual(routes.map(route => route.path), ["/health", "/v1/webhooks/stripe", "/v1/webhooks/authorize-net/site_test"]);
  assert.deepEqual(routes[0], {
    path: "/health",
    method: "GET",
    authentication: "none",
    surface: "hosted",
    public: true,
  });
  assert(routes.slice(1).every(route => route.public && route.surface === "hosted" && route.method === "POST" && route.authentication));
  for (const site of ["*", "a/b", "..", "%2f", "a?b", ""]) {
    assert.throws(() => hostedPublicRouteManifest(site), /invalid_site_path_segment/);
  }
});

test("pinned EmDash derivation matches both stable (dinkus-payments) and beta (dinkus-payments-beta) installed route paths", async () => {
  const { makeRegistryPluginId } = await import("../node_modules/emdash/src/registry/plugin-id.ts");
  const { readFile } = await import("node:fs/promises");
  const metadata = JSON.parse(await readFile(new URL("../emdash-plugin.jsonc", import.meta.url), "utf8"));
  assert.equal(registryInstallationIdentity.publisherDid, metadata.publisher);
  assert.equal(registryInstallationIdentity.slug, metadata.slug);
  assert.equal(betaRegistryInstallationIdentity.publisherDid, metadata.publisher);
  assert.equal(betaRegistryInstallationIdentity.slug, `${metadata.slug}-beta`);

  const stableId = await makeRegistryPluginId(metadata.publisher, metadata.slug);
  const betaId = await makeRegistryPluginId(metadata.publisher, `${metadata.slug}-beta`);
  assert.equal(stableId, "r_3brsc2on3bu673rn");
  assert.equal(betaId, "r_sffx6l4z6mpqliki");
  assert.equal(await derivePaymentsRegistryPluginId(metadata.publisher, metadata.slug), stableId);
  assert.equal(await derivePaymentsRegistryPluginId(metadata.publisher, `${metadata.slug}-beta`), betaId);
  assert.equal(stableId, registryRouteManifest.installedPluginId);
  assert.equal(betaId, betaRegistryRouteManifest.installedPluginId);
  assert.equal(registryRouteManifest.routes[0].path, `/_emdash/api/plugins/${stableId}/admin`);
  assert.equal(betaRegistryRouteManifest.routes[0].path, `/_emdash/api/plugins/${betaId}/admin`);
  assert.equal(await verifyAcceptedRegistryInstallationIdentities(makeRegistryPluginId), true);
});

test("production public-only dispatcher refuses Payments admin without invoking its handler for both stable and beta IDs", async () => {
  const { createPublicPluginApiRouteHandler } = await import("../node_modules/emdash/src/astro/public-plugin-api-routes.ts");
  for (const pluginId of ACCEPTED_INSTALLED_PLUGIN_IDS) {
    let invoked = false;
    const dispatch = createPublicPluginApiRouteHandler({
      getPluginRouteMeta: () => plugin.routes.admin,
      handlePluginApiRoute: async () => { invoked = true; return { success: true }; },
    });
    const result = await dispatch(pluginId, "POST", "/admin", new Request("https://store.example.invalid/", { method: "POST" }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, "NOT_FOUND");
    assert.equal(invoked, false);
  }
});

test("every hosted scoped route denies anonymous input before service/checkout/wake dispatch", async () => {
  const { createHostedHandler } = await import("../src/hosted/http.ts");
  const scopes = [];
  const handler = createHostedHandler({
    authenticate: async (_request, scope) => { scopes.push(scope); throw new Error("denied"); },
    service: () => { assert.fail("must not dispatch"); },
    checkout: () => { assert.fail("must not dispatch"); },
    wakes: () => { assert.fail("must not dispatch"); },
  });
  for (const [path, route] of Object.entries(hostedHttpRoutes)) {
    const response = await handler(new Request(`https://payments.example.invalid${path}`, { method: route.method }));
    assert.equal(response.status, 401, path);
    assert.equal(scopes.at(-1), route.scope, path);
  }
});

test("shared-store callback, proof export and Access docs accept both stable and beta Registry identities", async () => {
  const {
    REGISTRY_BETA_CALLBACK_PATH,
    REGISTRY_BETA_PROOF_PATH,
    REGISTRY_CALLBACK_PATH,
    REGISTRY_PROOF_PATH,
  } = await import("../src/registry/connection.ts");
  const { readFile } = await import("node:fs/promises");
  assert.deepEqual(registryRouteManifest.publicRoutes, [REGISTRY_PROOF_PATH]);
  assert.deepEqual(betaRegistryRouteManifest.publicRoutes, [REGISTRY_BETA_PROOF_PATH]);
  assert.equal(REGISTRY_CALLBACK_PATH, `/_emdash/admin/plugins/${registryInstallationIdentity.installedPluginId}/status`);
  assert.equal(REGISTRY_BETA_CALLBACK_PATH, `/_emdash/admin/plugins/${betaRegistryInstallationIdentity.installedPluginId}/status`);

  const origin = "https://shop.example";
  assert.deepEqual(parsePaymentsCallbackUri(`${origin}${REGISTRY_CALLBACK_PATH}`, origin), {
    identity: registryInstallationIdentity,
    installedPluginId: "r_3brsc2on3bu673rn",
    callbackUri: `${origin}${REGISTRY_CALLBACK_PATH}`,
    proofUri: `${origin}${REGISTRY_PROOF_PATH}`,
  });
  assert.deepEqual(parsePaymentsCallbackUri(`${origin}${REGISTRY_BETA_CALLBACK_PATH}`, origin), {
    identity: betaRegistryInstallationIdentity,
    installedPluginId: "r_sffx6l4z6mpqliki",
    callbackUri: `${origin}${REGISTRY_BETA_CALLBACK_PATH}`,
    proofUri: `${origin}${REGISTRY_BETA_PROOF_PATH}`,
  });
  assert.equal(parsePaymentsCallbackUri(`${origin}/_emdash/admin/plugins/dinkus-payments/status`, origin), null);

  const docs = await readFile(new URL("../docs/route-auth.md", import.meta.url), "utf8");
  assert.ok(docs.includes(REGISTRY_PROOF_PATH));
  assert.ok(docs.includes(REGISTRY_CALLBACK_PATH));
  assert.ok(docs.includes(REGISTRY_BETA_PROOF_PATH));
  assert.ok(docs.includes(REGISTRY_BETA_CALLBACK_PATH));
  assert.equal(docs.includes("publicRoutes` is **`[]`**"), false);
});
