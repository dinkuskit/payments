import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyPkgPrNewOutput,
  runPkgPrNewPreview,
} from "../.github/scripts/publish-pkg-pr-new.mjs";
import {
  runExtractedGateScriptProcess,
  runReleaseAuthorityProof,
  verifyShippedEmDashWorkflowGateBinding,
} from "../scripts/release-authority-proof.mjs";
import {
  BASELINE_TAG,
  BASELINE_VERSION,
  BETA_INSTALLED_PLUGIN_ID,
  BETA_PLUGIN_NAME,
  BETA_REGISTRY_SLUG,
   MAX_PLUGIN_BUNDLE_BYTES,
  PACKAGE_NAME,
  RELEASE_PR_BRANCH,
  RELEASE_PR_TITLE_PREFIX,
  STABLE_INSTALLED_PLUGIN_ID,
  STABLE_PLUGIN_NAME,
  STABLE_REGISTRY_SLUG,
  computeNextBetaVersion,
  computeTargetVersion,
  extractChangelogSection,
  fetchRegistryVersions,
  findMissingChangesets,
  formatBetaProofRecord,
  highestBumpType,
  isAllowedReleaseTreePath,
  parseBetaProofRecord,
  parseChangesetFrontmatter,
  prepareRegistryWorkspace,
  readPendingChangesets,
  repositoryRoot,
  runReleaseFlowCli,
  validateBetaPromotionGate,
  validateEmDashDispatchGate,
  verifyApprovedBetaSourceTree,
  verifyBuiltPluginBundleSize,
  verifyVersionOnlyPackageMetadata,
} from "../scripts/release-flow.mjs";

test("locked stable and beta EmDash Registry identities match release-beta-cut-071", () => {
  assert.equal(STABLE_REGISTRY_SLUG, "dinkus-payments");
  assert.equal(BETA_REGISTRY_SLUG, "dinkus-payments-beta");
  assert.equal(STABLE_INSTALLED_PLUGIN_ID, "r_3brsc2on3bu673rn");
  assert.equal(BETA_INSTALLED_PLUGIN_ID, "r_sffx6l4z6mpqliki");
  assert.equal(BASELINE_VERSION, "0.2.8");
  assert.equal(BASELINE_TAG, "v0.2.8");
  assert.notEqual(STABLE_INSTALLED_PLUGIN_ID, BETA_INSTALLED_PLUGIN_ID);
});

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

test("findMissingChangesets requires at least one .changeset/*.md file on normal PRs and exempts ci: release PRs", () => {
  const missing = findMissingChangesets({
    changedFiles: ["src/plugin.ts", "README.md", ".changeset/README.md"],
    headRef: "feat/new-webhook",
    title: "feat: handle webhook retry",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.exempted, false);
  assert.match(missing.message, /Every PR must include at least one changeset/);

  const present = findMissingChangesets({
    changedFiles: ["src/plugin.ts", ".changeset/webhook-retry.md"],
    headRef: "feat/new-webhook",
    title: "feat: handle webhook retry",
  });
  assert.equal(present.ok, true);
  assert.equal(present.exempted, false);
  assert.deepEqual(present.changesetFiles, [".changeset/webhook-retry.md"]);

  const releaseBranchExempt = findMissingChangesets({
    changedFiles: ["package.json", "CHANGELOG.md"],
    headRef: RELEASE_PR_BRANCH,
    title: `${RELEASE_PR_TITLE_PREFIX} v0.2.9`,
  });
  assert.equal(releaseBranchExempt.ok, true);
  assert.equal(releaseBranchExempt.exempted, true);
});

test("parseChangesetFrontmatter and readPendingChangesets support explicit empty changesets (`changeset --empty`) and exclude them from bumps", async () => {
  const emptyParsed = parseChangesetFrontmatter("---\n---\n", ".changeset/empty.md");
  assert.equal(emptyParsed.empty, true);
  assert.equal(emptyParsed.bump, null);

  const emptyWithNote = parseChangesetFrontmatter(
    "---\n---\n\nInternal CI workflow update with no version bump.\n",
    ".changeset/empty-note.md",
  );
  assert.equal(emptyWithNote.empty, true);
  assert.equal(emptyWithNote.bump, null);

  assert.equal(highestBumpType([null, undefined]), null);
  assert.equal(computeTargetVersion("0.2.8", [null]), null);
  assert.equal(computeTargetVersion("0.2.8", [null, "patch"]), "0.2.9");

  const tempRoot = await mkdtemp(join(tmpdir(), "payments-empty-changeset-"));
  try {
    await mkdir(join(tempRoot, ".changeset"), { recursive: true });
    await writeFile(join(tempRoot, ".changeset/README.md"), "# Changesets\n", "utf8");
    await writeFile(join(tempRoot, ".changeset/01-empty.md"), "---\n---\n", "utf8");
    await writeFile(
      join(tempRoot, ".changeset/02-patch.md"),
      `---\n"${PACKAGE_NAME}": patch\n---\n\nFix status badge copy.\n`,
      "utf8",
    );

    const bumpingOnly = await readPendingChangesets(tempRoot);
    assert.equal(bumpingOnly.length, 1);
    assert.equal(bumpingOnly[0].filePath, ".changeset/02-patch.md");
    assert.equal(bumpingOnly[0].bump, "patch");

    const allChangesets = await readPendingChangesets(tempRoot, { includeEmpty: true });
    assert.equal(allChangesets.length, 2);
    assert.equal(allChangesets[0].empty, true);
    assert.equal(allChangesets[1].empty, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("computeTargetVersion and computeNextBetaVersion advance monotonically from git tags and dinkus-payments-beta registry versions", () => {
  const patchEntry = parseChangesetFrontmatter(
    `---\n"${PACKAGE_NAME}": patch\n---\n\nFix status screen copy.\n`,
    ".changeset/fix-copy.md",
  );
  const minorEntry = parseChangesetFrontmatter(
    `---\n"${PACKAGE_NAME}": minor\n---\n\nAdd refund summary panel.\n`,
    ".changeset/refund-panel.md",
  );

  assert.equal(computeTargetVersion("0.2.8", [patchEntry.bump]), "0.2.9");
  assert.equal(computeTargetVersion("0.2.8", [patchEntry.bump, minorEntry.bump]), "0.3.0");

  const firstBeta = computeNextBetaVersion({
    targetVersion: "0.2.9",
    gitTags: ["v0.2.8"],
    registryVersions: [],
  });
  assert.equal(firstBeta.version, "0.2.9-beta.1");
  assert.equal(firstBeta.tag, "v0.2.9-beta.1");
  assert.equal(firstBeta.slug, BETA_REGISTRY_SLUG);

  const secondBeta = computeNextBetaVersion({
    targetVersion: "0.2.9",
    gitTags: ["v0.2.8", "v0.2.9-beta.1"],
    registryVersions: ["0.2.9-beta.2"],
  });
  assert.equal(secondBeta.version, "0.2.9-beta.3");
  assert.equal(secondBeta.tag, "v0.2.9-beta.3");
});

test("validateEmDashDispatchGate and .github/scripts/emdash-dispatch-gate.mjs agree on every caller/dispatch case and bind to emdash-release.yml", async () => {
  const binding = await verifyShippedEmDashWorkflowGateBinding();
  assert.equal(binding.jobIfMatches, true);
  assert.equal(binding.gateScriptInvokedBeforeCredentials, true);
  assert.equal(binding.callerPassesStableReleaseMode, true);

  const testCases = [
    {
      label: "manual workflow_dispatch auto beta on main",
      input: { eventName: "workflow_dispatch", ref: "refs/heads/main", inputVersion: "", releaseMode: "" },
      expectedOk: true,
      expectedMode: "cut-beta",
      expectedSlug: BETA_REGISTRY_SLUG,
    },
    {
      label: "manual workflow_dispatch explicit beta on main",
      input: { eventName: "workflow_dispatch", ref: "refs/heads/main", inputVersion: "0.2.9-beta.2", releaseMode: "" },
      expectedOk: true,
      expectedMode: "cut-beta",
      expectedSlug: BETA_REGISTRY_SLUG,
    },
    {
      label: "manual workflow_dispatch stable version rejected",
      input: { eventName: "workflow_dispatch", ref: "refs/heads/main", inputVersion: "0.2.9", releaseMode: "" },
      expectedOk: false,
      expectedCode: "manual_stable_dispatch_forbidden",
    },
    {
      label: "manual workflow_dispatch spoofing release_mode=stable rejected",
      input: { eventName: "workflow_dispatch", ref: "refs/heads/main", inputVersion: "0.2.9-beta.1", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "manual_stable_dispatch_forbidden",
    },
    {
      label: "manual workflow_dispatch on non-main ref rejected",
      input: { eventName: "workflow_dispatch", ref: "refs/heads/feat/rogue-branch", inputVersion: "0.2.9-beta.1", releaseMode: "" },
      expectedOk: false,
      expectedCode: "forbidden_dispatch_ref",
    },
    {
      label: "delegated push from release.yml on main with release_mode=stable succeeds",
      input: { eventName: "push", ref: "refs/heads/main", inputVersion: "0.2.9", releaseMode: "stable" },
      expectedOk: true,
      expectedMode: "stable-call",
      expectedSlug: STABLE_REGISTRY_SLUG,
    },
    {
      label: "push without release_mode=stable rejected",
      input: { eventName: "push", ref: "refs/heads/main", inputVersion: "0.2.9", releaseMode: "" },
      expectedOk: false,
      expectedCode: "missing_stable_caller_input",
    },
    {
      label: "push on non-main ref rejected even with release_mode=stable",
      input: { eventName: "push", ref: "refs/heads/feat/rogue", inputVersion: "0.2.9", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "forbidden_caller_ref",
    },
    {
      label: "push with release_mode=stable but missing version rejected",
      input: { eventName: "push", ref: "refs/heads/main", inputVersion: "", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "missing_workflow_call_version",
    },
    {
      label: "push with release_mode=stable and beta version rejected",
      input: { eventName: "push", ref: "refs/heads/main", inputVersion: "0.2.9-beta.1", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "invalid_stable_caller_version",
    },
    {
      label: "unsupported event rejected",
      input: { eventName: "pull_request", ref: "refs/heads/main", inputVersion: "0.2.9", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "unsupported_event",
    },
  ];

  for (const tc of testCases) {
    const jsGate = validateEmDashDispatchGate(tc.input);
    const cliProc = runExtractedGateScriptProcess(tc.input);

    assert.equal(jsGate.ok, tc.expectedOk, `${tc.label}: JS gate ok mismatch`);
    assert.equal(cliProc.exitCode === 0, tc.expectedOk, `${tc.label}: CLI script exitCode mismatch`);

    if (tc.expectedOk) {
      assert.equal(jsGate.mode, tc.expectedMode, `${tc.label}: mode mismatch`);
      assert.equal(jsGate.slug, tc.expectedSlug, `${tc.label}: slug mismatch`);
      assert.deepEqual(cliProc.parsed, jsGate, `${tc.label}: CLI JSON output must match JS gate`);
    } else {
      assert.equal(jsGate.code, tc.expectedCode, `${tc.label}: error code mismatch`);
      assert.match(cliProc.stderr, new RegExp(jsGate.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("fetchRegistryVersions validates schema of 200 responses and every version entry, failing closed in cut-beta and check-registry-version", async () => {
  const notFound = await fetchRegistryVersions(BETA_REGISTRY_SLUG, "https://registry.example", {
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "NotFound" }),
    }),
  });
  assert.deepEqual(notFound, []);

  const pkgNotFound = await fetchRegistryVersions(BETA_REGISTRY_SLUG, "https://registry.example", {
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "PackageNotFound" }),
    }),
  });
  assert.deepEqual(pkgNotFound, []);

  const validEmptyList = await fetchRegistryVersions(BETA_REGISTRY_SLUG, "https://registry.example", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ plugin: { slug: BETA_REGISTRY_SLUG }, versions: [] }),
    }),
  });
  assert.deepEqual(validEmptyList, []);

  const malformedCases = [
    {
      name: "HTTP 503 error",
      response: { ok: false, status: 503, json: async () => ({ error: "ServiceUnavailable" }) },
      pattern: /HTTP 503 \(ServiceUnavailable\)/,
    },
    {
      name: "200 empty object {}",
      response: { ok: true, status: 200, json: async () => ({}) },
      pattern: /expected "versions" to be an array/,
    },
    {
      name: "200 unrecognized error object",
      response: { ok: true, status: 200, json: async () => ({ error: "UpstreamDatabaseOffline" }) },
      pattern: /error payload \(UpstreamDatabaseOffline\)/,
    },
    {
      name: "200 non-array versions field",
      response: { ok: true, status: 200, json: async () => ({ versions: "not-an-array" }) },
      pattern: /expected "versions" to be an array/,
    },
    {
      name: "200 malformed version entry missing version string",
      response: {
        ok: true,
        status: 200,
        json: async () => ({
          plugin: { slug: BETA_REGISTRY_SLUG },
          versions: [{ version: "0.2.9-beta.1" }, { badEntry: 123 }],
        }),
      },
      pattern: /version entry at index 1 is missing a valid version string/,
    },
    {
      name: "200 version entry with invalid semver",
      response: {
        ok: true,
        status: 200,
        json: async () => ({
          plugin: { slug: BETA_REGISTRY_SLUG },
          versions: [{ version: "0.2.9-beta.1" }, { version: "not-a-semver" }],
        }),
      },
      pattern: /invalid semver "not-a-semver" at index 1/,
    },
    {
      name: "200 mismatched plugin.slug",
      response: {
        ok: true,
        status: 200,
        json: async () => ({
          plugin: { slug: "wrong-slug" },
          versions: [{ version: "0.2.9-beta.1" }],
        }),
      },
      pattern: /plugin\.slug "wrong-slug" does not match/,
    },
  ];

  const tempRoot = await mkdtemp(join(tmpdir(), "payments-registry-validation-"));
  try {
    await mkdir(join(tempRoot, ".changeset"), { recursive: true });
    await writeFile(
      join(tempRoot, "package.json"),
      `${JSON.stringify({ name: PACKAGE_NAME, version: "0.2.8", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(tempRoot, ".changeset/bump.md"),
      `---\n"${PACKAGE_NAME}": patch\n---\n\nFix.\n`,
      "utf8",
    );
    const git = (args) =>
      execFileSync("git", args, { cwd: tempRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);

    for (const tc of malformedCases) {
      await assert.rejects(
        () =>
          fetchRegistryVersions(BETA_REGISTRY_SLUG, "https://registry.example", {
            fetchImpl: async () => tc.response,
          }),
        tc.pattern,
        `fetchRegistryVersions should reject ${tc.name}`,
      );

      await assert.rejects(
        () =>
          runReleaseFlowCli(["cut-beta"], {
            root: tempRoot,
            gitExec: git,
            fetchImpl: async () => tc.response,
            log: () => {},
          }),
        tc.pattern,
        `cut-beta should reject ${tc.name}`,
      );

      await assert.rejects(
        () =>
          runReleaseFlowCli(
            ["check-registry-version", "--slug", BETA_REGISTRY_SLUG, "--version", "0.2.9-beta.1"],
            {
              root: tempRoot,
              gitExec: git,
              fetchImpl: async () => tc.response,
              log: () => {},
            },
          ),
        tc.pattern,
        `check-registry-version should reject ${tc.name}`,
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateBetaPromotionGate enforces beta tag, no new changesets after beta, registry presence, and @running proof", () => {
  const betaSha = "1234567890abcdef1234567890abcdef12345678";

  const staleBeta = validateBetaPromotionGate({
    targetVersion: "0.2.9",
    betaVersion: "0.2.9-beta.1",
    betaTagSha: betaSha,
    currentMainSha: "fedcba0987654321fedcba0987654321fedcba09",
    changedFilesSinceBeta: [".changeset/extra-fix.md"],
    registryHasBetaVersion: true,
    proofRef: "https://github.com/dinkuskit/payments/actions/runs/100 (0.2.9-beta.1 @running pass)",
  });
  assert.equal(staleBeta.ok, false);
  assert.equal(staleBeta.code, "main_advanced_since_beta");

  const missingProof = validateBetaPromotionGate({
    targetVersion: "0.2.9",
    betaVersion: "0.2.9-beta.1",
    betaTagSha: betaSha,
    currentMainSha: betaSha,
    changedFilesSinceBeta: [],
    registryHasBetaVersion: true,
    proofRef: "",
  });
  assert.equal(missingProof.ok, false);
  assert.equal(missingProof.code, "missing_beta_proof");

  const valid = validateBetaPromotionGate({
    targetVersion: "0.2.9",
    betaVersion: "0.2.9-beta.1",
    betaTagSha: betaSha,
    currentMainSha: betaSha,
    changedFilesSinceBeta: [],
    registryHasBetaVersion: true,
    proofRef: "https://github.com/dinkuskit/payments/actions/runs/100 (0.2.9-beta.1 @running pass)",
  });
  assert.equal(valid.ok, true);
  const parsedProof = parseBetaProofRecord(valid.trailer);
  assert.deepEqual(parsedProof, {
    betaVersion: "0.2.9-beta.1",
    betaSha,
    proofRef: "https://github.com/dinkuskit/payments/actions/runs/100 (0.2.9-beta.1 @running pass)",
  });
});

test("verifyApprovedBetaSourceTree and verifyVersionOnlyPackageMetadata enforce version-only package.json and package-lock.json diffs", () => {
  const betaSha = "abcdef1234567890abcdef1234567890abcdef12";
  const proof = {
    betaVersion: "0.2.9-beta.1",
    betaSha,
    proofRef: "run-999 0.2.9-beta.1 @running pass",
  };

  const basePkg = {
    name: PACKAGE_NAME,
    version: "0.2.8",
    type: "module",
    scripts: { build: "npm run plugin:build" },
    dependencies: { jose: "6.2.12", stripe: "23.0.0" },
  };
  const baseLock = {
    name: PACKAGE_NAME,
    version: "0.2.8",
    lockfileVersion: 3,
    packages: {
      "": {
        name: PACKAGE_NAME,
        version: "0.2.8",
        dependencies: { jose: "6.2.12", stripe: "23.0.0" },
      },
      "node_modules/stripe": {
        version: "23.0.0",
        resolved: "https://registry.npmjs.org/stripe/-/stripe-23.0.0.tgz",
        integrity: "sha512-valid==",
      },
    },
  };

  const cleanReleasePkg = { ...basePkg, version: "0.2.9" };
  const cleanReleaseLock = structuredClone(baseLock);
  cleanReleaseLock.version = "0.2.9";
  cleanReleaseLock.packages[""].version = "0.2.9";

  // 1. Version-only bump passes
  const cleanTree = verifyApprovedBetaSourceTree({
    version: "0.2.9",
    proof,
    betaTagSha: betaSha,
    changedPathsSinceBeta: ["package.json", "package-lock.json", "CHANGELOG.md", ".changeset/fix-checkout.md"],
    betaPackageJsonText: JSON.stringify(basePkg),
    releasePackageJsonText: JSON.stringify(cleanReleasePkg),
    betaPackageLockText: JSON.stringify(baseLock),
    releasePackageLockText: JSON.stringify(cleanReleaseLock),
  });
  assert.equal(cleanTree.ok, true);

  // 2. Dependency change in package.json is rejected
  const depChangedPkg = {
    ...cleanReleasePkg,
    dependencies: { ...cleanReleasePkg.dependencies, "malicious-dep": "1.0.0" },
  };
  const depResult = verifyApprovedBetaSourceTree({
    version: "0.2.9",
    proof,
    betaTagSha: betaSha,
    changedPathsSinceBeta: ["package.json", "package-lock.json", "CHANGELOG.md"],
    betaPackageJsonText: JSON.stringify(basePkg),
    releasePackageJsonText: JSON.stringify(depChangedPkg),
    betaPackageLockText: JSON.stringify(baseLock),
    releasePackageLockText: JSON.stringify(cleanReleaseLock),
  });
  assert.equal(depResult.ok, false);
  assert.equal(depResult.code, "unapproved_package_metadata_change");
  assert.match(depResult.message, /package\.json modified non-version fields.*dependencies/);

  // 3. Script change in package.json is rejected
  const scriptChangedPkg = {
    ...cleanReleasePkg,
    scripts: { build: "node -e 'evil()'" },
  };
  const scriptResult = verifyApprovedBetaSourceTree({
    version: "0.2.9",
    proof,
    betaTagSha: betaSha,
    changedPathsSinceBeta: ["package.json", "package-lock.json", "CHANGELOG.md"],
    betaPackageJsonText: JSON.stringify(basePkg),
    releasePackageJsonText: JSON.stringify(scriptChangedPkg),
    betaPackageLockText: JSON.stringify(baseLock),
    releasePackageLockText: JSON.stringify(cleanReleaseLock),
  });
  assert.equal(scriptResult.ok, false);
  assert.equal(scriptResult.code, "unapproved_package_metadata_change");
  assert.match(scriptResult.message, /package\.json modified non-version fields.*scripts/);

  // 4. Lockfile resolved/integrity change is rejected
  const lockTampered = structuredClone(cleanReleaseLock);
  lockTampered.packages["node_modules/stripe"].resolved = "https://evil.example/stripe.tgz";
  lockTampered.packages["node_modules/stripe"].integrity = "sha512-tampered==";
  const lockResult = verifyApprovedBetaSourceTree({
    version: "0.2.9",
    proof,
    betaTagSha: betaSha,
    changedPathsSinceBeta: ["package.json", "package-lock.json", "CHANGELOG.md"],
    betaPackageJsonText: JSON.stringify(basePkg),
    releasePackageJsonText: JSON.stringify(cleanReleasePkg),
    betaPackageLockText: JSON.stringify(baseLock),
    releasePackageLockText: JSON.stringify(lockTampered),
  });
  assert.equal(lockResult.ok, false);
  assert.equal(lockResult.code, "unapproved_package_metadata_change");
  assert.match(lockResult.message, /package-lock\.json modified non-version fields.*packages/);

  // 5. Malformed JSON is rejected
  const malformedJsonResult = verifyVersionOnlyPackageMetadata({
    version: "0.2.9",
    betaPackageJsonText: JSON.stringify(basePkg),
    releasePackageJsonText: "{bad-json",
    betaPackageLockText: JSON.stringify(baseLock),
    releasePackageLockText: JSON.stringify(cleanReleaseLock),
  });
  assert.equal(malformedJsonResult.ok, false);
  assert.equal(malformedJsonResult.code, "unapproved_package_metadata_change");
  assert.match(malformedJsonResult.message, /release package\.json is not valid JSON/);

  // 6. Disallowed file path is still rejected
  const tamperedSource = verifyApprovedBetaSourceTree({
    version: "0.2.9",
    proof,
    betaTagSha: betaSha,
    changedPathsSinceBeta: ["package.json", "CHANGELOG.md", "src/plugin.ts"],
  });
  assert.equal(tamperedSource.ok, false);
  assert.equal(tamperedSource.code, "unapproved_source_changes_since_beta");
  assert.deepEqual(tamperedSource.disallowedPaths, ["src/plugin.ts"]);
});

test("publish-pkg-pr-new helper skips with ::notice:: and exit 0 on 404 App-not-installed output and fails on other errors", () => {
  const canned404Stderr =
    'Check failed (404): {"url":"/check","statusCode":404,"statusMessage":"Not Found","message":"The app https://github.com/apps/pkg-pr-new is not installed on or does not have access to dinkuskit/payments.","stack":""}';

  const skipped = classifyPkgPrNewOutput({
    status: 1,
    stdout: "",
    stderr: canned404Stderr,
  });
  assert.equal(skipped.outcome, "skipped_app_not_installed");
  assert.equal(skipped.exitCode, 0);
  assert.match(skipped.notice, /pkg-pr-new GitHub App is not installed/);

  const notices = [];
  const runSkipped = runPkgPrNewPreview({
    jsonPath: "preview.json",
    spawnImpl: () => ({ status: 1, stdout: "", stderr: canned404Stderr }),
    writeStdout: () => {},
    writeStderr: () => {},
    logNotice: (msg) => notices.push(msg),
  });
  assert.equal(runSkipped.exitCode, 0);
  assert.equal(notices.length, 1);

  const otherFailure = classifyPkgPrNewOutput({
    status: 1,
    stdout: "",
    stderr: "Check failed (500): Internal Server Error",
  });
  assert.equal(otherFailure.outcome, "failed");
  assert.equal(otherFailure.exitCode, 1);
  assert.equal(otherFailure.notice, null);

  const success = classifyPkgPrNewOutput({
    status: 0,
    stdout: "Published preview https://pkg.pr.new/@dinkuskit/payments@f74b9e4",
    stderr: "",
  });
  assert.equal(success.outcome, "published");
  assert.equal(success.exitCode, 0);
});

test("publish-merged-release resumes missing GitHub Release and triggers downstream Registry publish when tag already exists on HEAD", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "payments-resume-test-"));
  try {
    await mkdir(join(tempRoot, ".changeset"), { recursive: true });
    await mkdir(join(tempRoot, "src"), { recursive: true });
    await writeFile(
      join(tempRoot, "package.json"),
      `${JSON.stringify({ name: PACKAGE_NAME, version: "0.2.8", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(tempRoot, "package-lock.json"),
      `${JSON.stringify({ name: PACKAGE_NAME, version: "0.2.8", packages: { "": { name: PACKAGE_NAME, version: "0.2.8" } } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(tempRoot, "CHANGELOG.md"),
      "# @dinkuskit/payments\n\n## 0.2.8\n\n- Baseline.\n",
      "utf8",
    );
    await writeFile(join(tempRoot, "src/plugin.ts"), "export const x = 1;\n", "utf8");
    await writeFile(join(tempRoot, ".changeset/README.md"), "# Changesets\n", "utf8");

    const git = (args) =>
      execFileSync("git", args, { cwd: tempRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["add", "-A"]);
    git(["commit", "-m", "feat: beta state"]);
    git(["tag", "v0.2.9-beta.1"]);
    const betaSha = git(["rev-parse", "HEAD"]);

    await writeFile(
      join(tempRoot, "package.json"),
      `${JSON.stringify({ name: PACKAGE_NAME, version: "0.2.9", type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(tempRoot, "package-lock.json"),
      `${JSON.stringify({ name: PACKAGE_NAME, version: "0.2.9", packages: { "": { name: PACKAGE_NAME, version: "0.2.9" } } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(tempRoot, "CHANGELOG.md"),
      "# @dinkuskit/payments\n\n## 0.2.9\n\n- Patch fix.\n\n## 0.2.8\n\n- Baseline.\n",
      "utf8",
    );
    git(["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
    const trailer = formatBetaProofRecord({
      betaVersion: "0.2.9-beta.1",
      betaSha,
      proofRef: "run-123 0.2.9-beta.1 @running pass",
    });
    git(["commit", "-m", `ci: release v0.2.9\n\n${trailer}`]);
    git(["tag", "v0.2.9", "HEAD"]);

    const ghCalls = [];
    const outputFile = join(tempRoot, "github-output.txt");
    const result = await runReleaseFlowCli(
      ["publish-merged-release", "--github-output", outputFile],
      {
        root: tempRoot,
        gitExec: (args, cwd = tempRoot) => {
          if (args[0] === "push") return "";
          return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
        },
        ghExec: (args) => {
          ghCalls.push(args);
          if (args[0] === "release" && args[1] === "view") {
            throw new Error("release not found");
          }
          return "";
        },
        fetchImpl: async () => ({
          ok: false,
          status: 404,
          json: async () => ({ error: "NotFound" }),
        }),
        log: () => {},
      },
    );

    assert.equal(result.resumedFromExistingTag, true);
    assert.equal(result.tagCreated, false);
    assert.equal(result.githubReleaseCreated, true);
    assert.equal(result.registryNeeded, true);
    assert.equal(result.published, true);

    const ghOutputText = await readFile(outputFile, "utf8");
    assert.match(ghOutputText, /^published=true$/m);
    assert.match(ghOutputText, /^registry_needed=true$/m);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepareRegistryWorkspace stages isolated beta and stable manifests without mutating repo root", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "payments-release-flow-"));
  try {
    const betaDir = join(tempDir, "beta");
    const betaStaged = await prepareRegistryWorkspace({
      root: repositoryRoot,
      outDir: betaDir,
      version: "0.2.9-beta.1",
    });
    assert.equal(betaStaged.slug, BETA_REGISTRY_SLUG);
    assert.equal(betaStaged.name, BETA_PLUGIN_NAME);

    const betaManifest = JSON.parse(await readFile(join(betaDir, "emdash-plugin.jsonc"), "utf8"));
    assert.equal(betaManifest.slug, BETA_REGISTRY_SLUG);
    assert.equal(betaManifest.name, BETA_PLUGIN_NAME);
    assert.equal(betaManifest.version, "0.2.9-beta.1");

    const stableDir = join(tempDir, "stable");
    const stableStaged = await prepareRegistryWorkspace({
      root: repositoryRoot,
      outDir: stableDir,
      version: "0.2.9",
    });
    assert.equal(stableStaged.slug, STABLE_REGISTRY_SLUG);
    assert.equal(stableStaged.name, STABLE_PLUGIN_NAME);

    const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "emdash-plugin.jsonc"), "utf8"));
    assert.equal(rootManifest.slug, STABLE_REGISTRY_SLUG);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("extractChangelogSection extracts the matching version notes", () => {
  const changelog = [
    "# @dinkuskit/payments",
    "",
    "## 0.2.9",
    "",
    "### Patch Changes",
    "",
    "- Harden webhook replay handling.",
    "",
    "## 0.2.8",
    "",
    "- Initial baseline.",
  ].join("\n");

  assert.equal(
    extractChangelogSection(changelog, "0.2.9"),
    "### Patch Changes\n\n- Harden webhook replay handling.",
  );
  assert.equal(extractChangelogSection(changelog, "0.2.8"), "- Initial baseline.");
  assert.equal(extractChangelogSection(changelog, "0.9.9"), null);
});

test("built sandbox plugin bundle exists and stays under the 128 KB limit", async () => {
  if (!existsSync(join(repositoryRoot, "dist/sandbox/plugin.mjs"))) {
    execFileSync("npm", ["run", "plugin:build"], { cwd: repositoryRoot, stdio: "inherit" });
  }
  const result = await verifyBuiltPluginBundleSize(repositoryRoot);
  assert.ok(result.bytes > 0);
  assert.ok(result.bytes < MAX_PLUGIN_BUNDLE_BYTES);
});

test("release-authority-proof harness passes all 12 release-authority scenarios (a)-(l)", async () => {
  const report = await runReleaseAuthorityProof();
  assert.equal(report.allPassed, true);
  assert.equal(report.scenarioCount, 12);
  assert.deepEqual(
    report.scenarios.map((s) => s.id),
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"],
  );
});
