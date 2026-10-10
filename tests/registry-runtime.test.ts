import assert from "node:assert/strict";
import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { test } from "vitest";

test("loads the built registry plugin and validates its private status page", async () => {
  const host = await createPluginRuntimeTestHost();
  try {
    assert.equal(host.manifest.id, "dinkus-payments");
    assert.deepEqual(host.manifest.capabilities, ["network:request"]);
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
