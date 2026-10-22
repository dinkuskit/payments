#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// release:version runs this after `changeset version`. It copies package.json's new version into
// package-lock.json and changes nothing else. `npm install --package-lock-only` used to do this, but
// it also re-resolves the tree and can drop or add records, and the release tag job refuses any
// lockfile change beyond the version fields since the approved beta.
export function syncLockVersion(lockSource, version) {
  const lock = JSON.parse(lockSource);
  if (typeof lock.version !== "string" || typeof lock.packages?.[""]?.version !== "string") {
    throw new Error('package-lock.json has no "version" or packages[""].version to sync');
  }
  lock.version = version;
  lock.packages[""].version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const before = readFileSync("package-lock.json", "utf8");
  const after = syncLockVersion(before, version);
  if (after !== before) {
    writeFileSync("package-lock.json", after);
    console.log(`Synced package-lock.json version to ${version}.`);
  }
}
