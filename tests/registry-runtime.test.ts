import assert from "node:assert/strict";
import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { test } from "vitest";

test("loads the built registry plugin and validates its private status page", async () => {
  const host = await createPluginRuntimeTestHost();
  try {
    assert.equal(host.manifest.id, "dinkus-payments");
    assert.equal(host.manifest.capabilities.length, 0);
    assert.equal(host.manifest.admin.pages[0].path, "/status");

    const page = await host.admin.loadPage("/status");
    assert.equal(page.blocks[1].type, "banner");
    assert.match(JSON.stringify(page), /Status unavailable/);
    assert.doesNotMatch(JSON.stringify(page), /"action_id":"connect"/);
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
