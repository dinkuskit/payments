import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parsePort, safeNewRunDirectory } from "../scripts/registry-status-proof.mjs";

test("proof harness rejects malformed and unsafe ports", () => {
  for (const value of ["", "80", "65536", "4387x", "-1"]) {
    assert.throws(() => parsePort(value), /port/);
  }
  assert.equal(parsePort("4387"), 4387);
});

test("proof harness accepts one new external directory and rejects reuse", async () => {
  const parent = await mkdtemp(join(tmpdir(), "payments-proof-test-"));
  const run = join(parent, "run");
  try {
    assert.equal(await safeNewRunDirectory(run), run);
    await assert.rejects(safeNewRunDirectory(run), /must not already exist/);
    await assert.rejects(safeNewRunDirectory(join(process.cwd(), "runs")), /outside the repository/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("proof harness rejects a parent symlink into the repository", async () => {
  const parent = await mkdtemp(join(tmpdir(), "payments-proof-symlink-"));
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    await symlink(repository, join(parent, "linked"), "dir");
    await assert.rejects(safeNewRunDirectory(join(parent, "linked", "run")), /outside the repository/);
    await assert.rejects(safeNewRunDirectory("relative-run"), /absolute path/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
