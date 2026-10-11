import assert from "node:assert/strict";
import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { test } from "vitest";
import { CONNECT, CONTROL, JWKS, SITE, STATUS, body, control, fixture, session, snapshot } from "./helpers/registry-runtime.js";

test("loads the built registry plugin and validates its private status page", async () => {
  const host = await createPluginRuntimeTestHost();
  try {
    assert.equal(host.manifest.id, "dinkus-payments");
    assert.deepEqual(host.manifest.capabilities, ["network:request"]);
    assert.deepEqual(host.manifest.allowedHosts, ["dinkuskit.com", "payments.dinkuskit.com"]);
    assert.equal(host.manifest.admin.pages[0].path, "/status");

    const page = await host.admin.loadPage("/status");
    assert.equal(page.blocks[0].type, "header");
    assert.match(JSON.stringify(page), /Payment setup/);
    assert.match(JSON.stringify(page), /Connect payments/);
    assert.match(JSON.stringify(page), /Place a test order/);
    assert.match(JSON.stringify(page), /Not ready to sell/);
    assert.match(JSON.stringify(page), /paid TEST order visible in Commerce admin has not been confirmed/);
    assert.match(JSON.stringify(page), /"action_id":"connect"/);
    assert.deepEqual(host.http.requests(), []);
  } finally {
    await host.dispose();
  }
});

test("compiled Connect, signed exchange and status persist through real settings/KV and restart", async () => {
  const f = await fixture();
  const { host } = f;
  try {
    await f.prepareStart("connection-one");
    const pending = await f.action("connect");
    assert.match(JSON.stringify(pending), /Continue sign in/);
    assert.match(JSON.stringify(pending), /"action_id":"continue"/);
    assert.match(JSON.stringify(pending), /https:\/\/dinkuskit.com\/account\/connect\?connection_id=connection-one/);
    const c = await control(host);
    assert.equal(c.phase, "pending");
    assert.equal(c.adminId, f.admin.id);
    assert.equal(c.origin, SITE);
    const secret = await session(host);
    assert.equal(secret.kind, "flow");
    assert.equal(secret.flowId, c.flowId);
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(secret.verifier), "synthetic PKCE verifier shape");
    assert.equal(JSON.stringify(await host.inspect.kv.list()).includes(secret.verifier), false);
    assert.equal(JSON.stringify(pending).includes(secret.verifier), false);
    const start = host.http.requests()[0];
    assert.deepEqual(host.http.requests().map(r => [r.method, r.url]), [["POST", CONNECT]]);
    assert.deepEqual(Object.keys(body(start)).sort(), ["callback_uri", "client_id", "code_challenge", "code_challenge_method", "protocol_version", "service", "site_origin"]);
    assert.equal(body(start).protocol_version, 2);
    assert.equal(body(start).client_id, "dinkus-payments-emdash");
    assert.equal(body(start).service, "payments");
    assert.equal(body(start).site_origin, SITE);
    assert.equal(body(start).code_challenge_method, "S256");
    assert.equal(start.headers["content-type"], "application/json");
    const proof = await f.receipt("connection-one");
    assert.equal(proof.status, 200);
    const publicReceipt = await proof.json() as Record<string, unknown>;
    assert.deepEqual(publicReceipt, c.receipt);
    assert.deepEqual(Object.keys(publicReceipt).sort(), ["callback_uri", "challenge", "client_id", "code_challenge", "connection_id", "expires_at", "service", "site_id", "site_origin", "version"]);
    assert.equal(publicReceipt.version, 2);
    assert.equal(publicReceipt.site_id, "synthetic-site");
    assert.equal(publicReceipt.code_challenge, body(start).code_challenge);
    assert.equal(publicReceipt.callback_uri, body(start).callback_uri);
    // Account-service callback uses the stable installed Registry identity,
    // distinct from the package slug in the local test host.
    assert.equal(body(start).callback_uri, `${SITE}/_emdash/admin/plugins/r_3brsc2on3bu673rn/status`);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret.verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    assert.equal(publicReceipt.code_challenge, challenge);
    assert.equal(JSON.stringify(publicReceipt).includes(secret.verifier), false);
    // Early Continue must not poll the service or alter the pending state.
    const early = { ...c, nextPollAt: Date.now() + 60_000 };
    await host.fixtures.plugin.kv(CONTROL, early);
    assert.match(JSON.stringify(await f.action("continue")), /"action_id":"continue"/);
    assert.equal(host.http.requests().length, 1);
    assert.deepEqual(await control(host), early);
    await f.pollDue();
    const token = await f.prepareExchange();
    const ready = await f.action("continue");
    assert.match(JSON.stringify(ready), /Stripe is connected for TEST payments only/);
    assert.match(JSON.stringify(ready), /"action_id":"check"/);
    assert.match(JSON.stringify(ready), /Not ready to sell/);
    assert.match(JSON.stringify(ready), /Place an order on your store/);
    assert.equal(JSON.stringify(ready).includes(token), false);
    const complete = await control(host);
    assert.equal(complete.phase, "complete");
    assert.equal(complete.flowId, c.flowId);
    assert.deepEqual(complete.binding, { siteId: "synthetic-site", origin: SITE, issuer: "https://dinkuskit.com/account", subject: "synthetic-organization" });
    assert.equal(complete.receipt, undefined);
    const storedSession = await session(host);
    assert.equal(storedSession.kind, "session");
    assert.equal(storedSession.flowId, c.flowId);
    assert.ok(storedSession.token === token, "signed synthetic token persisted");
    assert.equal(JSON.stringify(await host.inspect.kv.list()).includes(token), false);
    assert.deepEqual(host.http.requests().map(r => [r.method, r.url]), [
      ["POST", CONNECT], ["POST", `${CONNECT}/token`], ["GET", JWKS], ["GET", JWKS], ["GET", STATUS],
    ]);
    const exchange = host.http.requests()[1];
    assert.deepEqual(Object.keys(body(exchange)).sort(), ["client_id", "code_verifier", "connection_id"]);
    assert.equal(body(exchange).client_id, "dinkus-payments-emdash");
    assert.equal(body(exchange).connection_id, "connection-one");
    assert.ok(body(exchange).code_verifier === secret.verifier, "exchange uses the persisted PKCE verifier");
    const status = host.http.requests()[4];
    assert.ok(status.headers.authorization === `Bearer ${token}`, "status uses the verified session token");
    assert.equal(status.headers["x-dinkus-site"], "synthetic-site");
    assert.equal(status.body.length, 0);
    assert.equal((await f.receipt("connection-one")).status, 404);
    const persisted = await snapshot(host);
    await host.restart();
    assert.deepEqual(await snapshot(host), persisted);
    host.http.clear();
    await f.prepareStatus();
    assert.match(JSON.stringify(await f.page()), /Stripe is connected for TEST payments only/);
    assert.deepEqual(await snapshot(host), persisted);
    assert.deepEqual(host.http.requests().map(r => r.url), [JWKS, STATUS]);
  } finally { await host.dispose(); }
});

test("compiled expiry requires explicit reconnect and stale receipts preserve the newer flow", async () => {
  const f = await fixture();
  const { host } = f;
  try {
    await f.prepareStart("old-connection");
    await f.action("connect");
    assert.equal((await f.receipt("old-connection")).status, 200);
    await f.pollDue();
    await f.prepareExchange();
    await f.action("continue");
    const old = await control(host);
    // Deterministic expired-session fixture in D1; expiry is evaluated by the
    // compiled plugin's real Date.now guard, not the host's scheduled clock.
    await host.fixtures.plugin.kv(CONTROL, { ...old, expiresAt: Date.now() - 1 });
    const expired = await snapshot(host);
    host.http.clear();
    assert.match(JSON.stringify(await f.page()), /Reconnect explicitly to continue/);
    assert.match(JSON.stringify(await f.action("continue")), /"action_id":"connect"/);
    assert.deepEqual(await snapshot(host), expired);
    assert.deepEqual(host.http.requests(), []);
    await f.prepareStart("new-connection");
    assert.match(JSON.stringify(await f.action("connect")), /"action_id":"continue"/);
    const fresh = await snapshot(host);
    assert.equal(fresh.control.phase, "pending");
    assert.notEqual(fresh.control.flowId, old.flowId);
    assert.deepEqual(fresh.control.binding, old.binding);
    assert.equal((await f.receipt("old-connection")).status, 404);
    assert.deepEqual(await snapshot(host), fresh);
    assert.equal((await f.receipt("new-connection")).status, 200);
    assert.deepEqual(await snapshot(host), fresh);
    assert.deepEqual(host.http.requests().map(r => r.url), [CONNECT]);
    await f.pollDue();
    const newToken = await f.prepareExchange();
    assert.match(JSON.stringify(await f.action("continue")), /Stripe is connected for TEST payments only/);
    assert.equal((await control(host)).flowId, fresh.control.flowId);
    assert.deepEqual((await control(host)).binding, old.binding);
    assert.ok((await session(host)).token === newToken, "reconnect persisted fresh signed token");
    assert.equal((await f.receipt("new-connection")).status, 404);
  } finally { await host.dispose(); }
});

test("concurrent compiled Connect actions reserve one flow and make one outbound request", async () => {
  const f = await fixture();
  const { host } = f;
  try {
    // Scenario reused from the shared-module concurrent-start test, now with
    // real D1 compare-and-set calls crossing two dispatched plugin invocations.
    await f.prepareStart("race-connection");
    const pages = await Promise.all([f.action("connect"), f.action("connect")]);
    for (const page of pages) assert.match(JSON.stringify(page), /"action_id":"continue"/);
    assert.deepEqual(host.http.requests().map(r => [r.method, r.url]), [["POST", CONNECT]]);
    const persisted = await snapshot(host);
    assert.equal(persisted.control.phase, "pending");
    assert.equal(persisted.control.receipt?.connection_id, "race-connection");
    assert.equal((await session(host)).flowId, persisted.control.flowId);
    assert.equal((await f.receipt("race-connection")).status, 200);
    assert.deepEqual(await snapshot(host), persisted);
    assert.match(JSON.stringify(await f.action("connect")), /"action_id":"continue"/);
    assert.deepEqual(await snapshot(host), persisted);
    assert.equal(host.http.requests().length, 1);
  } finally { await host.dispose(); }
});

test("real host allowed-host denial blocks status before synthetic transport and preserves the session", async () => {
  const f = await fixture();
  const { host } = f;
  try {
    await f.prepareStart("denial-connection");
    await f.action("connect");
    await f.pollDue();
    await f.prepareExchange();
    assert.match(JSON.stringify(await f.action("continue")), /Stripe is connected for TEST payments only/);
    const persisted = await snapshot(host);
    // Runtime-host entries share the parsed manifest arrays. Narrow this test
    // host's policy and restart its production runner; the built code and
    // repository manifest stay unchanged. JWKS remains permitted, status does not.
    assert.deepEqual(host.manifest.allowedHosts, ["dinkuskit.com", "payments.dinkuskit.com"]);
    host.manifest.allowedHosts!.splice(1, 1);
    await host.restart();
    host.http.clear();
    await f.prepareStatus(); // A valid reply is queued: policy must reject first.
    const denied = await f.page();
    assert.match(JSON.stringify(denied), /Checking Payments setup/);
    assert.match(JSON.stringify(denied), /"action_id":"check"/);
    assert.doesNotMatch(JSON.stringify(denied), /Stripe is connected for TEST payments only/);
    assert.deepEqual(host.http.requests().map(r => r.url), [JWKS]);
    assert.equal(host.http.requests().filter(r => r.url === STATUS).length, 0);
    assert.deepEqual(await snapshot(host), persisted);
    // Restore only this test host's policy. The already-queued status reply is
    // consumed now, showing that denial happened before the transport seam.
    host.manifest.allowedHosts!.push("payments.dinkuskit.com");
    await host.restart();
    await f.prepareStatus();
    assert.match(JSON.stringify(await f.page()), /Stripe is connected for TEST payments only/);
    assert.deepEqual(host.http.requests().map(r => r.url), [JWKS, JWKS, STATUS]);
    assert.deepEqual(await snapshot(host), persisted);
  } finally { await host.dispose(); }
});

test("denies unauthenticated and insufficient-role admin requests", async () => {
  const host = await createPluginRuntimeTestHost();
  try {
    const unauthenticated = await host.actions.routes.request("admin", {
      method: "POST",
      body: { type: "page_load", page: "/status" },
    });
    assert.equal(unauthenticated.status, 401);

    const subscriber = await host.fixtures.user({
      email: "subscriber@example.invalid",
      role: "subscriber",
    });
    const insufficientRole = await host.actions.routes.request("admin", {
      method: "POST",
      body: { type: "page_load", page: "/status" },
      user: subscriber,
    });
    assert.equal(insufficientRole.status, 403);
    assert.deepEqual(host.http.requests(), []);
  } finally {
    await host.dispose();
  }
});

test("built route preserves explicit private metadata and rejects non-admin token scope", async () => {
  const host = await createPluginRuntimeTestHost();
  try {
    const route = host.manifest.routes?.find(route => route.name === "admin");
    assert.equal(route?.public, false);
    assert.equal(route?.permission, "plugins:manage");
    const admin = await host.fixtures.user({ email: "admin-scope@example.invalid", role: "admin" });
    const denied = await host.actions.routes.request("admin", {
      method: "POST",
      body: { type: "page_load", page: "/status" },
      user: admin,
      tokenScopes: ["content:read"],
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(host.http.requests(), []);
  } finally {
    await host.dispose();
  }
});
