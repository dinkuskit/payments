import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  auditPins,
  auditRepositoryPins,
  collectSkillPins,
  collectWorkflowPins,
  fetchPinSources,
  loadReviewedPins,
  planSourceFetches,
} from "../scripts/pin-audit.mjs";
import { repositoryRoot } from "../scripts/repo-contract.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function manifestOf(...entries) {
  return JSON.stringify({
    pins: entries.map(([source, sha]) => ({ source, sha, review: "reviewed in example#1" })),
  });
}

test("every SHA this repository pins is listed in the reviewed-pins manifest", async () => {
  const { pins, findings } = await auditRepositoryPins(repositoryRoot);
  assert.deepEqual(findings, []);
  // The audit must be looking at all three kinds of pin, not passing on an empty list.
  const pinned = pins.map((pin) => `${pin.source} ${pin.where.split(":")[0]}`);
  assert.ok(pinned.includes("actions/checkout .github/workflows/repo-contract.yml"));
  assert.ok(pinned.includes("dinkuskit/clawsweeper .github/workflows/clawsweeper-dispatch.yml"));
  assert.ok(pinned.includes("saariuslystoned/SaariusSkills scripts/agent-skills"));
});

test("collectWorkflowPins resolves actions, action subdirectories and reusable workflows to their source repository", () => {
  const workflow = `
jobs:
  build:
    steps:
      - uses: actions/checkout@${SHA_A} # v7.0.0
      - name: Publish
        uses: emdash-cms/emdash/apps/release-action@${SHA_B}
  local:
    uses: ./.github/workflows/emdash-release.yml
  review:
    uses: dinkuskit/clawsweeper/.github/workflows/dinkuskit-native-canary.yml@${SHA_A}
`;
  assert.deepEqual(collectWorkflowPins(workflow, ".github/workflows/x.yml"), {
    pins: [
      { source: "actions/checkout", sha: SHA_A, where: ".github/workflows/x.yml:5" },
      { source: "emdash-cms/emdash", sha: SHA_B, where: ".github/workflows/x.yml:7" },
      { source: "dinkuskit/clawsweeper", sha: SHA_A, where: ".github/workflows/x.yml:11" },
    ],
    findings: [],
  });

  const unresolvable = collectWorkflowPins(
    "      - uses: actions/checkout@v7\n      - uses: docker://alpine:3\n",
    ".github/workflows/x.yml",
  );
  assert.deepEqual(unresolvable.pins, []);
  assert.equal(unresolvable.findings.length, 2);
  assert.match(unresolvable.findings[0], /x\.yml:1 \(actions\/checkout@v7\)/);
  assert.match(unresolvable.findings[1], /x\.yml:2 \(docker:\/\/alpine:3\)/);
});

test("collectSkillPins attributes each skill SHA to the repository the script names", () => {
  const script = `SAARIUS_REPO="https://github.com/saariuslystoned/SaariusSkills.git"
SAARIUS_SHA="${SHA_A}"
EMDASH_COMMERCE_SHA="${SHA_B}"
SAARIUS_DIR="$CACHE_DIR/saarius-$SAARIUS_SHA"
`;
  assert.deepEqual(collectSkillPins(script, "scripts/agent-skills"), {
    pins: [
      { source: "saariuslystoned/SaariusSkills", sha: SHA_A, where: "scripts/agent-skills:2" },
      { source: "saariuslystoned/SaariusSkills", sha: SHA_B, where: "scripts/agent-skills:3" },
    ],
    findings: [],
  });

  const inline = collectSkillPins(
    `SAARIUS_REPO="https://github.com/saariuslystoned/SaariusSkills.git"\ngit checkout ${SHA_A}\n`,
  );
  assert.deepEqual(inline.pins, []);
  assert.match(inline.findings[0], /commit SHA outside a NAME_SHA assignment in scripts\/agent-skills:2/);

  const ambiguous = collectSkillPins(
    `ONE_REPO="https://github.com/a/one.git"\nTWO_REPO="https://github.com/a/two.git"\nONE_SHA="${SHA_A}"\nTHREE_SHA="${SHA_B}"\n`,
  );
  assert.deepEqual(ambiguous.pins, [{ source: "a/one", sha: SHA_A, where: "scripts/agent-skills:3" }]);
  assert.match(ambiguous.findings[0], /scripts\/agent-skills:4 \(THREE_SHA\)/);
});

test("auditPins fails a pin whose SHA the manifest does not list for that source", () => {
  const { reviewed, findings } = loadReviewedPins(manifestOf(["Actions/Checkout", SHA_A]));
  assert.deepEqual(findings, []);

  assert.deepEqual(auditPins([{ source: "actions/checkout", sha: SHA_A, where: "x.yml:1" }], reviewed), []);

  const bumped = auditPins([{ source: "actions/checkout", sha: SHA_B, where: "x.yml:1" }], reviewed);
  assert.equal(bumped.length, 1);
  assert.match(bumped[0], new RegExp(`unreviewed pin in x\\.yml:1 \\(actions/checkout@${SHA_B}\\)`));

  // A SHA reviewed for one repository says nothing about another repository.
  const otherSource = auditPins([{ source: "evil/checkout", sha: SHA_A, where: "x.yml:2" }], reviewed);
  assert.equal(otherSource.length, 1);
});

test("loadReviewedPins rejects entries that do not record a source, SHA and review", () => {
  assert.deepEqual(loadReviewedPins("{").findings, [".github/reviewed-pins.json is not valid JSON"]);
  assert.deepEqual(loadReviewedPins("{}").findings, ['.github/reviewed-pins.json must contain a "pins" array']);

  const { reviewed, findings } = loadReviewedPins(
    JSON.stringify({
      pins: [
        { source: "actions/checkout", sha: SHA_A, review: "reviewed in example#1" },
        { source: "actions/checkout", sha: SHA_A, review: "again" },
        { source: "actions/checkout", sha: "v7", review: "reviewed" },
        { source: "checkout", sha: SHA_B, review: "reviewed" },
        { source: "actions/setup-node", sha: SHA_B, review: " " },
      ],
    }),
  );
  assert.equal(reviewed.size, 1);
  assert.equal(findings.length, 4);
  assert.match(findings[0], /pins\[1\] repeats/);
  assert.match(findings[1], /pins\[2\] needs a 40-char commit "sha"/);
  assert.match(findings[2], /pins\[3\] needs a "source"/);
  assert.match(findings[3], /pins\[4\] needs a "review"/);
});

test("fetchPinSources resolves every pin and writes the source diff for pins the base manifest lacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "payments-pin-audit-test-"));
  try {
    const source = join(root, "source");
    const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "-b", "main", source]);
    git("config", "user.name", "Pin Audit Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(source, "action.yml"), "runs: reviewed\n", "utf8");
    git("add", "action.yml");
    git("commit", "--quiet", "-m", "reviewed");
    const reviewedSha = git("rev-parse", "HEAD");
    await writeFile(join(source, "action.yml"), "runs: changed\n", "utf8");
    git("commit", "--quiet", "-am", "changed");
    const bumpedSha = git("rev-parse", "HEAD");

    const base = loadReviewedPins(manifestOf(["acme/action", reviewedSha])).reviewed;
    const plan = planSourceFetches(
      [
        { source: "acme/action", sha: reviewedSha, where: "a.yml:1" },
        { source: "acme/action", sha: bumpedSha, where: "a.yml:2" },
        { source: "acme/action", sha: bumpedSha, where: "b.yml:3" },
        { source: "acme/first-use", sha: bumpedSha, where: "c.yml:4" },
        { source: "acme/action", sha: SHA_A, where: "d.yml:5" },
      ],
      base,
    );
    assert.deepEqual(plan, [
      { source: "acme/action", sha: reviewedSha, where: ["a.yml:1"], previous: null },
      { source: "acme/action", sha: bumpedSha, where: ["a.yml:2", "b.yml:3"], previous: [reviewedSha] },
      { source: "acme/first-use", sha: bumpedSha, where: ["c.yml:4"], previous: [] },
      { source: "acme/action", sha: SHA_A, where: ["d.yml:5"], previous: [reviewedSha] },
    ]);

    const outDir = join(root, "out");
    const findings = await fetchPinSources(plan, {
      outDir,
      remoteFor: () => pathToFileURL(source).href,
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0], new RegExp(`cannot be resolved at its source in d\\.yml:5 \\(acme/action@${SHA_A}\\)`));

    const bumpDiff = `acme__action.${reviewedSha.slice(0, 12)}..${bumpedSha.slice(0, 12)}.diff`;
    const firstUseDiff = `acme__first-use.new..${bumpedSha.slice(0, 12)}.diff`;
    const index = JSON.parse(await readFile(join(outDir, "index.json"), "utf8"));
    assert.deepEqual(
      index.map((record) => [record.sha, record.resolved, record.diffs]),
      [
        [reviewedSha, true, []],
        [bumpedSha, true, [bumpDiff]],
        [bumpedSha, true, [firstUseDiff]],
        [SHA_A, false, []],
      ],
    );
    const bump = await readFile(join(outDir, bumpDiff), "utf8");
    assert.match(bump, /^-runs: reviewed$/m);
    assert.match(bump, /^\+runs: changed$/m);
    const firstUse = await readFile(join(outDir, firstUseDiff), "utf8");
    assert.match(firstUse, /^new file mode/m);
    assert.match(firstUse, /^\+runs: changed$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
