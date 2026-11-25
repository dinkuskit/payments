import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { repositoryRoot } from "../scripts/repo-contract.mjs";
import {
  auditWorkflowSecretGate,
  auditWorkflowSecretGates,
  findPermissionGate,
} from "../scripts/workflow-secret-gate.mjs";

const gatedCall = `
on:
  issue_comment:
    types: [created]
jobs:
  gate:
    runs-on: ubuntu-latest
    outputs:
      allowed: \${{ steps.check.outputs.allowed }}
    steps:
      - id: check
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          permission=$(gh api "repos/$GITHUB_REPOSITORY/collaborators/$ACTOR/permission" --jq .permission)
          case "$permission" in admin|maintain|write) echo allowed=true >> "$GITHUB_OUTPUT" ;; esac
  call:
    needs: gate
    if: needs.gate.outputs.allowed == 'true'
    uses: owner/repo/.github/workflows/review.yml@0123456789abcdef0123456789abcdef01234567
    secrets:
      TOKEN: \${{ secrets.TOKEN }}
`;

test("repository workflows gate every secret-bearing reusable call on untrusted triggers", async () => {
  assert.deepEqual(await auditWorkflowSecretGates(repositoryRoot), []);
});

test("auditWorkflowSecretGate accepts a permission-gated secret-bearing call", () => {
  assert.deepEqual(auditWorkflowSecretGate(gatedCall), []);
  assert.deepEqual(
    auditWorkflowSecretGate(gatedCall.replace("on:\n  issue_comment:", "on:\n  pull_request_target:")),
    [],
  );
});

test("auditWorkflowSecretGate rejects pull_request_target and issue_comment calls that pass secrets without a gate", () => {
  const ungated = `
on: [pull_request_target]
jobs:
  call:
    uses: owner/repo/.github/workflows/review.yml@0123456789abcdef0123456789abcdef01234567
    secrets: inherit
`;
  const [finding] = auditWorkflowSecretGate(ungated, ".github/workflows/review.yml");
  assert.match(finding, /^pull_request_target job passes secrets/);
  assert.match(finding, /jobs\.call: no job in needs runs a permission gate first/);

  const cases = [
    {
      label: "needs a job with no permission check",
      workflow: gatedCall.replace(/permission=.*\n.*\n/, "echo allowed=true >> \"$GITHUB_OUTPUT\"\n"),
      reason: /no job in needs runs a permission gate first/,
    },
    {
      label: "gate runs but the call ignores its result",
      workflow: gatedCall.replace("if: needs.gate.outputs.allowed == 'true'", "if: always()"),
      reason: /if: does not consume needs\.gate\.outputs\.allowed/,
    },
    {
      label: "gate output does not come from the permission step",
      workflow: gatedCall.replace("steps.check.outputs.allowed", "steps.other.outputs.allowed"),
      reason: /gate checks permission but exposes no output from that step/,
    },
    {
      label: "permission check only in the gate job if:, not a step",
      workflow: gatedCall
        .replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    if: contains(fromJSON('[\"OWNER\"]'), github.event.comment.author_association)\n")
        .replace(/permission=.*\n.*\n/, "echo allowed=true >> \"$GITHUB_OUTPUT\"\n"),
      reason: /no job in needs runs a permission gate first/,
    },
  ];
  for (const { label, workflow, reason } of cases) {
    const findings = auditWorkflowSecretGate(workflow);
    assert.equal(findings.length, 1, label);
    assert.match(findings[0], /^issue_comment job passes secrets to owner\/repo/, label);
    assert.match(findings[0], reason, label);
  }
});

test("auditWorkflowSecretGate ignores trusted triggers and calls that pass no secrets", () => {
  const ungated = `
on:
  pull_request:
jobs:
  call:
    uses: ./.github/workflows/review.yml
    secrets: inherit
`;
  assert.deepEqual(auditWorkflowSecretGate(ungated), []);
  assert.deepEqual(
    auditWorkflowSecretGate(ungated.replace("pull_request:", "pull_request_target:").replace("    secrets: inherit\n", "")),
    [],
  );
});

// Runs the real ClawSweeper gate step against a stubbed `gh` so the fixture
// proves who reaches the secret-bearing `uses:` job, not just its shape.
async function runClawSweeperGate({ eventName, event, permission }) {
  const workflow = parse(await readFile(join(repositoryRoot, ".github/workflows/clawsweeper-dispatch.yml"), "utf8"));
  const gate = findPermissionGate(workflow.jobs, "review");
  assert.equal(gate.reason, undefined);
  assert.match(workflow.jobs.review.if, new RegExp(`needs\\.${gate.gateId}\\.outputs\\.${gate.outputName} == 'true'`));
  const step = workflow.jobs[gate.gateId].steps.find((candidate) => candidate.id === gate.stepId);

  const scratch = await mkdtemp(join(tmpdir(), "workflow-secret-gate-"));
  try {
    const repoId = Number(step.env.TARGET_ID);
    const responses = {
      [`repos/${step.env.TARGET_REPO}`]: { id: repoId, default_branch: "main" },
      [`repos/${step.env.TARGET_REPO}/pulls/7`]: {
        state: "open",
        draft: false,
        user: { login: "contributor", type: "User" },
        base: { repo: { id: repoId }, ref: "main", sha: "a".repeat(40) },
        head: { sha: "b".repeat(40) },
      },
    };
    if (permission) {
      responses[`repos/${step.env.TARGET_REPO}/collaborators/${event.sender.login}/permission`] = { permission };
    }
    const gh = join(scratch, "gh");
    await writeFile(
      gh,
      `#!/usr/bin/env node
const responses = ${JSON.stringify(responses)};
require("node:fs").appendFileSync(${JSON.stringify(join(scratch, "calls"))}, \`\${process.argv[3]}\\n\`);
const body = process.argv[2] === "api" ? responses[process.argv[3]] : undefined;
if (!body) process.exit(1);
process.stdout.write(JSON.stringify(body));
`,
    );
    await chmod(gh, 0o755);
    const eventPath = join(scratch, "event.json");
    const outputPath = join(scratch, "output");
    await writeFile(eventPath, JSON.stringify(event));
    await writeFile(outputPath, "");
    await writeFile(join(scratch, "calls"), "");

    const result = spawnSync("bash", ["-c", step.run], {
      encoding: "utf8",
      env: {
        PATH: `${scratch}${delimiter}${process.env.PATH}`,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GH_TOKEN: "fixture",
        TARGET_REPO: step.env.TARGET_REPO,
        TARGET_ID: step.env.TARGET_ID,
        PR_NUMBER: "7",
        MANUAL_PUBLISH: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = Object.fromEntries(
      (await readFile(outputPath, "utf8")).split("\n").filter(Boolean).map((line) => line.split("=")),
    );
    const calls = (await readFile(join(scratch, "calls"), "utf8")).split("\n").filter(Boolean);
    return { output, calls };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function comment(authorAssociation) {
  return {
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/dinkuskit/payments/pulls/7" } },
    comment: { body: "@clawsweeper review", user: { login: "commenter", type: "User" }, author_association: authorAssociation },
    sender: { login: "commenter", type: "User" },
  };
}

function label(login) {
  return { action: "labeled", label: { name: "clawsweeper:review" }, pull_request: { number: 7 }, sender: { login, type: "User" } };
}

test("the ClawSweeper gate rejects a commenter without repository access before the secret-bearing uses:", async () => {
  for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"]) {
    const { output, calls } = await runClawSweeperGate({ eventName: "issue_comment", event: comment(association) });
    // The comment reached the association check (the PR was read) and stopped there.
    assert.deepEqual(calls, ["repos/dinkuskit/payments", "repos/dinkuskit/payments/pulls/7"], association);
    assert.equal(output.requested, "false", association);
  }
  const { output: maintainer } = await runClawSweeperGate({ eventName: "issue_comment", event: comment("MEMBER") });
  assert.equal(maintainer.requested, "true");
  assert.equal(maintainer.pr_number, "7");
});

test("the ClawSweeper gate rejects a review label from a sender without write permission before the secret-bearing uses:", async () => {
  for (const permission of ["read", "triage", undefined]) {
    const { output, calls } = await runClawSweeperGate({ eventName: "pull_request_target", event: label("outsider"), permission });
    assert.equal(calls.at(-1), "repos/dinkuskit/payments/collaborators/outsider/permission", String(permission));
    assert.equal(output.requested, "false", String(permission));
  }
  const { output: writer } = await runClawSweeperGate({ eventName: "pull_request_target", event: label("writer"), permission: "write" });
  assert.equal(writer.requested, "true");
  assert.equal(writer.force_label_by, "writer");
});
