import assert from "node:assert/strict";
import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { test } from "vitest";
import { vi } from "vitest";
import { PluginBridge } from "@emdash-cms/cloudflare/sandbox";
import { CONNECT, CONTROL, JWKS, PASSES, SITE, STATUS, STORE_KEY, body, control, fixture, session, snapshot } from "./helpers/registry-runtime.js";

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
    const link = "https://accounts.stripe.com/r/acct_synthetic#alu_test_budget";
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
    // Check: control read twice, the store-key pass, status, this admin's session, diagnostics, control recheck.
    assert.deepEqual(calls, ["kvGetVersioned", "kvGetVersioned", "httpFetch", "httpFetch", "settingsGetVersioned", "httpFetch", "kvGetVersioned"]);
    const detail = host.http.requests().find(r => r.url.endsWith("/v1/connect/diagnostics"))!;
    assert.equal(JSON.parse(atob(detail.headers.authorization!.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))).scope, "payments:admin");
    assert.equal(host.http.requests().some(r => r.method !== "GET" && r.url !== PASSES), false);
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
    assert.equal(host.http.requests().some(r => r.method !== "GET" && r.url !== PASSES), false);
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
      assert.match(page, /This page needs a fresh DinkusKit sign-in for this store/);
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
      assert.match(JSON.stringify(await f.action("continue")), /Connected: Stripe test mode\. Test card payments work at checkout/);
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
      assert.match(page, /Connected: Stripe test mode\. Test card payments work at checkout/);
      assert.doesNotMatch(page, /status_read_session|check failed/);
      assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, STATUS]);
      host.http.clear();
    }
  } finally { await host.dispose(); }
});

test("compiled Continue saves authorization and reads status within ten bridge calls", async () => {
  const f = await fixture({ installedId: "r_3brsc2on3bu673rn" }); const { host } = f;
  const calls: string[] = [];
  const count = (name: string) => {
    calls.push(name);
    if (calls.length > 10) throw new Error("synthetic_subrequest_limit");
  };
  try {
    await f.prepareStart("budgeted-renewal"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange();
    // Every plugin KV key counts here; settings calls reach kv* internally and
    // are counted once, as settings*.
    for (const name of ["kvGet", "kvSet", "kvGetVersioned", "kvCompareAndSet", "settingsGet", "settingsGetVersioned", "settingsCompareAndSet", "httpFetch"] as const) {
      const original = PluginBridge.prototype[name];
      vi.spyOn(PluginBridge.prototype, name).mockImplementation(async function(...args: unknown[]) {
        if (!name.startsWith("kv") || !String(args[0]).startsWith("settings:")) count(name);
        return (original as (...args: unknown[]) => Promise<unknown>).apply(this, args);
      } as never);
    }
    const page = JSON.stringify(await f.action("continue"));
    assert.match(page, /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.doesNotMatch(page, /status_read_session|check failed|"action_id":"setup_processor"/);
    assert.deepEqual(calls, ["kvGetVersioned", "kvCompareAndSet", "kvGetVersioned", "settingsGetVersioned", "httpFetch", "httpFetch", "httpFetch", "kvGetVersioned", "settingsCompareAndSet", "kvCompareAndSet"]);
    assert.deepEqual(host.http.requests().filter(r => r.url === STATUS || r.url === JWKS).map(r => r.url), [JWKS, STATUS]);
    assert.equal(host.http.requests().some(r => r.url.endsWith("/v1/connect") || r.url.endsWith("/diagnostics")), false);
    const saved = await snapshot(host);
    assert.equal(saved.control.phase, "complete");
    calls.length = 0; host.http.clear(); await f.prepareStatus();
    assert.match(JSON.stringify(await f.action("check")), /Connected: Stripe test mode\. Test card payments work at checkout/);
    // Check: control read twice, the store key, its pass, status, then the remembered status.
    assert.deepEqual(calls, ["kvGetVersioned", "kvGetVersioned", "settingsGet", "httpFetch", "httpFetch", "kvSet"]);
    assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, STATUS]);
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
    assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, STATUS, "https://payments.dinkuskit.com/v1/connect/diagnostics"]);
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
    assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, STATUS, "https://payments.dinkuskit.com/v1/connect/diagnostics"]);
  } finally { vi.restoreAllMocks(); await host.dispose(); }
});

for (const stage of ["read_control", "read_key", "fetch_pass", "decode_pass", "fetch_status", "decode_status", "http_status"] as const) {
  test(`compiled status failure ${stage} stays bounded and recovers on a fresh check`, async () => {
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
      } else if (stage === "read_key") {
        vi.spyOn(PluginBridge.prototype, "settingsGet").mockRejectedValue(new Error("synthetic-private-error-content"));
      } else if (stage === "fetch_pass" || stage === "fetch_status") {
        const fetch = PluginBridge.prototype.httpFetch;
        vi.spyOn(PluginBridge.prototype, "httpFetch").mockImplementation(async function(url, init) {
          if (url === (stage === "fetch_pass" ? PASSES : STATUS)) throw new Error("synthetic-private-error-content");
          return fetch.call(this, url, init);
        });
      } else if (stage === "decode_pass") {
        // Queued first, so this pass for another scope is the one the page gets.
        await f.preparePass({ scope: "payments:admin" });
      }
      await f.prepareStatusResponse(stage === "decode_status" ? { private: "synthetic-private-response" } : { state: "disconnected", mode: "test" }, stage === "http_status" ? 503 : 200);
      const page = JSON.stringify(await f.page());
      assert.match(page, /Payments setup check failed/);
      assert.ok(page.includes(`status_${stage === "http_status" ? "fetch_status" : stage}`));
      if (stage === "http_status") assert.match(page, /HTTP 503/);
      assert.doesNotMatch(page, /Checking Payments setup|synthetic-private|"action_id":"setup_processor"|Connect payments first/);
      assert.match(page, /"action_id":"check"/);
      assert.equal(host.http.requests().some(r => r.method !== "GET" && r.url !== PASSES), false);
      vi.restoreAllMocks(); host.http.clear();
      await f.prepareStatusResponse({ state: "disconnected", mode: "test" });
      const recovered = JSON.stringify(await f.action("check"));
      assert.doesNotMatch(recovered, /Support code|check failed/);
      assert.match(recovered, /No processor account is connected/);
      assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, STATUS]);
    } finally { vi.restoreAllMocks(); await host.dispose(); }
  });
}

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
    assert.match(JSON.stringify(pending), /this page checks your approval on its own/);
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
    assert.match(JSON.stringify(ready), /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.match(JSON.stringify(ready), /"action_id":"check"/);
    assert.doesNotMatch(JSON.stringify(ready), /Not ready to sell/);
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
      ["POST", CONNECT], ["POST", `${CONNECT}/token`], ["GET", JWKS], ["GET", STATUS],
    ]);
    await f.prepareStatus();
    assert.match(JSON.stringify(await f.action("check")), /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.deepEqual(host.http.requests().map(r => [r.method, r.url]), [
      ["POST", CONNECT], ["POST", `${CONNECT}/token`], ["GET", JWKS], ["GET", STATUS], ["POST", PASSES], ["GET", STATUS],
    ]);
    const exchange = host.http.requests()[1];
    assert.deepEqual(Object.keys(body(exchange)).sort(), ["client_id", "code_verifier", "connection_id"]);
    assert.equal(body(exchange).client_id, "dinkus-payments-emdash");
    assert.equal(body(exchange).connection_id, "connection-one");
    assert.ok(body(exchange).code_verifier === secret.verifier, "exchange uses the persisted PKCE verifier");
    assert.ok(host.http.requests()[3].headers.authorization === `Bearer ${token}`, "Continue's status read uses the verified session token");
    // Check trades the store key at DinkusKit.com only, and reads status with that pass.
    const pass = host.http.requests()[4];
    assert.ok(pass.headers.authorization === `Bearer ${STORE_KEY}`, "the store key goes to store-passes");
    assert.deepEqual(body(pass), { site_id: "synthetic-site", scope: "payments:checkout", audience: "dinkus-payments" });
    assert.equal(host.http.requests().filter(r => r.headers.authorization === `Bearer ${STORE_KEY}`).length, 1);
    const status = host.http.requests()[5];
    assert.ok(status.headers.authorization?.startsWith("Bearer ey") && status.headers.authorization !== `Bearer ${token}`, "status uses the store's fresh pass");
    assert.equal(status.headers["x-dinkus-site"], "synthetic-site");
    assert.equal(status.body.length, 0);
    assert.equal((await f.receipt("connection-one")).status, 404);
    const persisted = await snapshot(host);
    await host.restart();
    assert.deepEqual(await snapshot(host), persisted);
    host.http.clear();
    await f.prepareStatus();
    assert.match(JSON.stringify(await f.page()), /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.deepEqual(await snapshot(host), persisted);
    assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, STATUS]);
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
    // Past the page's own sign-in, status is read with a fresh store pass and nothing asks to sign in.
    await f.prepareStatus();
    const lapsed = JSON.stringify(await f.page());
    assert.match(lapsed, /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.doesNotMatch(lapsed, /Sign in again|Last checked/);
    assert.deepEqual(await snapshot(host), expired);
    assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, STATUS]);
    host.http.clear();
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
    assert.match(JSON.stringify(await f.action("continue")), /Connected: Stripe test mode\. Test card payments work at checkout/);
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
    assert.match(JSON.stringify(await f.action("continue")), /Connected: Stripe test mode\. Test card payments work at checkout/);
    const persisted = await snapshot(host);
    // Runtime-host entries share the parsed manifest arrays. Narrow this test
    // host's policy and restart its production runner; the built code and
    // repository manifest stay unchanged. DinkusKit.com remains permitted, status does not.
    assert.deepEqual(host.manifest.allowedHosts, ["dinkuskit.com", "payments.dinkuskit.com"]);
    host.manifest.allowedHosts!.splice(1, 1);
    await host.restart();
    host.http.clear();
    await f.prepareStatus(); // A valid reply is queued: policy must reject first.
    const denied = await f.page();
    assert.match(JSON.stringify(denied), /Payments setup check failed/);
    assert.match(JSON.stringify(denied), /status_fetch_status/);
    assert.match(JSON.stringify(denied), /"action_id":"check"/);
    assert.doesNotMatch(JSON.stringify(denied), /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.deepEqual(host.http.requests().map(r => r.url), [PASSES]);
    assert.equal(host.http.requests().filter(r => r.url === STATUS).length, 0);
    assert.deepEqual(await snapshot(host), persisted);
    // Restore only this test host's policy. The already-queued status reply is
    // consumed now, showing that denial happened before the transport seam.
    host.manifest.allowedHosts!.push("payments.dinkuskit.com");
    await host.restart();
    await f.prepareStatus();
    assert.match(JSON.stringify(await f.page()), /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, PASSES, STATUS]);
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
    assert.match(ready, /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.doesNotMatch(ready, /Continue setup at Stripe/);
    assert.ok(host.http.requests().some(r => r.url === STATUS));
    const other = await host.fixtures.user({ email: "other-admin@example.invalid", role: "admin" });
    // Another admin, or this one after the sign-in lapsed, sees the current status and Sign in again.
    host.http.clear(); await f.prepareStatus("setup");
    const otherPage = JSON.stringify(await host.admin.act("/status", "setup_processor", { user: other }));
    assert.doesNotMatch(otherPage, /Continue setup at Stripe/);
    assert.match(otherPage, /Changing your Stripe setup needs a fresh DinkusKit sign-in.*"label":"Sign in again","action_id":"connect"/);
    assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, STATUS]);
    const subscriber = await host.fixtures.user({ email: "setup-subscriber@example.invalid", role: "subscriber" });
    const denied = await host.actions.routes.request("admin", { method: "POST", body: { type: "block_action", action_id: "setup_processor" }, user: subscriber });
    assert.equal(denied.status, 403);
    await host.fixtures.plugin.kv(CONTROL, { ...await control(host), expiresAt: Date.now() - 1 });
    host.http.clear(); await f.prepareStatus("setup");
    assert.match(JSON.stringify(await f.action("setup_processor")), /Changing your Stripe setup needs a fresh DinkusKit sign-in/);
    assert.equal(host.http.requests().some(r => r.url === endpoint), false);
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


test("compiled provider identity is explicit, bounded and preserves stored state and prior failure", async () => {
  const f = await fixture({ installedId: "r_3brsc2on3bu673rn" }); const { host } = f;
  try {
    await f.prepareStart("identity-proof"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue"); host.http.clear();
    await f.prepareStatus(); await f.action("check");
    assert.equal(host.http.requests().filter(r => r.url.endsWith("/provider-identity")).length, 0);
    host.http.clear();
    const saved = await snapshot(host);
    const calls: string[] = [];
    for (const name of ["kvGetVersioned", "kvCompareAndSet", "settingsGetVersioned", "settingsCompareAndSet", "httpFetch"] as const) {
      const original = PluginBridge.prototype[name];
      vi.spyOn(PluginBridge.prototype, name).mockImplementation(async function(...args: unknown[]) {
        if (!name.startsWith("kv") || args[0] === CONTROL) calls.push(name);
        return (original as (...args: unknown[]) => Promise<unknown>).apply(this,args);
      } as never);
    }
    await f.prepareIdentity({result:"match",validTestPrefix:true,httpStatus:200,at:Date.now(),diagnostics:{state:"connecting",mode:"test",processorAccountPresent:false,evidence:"observed",lastFailure:{category:"unknown",status:400,at:Date.now()-1000}}});
    const page = JSON.stringify(await f.action("check_provider_identity"));
    assert.match(page,/platform identity matches/); assert.match(page,/Recorded setup failure: unknown/); assert.match(page,/HTTP 400/);
    assert.equal(host.http.requests().filter(r=>r.url.endsWith("/provider-identity")).length,1);
    assert.ok(host.http.requests().every(r=>r.method==="GET"));
    assert.deepEqual(calls,["kvGetVersioned","settingsGetVersioned","httpFetch","kvGetVersioned","httpFetch","kvGetVersioned"]);
    assert.deepEqual(await snapshot(host),saved);
  } finally { vi.restoreAllMocks(); await host.dispose(); }
});

test("compiled provider identity rejects raw responses and unavailable server output", async () => {
  const f = await fixture(); const { host } = f;
  try {
    await f.prepareStart("identity-redaction"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue"); host.http.clear();
    for (const [status,payload] of [[503,{error:"PRIVATE_CANARY"}],[200,{result:"match",validTestPrefix:true,httpStatus:200,at:Date.now(),raw:"PRIVATE_CANARY"}]] as const) {
      await f.prepareIdentity(payload,status);
      const page=JSON.stringify(await f.action("check_provider_identity"));
      assert.match(page,/identity check is unavailable/); assert.doesNotMatch(page,/PRIVATE_CANARY/);
    }
  } finally { await host.dispose(); }
});

test("compiled provider identity rejects replaced flow after the read", async () => {
  const f = await fixture(); const { host } = f;
  try {
    await f.prepareStart("identity-race"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue"); host.http.clear();
    await f.prepareIdentity({result:"match",validTestPrefix:true,httpStatus:200,at:Date.now()});
    const original=PluginBridge.prototype.httpFetch;
    vi.spyOn(PluginBridge.prototype,"httpFetch").mockImplementation(async function(...args) {
      const result=await original.apply(this,args);
      if (String(args[0]).endsWith("/provider-identity")) await host.fixtures.plugin.kv(CONTROL,{...await control(host),flowId:"replacement"});
      return result;
    });
    const page=JSON.stringify(await f.action("check_provider_identity"));
    assert.doesNotMatch(page,/platform identity matches/);
    assert.equal((await control(host)).flowId,"replacement");
  } finally { vi.restoreAllMocks(); await host.dispose(); }
});

test("compiled Check exposes an exact support reference without extra requests or state changes",async()=>{
 const f=await fixture();const {host}=f;
 try {
  await f.prepareStart("support-reference-flow");await f.action("connect");await f.pollDue();await f.prepareExchange();await f.action("continue");host.http.clear();
  const before=await snapshot(host),at=Date.now()-1234;
  await f.prepareStatusResponse({state:"connecting",mode:"test",bindingRef:"stripe_support_fixture"});
  await host.http.respond("https://payments.dinkuskit.com/v1/connect/diagnostics",Response.json({state:"connecting",mode:"test",processorAccountPresent:false,evidence:"observed",lastFailure:{category:"unknown",status:400,at}}));
  const page=await f.action("check");const ref=page.blocks.find((b:{text?:string})=>b.text?.startsWith("Setup support reference: "));
  assert.deepEqual(JSON.parse(ref.text.slice("Setup support reference: ".length)),{bindingRef:"stripe_support_fixture",failureAt:at,category:"unknown",httpStatus:400});
  assert.ok(host.http.requests().every(r=>r.method==="GET"||r.url===PASSES));assert.equal(host.http.requests().filter(r=>r.url===STATUS).length,1);assert.equal(host.http.requests().filter(r=>r.url.endsWith("/diagnostics")).length,1);assert.deepEqual(await snapshot(host),before);
  // Another admin reads the store's status, but the admin-only failure detail needs their own sign-in.
  const other=await host.fixtures.user({email:"support-other@example.invalid",role:"admin"});host.http.clear();
  await f.prepareStatusResponse({state:"connecting",mode:"test",bindingRef:"stripe_support_fixture"});
  const otherPage=JSON.stringify(await host.admin.act("/status","check",{user:other}));
  assert.doesNotMatch(otherPage,/Setup support reference/);assert.match(otherPage,/What the last setup attempt recorded.*"label":"Sign in again","action_id":"connect"/);
  assert.deepEqual(host.http.requests().map(r=>r.url),[PASSES,STATUS]);assert.deepEqual(await snapshot(host),before);
 } finally {await host.dispose();}
});

test("compiled beta Registry installation identity (r_sffx6l4z6mpqliki) uses beta callback and proof paths alongside stable (r_3brsc2on3bu673rn)", async () => {
  for (const installedId of ["r_3brsc2on3bu673rn", "r_sffx6l4z6mpqliki"] as const) {
    const f = await fixture({ installedId });
    const { host } = f;
    try {
      await f.prepareStart(`conn-${installedId}`);
      await f.action("connect");
      const start = host.http.requests()[0];
      assert.equal(body(start).callback_uri, `${SITE}/_emdash/admin/plugins/${installedId}/status`);
      const proof = await f.receipt(`conn-${installedId}`);
      assert.equal(proof.status, 200);
      const receipt = await proof.json() as Record<string, unknown>;
      assert.equal(receipt.callback_uri, `${SITE}/_emdash/admin/plugins/${installedId}/status`);
      await f.pollDue();
      await f.prepareExchange(`conn-${installedId}`);
      assert.match(JSON.stringify(await f.action("continue")), /Connected: Stripe test mode\. Test card payments work at checkout/);
      await f.prepareStatus();
      assert.match(JSON.stringify(await f.action("check")), /Connected: Stripe test mode\. Test card payments work at checkout/);
    } finally {
      await host.dispose();
    }
  }
});

test("compiled page load after DinkusKit's Approve finishes sign-in and shows the connection", async () => {
  const f = await fixture(); const { host } = f;
  try {
    await f.prepareStart("approved-on-return"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange();
    const page = JSON.stringify(await f.page());
    assert.match(page, /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.equal((await control(host)).phase, "complete");
  } finally { await host.dispose(); }
});

test("compiled Continue pressed inside the poll interval waits it out within ten bridge calls", async () => {
  const f = await fixture(); const { host } = f;
  const calls: string[] = [];
  try {
    // prepareStart answers interval 1, so the poll is about a second away.
    await f.prepareStart("continue-early"); await f.action("connect");
    await f.prepareExchange();
    for (const name of ["kvGet", "kvSet", "kvGetVersioned", "kvCompareAndSet", "settingsGetVersioned", "settingsCompareAndSet", "httpFetch"] as const) {
      const original = PluginBridge.prototype[name];
      vi.spyOn(PluginBridge.prototype, name).mockImplementation(async function(...args: unknown[]) {
        if (!name.startsWith("kv") || !String(args[0]).startsWith("settings:")) {
          calls.push(name);
          if (calls.length > 10) throw new Error("synthetic_subrequest_limit");
        }
        return (original as (...args: unknown[]) => Promise<unknown>).apply(this, args);
      } as never);
    }
    const page = JSON.stringify(await f.action("continue"));
    assert.match(page, /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.equal(calls.length, 10);
    assert.equal(host.http.requests().filter(r => r.url.endsWith("/token")).length, 1);
  } finally { vi.restoreAllMocks(); await host.dispose(); }
});

test("compiled Approve with no store key from DinkusKit.com shows the status read at approval, to that admin only", async () => {
  const f = await fixture({ storeKey: null }); const { host } = f;
  try {
    await f.prepareStart("approve-then-lapse"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue");
    await host.fixtures.plugin.kv(CONTROL, { ...await control(host), expiresAt: Date.now() - 1 });
    host.http.clear();
    const page = await f.page();
    assert.equal(page.blocks[1].title, "Connected: Stripe test mode");
    assert.match(String(page.blocks[1].description), /^Last checked .* UTC\. Select Connect again so this page can check it now/);
    assert.match(JSON.stringify(page), /"label":"Connect again","action_id":"connect"/);
    assert.doesNotMatch(JSON.stringify(page), /Sign in again/);
    assert.deepEqual(host.http.requests(), []);
    const other = await host.fixtures.user({ email: "other-admin@example.invalid", role: "admin" });
    const otherPage = await host.admin.loadPage("/status", { user: other });
    assert.equal(otherPage.blocks[1].title, "Payment status not checked");
  } finally { await host.dispose(); }
});

test("compiled sessions saved by the previous release keep working with no remembered status", async () => {
  const f = await fixture(); const { host } = f;
  try {
    await f.prepareStart("previous-release"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue");
    // The control 0.2.8 persisted: no lastStatus, no state:last-status. The key itself
    // comes from this release's Connect; the released 0.3.0 key setup is the next test.
    const { lastStatus: _dropped, ...previous } = await control(host) as Record<string, unknown>;
    await host.fixtures.plugin.kv(CONTROL, previous);
    assert.equal(await host.inspect.kv.get("state:last-status"), null);
    const saved = await snapshot(host);
    // A lapsed previous-release sign-in no longer matters: status comes from the store key.
    await host.fixtures.plugin.kv(CONTROL, { ...previous, expiresAt: Date.now() - 1 });
    host.http.clear(); await f.prepareStatus();
    const lapsed = JSON.stringify(await f.page());
    assert.match(lapsed, /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.doesNotMatch(lapsed, /Sign in again/);
    assert.deepEqual(host.http.requests().map(r => r.url), [PASSES, STATUS]);
    // An active previous-release sign-in keeps its saved authorization.
    await host.fixtures.plugin.kv(CONTROL, previous);
    await f.prepareStatus();
    assert.match(JSON.stringify(await f.page()), /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.deepEqual((await snapshot(host)).setting, saved.setting);
    assert.equal((await control(host)).flowId, saved.control.flowId);
  } finally { await host.dispose(); }
});


test("a store set up with released 0.3.0 asks for Connect again, then reads status with its own key", async () => {
  // Exactly what 0.3.0 saved: a session with no store key in it, and the pasted key
  // in its own "storeKey" setting. This release retires the paste (store-connect-082).
  const f = await fixture({ storeKey: null }); const { host } = f;
  try {
    await f.prepareStart("released-0-3-0"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange(); await f.action("continue");
    await host.fixtures.plugin.setting("storeKey", STORE_KEY);
    assert.equal("storeKey" in await session(host), false);
    await host.fixtures.plugin.kv(CONTROL, { ...await control(host), expiresAt: Date.now() - 1 });
    host.http.clear();
    const page = await f.page();
    assert.match(JSON.stringify(page), /"label":"Connect again","action_id":"connect"/);
    assert.doesNotMatch(JSON.stringify(page), /Paste|Sign in again/);
    assert.deepEqual(host.http.requests(), [], "the old pasted key is never sent anywhere");
    // Connect again: DinkusKit.com hands over this plugin's own key, and status reads with it.
    const fresh = `dk_store_${"F".repeat(43)}`;
    f.issueKey(fresh);
    await f.prepareStart("released-0-3-0-again"); await f.action("connect"); await f.pollDue();
    await f.prepareExchange();
    assert.match(JSON.stringify(await f.action("continue")), /Connected: Stripe test mode\. Test card payments work at checkout/);
    assert.equal((await session(host)).storeKey, fresh);
    host.http.clear(); await f.prepareStatus();
    assert.match(JSON.stringify(await f.page()), /Connected: Stripe test mode\. Test card payments work at checkout/);
    const passes = host.http.requests().filter(r => r.url === PASSES);
    assert.equal(passes.length, 1);
    assert.equal(passes[0].headers.authorization, `Bearer ${fresh}`);
    assert.equal(host.http.requests().some(r => JSON.stringify(r.headers).includes(STORE_KEY)), false);
  } finally { await host.dispose(); }
});

test("compiled operator preparation requires confirmation and keeps the held grant private", async () => {
  const f = await fixture(); const { host } = f;
  try {
    await f.prepareStart("legacy-recovery"); await f.action("connect"); await f.pollDue();
    const token = await f.prepareExchange(); await f.action("continue"); host.http.clear();
    await f.prepareDiagnostics("recovery_required", { state: "recovery_required", mode: "test", processorAccountPresent: false, evidence: "observed", lastFailure: { category: "unknown", status: 400, at: Date.now() - 86400000 } });
    const start = JSON.stringify(await f.action("check"));
    assert.match(start, /review_legacy_v2/);
    host.http.clear(); await f.prepareSession();
    const confirmation = JSON.stringify(await f.action("review_legacy_v2"));
    assert.match(confirmation, /Confirm recovery preparation/);
    assert.equal(host.http.requests().some(r => r.method === "POST"), false);
    host.http.clear(); await f.prepareSession();
    await host.http.respond("https://payments.dinkuskit.com/v1/connect/reconcile-legacy-rejection", Response.json({
      state: "prepared", mode: "test", bindingRef: "stripe_synthetic", operationId: "synthetic-operation", preparedAt: Date.now(),
    }));
    const result = JSON.stringify(await f.action("prepare_legacy_v2"));
    assert.match(result, /Recovery preparation saved/);
    assert.doesNotMatch(result, /setup_processor|prepare_legacy_v2/);
    assert.equal(result.includes(token), false);
    const posts = host.http.requests().filter(r => r.method === "POST");
    assert.equal(posts.length, 1); assert.equal(posts[0].url, "https://payments.dinkuskit.com/v1/connect/reconcile-legacy-rejection");
    assert.equal(posts[0].body.byteLength, 0);
    const another = await host.fixtures.user({ email: "another-admin@example.invalid", role: "admin" });
    host.http.clear(); await f.prepareStatus();
    assert.match(JSON.stringify(await host.admin.act("/status", "prepare_legacy_v2", { user: another })), /Sign in again/);
    assert.equal(host.http.requests().some(r => r.url.endsWith("/reconcile-legacy-rejection")), false);
  } finally { await host.dispose(); }
});
