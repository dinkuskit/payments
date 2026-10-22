import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { syncLockVersion } from "../scripts/sync-lock-version.mjs";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

test("release:version changes only the lockfile's two version fields", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.match(pkg.scripts["release:version"], /sync-lock-version\.mjs/);
  assert.doesNotMatch(pkg.scripts["release:version"], /npm install/);
  const before = await read("../package-lock.json");
  const after = JSON.parse(syncLockVersion(before, "9.9.9"));
  const original = JSON.parse(before);
  assert.equal(after.version, "9.9.9");
  assert.equal(after.packages[""].version, "9.9.9");
  original.version = "9.9.9";
  original.packages[""].version = "9.9.9";
  assert.deepEqual(after, original);
  assert.equal(syncLockVersion(before, JSON.parse(before).version), before);
  assert.throws(() => syncLockVersion("{}", "1.0.0"), /no "version"/);
});
