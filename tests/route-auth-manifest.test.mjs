import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/plugin.ts";
import {
  assertExplicitRegistryRouteAuth,
  registryInstallationIdentity,
  registryRouteManifest,
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

test("Registry installation identity verifies the derived ID, not the native slug", () => {
  assert.equal(verifyRegistryInstallationIdentity(registryInstallationIdentity), true);
  assert.equal(
    verifyRegistryInstallationIdentity({
      ...registryInstallationIdentity,
      installedPluginId: registryInstallationIdentity.slug,
    }),
    false,
  );
  assert.equal(registryInstallationIdentity.slug, "dinkus-payments");
  assert.match(registryInstallationIdentity.installedPluginId, /^r_[a-z2-7]{16}$/);
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

test("pinned EmDash derivation matches the declared publisher and installed route paths", async () => {
  const { makeRegistryPluginId } = await import("../node_modules/emdash/src/registry/plugin-id.ts");
  const { readFile } = await import("node:fs/promises");
  const metadata = JSON.parse(await readFile(new URL("../emdash-plugin.jsonc", import.meta.url), "utf8"));
  assert.equal(registryInstallationIdentity.publisherDid, metadata.publisher);
  assert.equal(registryInstallationIdentity.slug, metadata.slug);
  const id = await makeRegistryPluginId(metadata.publisher, metadata.slug);
  assert.equal(id, registryRouteManifest.installedPluginId);
  assert.equal(registryRouteManifest.routes[0].path, `/_emdash/api/plugins/${id}/admin`);
});

test("production public-only dispatcher refuses Payments admin without invoking its handler", async () => {
  const { createPublicPluginApiRouteHandler } = await import("../node_modules/emdash/src/astro/public-plugin-api-routes.ts");
  let invoked = false;
  const dispatch = createPublicPluginApiRouteHandler({
    getPluginRouteMeta: () => plugin.routes.admin,
    handlePluginApiRoute: async () => { invoked = true; return { success: true }; },
  });
  const result = await dispatch(registryInstallationIdentity.installedPluginId, "POST", "/admin", new Request("https://store.example.invalid/", { method: "POST" }));
  assert.equal(result.success, false);
  assert.equal(result.error.code, "NOT_FOUND");
  assert.equal(invoked, false);
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

test("shared-store callback, proof export and Access docs use the installed Registry identity", async () => {
  const { REGISTRY_CALLBACK_PATH, REGISTRY_PROOF_PATH } = await import('../src/registry/connection.ts');
  const { readFile } = await import('node:fs/promises');
  assert.deepEqual(registryRouteManifest.publicRoutes, [REGISTRY_PROOF_PATH]);
  assert.equal(REGISTRY_CALLBACK_PATH, `/_emdash/admin/plugins/${registryInstallationIdentity.installedPluginId}/status`);
  const docs = await readFile(new URL('../docs/route-auth.md', import.meta.url), 'utf8');
  assert.ok(docs.includes(REGISTRY_PROOF_PATH)); assert.ok(docs.includes(REGISTRY_CALLBACK_PATH));
  assert.equal(docs.includes('publicRoutes` is **`[]`**'), false);
});
