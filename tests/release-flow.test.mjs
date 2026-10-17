import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BASELINE_TAG,
  BASELINE_VERSION,
  BETA_INSTALLED_PLUGIN_ID,
  BETA_PLUGIN_NAME,
  BETA_REGISTRY_SLUG,
  MAX_PLUGIN_BUNDLE_BYTES,
  PACKAGE_NAME,
  RELEASE_PR_BRANCH,
  STABLE_INSTALLED_PLUGIN_ID,
  STABLE_PLUGIN_NAME,
  STABLE_REGISTRY_SLUG,
  computeNextBetaVersion,
  computeTargetVersion,
  extractChangelogSection,
  findMissingChangesets,
  formatBetaProofRecord,
  highestBumpType,
  parseBetaProofRecord,
  parseChangesetFrontmatter,
  prepareRegistryWorkspace,
  repositoryRoot,
  validateBetaPromotionGate,
} from "../scripts/release-flow.mjs";

test("parseChangesetFrontmatter parses valid changesets and rejects invalid ones", () => {
  const parsed = parseChangesetFrontmatter(
    `---\n"@dinkuskit/payments": patch\n---\n\nAdd release-beta-cut-071 automation.\n`,
    ".changeset/release-flow.md",
  );
  assert.equal(parsed.bump, "patch");
  assert.equal(parsed.summary, "Add release-beta-cut-071 automation.");

  assert.throws(
    () => parseChangesetFrontmatter(`No frontmatter here`, ".changeset/bad.md"),
    /missing YAML frontmatter/,
  );
  assert.throws(
    () =>
      parseChangesetFrontmatter(
        `---\n"@dinkuskit/commerce": minor\n---\n\nWrong package.\n`,
        ".changeset/wrong.md",
      ),
    /must target "@dinkuskit\/payments"/,
  );
  assert.throws(
    () =>
      parseChangesetFrontmatter(
        `---\n"@dinkuskit/payments": patch\n---\n\n   \n`,
        ".changeset/empty.md",
      ),
    /non-empty summary body/,
  );
});

test("highestBumpType and computeTargetVersion calculate next stable semver from 0.2.8 baseline", () => {
  assert.equal(BASELINE_VERSION, "0.2.8");
  assert.equal(BASELINE_TAG, "v0.2.8");
  assert.equal(highestBumpType(["patch"]), "patch");
  assert.equal(highestBumpType(["patch", "minor"]), "minor");
  assert.equal(highestBumpType(["patch", "major", "minor"]), "major");
  assert.equal(highestBumpType([]), null);

  assert.equal(computeTargetVersion("0.2.8", ["patch"]), "0.2.9");
  assert.equal(computeTargetVersion("0.2.8", ["patch", "minor"]), "0.3.0");
  assert.equal(computeTargetVersion("0.2.8", ["major"]), "1.0.0");
  assert.equal(computeTargetVersion("0.2.8", []), null);
});

test("findMissingChangesets enforces changeset presence on PRs and exempts ci: release PRs", () => {
  const missing = findMissingChangesets({
    changedFiles: ["src/plugin.ts", "README.md"],
    headRef: "feat/some-change",
    title: "feat: update plugin",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.exempted, false);

  const readmeOnly = findMissingChangesets({
    changedFiles: [".changeset/README.md", "src/plugin.ts"],
    headRef: "feat/some-change",
    title: "feat: update plugin",
  });
  assert.equal(readmeOnly.ok, false);

  const present = findMissingChangesets({
    changedFiles: [".changeset/add-flow.md", "src/plugin.ts"],
    headRef: "feat/some-change",
    title: "feat: update plugin",
  });
  assert.equal(present.ok, true);
  assert.equal(present.exempted, false);
  assert.deepEqual(present.changesetFiles, [".changeset/add-flow.md"]);

  const releaseBranch = findMissingChangesets({
    changedFiles: ["package.json", "CHANGELOG.md"],
    headRef: RELEASE_PR_BRANCH,
    title: "ci: release v0.2.9",
  });
  assert.equal(releaseBranch.ok, true);
  assert.equal(releaseBranch.exempted, true);
});

test("computeNextBetaVersion increments past highest git tag and EmDash Registry beta version without pre.json", () => {
  const first = computeNextBetaVersion({
    targetVersion: "0.2.9",
    gitTags: [],
    registryVersions: [],
  });
  assert.equal(first.version, "0.2.9-beta.1");
  assert.equal(first.tag, "v0.2.9-beta.1");
  assert.equal(first.slug, "dinkus-payments-beta");

  const fromTags = computeNextBetaVersion({
    targetVersion: "0.2.9",
    gitTags: ["v0.2.8", "v0.2.9-beta.1", "v0.2.9-beta.2", "v0.3.0-beta.9"],
    registryVersions: ["0.2.9-beta.1"],
  });
  assert.equal(fromTags.version, "0.2.9-beta.3");
  assert.equal(fromTags.betaNumber, 3);

  const fromRegistry = computeNextBetaVersion({
    targetVersion: "0.2.9",
    gitTags: ["v0.2.9-beta.2"],
    registryVersions: ["0.2.9-beta.4", "0.2.8-beta.10"],
  });
  assert.equal(fromRegistry.version, "0.2.9-beta.5");
  assert.equal(fromRegistry.tag, "v0.2.9-beta.5");
});

test("validateBetaPromotionGate enforces release-beta-cut-071 rules before opening ci: release PR", () => {
  const valid = validateBetaPromotionGate({
    targetVersion: "0.2.9",
    betaVersion: "0.2.9-beta.2",
    betaTagSha: "abc1234def5678",
    currentMainSha: "abc1234def5678",
    changedFilesSinceBeta: [],
    registryHasBetaVersion: true,
    proofRef: "https://github.com/dinkuskit/payments/actions/runs/999 (0.2.9-beta.2 @running pass)",
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.betaTag, "v0.2.9-beta.2");
  const parsedProof = parseBetaProofRecord(valid.trailer);
  assert.deepEqual(parsedProof, {
    betaVersion: "0.2.9-beta.2",
    betaSha: "abc1234def5678",
    proofRef: "https://github.com/dinkuskit/payments/actions/runs/999 (0.2.9-beta.2 @running pass)",
  });

  // Rejects when main gained a new changeset after the beta pass
  const newChangeset = validateBetaPromotionGate({
    targetVersion: "0.2.9",
    betaVersion: "0.2.9-beta.2",
    betaTagSha: "abc1234def5678",
    currentMainSha: "def5678abc1234",
    changedFilesSinceBeta: [".changeset/another-change.md"],
    registryHasBetaVersion: true,
    proofRef: "run-999 0.2.9-beta.2 @running pass",
  });
  assert.equal(newChangeset.ok, false);
  assert.equal(newChangeset.code, "main_advanced_since_beta");

  // Rejects when proof does not name the beta version
  const badProof = validateBetaPromotionGate({
    targetVersion: "0.2.9",
    betaVersion: "0.2.9-beta.2",
    betaTagSha: "abc1234def5678",
    currentMainSha: "abc1234def5678",
    changedFilesSinceBeta: [],
    registryHasBetaVersion: true,
    proofRef: "0.2.9-beta.1 passed",
  });
  assert.equal(badProof.ok, false);
  assert.equal(badProof.code, "missing_beta_proof");

  // Rejects when beta version is not in Registry
  const missingInRegistry = validateBetaPromotionGate({
    targetVersion: "0.2.9",
    betaVersion: "0.2.9-beta.2",
    betaTagSha: "abc1234def5678",
    currentMainSha: "abc1234def5678",
    changedFilesSinceBeta: [],
    registryHasBetaVersion: false,
    proofRef: "0.2.9-beta.2 passed",
  });
  assert.equal(missingInRegistry.ok, false);
  assert.equal(missingInRegistry.code, "beta_not_in_registry");
});

test("extractChangelogSection extracts the matching version notes from CHANGELOG.md", () => {
  const sampleChangelog = [
    "# @dinkuskit/payments",
    "",
    "## 0.2.9",
    "",
    "### Patch Changes",
    "",
    "- Add release-beta-cut-071 automation.",
    "",
    "## 0.2.8",
    "",
    "- Initial baseline.",
  ].join("\n");

  assert.equal(
    extractChangelogSection(sampleChangelog, "0.2.9"),
    "### Patch Changes\n\n- Add release-beta-cut-071 automation.",
  );
  assert.equal(extractChangelogSection(sampleChangelog, "0.2.8"), "- Initial baseline.");
  assert.equal(extractChangelogSection(sampleChangelog, "0.3.0"), null);
});

test("prepareRegistryWorkspace stages isolated beta and stable EmDash manifests without mutating the repo", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "payments-registry-stage-"));
  try {
    const betaStage = await prepareRegistryWorkspace({
      root: repositoryRoot,
      outDir: join(tempDir, "beta"),
      version: "0.2.9-beta.1",
    });
    assert.equal(betaStage.slug, BETA_REGISTRY_SLUG);
    assert.equal(betaStage.name, BETA_PLUGIN_NAME);
    const betaManifest = JSON.parse(
      await readFile(join(betaStage.workspaceDir, "emdash-plugin.jsonc"), "utf8"),
    );
    assert.equal(betaManifest.slug, "dinkus-payments-beta");
    assert.equal(betaManifest.name, "DinkusKit Payments (Beta)");
    assert.equal(betaManifest.version, "0.2.9-beta.1");

    const stableStage = await prepareRegistryWorkspace({
      root: repositoryRoot,
      outDir: join(tempDir, "stable"),
      version: "0.2.9",
    });
    assert.equal(stableStage.slug, STABLE_REGISTRY_SLUG);
    assert.equal(stableStage.name, STABLE_PLUGIN_NAME);
    const stableManifest = JSON.parse(
      await readFile(join(stableStage.workspaceDir, "emdash-plugin.jsonc"), "utf8"),
    );
    assert.equal(stableManifest.slug, "dinkus-payments");
    assert.equal(stableManifest.name, "DinkusKit Payments");
    assert.equal(stableManifest.version, "0.2.9");

    // Root manifest remains untouched at 0.2.8 / dinkus-payments
    const rootManifest = JSON.parse(
      await readFile(join(repositoryRoot, "emdash-plugin.jsonc"), "utf8"),
    );
    assert.equal(rootManifest.slug, "dinkus-payments");
    assert.equal(rootManifest.version, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("workflows, scripts, and RELEASING.md match GrillTrack release-beta-cut-071 and dinkuskit/commerce", async () => {
  assert.equal(PACKAGE_NAME, "@dinkuskit/payments");
  assert.equal(STABLE_INSTALLED_PLUGIN_ID, "r_3brsc2on3bu673rn");
  assert.equal(BETA_INSTALLED_PLUGIN_ID, "r_sffx6l4z6mpqliki");
  assert.equal(MAX_PLUGIN_BUNDLE_BYTES, 131_072);

  const changesetWorkflow = await readFile(
    join(repositoryRoot, ".github/workflows/changeset-check.yml"),
    "utf8",
  );
  assert.match(changesetWorkflow, /node \.github\/scripts\/check-changeset\.mjs/);

  const previewWorkflow = await readFile(
    join(repositoryRoot, ".github/workflows/preview.yml"),
    "utf8",
  );
  assert.match(previewWorkflow, /npx pkg-pr-new publish --json preview\.json/);

  const emdashReleaseWorkflow = await readFile(
    join(repositoryRoot, ".github/workflows/emdash-release.yml"),
    "utf8",
  );
  assert.match(emdashReleaseWorkflow, /workflow_call:/);
  assert.match(emdashReleaseWorkflow, /workflow_dispatch:/);
  assert.match(emdashReleaseWorkflow, /RELEASE_APP_ID/);
  assert.match(emdashReleaseWorkflow, /RELEASE_APP_PRIVATE_KEY/);
  assert.match(emdashReleaseWorkflow, /node \.github\/scripts\/prepare-emdash-release\.mjs/);
  assert.match(emdashReleaseWorkflow, /node \.github\/scripts\/verify-registry-release\.mjs/);

  const releaseWorkflow = await readFile(
    join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  assert.match(releaseWorkflow, /workflow_dispatch:/);
  assert.match(releaseWorkflow, /beta_version:/);
  assert.match(releaseWorkflow, /proof_ref:/);
  assert.match(releaseWorkflow, /RELEASE_APP_ID/);
  assert.match(releaseWorkflow, /RELEASE_APP_PRIVATE_KEY/);
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/emdash-release\.yml/);

  const releasingDoc = await readFile(join(repositoryRoot, "RELEASING.md"), "utf8");
  assert.match(releasingDoc, /release-beta-cut-071/);
  assert.match(releasingDoc, /dinkus-payments-beta/);
  assert.match(releasingDoc, /r_sffx6l4z6mpqliki/);
  assert.match(releasingDoc, /r_3brsc2on3bu673rn/);
  assert.match(releasingDoc, /v0\.2\.8/);
  assert.match(releasingDoc, /Connected: Stripe test mode/);
});
