import assert from "node:assert/strict";
import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { test } from "vitest";
import { vi } from "vitest";
import { PluginBridge } from "@emdash-cms/cloudflare/sandbox";
import { CONNECT, CONTROL, JWKS, SITE, STATUS, body, control, fixture, session, snapshot } from "./helpers/registry-runtime.js";

test("compiled setup retains its verified link and diagnostics within ten bridge calls", async () => {
  const f = await fixture({ installedId: "r_3brsc2on3bu673rn" }); const { host } = f;
  const calls: string[] = [];
  try {
    await f.prepareStart("setup-budget"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue"); host.http.clear();
    for (const name of ["kvGetVersioned", "kvCompareAndSet", "settingsGetVersioned", "settingsCompareAndSet", "httpFetch"] as const) {
      const original = PluginBridge.prototype[name];
      vi.spyOn(PluginBridge.prototype, name).mockImplementation(async function(...args: unknown[]) {
        if (!name.startsWith("kv") || args[0] === CONTROL) {
          calls.push(name);
          if (calls.length > 10) throw new Error("synthetic_subrequest_limit");
        }
        return (original as (...args: unknown[]) => Promise<unknown>).apply(this, args);
      } as never);
    }
    const saved = await snapshot(host);
    const link = "https://connect.stripe.com/setup/synthetic-budget";
    await f.prepareSetupDiagnostics("connecting", { state: "connecting", mode: "test", processorAccountPresent: false, evidence: "unobserved" });
    await host.http.respond("https://payments.dinkuskit.com/v1/connect", Response.json({ state: "setup_required", mode: "test", bindingRef: "synthetic-binding", url: link, expiresAt: Date.now() + 60_000 }));
    const page = JSON.stringify(await f.action("setup_processor"));
    assert.match(page, /Continue setup at Stripe/);
    assert.ok(page.includes(link));
    assert.doesNotMatch(page, /status_recheck_control|No processor setup was attempted/);
    assert.deepEqual(calls, ["kvGetVersioned", "settingsGetVersioned", "httpFetch", "kvGetVersioned", "httpFetch", "kvGetVersioned", "httpFetch", "httpFetch", "kvGetVersioned", "kvGetVersioned"]);
    assert.equal(host.http.requests().filter(r => r.url === JWKS).length, 1);
    assert.equal(host.http.requests().filter(r => r.url.endsWith("/v1/connect")).length, 1);
    assert.deepEqual(await snapshot(host), saved);
    calls.length = 0; host.http.clear();
    await f.prepareDiagnostics("connecting", { state: "connecting", mode: "test", processorAccountPresent: false, evidence: "unobserved" });
    assert.match(JSON.stringify(await f.action("check")), /Your DinkusKit authorization is connected/);
    assert.equal(calls.length, 7);
    assert.equal(host.http.requests().some(r => r.method !== "GET"), false);
  } finally { vi.restoreAllMocks(); await host.dispose(); }
});

test("compiled post-setup status failure does not claim that no setup was attempted", async () => {
  const f = await fixture(); const { host } = f;
  try {
    await f.prepareStart("setup-uncertain"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue"); host.http.clear();
    await f.prepareSetupStatusResponse({ error: "synthetic-private-material" }, 503);
    await host.http.respond("https://payments.dinkuskit.com/v1/connect", Response.json({ state: "setup_required", mode: "test", bindingRef: "synthetic-binding", url: "https://connect.stripe.com/setup/synthetic", expiresAt: Date.now() + 60_000 }));
    const page = JSON.stringify(await f.action("setup_processor"));
    assert.match(page, /Processor setup was requested/);
    assert.doesNotMatch(page, /No processor setup was attempted|synthetic-private-material|Continue setup at Stripe/);
    assert.equal(host.http.requests().filter(r => r.url.endsWith("/v1/connect")).length, 1);
    host.http.clear(); await f.prepareStatus(); await f.action("check");
    assert.equal(host.http.requests().some(r => r.method !== "GET"), false);
  } finally { await host.dispose(); }
});

test("compiled setup rejects concurrent flow replacement before and after status", async () => {
  for (const changeAfter of ["/v1/connect", "/v1/status"]) {
    const f = await fixture(); const { host } = f;
    try {
      await f.prepareStart("setup-race"); await f.action("connect"); await f.pollDue();
      await f.prepareExchange(); await f.action("continue"); host.http.clear();
      await f.prepareProcessorStatus();
      await host.http.respond("https://payments.dinkuskit.com/v1/connect", Response.json({ state: "setup_required", mode: "test", bindingRef: "synthetic-binding", url: "https://connect.stripe.com/setup/synthetic-race", expiresAt: Date.now() + 60_000 }));
      const fetch = PluginBridge.prototype.httpFetch;
      vi.spyOn(PluginBridge.prototype, "httpFetch").mockImplementation(async function(url, init) {
        const result = await fetch.call(this, url, init);
        if (url.endsWith(changeAfter)) await host.fixtures.plugin.kv(CONTROL, { ...await control(host), flowId: "replacement-flow" });
        return result;
      });
      const page = JSON.stringify(await f.action("setup_processor"));
      assert.doesNotMatch(page, /Continue setup at Stripe|synthetic-race/);
      assert.match(page, /Reconnect explicitly/);
      assert.equal((await control(host)).flowId, "replacement-flow");
    } finally { vi.restoreAllMocks(); await host.dispose(); }
  }
});

test("compiled installed instance preserves encrypted session identity through renewal and restart", async () => {
  const f = await fixture({ installedId: "r_3brsc2on3bu673rn" }); const { host } = f;
  try {
    assert.equal(host.manifest.id, "r_3brsc2on3bu673rn");
    for (let cycle = 0; cycle < 2; cycle++) {
      await f.prepareStart(`installed-renewal-${cycle}`); await f.action("connect"); await f.pollDue();
      await f.prepareExchange();
      assert.match(JSON.stringify(await f.action("continue")), /Your DinkusKit authorization was saved/);
      const c = await control(host);
      const stored = await session(host);
      assert.equal(stored.kind, "session");
      assert.equal(stored.flowId, c.flowId);
      assert.equal(c.phase, "complete");
      const persisted = await snapshot(host);
      await host.restart();
      assert.deepEqual(await snapshot(host), persisted);
      host.http.clear(); await f.prepareStatus();
      const page = JSON.stringify(await f.page());
      assert.match(page, /Stripe is connected for TEST payments only/);
      assert.doesNotMatch(page, /status_read_session|check failed/);
      assert.deepEqual(host.http.requests().map(r => r.url), [JWKS, STATUS]);
      host.http.clear();
    }
  } finally { await host.dispose(); }
});

test("compiled Continue saves authorization within ten bridge calls and checks status in a fresh request", async () => {
  const f = await fixture({ installedId: "r_3brsc2on3bu673rn" }); const { host } = f;
  const calls: string[] = [];
  const count = (name: string) => {
    calls.push(name);
    if (calls.length > 10) throw new Error("synthetic_subrequest_limit");
  };
  try {
    await f.prepareStart("budgeted-renewal"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange();
    for (const name of ["kvGetVersioned", "kvCompareAndSet", "settingsGetVersioned", "settingsCompareAndSet", "httpFetch"] as const) {
      const original = PluginBridge.prototype[name];
      vi.spyOn(PluginBridge.prototype, name).mockImplementation(async function(...args: unknown[]) {
        if (!name.startsWith("kv") || args[0] === CONTROL) count(name);
        return (original as (...args: unknown[]) => Promise<unknown>).apply(this, args);
      } as never);
    }
    const page = JSON.stringify(await f.action("continue"));
    assert.match(page, /Your DinkusKit authorization was saved/);
    assert.doesNotMatch(page, /status_read_session|check failed|"action_id":"setup_processor"/);
    assert.deepEqual(calls, ["kvGetVersioned", "kvCompareAndSet", "kvGetVersioned", "settingsGetVersioned", "httpFetch", "httpFetch", "kvGetVersioned", "settingsCompareAndSet", "kvCompareAndSet"]);
    assert.equal(host.http.requests().some(r => r.url === STATUS || r.url.endsWith("/v1/connect")), false);
    const saved = await snapshot(host);
    assert.equal(saved.control.phase, "complete");
    calls.length = 0; host.http.clear(); await f.prepareStatus();
    assert.match(JSON.stringify(await f.action("check")), /Stripe is connected for TEST payments only/);
    assert.equal(calls.length, 5);
    assert.deepEqual(await snapshot(host), saved);
  } finally { vi.restoreAllMocks(); await host.dispose(); }
});

test("compiled Check performs one status sequence for an already completed grant", async () => {
  const f = await fixture(); const { host } = f;
  try {
    await f.prepareStart("single-check"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue"); host.http.clear();
    await f.prepareDiagnostics("connecting", { state: "connecting", mode: "test", processorAccountPresent: false, evidence: "unobserved" });
    const checked = JSON.stringify(await f.action("check"));
    assert.match(checked, /Your DinkusKit authorization is connected/);
    assert.deepEqual(host.http.requests().map(r => r.url), [JWKS, STATUS, "https://payments.dinkuskit.com/v1/connect/diagnostics"]);
  } finally { await host.dispose(); }
});

test("compiled final control-read failure reports a safe terminal cause without stale readiness", async () => {
  const f = await fixture(); const { host } = f;
  let diagnosticsDone = false;
  try {
    await f.prepareStart("failed-final-read"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue"); host.http.clear();
    const getVersioned = PluginBridge.prototype.kvGetVersioned;
    const fetch = PluginBridge.prototype.httpFetch;
    vi.spyOn(PluginBridge.prototype, "kvGetVersioned").mockImplementation(async function(key) {
      if (key === CONTROL && diagnosticsDone) throw new Error("synthetic-private-error-content");
      return getVersioned.call(this, key);
    });
    vi.spyOn(PluginBridge.prototype, "httpFetch").mockImplementation(async function(url, init) {
      const result = await fetch.call(this, url, init);
      if (url.endsWith("/v1/connect/diagnostics")) diagnosticsDone = true;
      return result;
    });
    await f.prepareDiagnostics("connecting", { state: "connecting", mode: "test", processorAccountPresent: false, evidence: "unobserved" });
    const page = JSON.stringify(await f.page());
    assert.equal(diagnosticsDone, true);
    assert.match(page, /Payments setup check failed/);
    assert.match(page, /status_recheck_control/);
    assert.doesNotMatch(page, /Checking Payments setup|synthetic-private-error-content|Your DinkusKit authorization is connected|"action_id":"setup_processor"/);
    assert.match(page, /"action_id":"check"/);
    assert.deepEqual(host.http.requests().map(r => r.url), [JWKS, STATUS, "https://payments.dinkuskit.com/v1/connect/diagnostics"]);
  } finally { vi.restoreAllMocks(); await host.dispose(); }
});

test("compiled status failures identify only the observed safe stage and recover on a fresh check", async () => {
  for (const stage of ["read_control", "read_session", "verify_session", "fetch_status", "decode_status", "http_status"] as const) {
    const f = await fixture(); const { host } = f;
    try {
      await f.prepareStart(`failure-${stage}`); await f.action("connect"); await f.pollDue();
      await f.prepareExchange(); await f.action("continue"); host.http.clear();
      if (stage === "read_control") {
        const read = PluginBridge.prototype.kvGetVersioned;
        vi.spyOn(PluginBridge.prototype, "kvGetVersioned").mockImplementation(async function(key) {
          if (key === CONTROL) throw new Error("synthetic-private-error-content");
          return read.call(this, key);
        });
      } else if (stage === "read_session") {
        vi.spyOn(PluginBridge.prototype, "settingsGetVersioned").mockRejectedValue(new Error("synthetic-private-error-content"));
      } else if (stage === "verify_session" || stage === "fetch_status") {
        const fetch = PluginBridge.prototype.httpFetch;
        vi.spyOn(PluginBridge.prototype, "httpFetch").mockImplementation(async function(url, init) {
          if (url === (stage === "verify_session" ? JWKS : STATUS)) throw new Error("synthetic-private-error-content");
          return fetch.call(this, url, init);
        });
      }
      await f.prepareStatusResponse(stage === "decode_status" ? { private: "synthetic-private-response" } : { state: "disconnected", mode: "test" }, stage === "http_status" ? 503 : 200);
      const page = JSON.stringify(await f.page());
      assert.match(page, /Payments setup check failed/);
      assert.ok(page.includes(`status_${stage === "http_status" ? "fetch_status" : stage}`));
      if (stage === "http_status") assert.match(page, /HTTP 503/);
      assert.doesNotMatch(page, /Checking Payments setup|synthetic-private|"action_id":"setup_processor"|Connect payments first/);
      assert.match(page, /"action_id":"check"/);
      assert.equal(host.http.requests().some(r => r.method !== "GET"), false);
      vi.restoreAllMocks(); host.http.clear();
      await f.prepareStatusResponse({ state: "disconnected", mode: "test" });
      const recovered = JSON.stringify(await f.action("check"));
      assert.doesNotMatch(recovered, /Support code|check failed/);
      assert.match(recovered, /No processor account is connected/);
      assert.deepEqual(host.http.requests().map(r => r.url), [JWKS, STATUS]);
    } finally { vi.restoreAllMocks(); await host.dispose(); }
  }
});

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
    assert.match(JSON.stringify(ready), /Your DinkusKit authorization was saved/);
    assert.match(JSON.stringify(ready), /"action_id":"check"/);
    assert.match(JSON.stringify(ready), /Not ready to sell/);
    assert.doesNotMatch(JSON.stringify(ready), /"action_id":"setup_processor"/);
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
      ["POST", CONNECT], ["POST", `${CONNECT}/token`], ["GET", JWKS],
    ]);
    await f.prepareStatus();
    assert.match(JSON.stringify(await f.action("check")), /Stripe is connected for TEST payments only/);
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
    assert.match(JSON.stringify(await f.action("continue")), /Your DinkusKit authorization was saved/);
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
    assert.match(JSON.stringify(await f.action("continue")), /Your DinkusKit authorization was saved/);
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
    assert.match(JSON.stringify(denied), /Payments setup check failed/);
    assert.match(JSON.stringify(denied), /status_fetch_status/);
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

test("compiled processor setup starts/resumes separately from consent and rejects unsafe links and expired/wrong-user sessions", async () => {
  const f = await fixture(); const { host } = f;
  const endpoint = "https://payments.dinkuskit.com/v1/connect";
  try {
    await f.prepareStart("processor-flow"); await f.action("connect"); await f.pollDue();
    const token = await f.prepareExchange(); await f.action("continue");
    host.http.clear(); await f.prepareStatus(true);
    const disconnected = JSON.stringify(await f.page());
    assert.match(disconnected, /No processor account is connected/);
    assert.match(disconnected, /"action_id":"setup_processor"/);
    await f.prepareStatus(true);
    assert.match(JSON.stringify(await f.action("check")), /No processor account is connected/);
    assert.equal(host.http.requests().some(r => r.url === endpoint), false);
    const persisted = await snapshot(host);
    for (const url of ["https://connect.stripe.com/setup/first", "https://connect.stripe.com/setup/resume"]) {
      host.http.clear(); await f.prepareProcessorStatus();
      await host.http.respond(endpoint, Response.json({ state: "setup_required", mode: "test", bindingRef: "synthetic-binding", url, expiresAt: Date.now() + 60_000 }));
      const page = JSON.stringify(await f.action("setup_processor"));
      assert.match(page, /Continue setup at Stripe/); assert.ok(page.includes(url));
      assert.match(page, /Not ready to sell/); assert.equal(page.includes(token), false);
      const request = host.http.requests().find(r => r.url === endpoint)!;
      assert.equal(request.method, "POST"); assert.equal(request.body.length, 0);
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.headers["x-dinkus-site"], "synthetic-site");
      assert.deepEqual(await snapshot(host), persisted);
    }
    host.http.clear(); await f.prepareProcessorStatus();
    await host.http.respond(endpoint, Response.json({ state: "setup_required", mode: "test", bindingRef: "synthetic-binding", url: "https://evil.invalid/setup/x", expiresAt: Date.now() + 60_000 }));
    assert.doesNotMatch(JSON.stringify(await f.action("setup_processor")), /evil.invalid|Continue setup at Stripe/);
    for (const code of [401, 500]) {
      host.http.clear(); await f.prepareProcessorStatus();
      await host.http.respond(endpoint, Response.json({ error: "unavailable" }, { status: code }));
      assert.doesNotMatch(JSON.stringify(await f.action("setup_processor")), /Continue setup at Stripe/);
      assert.equal(host.http.requests().filter(r => r.url === endpoint).length, 1);
    }
    host.http.clear(); await f.prepareProcessorStatus(false);
    await host.http.respond(endpoint, Response.json({ state: "ready", mode: "test", bindingRef: "synthetic-binding" }));
    const ready = JSON.stringify(await f.action("setup_processor"));
    assert.match(ready, /Stripe is connected for TEST payments only/);
    assert.doesNotMatch(ready, /Continue setup at Stripe/);
    assert.ok(host.http.requests().some(r => r.url === STATUS));
    const other = await host.fixtures.user({ email: "other-admin@example.invalid", role: "admin" });
    host.http.clear();
    assert.doesNotMatch(JSON.stringify(await host.admin.act("/status", "setup_processor", { user: other })), /Continue setup at Stripe/);
    assert.deepEqual(host.http.requests(), []);
    const subscriber = await host.fixtures.user({ email: "setup-subscriber@example.invalid", role: "subscriber" });
    const denied = await host.actions.routes.request("admin", { method: "POST", body: { type: "block_action", action_id: "setup_processor" }, user: subscriber });
    assert.equal(denied.status, 403);
    await host.fixtures.plugin.kv(CONTROL, { ...await control(host), expiresAt: Date.now() - 1 });
    assert.doesNotMatch(JSON.stringify(await f.action("setup_processor")), /Continue setup at Stripe/);
    assert.deepEqual(host.http.requests(), []);
  } finally { await host.dispose(); }
});


test("compiled diagnostics explain connecting and recovery without retry or false reconnect advice", async () => {
  const f = await fixture(); const { host } = f;
  try {
    await f.prepareStart("diagnostic-flow"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue"); host.http.clear();
    const diagnosis = { state: "connecting", mode: "test", processorAccountPresent: false, evidence: "observed", lastFailure: { category: "permission", status: 403, at: Date.now() - 1000 } };
    await f.prepareDiagnostics("connecting", diagnosis);
    const observed = JSON.stringify(await f.page());
    assert.match(observed, /Stripe refused/); assert.match(observed, /Your DinkusKit authorization is connected/);
    assert.doesNotMatch(observed, /Connect your DinkusKit account to continue/);
    for (const reply of [{ payload: { error: "not_found" }, code: 404 }, { payload: { ...diagnosis, raw: "private-diagnostic-material" }, code: 200 }]) {
      await f.prepareDiagnostics("connecting", reply.payload, reply.code);
      const unavailable = JSON.stringify(await f.page());
      assert.match(unavailable, /No recorded failure detail/); assert.doesNotMatch(unavailable, /private-diagnostic-material/);
    }
    await f.prepareDiagnostics("recovery_required", { ...diagnosis, state: "recovery_required" });
    const recovery = JSON.stringify(await f.page());
    assert.match(recovery, /safe setup retry window has ended/);
    assert.doesNotMatch(recovery, /"action_id":"setup_processor"/);
    assert.equal(host.http.requests().filter(r => r.url.endsWith("/v1/connect")).length, 0);
  } finally { await host.dispose(); }
});
