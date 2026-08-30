import assert from "node:assert/strict";
import test from "node:test";

import { auditRepository, repositoryRoot } from "../scripts/repo-contract.mjs";

test("the committed scaffold satisfies the public repository contract", async () => {
  assert.deepEqual(await auditRepository(repositoryRoot), []);
});
