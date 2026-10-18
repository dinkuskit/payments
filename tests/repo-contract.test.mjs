import assert from "node:assert/strict";
import test from "node:test";

import {
  auditRepository,
  auditWorkflowActionPins,
  repositoryRoot,
} from "../scripts/repo-contract.mjs";

test("the package satisfies the public repository contract", async () => {
  assert.deepEqual(await auditRepository(repositoryRoot), []);
});

test("auditWorkflowActionPins enforces 40-char commit SHA pinning and allows local reusable workflows", () => {
  const valid = `
jobs:
  build:
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
  delegated:
    uses: ./.github/workflows/emdash-release.yml
`;
  assert.deepEqual(auditWorkflowActionPins(valid, ".github/workflows/release.yml"), []);

  const unpinned = `
jobs:
  build:
    steps:
      - uses: actions/create-github-app-token@v1
      - uses: actions/upload-artifact@v4
`;
  const findings = auditWorkflowActionPins(unpinned, ".github/workflows/release.yml");
  assert.equal(findings.length, 2);
  assert.match(findings[0], /actions\/create-github-app-token@v1/);
  assert.match(findings[1], /actions\/upload-artifact@v4/);
});
