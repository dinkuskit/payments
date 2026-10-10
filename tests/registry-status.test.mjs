import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeStatus,
  unavailableStatusProjection,
} from "../src/registry/status.ts";
import {
  projectSetupScreen,
  renderSetupScreen,
} from "../src/registry/setup.ts";
import plugin from "../src/plugin.ts";

test("decodes every status state and preserves only the public status shape", () => {
  for (const state of [
    "disconnected",
    "connecting",
    "setup_required",
    "ready",
    "checking",
    "action_required",
    "recovery_required",
  ]) {
    assert.deepEqual(decodeStatus({ state, mode: "test" }), { state, mode: "test" });
  }
  assert.deepEqual(
    decodeStatus({ state: "ready", mode: "live", bindingRef: "binding-1" }),
    { state: "ready", mode: "live", bindingRef: "binding-1" },
  );
  assert.deepEqual(
    decodeStatus({
      state: "ready",
      mode: "test",
      bindingRef: "binding-1",
      connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_one" },
    }),
    {
      state: "ready",
      mode: "test",
      bindingRef: "binding-1",
      connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_one" },
    },
  );
  assert.deepEqual(
    decodeStatus({
      state: "ready",
      mode: "test",
      connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported" },
    }),
    {
      state: "ready",
      mode: "test",
      connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported" },
    },
  );
});

test("rejects provider fields, missing fields, invalid modes, and extra fields", () => {
  for (const value of [
    { state: "ready", mode: "test", providerId: "stripe" },
    { state: "ready" },
    { state: "ready", mode: "sandbox" },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "unsupported" } },
    { state: "checking", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "unknown" } },
    { state: "unknown", mode: "test" },
    { state: "ready", mode: "test", bindingRef: "" },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "live", result: "verified", accountRef: "acct_one" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "verified" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "merchant-one" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "authorize_net", mode: "test", result: "verified" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "authorize_net", mode: "test", result: "unsupported", accountRef: "merchant-one" } },
    { state: "action_required", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "verified", accountRef: "acct_one" } },
    { state: "ready", mode: "test", connectionEvidence: { provider: "stripe", mode: "test", result: "unknown", accountRef: "acct_one" } },
  ]) {
    assert.throws(() => decodeStatus(value), /invalid_status/);
  }
});

test("legacy status has no fabricated evidence", () => {
  assert.deepEqual(decodeStatus({ state: "ready", mode: "live" }), { state: "ready", mode: "live" });
});

test("production projection stays unavailable", () => {
  assert.deepEqual(unavailableStatusProjection(), {
    availability: "unavailable",
    status: null,
    message: "Connect your DinkusKit account to check payment setup. Account connection is not available in this build.",
  });
});

test("setup projection keeps Commerce TEST-order authority unknown", () => {
  const verifiedTest = projectSetupScreen({
    availability: "available",
    status: {
      state: "ready",
      mode: "test",
      connectionEvidence: {
        provider: "stripe",
        mode: "test",
        result: "verified",
        accountRef: "acct_one",
      },
    },
  });
  assert.equal(verifiedTest.overall, "Not ready to sell");
  assert.equal(verifiedTest.steps[0].status, "incomplete");
  assert.match(verifiedTest.steps[0].description, /TEST payments only/);
  assert.equal(verifiedTest.steps[1].status, "incomplete");
  assert.match(verifiedTest.steps[1].description, /paid TEST order visible in Commerce admin has not been confirmed/);

  const verifiedLive = projectSetupScreen({
    availability: "available",
    status: {
      state: "ready",
      mode: "live",
      connectionEvidence: {
        provider: "stripe",
        mode: "live",
        result: "verified",
        accountRef: "acct_one",
      },
    },
  });
  assert.equal(verifiedLive.steps[0].status, "complete");
  assert.equal(verifiedLive.steps[1].status, "incomplete");
  assert.equal(verifiedLive.overall, "Not ready to sell");
});

test("setup projection gives truthful provider next actions and fails closed", () => {
  for (const result of ["action_required", "unknown"]) {
    const screen = projectSetupScreen({
      availability: "available",
      status: {
        state: result === "action_required" ? "action_required" : "checking",
        mode: "test",
        connectionEvidence: {
          provider: "stripe",
          mode: "test",
          result,
          accountRef: "acct_one",
        },
      },
    });
    assert.equal(screen.steps[0].status, "incomplete");
    assert.match(screen.steps[0].description, /Stripe/);
    assert.doesNotMatch(screen.steps[0].description, /verified for TEST/);
  }

  const authorizeNet = projectSetupScreen({
    availability: "available",
    status: {
      state: "ready",
      mode: "test",
      connectionEvidence: {
        provider: "authorize_net",
        mode: "test",
        result: "unsupported",
      },
    },
  });
  assert.equal(authorizeNet.steps[0].status, "incomplete");
  assert.match(authorizeNet.steps[0].description, /not supported/);

  const malformed = projectSetupScreen({
    availability: "available",
    status: { state: "ready", mode: "test", provider: "stripe" },
  });
  assert.equal(malformed.steps[0].status, "incomplete");
  assert.match(malformed.steps[0].description, /unavailable/);
});

test("setup renderer has one screen with a usable connect action and no provider selector", () => {
  const serialized = JSON.stringify(renderSetupScreen(unavailableStatusProjection()));
  assert.match(serialized, /Payment setup/);
  assert.match(serialized, /Connect payments/);
  assert.match(serialized, /Place a test order/);
  assert.match(serialized, /Not ready to sell/);
  assert.match(serialized, /"action_id":"connect"/);
  assert.doesNotMatch(serialized, /provider selector|Authorize\.net.*Stripe/);
});

test("admin route is read-only and browser input cannot change output", async () => {
  const response = await plugin.routes.admin.handler(
    {
      input: {
        type: "page_load",
        page: "/status",
        status: {
          availability: "available",
          status: {
            state: "ready",
            mode: "live",
            connectionEvidence: {
              provider: "stripe",
              mode: "live",
              result: "verified",
              accountRef: "acct_browser",
            },
          },
          paid: true,
          ready: true,
        },
      },
      user: { id: "admin" },
    },
    {
      site: { url: "https://shop.example" },
      kv: { async get() { return null; }, async getVersioned() { return null; }, async compareAndSet() { return { applied: false }; }, async compareAndDelete() { return { applied: false }; } },
      settings: { async get() { return null; }, async getVersioned() { return null; }, async compareAndSet() { return { applied: false }; }, async compareAndDelete() { return { applied: false }; } },
    },
  );
  const serialized = JSON.stringify(response);
  assert.match(serialized, /Payment setup/);
  assert.match(serialized, /Not ready to sell/);
  assert.match(serialized, /paid TEST order visible in Commerce admin has not been confirmed/);
  assert.doesNotMatch(serialized, /acct_browser|"paid":true|"ready":true/);
});
