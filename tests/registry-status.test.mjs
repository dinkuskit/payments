import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeStatus,
  unavailableStatusProjection,
} from "../src/registry/status.ts";
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
});

test("rejects provider fields, missing fields, invalid modes, and extra fields", () => {
  for (const value of [
    { state: "ready", mode: "test", providerId: "stripe" },
    { state: "ready" },
    { state: "ready", mode: "sandbox" },
    { state: "unknown", mode: "test" },
    { state: "ready", mode: "test", bindingRef: "" },
  ]) {
    assert.throws(() => decodeStatus(value), /invalid_status/);
  }
});

test("production projection stays unavailable", () => {
  assert.deepEqual(unavailableStatusProjection(), {
    availability: "unavailable",
    status: null,
    message: "Connect your DinkusKit account to check payment setup. Account connection is not available in this build.",
  });
});

test("admin route is read-only and has no connect action", async () => {
  const response = await plugin.routes.admin.handler(
    { input: { type: "page_load", page: "/status" } },
    {},
  );
  const serialized = JSON.stringify(response);
  assert.match(serialized, /Status unavailable/);
  assert.match(serialized, /Not checked/);
  assert.doesNotMatch(serialized, /"action_id":"connect"/);
});
