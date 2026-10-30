import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyPkgPrNewOutput,
  runPkgPrNewPreview,
} from "../.github/scripts/publish-pkg-pr-new.mjs";
import {
  computePackageChecksum,
  parseSelector,
  recordMatches,
  resolvePdsEndpoint,
} from "../.github/scripts/verify-registry-release.mjs";
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
  bumpPatch,
  compareSemver,
  computeNextBetaVersion,
  computeTargetVersion,
  extractChangelogSection,
  fetchRegistryVersions,
  findMissingChangesets,
  formatBetaProofRecord,
  highestBumpType,
  insertChangelogSection,
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

test("locked stable and beta EmDash Registry identities match release-branches-079", () => {
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
  assert.equal(binding.callerPassesBetaReleaseMode, true);
  assert.equal(binding.delegatedOidcReleaseConfigured, true);

  const testCases = [
    {
      label: "beta tag run with release_mode=beta publishes the beta package",
      input: { eventName: "push", ref: "refs/tags/v0.2.9-beta.2", inputVersion: "0.2.9-beta.2", releaseMode: "beta" },
      expectedOk: true,
      expectedMode: "beta-tag",
      expectedSlug: BETA_REGISTRY_SLUG,
    },
    {
      label: "stable tag run with release_mode=stable publishes the stable package",
      input: { eventName: "push", ref: "refs/tags/v0.2.9", inputVersion: "0.2.9", releaseMode: "stable" },
      expectedOk: true,
      expectedMode: "stable-tag",
      expectedSlug: STABLE_REGISTRY_SLUG,
    },
    {
      label: "a Run workflow press never publishes, even naming a beta",
      input: { eventName: "workflow_dispatch", ref: "refs/heads/main", inputVersion: "0.2.9-beta.2", releaseMode: "beta" },
      expectedOk: false,
      expectedCode: "dispatch_publish_forbidden",
    },
    {
      label: "a Run workflow press on main spoofing release_mode=stable is rejected",
      input: { eventName: "workflow_dispatch", ref: "refs/heads/main", inputVersion: "0.2.9", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "dispatch_publish_forbidden",
    },
    {
      label: "Retry the publish pressed on a stable tag runs that tag's publish",
      input: { eventName: "workflow_dispatch", ref: "refs/tags/v0.2.9", inputVersion: "0.2.9", releaseMode: "stable" },
      expectedOk: true,
      expectedMode: "stable-tag",
      expectedSlug: STABLE_REGISTRY_SLUG,
    },
    {
      label: "Retry the publish on a beta tag cannot switch to release_mode=stable",
      input: { eventName: "workflow_dispatch", ref: "refs/tags/v0.2.9-beta.1", inputVersion: "0.2.9-beta.1", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "missing_beta_caller_input",
    },
    {
      label: "push to main never publishes",
      input: { eventName: "push", ref: "refs/heads/main", inputVersion: "0.2.9", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "forbidden_caller_ref",
    },
    {
      label: "push to a release branch never publishes",
      input: { eventName: "push", ref: "refs/heads/release/0.2.9", inputVersion: "0.2.9-beta.1", releaseMode: "beta" },
      expectedOk: false,
      expectedCode: "forbidden_caller_ref",
    },
    {
      label: "a tag that is not a version is rejected",
      input: { eventName: "push", ref: "refs/tags/release-0.2.9", inputVersion: "0.2.9", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "forbidden_caller_ref",
    },
    {
      label: "version input must equal the tag's version",
      input: { eventName: "push", ref: "refs/tags/v0.2.9", inputVersion: "0.2.10", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "version_tag_mismatch",
    },
    {
      label: "missing version input is rejected",
      input: { eventName: "push", ref: "refs/tags/v0.2.9", inputVersion: "", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "version_tag_mismatch",
    },
    {
      label: "beta tag with release_mode=stable is rejected",
      input: { eventName: "push", ref: "refs/tags/v0.2.9-beta.1", inputVersion: "0.2.9-beta.1", releaseMode: "stable" },
      expectedOk: false,
      expectedCode: "missing_beta_caller_input",
    },
    {
      label: "stable tag with release_mode=beta is rejected",
      input: { eventName: "push", ref: "refs/tags/v0.2.9", inputVersion: "0.2.9", releaseMode: "beta" },
      expectedOk: false,
      expectedCode: "missing_stable_caller_input",
    },
    {
      label: "unsupported event rejected",
      input: { eventName: "pull_request", ref: "refs/tags/v0.2.9", inputVersion: "0.2.9", releaseMode: "stable" },
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

const TEST_PUBLISHER = "did:plc:ekk4pjmkh3k3ql2kfoex3qt4";
const TEST_PDS = "https://publisher.example";
const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";
const releaseRecord = (version, slug = BETA_REGISTRY_SLUG) => ({
  uri: `at://${TEST_PUBLISHER}/${RELEASE_COLLECTION}/${slug}:${version}`,
  value: { package: slug, version },
});
const mockPdsFetch = (response) => async (url) => {
  if (String(url).startsWith("https://plc.directory/")) {
    return { ok: true, json: async () => ({ service: [{ id: "#atproto_pds", serviceEndpoint: TEST_PDS }] }) };
  }
  return typeof response === "function" ? response(new URL(url)) : response;
};
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

async function writePublisherManifest(root) {
  await writeFile(join(root, "emdash-plugin.jsonc"), JSON.stringify({ publisher: TEST_PUBLISHER }));
}

test("release inventory follows the manifest publisher and all PDS pages, including unlisted versions", async () => {
  const calls = [];
  const versions = await fetchRegistryVersions(BETA_REGISTRY_SLUG, {
    root: repositoryRoot,
    fetchImpl: mockPdsFetch((url) => {
      calls.push(url);
      assert.equal(url.origin, TEST_PDS);
      assert.equal(url.pathname, "/xrpc/com.atproto.repo.listRecords");
      assert.equal(url.searchParams.get("repo"), TEST_PUBLISHER);
      assert.equal(url.searchParams.get("collection"), RELEASE_COLLECTION);
      assert.equal(url.searchParams.get("limit"), "100");
      return jsonResponse(url.searchParams.has("cursor")
        ? { records: [releaseRecord("0.2.9-beta.8")] }
        : { records: [releaseRecord("0.2.9-beta.2"), releaseRecord("0.2.8", STABLE_REGISTRY_SLUG)], cursor: "page2" });
    }),
  });
  assert.deepEqual(versions, ["0.2.9-beta.2", "0.2.9-beta.8"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get("cursor"), "page2");
  assert.deepEqual(await fetchRegistryVersions(BETA_REGISTRY_SLUG, {
    root: repositoryRoot, fetchImpl: mockPdsFetch(jsonResponse({ records: [] })),
  }), []);
});

test("changeset parsing remains available before dependencies are installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "payments-no-dependencies-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, ".github/scripts"), { recursive: true });
    await writeFile(join(root, "scripts/release-flow.mjs"), await readFile(join(repositoryRoot, "scripts/release-flow.mjs")));
    await writeFile(join(root, ".github/scripts/verify-registry-release.mjs"), await readFile(join(repositoryRoot, ".github/scripts/verify-registry-release.mjs")));
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { parseChangesetFrontmatter } from ${JSON.stringify(`file://${join(root, "scripts/release-flow.mjs")}`)};
      if (!parseChangesetFrontmatter('---\\n---\\n').empty) process.exit(1);
    `]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release inventory reads JSONC publisher identity and rejects malformed syntax", async () => {
  const root = await mkdtemp(join(tmpdir(), "payments-jsonc-publisher-"));
  try {
    const manifestPath = join(root, "emdash-plugin.jsonc");
    const fetchImpl = mockPdsFetch(jsonResponse({ records: [] }));
    await writeFile(manifestPath, `{ // publisher identity\n "publisher": "${TEST_PUBLISHER}",\n}`);
    assert.deepEqual(await fetchRegistryVersions(BETA_REGISTRY_SLUG, { root, fetchImpl }), []);
    await writeFile(manifestPath, `{"publisher": "${TEST_PUBLISHER}", broken}`);
    await assert.rejects(() => fetchRegistryVersions(BETA_REGISTRY_SLUG, { root, fetchImpl }), /JSONC/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release inventory failures abort beta tagging and release checks", async () => {
  const malformedCases = [
    { name: "network failure", response: () => { throw new Error("fetch failed"); }, pattern: /fetch failed/ },
    { name: "HTTP 503", response: { ok: false, status: 503 }, pattern: /HTTP 503/ },
    { name: "404 is not empty history", response: { ok: false, status: 404 }, pattern: /HTTP 404/ },
    { name: "invalid JSON", response: { ok: true, json: async () => { throw new Error("invalid JSON"); } }, pattern: /invalid JSON/ },
    { name: "missing records", response: jsonResponse({}), pattern: /records.*array/ },
    { name: "old aggregator shape", response: jsonResponse({ versions: [] }), pattern: /records.*array/ },
    { name: "invalid record", response: jsonResponse({ records: [{}] }), pattern: /record/ },
    { name: "foreign publisher", response: jsonResponse({ records: [{ ...releaseRecord("0.2.9-beta.1"), uri: `at://did:plc:wrong/${RELEASE_COLLECTION}/${BETA_REGISTRY_SLUG}:0.2.9-beta.1` }] }), pattern: /URI/ },
    { name: "URI version mismatch", response: jsonResponse({ records: [{ ...releaseRecord("0.2.9-beta.1"), value: { package: BETA_REGISTRY_SLUG, version: "0.2.9-beta.2" } }] }), pattern: /URI/ },
    { name: "invalid version", response: jsonResponse({ records: [releaseRecord("invalid")] }), pattern: /semantic version/ },
    { name: "invalid cursor", response: jsonResponse({ records: [], cursor: 42 }), pattern: /cursor/ },
    { name: "looping cursor", response: jsonResponse({ records: [], cursor: "same" }), pattern: /cursor/ },
  ];
  const tempRoot = await mkdtemp(join(tmpdir(), "payments-registry-validation-"));
  try {
    await writePublisherManifest(tempRoot);
    await mkdir(join(tempRoot, ".changeset"), { recursive: true });
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "0.2.8" }));
    await writeFile(join(tempRoot, ".changeset/bump.md"), `---\n"${PACKAGE_NAME}": patch\n---\n\nFix.\n`);
    const gitCalls = [];
    const deps = { root: tempRoot, gitExec: (args) => { gitCalls.push(args); return ""; }, log: () => {} };
    for (const tc of malformedCases) {
      const fetchImpl = mockPdsFetch(tc.response);
      await assert.rejects(() => fetchRegistryVersions(BETA_REGISTRY_SLUG, { root: tempRoot, fetchImpl }), tc.pattern, tc.name);
      await assert.rejects(() => runReleaseFlowCli(["cut-beta"], { ...deps, fetchImpl }), tc.pattern, tc.name);
      await assert.rejects(() => runReleaseFlowCli(["check-registry-version", "--slug", BETA_REGISTRY_SLUG, "--version", "0.2.9-beta.1"], { ...deps, fetchImpl }), tc.pattern, tc.name);
    }
    assert.equal(gitCalls.some(([command]) => command === "push"), false);
    assert.equal(gitCalls.some(([command, option]) => command === "tag" && option !== "--list"), false);

    const result = await runReleaseFlowCli(["plan-beta"], {
      ...deps, fetchImpl: mockPdsFetch(jsonResponse({ records: [releaseRecord("0.2.9-beta.8")] })),
    });
    assert.equal(result.version, "0.2.9-beta.9");
    assert.equal(result.betaTag, "v0.2.9-beta.9");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateBetaPromotionGate enforces the beta at its release branch tip, not yet released, in the Registry, with @running proof", () => {
  const betaSha = "1234567890abcdef1234567890abcdef12345678";
  const proofRef = "https://github.com/dinkuskit/live-journeys/actions/runs/100 (0.2.9-beta.1 @running pass)";
  const base = {
    targetVersion: "0.2.9",
    betaVersion: "0.2.9-beta.1",
    betaTagSha: betaSha,
    branchTipSha: betaSha,
    registryHasBetaVersion: true,
    proofRef,
  };

  const moved = validateBetaPromotionGate({ ...base, branchTipSha: "fedcba0987654321fedcba0987654321fedcba09" });
  assert.equal(moved.ok, false);
  assert.equal(moved.code, "release_branch_advanced_since_beta");

  assert.equal(validateBetaPromotionGate({ ...base, branchTipSha: "" }).code, "missing_release_branch");
  assert.equal(validateBetaPromotionGate({ ...base, betaTagSha: "" }).code, "missing_beta_tag");
  assert.equal(validateBetaPromotionGate({ ...base, stableTagSha: betaSha }).code, "already_released");
  assert.equal(validateBetaPromotionGate({ ...base, registryHasBetaVersion: false }).code, "beta_not_in_registry");
  assert.equal(validateBetaPromotionGate({ ...base, betaVersion: "0.2.10-beta.1" }).code, "beta_version_mismatch");

  const missingProof = validateBetaPromotionGate({ ...base, proofRef: "" });
  assert.equal(missingProof.ok, false);
  assert.equal(missingProof.code, "missing_beta_proof");

  const valid = validateBetaPromotionGate(base);
  assert.equal(valid.ok, true);
  assert.equal(valid.releaseBranch, "release/0.2.9");
  assert.deepEqual(parseBetaProofRecord(valid.trailer), { betaVersion: "0.2.9-beta.1", betaSha, proofRef });
});

test("insertChangelogSection puts a version above the newest section once", () => {
  const changelog = "# @dinkuskit/payments\n\n## 0.2.8\n\n- Baseline.\n";
  const once = insertChangelogSection(changelog, "0.2.9", "### Patch Changes\n\n- Fix.");
  assert.equal(once, "# @dinkuskit/payments\n\n## 0.2.9\n\n### Patch Changes\n\n- Fix.\n\n## 0.2.8\n\n- Baseline.\n");
  assert.equal(insertChangelogSection(once, "0.2.9", "- Other."), once);
  assert.equal(compareSemver("0.2.10", "0.3.10"), -1);
  assert.equal(compareSemver("0.3.0", "0.3.0-beta.3"), 1);
  assert.equal(bumpPatch("0.3.0"), "0.3.1");
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

for (const released of [false, true]) {
test(`verify-release-tag accepts a stable tag on its release branch and ${released ? "keeps" : "creates"} its GitHub Release`, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "payments-tag-run-test-"));
  try {
    await writePublisherManifest(tempRoot);
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
    await writeFile(join(tempRoot, "CHANGELOG.md"), "# @dinkuskit/payments\n\n## 0.2.8\n\n- Baseline.\n", "utf8");
    await writeFile(join(tempRoot, "src/plugin.ts"), "export const x = 1;\n", "utf8");
    await writeFile(join(tempRoot, ".changeset/README.md"), "# Changesets\n", "utf8");

    const git = (args) =>
      execFileSync("git", args, { cwd: tempRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

    git(["init", "-b", "release/0.2.9"]);
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
    await writeFile(join(tempRoot, "CHANGELOG.md"), "# @dinkuskit/payments\n\n## 0.2.9\n\n- Patch fix.\n\n## 0.2.8\n\n- Baseline.\n", "utf8");
    await writePublisherManifest(tempRoot, "0.2.9");
    git(["add", "package.json", "package-lock.json", "emdash-plugin.jsonc", "CHANGELOG.md"]);
    const trailer = formatBetaProofRecord({ betaVersion: "0.2.9-beta.1", betaSha, proofRef: "run-123 (0.2.9-beta.1 @running pass)" });
    git(["commit", "-m", `ci: release v0.2.9\n\n${trailer}`]);
    git(["tag", "v0.2.9", "HEAD"]);

    const ghCalls = [];
    const outputFile = join(tempRoot, "github-output.txt");
    const result = await runReleaseFlowCli(["verify-release-tag", "--ref", "refs/tags/v0.2.9", "--github-output", outputFile], {
      root: tempRoot,
      gitExec: (args, cwd = tempRoot) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim(),
      ghExec: (args) => {
        ghCalls.push(args);
        if (args[0] === "release" && args[1] === "view" && !released) throw new Error("release not found");
        return "";
      },
      log: () => {},
    });

    assert.equal(result.releaseMode, "stable");
    assert.equal(result.slug, STABLE_REGISTRY_SLUG);
    assert.equal(result.betaVersion, "0.2.9-beta.1");
    assert.equal(result.githubReleaseCreated, !released);
    assert.equal(ghCalls.some((args) => args[0] === "release" && args[1] === "create"), !released);
    const ghOutputText = await readFile(outputFile, "utf8");
    assert.match(ghOutputText, /^release_mode=stable$/m);
    assert.match(ghOutputText, /^version=0\.2\.9$/m);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
}

test("the Registry job verifies an already-listed version instead of skipping the check", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/emdash-release.yml"), "utf8");
  const verifyStep = workflow.split("      - name: Verify release is indexed in EmDash Registry\n")[1]?.split("      - name:")[0];
  assert.ok(verifyStep, "missing verify step");
  assert.doesNotMatch(verifyStep, /^\s+if:/m);
  const release = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
  const job = release.split("\n  publish-emdash:\n")[1]?.split("\n  # A beta that")[0];
  assert.match(job, /needs: release-tag\n/);
  assert.doesNotMatch(job, /^ {4}if:/m);
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
    for (const stagedDir of [betaDir, stableDir]) {
      for (const section of Object.values(rootManifest.sections)) {
        assert.equal(
          await readFile(join(stagedDir, section.file), "utf8"),
          await readFile(join(repositoryRoot, section.file), "utf8"),
        );
      }
      const icon = rootManifest.release.artifacts.icon.file;
      assert.deepEqual(await readFile(join(stagedDir, icon)), await readFile(join(repositoryRoot, icon)));
      for (const screenshot of rootManifest.release.artifacts.screenshots) {
        assert.deepEqual(
          await readFile(join(stagedDir, screenshot.file)),
          await readFile(join(repositoryRoot, screenshot.file)),
        );
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("prepare-emdash-release.mjs builds official emdash-plugin release prepare tarballs and verify-registry-release.mjs validates PDS multihash records", async () => {
  if (!existsSync(join(repositoryRoot, "dist/sandbox/plugin.mjs"))) {
    execFileSync("npm", ["run", "plugin:build"], { cwd: repositoryRoot, stdio: "inherit" });
  }

  const tempDir = await mkdtemp(join(tmpdir(), "payments-oidc-prepare-"));
  try {
    const betaDir = join(tempDir, "beta");
    const betaOut = join(tempDir, "beta-output.txt");
    execFileSync(
      process.execPath,
      [
        join(repositoryRoot, ".github/scripts/prepare-emdash-release.mjs"),
        "--version",
        "0.2.9-beta.1",
        "--out-dir",
        betaDir,
        "--github-output",
        betaOut,
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );

    const betaTarballPath = join(betaDir, "dinkus-payments-beta-0.2.9-beta.1.tar.gz");
    const betaTarStat = await stat(betaTarballPath);
    assert.ok(betaTarStat.isFile() && betaTarStat.size > 0);

    const betaOutputText = await readFile(betaOut, "utf8");
    assert.match(betaOutputText, /^package-slug=dinkus-payments-beta$/m);
    assert.match(betaOutputText, /^version=0\.2\.9-beta\.1$/m);
    assert.match(betaOutputText, /^publisher-did=did:plc:ekk4pjmkh3k3ql2kfoex3qt4$/m);
    assert.match(betaOutputText, /^selector=dinkus-payments-beta@0\.2\.9-beta\.1$/m);

    const tarballBytes = await readFile(betaTarballPath);
    const checksum = computePackageChecksum(tarballBytes);
    assert.match(checksum, /^b[a-z2-7]+$/);
    assert.deepEqual(parseSelector("dinkus-payments-beta@0.2.9-beta.1"), {
      slug: "dinkus-payments-beta",
      version: "0.2.9-beta.1",
    });

    const matchRes = recordMatches(
      {
        $type: "com.emdashcms.experimental.package.release",
        package: "dinkus-payments-beta",
        version: "0.2.9-beta.1",
        artifacts: {
          package: {
            checksum,
            blob: { size: tarballBytes.byteLength, mimeType: "application/gzip" },
          },
        },
      },
      {
        slug: "dinkus-payments-beta",
        version: "0.2.9-beta.1",
        checksum,
        size: tarballBytes.byteLength,
      },
    );
    assert.deepEqual(matchRes, { ok: true, reasons: [] });

    const pdsEndpoint = await resolvePdsEndpoint(
      "did:plc:ekk4pjmkh3k3ql2kfoex3qt4",
      async () =>
        new Response(
          JSON.stringify({
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: "https://porcini.us-east.host.bsky.network",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    assert.equal(pdsEndpoint, "https://porcini.us-east.host.bsky.network");
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

test("release-authority-proof harness passes all 15 release-authority scenarios (a)-(o)", async () => {
  const report = await runReleaseAuthorityProof();
  assert.equal(report.allPassed, true);
  assert.equal(report.scenarioCount, 15);
  assert.deepEqual(
    report.scenarios.map((s) => s.id),
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"],
  );
});
