import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { ReleaseServiceClient } from "@emdash-cms/registry-client/release-service";
import { NSID } from "@emdash-cms/registry-lexicons";
import { validatePluginBundle } from "@emdash-cms/registry-verification/bundle";
import {
  fetchGithubOidcToken,
  parseWorkflowConnectionArgs,
} from "../.github/scripts/ensure-emdash-workflow-connection.mjs";
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
  commitOnMain,
  createSeededRepo,
  createStubEnvironment,
  runExtractedGateScriptProcess,
  runReleaseAuthorityProof,
  squashMergeReleasePr,
  verifyEmDashWorkflowContract,
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
  RELEASE_ACTOR_TRAILER,
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
  resolveTagActor,
  runReleaseFlowCli,
  validateBetaPromotionGate,
  validateEmDashDispatchGate,
  verifyApprovedBetaSourceTree,
  verifyBuiltPluginBundleSize,
  verifyVersionOnlyPackageMetadata,
  verifyWriteAuthority,
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

// Pushes, local tags made to be pushed, PR writes and GitHub Releases: what a release run changes.
const RELEASE_EFFECT = (event) =>
  event.startsWith("git:push:") ||
  event.startsWith("git:tag:") ||
  event.startsWith("gh:pr:create:") ||
  event.startsWith("gh:pr:edit:") ||
  event.startsWith("gh:release:create:");
// Reads a run may make between its authority check and the effect it guards.
const RELEASE_LOOKUP = (event) => event === "gh:pr:list" || event.startsWith("gh:release:view:");

async function startReleaseAuthorityTestRig(sandboxDir, bareOriginDir) {
  const state = {
    collaborators: new Map(),
    prs: [],
    releases: new Map(),
    pdsBetaVersions: [],
    pdsStableVersions: [],
    httpLog: [],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = req.method || "GET";
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";

    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;
    const body = rawBody ? JSON.parse(rawBody) : null;

    const send = (status, payload, summary = "") => {
      state.httpLog.push({ method, path: url.pathname, token, status, summary });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname.startsWith("/plc/")) {
      return send(200, { service: [{ id: "#atproto_pds", serviceEndpoint: "https://pds.test" }] }, "did-doc");
    }
    if (url.pathname === "/xrpc/com.atproto.repo.listRecords") {
      const records = [
        ...state.pdsBetaVersions.map((version) => ({ version, package: BETA_REGISTRY_SLUG })),
        ...state.pdsStableVersions.map((version) => ({ version, package: STABLE_REGISTRY_SLUG })),
      ].map((value) => ({
        uri: `at://did:plc:release-proof/${RELEASE_COLLECTION}/${value.package}:${value.version}`,
        value,
      }));
      return send(200, { records }, `records:${records.length}`);
    }

    const permMatch = /^\/repos\/dinkuskit\/payments\/collaborators\/([^/]+)\/permission$/.exec(url.pathname);
    if (method === "GET" && permMatch) {
      if (token !== "app-write-token" && token !== "app-contents-read-token") {
        return send(403, { message: "Resource not accessible by integration" }, "forbidden-token");
      }
      const login = decodeURIComponent(permMatch[1]);
      if (!state.collaborators.has(login)) {
        return send(404, { message: "Not Found" }, `${login}:404`);
      }
      const permission = state.collaborators.get(login);
      return send(200, { permission, user: { login } }, `${login}:${permission}`);
    }

    if (method !== "GET" && token !== "app-write-token") {
      return send(403, { message: "Resource not accessible by integration" }, "write-denied-for-read-token");
    }

    if (url.pathname === "/repos/dinkuskit/payments/pulls" && method === "GET") {
      const wantState = url.searchParams.get("state") || "open";
      const head = url.searchParams.get("head") || "";
      const search = url.searchParams.get("search") || "";
      const filtered = state.prs.filter((pr) => {
        if (wantState === "merged" && pr.state !== "merged") return false;
        if (wantState === "open" && pr.state !== "open") return false;
        if (head && pr.head !== head) return false;
        if (search && !pr.mergeSha?.includes(search) && !pr.body.includes(search)) return false;
        return true;
      });
      return send(200, filtered, `prs:${filtered.length}`);
    }

    if (url.pathname === "/repos/dinkuskit/payments/pulls" && method === "POST") {
      const pr = {
        number: state.prs.length + 1,
        state: "open",
        base: body.base,
        head: body.head,
        title: body.title,
        body: body.body,
        html_url: `https://github.com/dinkuskit/payments/pull/${state.prs.length + 1}`,
      };
      state.prs.push(pr);
      return send(201, pr, `pr:create:${pr.number}`);
    }

    const prEditMatch = /^\/repos\/dinkuskit\/payments\/pulls\/(\d+)$/.exec(url.pathname);
    if (prEditMatch && method === "PATCH") {
      const pr = state.prs.find((entry) => entry.number === Number(prEditMatch[1]));
      if (!pr) return send(404, { message: "Not Found" }, "pr:missing");
      if (body.title !== undefined) pr.title = body.title;
      if (body.body !== undefined) pr.body = body.body;
      return send(200, pr, `pr:edit:${pr.number}`);
    }

    const relViewMatch = /^\/repos\/dinkuskit\/payments\/releases\/tags\/([^/]+)$/.exec(url.pathname);
    if (relViewMatch && method === "GET") {
      const tag = decodeURIComponent(relViewMatch[1]);
      if (!state.releases.has(tag)) return send(404, { message: "Not Found" }, `release:missing:${tag}`);
      return send(200, state.releases.get(tag), `release:found:${tag}`);
    }

    if (url.pathname === "/repos/dinkuskit/payments/releases" && method === "POST") {
      const tag = body.tag_name;
      if (body.verify_tag) {
        try {
          execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
            cwd: bareOriginDir,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          return send(422, { message: `Tag ${tag} does not exist on origin` }, `release:missing-tag:${tag}`);
        }
      }
      const rel = { tagName: tag, tag_name: tag, title: body.name, notes: body.body };
      state.releases.set(tag, rel);
      return send(201, rel, `release:create:${tag}`);
    }

    return send(404, { message: `Unhandled test route ${method} ${url.pathname}` }, "unhandled");
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const apiOrigin = `http://127.0.0.1:${address.port}`;

  const binDir = join(sandboxDir, "bin");
  await mkdir(binDir, { recursive: true });
  const ghBinPath = join(binDir, "gh");
  const ghScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
const api = process.env.TEST_GH_API_ORIGIN;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

async function request(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: {
      accept: "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    process.stderr.write(\`gh: \${data?.message || "HTTP " + res.status} (HTTP \${res.status})\\n\`);
    process.exit(1);
  }
  return data;
}

function flagValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : "";
}

if (args[0] === "api") {
  const endpoint = "/" + String(args[1] || "").replace(/^\\/+/, "");
  const data = await request("GET", endpoint);
  const jq = flagValue("--jq");
  if (jq === ".permission") {
    process.stdout.write(String(data.permission ?? "") + "\\n");
  } else {
    process.stdout.write(JSON.stringify(data) + "\\n");
  }
} else if (args[0] === "pr" && args[1] === "list") {
  const qs = new URLSearchParams();
  for (const key of ["state", "head", "base", "search"]) {
    const val = flagValue("--" + key);
    if (val) qs.set(key, val);
  }
  const prs = await request("GET", "/repos/dinkuskit/payments/pulls?" + qs.toString());
  const jq = flagValue("--jq");
  if (jq.includes(".[0].title")) {
    process.stdout.write((prs[0]?.title ?? "") + "\\n");
  } else if (jq.includes(".[].title")) {
    process.stdout.write(prs.map((p) => p.title).join("\\n") + "\\n");
  } else if (jq.includes(".[0].number")) {
    process.stdout.write((prs[0]?.number ? String(prs[0].number) : "") + "\\n");
  } else if (jq.includes(".[0].body")) {
    process.stdout.write((prs[0]?.body ?? "") + "\\n");
  } else {
    process.stdout.write(JSON.stringify(prs) + "\\n");
  }
} else if (args[0] === "pr" && args[1] === "create") {
  const pr = await request("POST", "/repos/dinkuskit/payments/pulls", {
    base: flagValue("--base"),
    head: flagValue("--head"),
    title: flagValue("--title"),
    body: flagValue("--body"),
  });
  process.stdout.write(pr.html_url + "\\n");
} else if (args[0] === "pr" && args[1] === "edit") {
  await request("PATCH", "/repos/dinkuskit/payments/pulls/" + args[2], {
    title: flagValue("--title"),
    body: flagValue("--body"),
  });
} else if (args[0] === "release" && args[1] === "view") {
  const rel = await request("GET", "/repos/dinkuskit/payments/releases/tags/" + encodeURIComponent(args[2]));
  process.stdout.write(JSON.stringify({ tagName: rel.tagName }) + "\\n");
} else if (args[0] === "release" && args[1] === "create") {
  await request("POST", "/repos/dinkuskit/payments/releases", {
    tag_name: args[2],
    name: flagValue("--title"),
    body: flagValue("--notes"),
    verify_tag: args.includes("--verify-tag"),
  });
} else {
  process.stderr.write("Unexpected gh command: " + args.join(" ") + "\\n");
  process.exit(1);
}
`;
  await writeFile(ghBinPath, ghScript, "utf8");
  await chmod(ghBinPath, 0o755);

  const pdsPreloadPath = join(sandboxDir, "pds-loopback.mjs");
  await writeFile(
    pdsPreloadPath,
    `const origFetch = globalThis.fetch;
const api = process.env.TEST_GH_API_ORIGIN;
globalThis.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (raw.startsWith("https://plc.directory/")) {
    return origFetch(api + "/plc/" + raw.slice("https://plc.directory/".length), init);
  }
  if (raw.startsWith("https://pds.test/")) {
    return origFetch(api + raw.slice("https://pds.test".length), init);
  }
  return origFetch(input, init);
};
`,
    "utf8",
  );

  return {
    state,
    apiOrigin,
    binDir,
    pdsPreloadPath,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

test("test_revoked_between_enqueue_and_publish_yields_zero_effects: real subprocess CLI, bare-origin git pushes, and executable gh enforce human authority across tag and Registry handoffs", async () => {
  const sandboxDir = await mkdtemp(join(tmpdir(), "payments-real-authority-handoff-"));
  const bareOriginDir = join(sandboxDir, "origin.git");
  const mainCheckout = join(sandboxDir, "main-checkout");
  const git = (args, cwd) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git(["init", "--bare", "-b", "main", bareOriginDir], sandboxDir);
  const rig = await startReleaseAuthorityTestRig(sandboxDir, bareOriginDir);

  try {
    git(["clone", "-q", bareOriginDir, mainCheckout], sandboxDir);
    git(["config", "user.name", "Release Bot"], mainCheckout);
    git(["config", "user.email", "release-bot@example.invalid"], mainCheckout);

    await mkdir(join(mainCheckout, ".changeset"), { recursive: true });
    await mkdir(join(mainCheckout, "src"), { recursive: true });
    await mkdir(join(mainCheckout, "scripts"), { recursive: true });

    const bumpHelperSource = `import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
const cwd = process.cwd();
const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
const files = (await readdir(join(cwd, ".changeset"))).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md").sort();
let rank = 0;
const summaries = [];
for (const file of files) {
  const raw = await readFile(join(cwd, ".changeset", file), "utf8");
  const m = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(raw.replace(/\\r\\n/g, "\\n"));
  if (!m) continue;
  if (m[1].includes(": major")) rank = Math.max(rank, 3);
  else if (m[1].includes(": minor")) rank = Math.max(rank, 2);
  else if (m[1].includes(": patch")) rank = Math.max(rank, 1);
  if (m[1].trim()) summaries.push("- " + m[2].trim());
  await rm(join(cwd, ".changeset", file), { force: true });
}
const next = rank === 3 ? \`\${maj + 1}.0.0\` : rank === 2 ? \`\${maj}.\${min + 1}.0\` : \`\${maj}.\${min}.\${pat + 1}\`;
pkg.version = next;
await writeFile(join(cwd, "package.json"), JSON.stringify(pkg, null, 2) + "\\n", "utf8");
const lock = JSON.parse(await readFile(join(cwd, "package-lock.json"), "utf8"));
lock.version = next;
if (lock.packages?.[""]) lock.packages[""].version = next;
await writeFile(join(cwd, "package-lock.json"), JSON.stringify(lock, null, 2) + "\\n", "utf8");
const changelog = await readFile(join(cwd, "CHANGELOG.md"), "utf8");
await writeFile(join(cwd, "CHANGELOG.md"), changelog.replace(/^## /m, \`## \${next}\\n\\n### Changes\\n\\n\${summaries.join("\\n")}\\n\\n## \`), "utf8");
`;
    await writeFile(join(mainCheckout, "scripts/bump-from-changesets.mjs"), bumpHelperSource, "utf8");
    await writeFile(
      join(mainCheckout, "emdash-plugin.jsonc"),
      JSON.stringify({ publisher: "did:plc:release-proof" }, null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      join(mainCheckout, "package.json"),
      JSON.stringify(
        {
          name: PACKAGE_NAME,
          version: "0.2.8",
          type: "module",
          scripts: { "release:version": "node scripts/bump-from-changesets.mjs" },
          dependencies: { jose: "6.2.12", stripe: "23.0.0" },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await writeFile(
      join(mainCheckout, "package-lock.json"),
      JSON.stringify(
        {
          name: PACKAGE_NAME,
          version: "0.2.8",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": { name: PACKAGE_NAME, version: "0.2.8", dependencies: { jose: "6.2.12", stripe: "23.0.0" } },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await writeFile(join(mainCheckout, "CHANGELOG.md"), "# @dinkuskit/payments\n\n## 0.2.8\n\n- Baseline.\n", "utf8");
    await writeFile(join(mainCheckout, "src/plugin.ts"), 'export const pluginVersion = "0.2.8";\n', "utf8");
    await writeFile(join(mainCheckout, ".changeset/README.md"), "# Changesets\n", "utf8");
    await writeFile(
      join(mainCheckout, ".changeset/add-feature.md"),
      `---\n"${PACKAGE_NAME}": patch\n---\n\nFix checkout callback status handling.\n`,
      "utf8",
    );

    git(["add", "-A"], mainCheckout);
    git(["commit", "-q", "-m", "feat: baseline with pending changeset"], mainCheckout);
    git(["tag", "v0.2.8"], mainCheckout);
    git(["push", "-q", "origin", "main", "refs/tags/v0.2.8"], mainCheckout);

    const releaseFlowPath = join(repositoryRoot, "scripts/release-flow.mjs");
    const runSubprocess = (cliArgs, { cwd, token = "app-write-token", withPdsPreload = false } = {}) =>
      new Promise((resolveRun, rejectRun) => {
        const fullCliArgs = [...cliArgs, "--root", cwd];
        const nodeArgs = withPdsPreload
          ? ["--import", rig.pdsPreloadPath, releaseFlowPath, ...fullCliArgs]
          : [releaseFlowPath, ...fullCliArgs];
        const proc = spawn(process.execPath, nodeArgs, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PATH: `${rig.binDir}${delimiter}${process.env.PATH || ""}`,
            TEST_GH_API_ORIGIN: rig.apiOrigin,
            GH_TOKEN: token,
            GITHUB_TOKEN: token,
          },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.setEncoding("utf8");
        proc.stderr.setEncoding("utf8");
        proc.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        proc.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        proc.on("error", rejectRun);
        proc.on("close", (code) => {
          resolveRun({
            status: code ?? 1,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
        });
      });

    let cloneCounter = 0;
    const freshClone = (checkoutRef = "main") => {
      cloneCounter += 1;
      const dir = join(sandboxDir, `runner-${cloneCounter}`);
      git(["clone", "-q", bareOriginDir, dir], sandboxDir);
      git(["config", "user.name", "Release Bot"], dir);
      git(["config", "user.email", "release-bot@example.invalid"], dir);
      git(["checkout", "-q", checkoutRef], dir);
      return dir;
    };

    // Pre-push revocation: alice dropped to "read" before cut-beta pushes -> zero local or bare-origin refs.
    rig.state.collaborators.set("alice", "read");
    const cutRevoked = await runSubprocess(["cut-beta", "--actor", "alice"], {
      cwd: freshClone("main"),
      withPdsPreload: true,
    });
    assert.equal(cutRevoked.status, 1);
    assert.match(cutRevoked.stderr, /Refusing to cut v0\.2\.9-beta\.1: alice no longer has write access to dinkuskit\/payments \(permission "read"\)/);
    assert.equal(git(["for-each-ref", "refs/heads/release/", "refs/tags/v0.2.9*"], bareOriginDir), "");

    // (a) Allowed end-to-end beta chain: cut-beta -> annotated tag on bare origin -> automatic tag push verify-release-tag (no --actor) -> read-only App token verify-authority.
    rig.state.collaborators.set("alice", "write");
    const cutOut = join(sandboxDir, "cut-beta.out");
    const cutAllowed = await runSubprocess(["cut-beta", "--actor", "alice", "--github-output", cutOut], {
      cwd: freshClone("main"),
      withPdsPreload: true,
    });
    assert.equal(cutAllowed.status, 0, cutAllowed.stderr);
    assert.equal(git(["cat-file", "-t", "refs/tags/v0.2.9-beta.1"], bareOriginDir), "tag");
    assert.match(git(["cat-file", "-p", "refs/tags/v0.2.9-beta.1"], bareOriginDir), /^Release-Actor: alice$/m);
    assert.equal(resolveTagActor("v0.2.9-beta.1", bareOriginDir), "alice");

    const betaTagOut = join(sandboxDir, "beta-tag.out");
    const betaTagCheck = await runSubprocess(
      ["verify-release-tag", "--ref", "refs/tags/v0.2.9-beta.1", "--require-actor", "--github-output", betaTagOut],
      { cwd: freshClone("refs/tags/v0.2.9-beta.1") },
    );
    assert.equal(betaTagCheck.status, 0, betaTagCheck.stderr);
    const betaTagOutputText = await readFile(betaTagOut, "utf8");
    assert.match(betaTagOutputText, /^release_actor=alice$/m);
    assert.match(betaTagOutputText, /^release_mode=beta$/m);

    // Job GITHUB_TOKEN without App installation access gets 403; read-only App token (permission-contents: read) succeeds with 200 while still denying writes.
    const jobTokenDenied = await runSubprocess(
      ["verify-authority", "--actor", "alice", "--effect", "publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry"],
      { cwd: freshClone("refs/tags/v0.2.9-beta.1"), token: "github-job-contents-read" },
    );
    assert.equal(jobTokenDenied.status, 1);

    const betaAuthOut = join(sandboxDir, "beta-auth.out");
    const betaFinalAuth = await runSubprocess(
      [
        "verify-authority",
        "--actor",
        "alice",
        "--effect",
        "publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry",
        "--github-output",
        betaAuthOut,
      ],
      { cwd: freshClone("refs/tags/v0.2.9-beta.1"), token: "app-contents-read-token" },
    );
    assert.equal(betaFinalAuth.status, 0, betaFinalAuth.stderr);
    assert.deepEqual(JSON.parse(betaFinalAuth.stdout), {
      ok: true,
      actor: "alice",
      permission: "write",
      effect: "publish dinkus-payments-beta@0.2.9-beta.1 to EmDash Registry",
    });
    assert.match(await readFile(betaAuthOut, "utf8"), /^actor=alice\npermission=write$/m);
    rig.state.pdsBetaVersions.push("0.2.9-beta.1");

    // Promote -> squash merge -> publish-merged-release pushes stable annotated tag v0.2.9 to bare origin.
    const promoteArgs = [
      "promote",
      "--beta-version",
      "0.2.9-beta.1",
      "--proof-ref",
      "https://github.com/dinkuskit/live-journeys/actions/runs/701 (0.2.9-beta.1 @running pass)",
      "--actor",
      "alice",
    ];
    rig.state.collaborators.set("alice", "read");
    const promoteRevoked = await runSubprocess(promoteArgs, { cwd: freshClone("main"), withPdsPreload: true });
    assert.equal(promoteRevoked.status, 1);
    assert.equal(rig.state.prs.length, 0);
    assert.equal(git(["for-each-ref", `refs/heads/${RELEASE_PR_BRANCH}`], bareOriginDir), "");

    rig.state.collaborators.set("alice", "write");
    const promoteAllowed = await runSubprocess(promoteArgs, { cwd: freshClone("main"), withPdsPreload: true });
    assert.equal(promoteAllowed.status, 0, promoteAllowed.stderr);
    assert.equal(rig.state.prs.length, 1);

    git(["fetch", "-q", "origin", RELEASE_PR_BRANCH, "main"], mainCheckout);
    git(["checkout", "-q", "main"], mainCheckout);
    const prMessage = git(["log", "-1", "--format=%B", `origin/${RELEASE_PR_BRANCH}`], mainCheckout);
    git(["merge", "-q", "--squash", `origin/${RELEASE_PR_BRANCH}`], mainCheckout);
    git(["commit", "-q", "-m", prMessage], mainCheckout);
    const mergedMainSha = git(["rev-parse", "HEAD"], mainCheckout);
    git(["push", "-q", "origin", "main"], mainCheckout);
    rig.state.prs[0].state = "merged";
    rig.state.prs[0].mergeSha = mergedMainSha;

    rig.state.collaborators.set("alice", "read");
    const mergedRevoked = await runSubprocess(["publish-merged-release", "--actor", "alice"], { cwd: freshClone("main") });
    assert.equal(mergedRevoked.status, 1);
    assert.equal(git(["for-each-ref", "refs/tags/v0.2.9"], bareOriginDir), "");

    rig.state.collaborators.set("alice", "write");
    const mergedAllowed = await runSubprocess(["publish-merged-release", "--actor", "alice"], { cwd: freshClone("main") });
    assert.equal(mergedAllowed.status, 0, mergedAllowed.stderr);
    assert.equal(git(["cat-file", "-t", "refs/tags/v0.2.9"], bareOriginDir), "tag");
    assert.match(git(["cat-file", "-p", "refs/tags/v0.2.9"], bareOriginDir), /^Release-Actor: alice$/m);

    // (b) Revoked AFTER stable tag push, BEFORE automatic verify-release-tag runs:
    // child exits 1, 0 GitHub Releases created, release_actor NOT written to $GITHUB_OUTPUT.
    rig.state.collaborators.set("alice", "read");
    const revokedStableOut = join(sandboxDir, "revoked-stable-tag.out");
    const stableRevokedBeforeTagVerify = await runSubprocess(
      ["verify-release-tag", "--ref", "refs/tags/v0.2.9", "--require-actor", "--github-output", revokedStableOut],
      { cwd: freshClone("refs/tags/v0.2.9") },
    );
    assert.equal(stableRevokedBeforeTagVerify.status, 1);
    assert.match(
      stableRevokedBeforeTagVerify.stderr,
      /Refusing to publish v0\.2\.9: alice no longer has write access to dinkuskit\/payments \(permission "read"\)/,
    );
    assert.equal(rig.state.releases.size, 0);
    assert.equal(existsSync(revokedStableOut), false);

    // Restore alice="write": automatic verify-release-tag passes, creates GitHub Release, and outputs release_actor=alice.
    rig.state.collaborators.set("alice", "write");
    const allowedStableOut = join(sandboxDir, "allowed-stable-tag.out");
    const stableTagAllowed = await runSubprocess(
      ["verify-release-tag", "--ref", "refs/tags/v0.2.9", "--require-actor", "--github-output", allowedStableOut],
      { cwd: freshClone("refs/tags/v0.2.9") },
    );
    assert.equal(stableTagAllowed.status, 0, stableTagAllowed.stderr);
    assert.equal(rig.state.releases.has("v0.2.9"), true);
    assert.match(await readFile(allowedStableOut, "utf8"), /^release_actor=alice$/m);

    // (c) Revoked during emdash-release.yml build/test window (after verify-release-tag passed, right before Registry publish):
    rig.state.collaborators.set("alice", "read");
    const buildWindowRevokedRead = await runSubprocess(
      ["verify-authority", "--actor", "alice", "--effect", "publish dinkus-payments@0.2.9 to EmDash Registry"],
      { cwd: freshClone("refs/tags/v0.2.9"), token: "app-contents-read-token" },
    );
    assert.equal(buildWindowRevokedRead.status, 1);
    assert.match(
      buildWindowRevokedRead.stderr,
      /Refusing to publish dinkus-payments@0\.2\.9 to EmDash Registry: alice no longer has write access to dinkuskit\/payments \(permission "read"\)/,
    );

    rig.state.collaborators.set("alice", "none");
    const buildWindowRevokedNone = await runSubprocess(
      ["verify-authority", "--actor", "alice", "--effect", "publish dinkus-payments@0.2.9 to EmDash Registry"],
      { cwd: freshClone("refs/tags/v0.2.9"), token: "app-contents-read-token" },
    );
    assert.equal(buildWindowRevokedNone.status, 1);
    assert.match(buildWindowRevokedNone.stderr, /\(permission "none"\)/);
    assert.deepEqual(rig.state.pdsStableVersions, []);

    // Manual retry-publish pressed on the tag by maintainer bob ("maintain") overrides revoked alice and completes Registry authority check.
    rig.state.collaborators.set("bob", "maintain");
    const retryOut = join(sandboxDir, "retry-stable-tag.out");
    const retryTagCheck = await runSubprocess(
      [
        "verify-release-tag",
        "--ref",
        "refs/tags/v0.2.9",
        "--require-actor",
        "--actor",
        "bob",
        "--github-output",
        retryOut,
      ],
      { cwd: freshClone("refs/tags/v0.2.9") },
    );
    assert.equal(retryTagCheck.status, 0, retryTagCheck.stderr);
    assert.match(await readFile(retryOut, "utf8"), /^release_actor=bob$/m);

    const retryFinalAuth = await runSubprocess(
      ["verify-authority", "--actor", "bob", "--effect", "publish dinkus-payments@0.2.9 to EmDash Registry"],
      { cwd: freshClone("refs/tags/v0.2.9"), token: "app-contents-read-token" },
    );
    assert.equal(retryFinalAuth.status, 0, retryFinalAuth.stderr);
    rig.state.pdsStableVersions.push("0.2.9");

    // (d) Forged lightweight tag whose commit message body contains "Release-Actor: bob":
    // resolveTagActor returns "" because objecttype is "commit" (not "tag"), and verify-release-tag --require-actor exits 1.
    const forgeWork = freshClone("refs/tags/v0.2.9");
    git(["checkout", "-q", "-B", "release/0.2.10", "refs/tags/v0.2.9"], forgeWork);
    await writeFile(join(forgeWork, "src/forged.ts"), "export const forged = true;\n", "utf8");
    git(["add", "src/forged.ts"], forgeWork);
    git(["commit", "-q", "-m", `fix: attempt provenance spoof\n\n${RELEASE_ACTOR_TRAILER}: bob`], forgeWork);
    const forgedCommitSha = git(["rev-parse", "HEAD"], forgeWork);
    git(["tag", "v0.2.10-beta.1", forgedCommitSha], forgeWork); // lightweight tag (no -a)
    git(["push", "-q", "origin", "release/0.2.10", "refs/tags/v0.2.10-beta.1"], forgeWork);

    const forgedTagCheckout = freshClone("refs/tags/v0.2.10-beta.1");
    assert.equal(git(["for-each-ref", "--format=%(objecttype)", "refs/tags/v0.2.10-beta.1"], forgedTagCheckout), "commit");
    assert.equal(resolveTagActor("v0.2.10-beta.1", forgedTagCheckout), "");

    const forgedOut = join(sandboxDir, "forged-tag.out");
    const forgedCheck = await runSubprocess(
      ["verify-release-tag", "--ref", "refs/tags/v0.2.10-beta.1", "--require-actor", "--github-output", forgedOut],
      { cwd: forgedTagCheckout },
    );
    assert.equal(forgedCheck.status, 1);
    assert.match(
      forgedCheck.stderr,
      /Refusing to publish v0\.2\.10-beta\.1: "\(empty\)" is not a GitHub login whose write access can be checked\./,
    );
    assert.equal(existsSync(forgedOut), false);

    // Clean up forged branch/tag on bare origin and prove add-fix pushes a real annotated tag carrying Release-Actor: bob.
    git(["push", "-q", "origin", ":refs/heads/release/0.2.10", ":refs/tags/v0.2.10-beta.1"], forgeWork);
    git(["checkout", "-q", "main"], mainCheckout);
    await writeFile(
      join(mainCheckout, ".changeset/shipping-fix.md"),
      `---\n"${PACKAGE_NAME}": patch\n---\n\nKeep shipping total after refresh.\n`,
      "utf8",
    );
    await writeFile(join(mainCheckout, "src/shipping.ts"), "export const keepTotal = true;\n", "utf8");
    git(["add", "-A"], mainCheckout);
    git(["commit", "-q", "-m", "fix: keep shipping total"], mainCheckout);
    const fixSha = git(["rev-parse", "HEAD"], mainCheckout);
    git(["push", "-q", "origin", "main"], mainCheckout);

    const addFixAllowed = await runSubprocess(
      ["add-fix", "--release-version", "0.2.10", "--commit", fixSha, "--actor", "bob"],
      { cwd: freshClone("main"), withPdsPreload: true },
    );
    assert.equal(addFixAllowed.status, 0, addFixAllowed.stderr);
    assert.equal(git(["cat-file", "-t", "refs/tags/v0.2.10-beta.1"], bareOriginDir), "tag");
    assert.equal(resolveTagActor("v0.2.10-beta.1", bareOriginDir), "bob");
    const patchTagCheck = await runSubprocess(
      ["verify-release-tag", "--ref", "refs/tags/v0.2.10-beta.1", "--require-actor"],
      { cwd: freshClone("refs/tags/v0.2.10-beta.1") },
    );
    assert.equal(patchTagCheck.status, 0, patchTagCheck.stderr);
  } finally {
    await rig.close();
    await rm(sandboxDir, { recursive: true, force: true });
  }
});

test("mid-run permission revocation after command start yields zero local tags, pushes, PRs, or GitHub Releases and idempotent cut-beta refreshes unpushed tag provenance", async () => {
  const actor = "release-presser";
  const events = [];
  const { root } = await createSeededRepo("revoked-authority", []);
  const git = (args, cwd = root) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const permissions = new Map([[actor, "write"], ["second-maintainer", "admin"]]);
    let revokeOnNextGit = false;
    const gitExec = (args, cwd = root) => {
      if (revokeOnNextGit) {
        revokeOnNextGit = false;
        permissions.set(actor, "read");
        events.push(`authority:revoked:${actor}`);
      }
      if (args[0] === "push") {
        events.push(`git:push:${args.slice(1).join(" ")}`);
        return "";
      }
      if (args[0] === "tag" && args[1] !== "--list") {
        const tagName = args.find((arg, i) => i > 0 && !arg.startsWith("-") && args[i - 1] !== "-m") ?? args[1];
        events.push(`git:tag:${tagName}`);
      }
      return git(args, cwd);
    };
    const env = createStubEnvironment({ events });
    const ghExec = (args, cwd) => {
      const permission = /^repos\/dinkuskit\/payments\/collaborators\/([^/]+)\/permission$/.exec(args[1] ?? "");
      if (args[0] === "api" && permission) {
        events.push(`gh:api:permission:${permission[1]}`);
        if (!permissions.has(permission[1])) throw new Error("gh: Not Found (HTTP 404)");
        return permissions.get(permission[1]);
      }
      return env.ghExec(args, cwd);
    };
    const deps = { root, gitExec, ghExec, fetchImpl: env.fetchImpl, npmExec: env.npmExec, log: () => {} };

    const enqueue = (argv) => {
      verifyWriteAuthority(actor, { root, ghExec, effect: "queue the release run" });
      return [...argv, "--actor", actor];
    };
    const runRevoked = async (argv) => {
      const queued = enqueue(argv);
      const from = events.length;
      revokeOnNextGit = true;
      await assert.rejects(
        () => runReleaseFlowCli(queued, deps),
        /release-presser no longer has write access to dinkuskit\/payments \(permission "read"\)/,
        argv[0],
      );
      const run = events.slice(from);
      assert.ok(run.includes(`authority:revoked:${actor}`), `${argv[0]} was revoked mid-run`);
      assert.deepEqual(run.filter(RELEASE_EFFECT), [], `${argv[0]} made no effect after revocation`);
      permissions.set(actor, "write");
    };
    const runAuthorized = async (argv) => {
      const from = events.length;
      const result = await runReleaseFlowCli(enqueue(argv), deps);
      const run = events.slice(from);
      assert.ok(run.some((event) => event.startsWith("git:push:") || event.startsWith("gh:release:create:")), `${argv[0]} made its effects`);
      run.forEach((event, index) => {
        if (!RELEASE_EFFECT(event)) return;
        let previous = index - 1;
        while (previous >= 0 && (RELEASE_LOOKUP(run[previous]) || run[previous].startsWith("git:tag:"))) previous -= 1;
        assert.equal(run[previous], `gh:api:permission:${actor}`, `${argv[0]}: ${event} follows a fresh authority read`);
      });
      return { result, pushes: run.filter((event) => event.startsWith("git:push:")) };
    };

    await runRevoked(["cut-beta"]);
    assert.equal(git(["tag", "--list", "v0.2.9-beta.*"]), "");

    // Pre-existing lightweight tag at HEAD gets upgraded in-place to an annotated tag when cut-beta runs with --actor.
    const mainHead = git(["rev-parse", "HEAD"]);
    git(["tag", "v0.2.9-beta.1", mainHead]);
    assert.equal(resolveTagActor("v0.2.9-beta.1", root), "");
    const { result: cut, pushes: cutPushes } = await runAuthorized(["cut-beta", "--version", "0.2.9-beta.1"]);
    assert.equal(resolveTagActor("v0.2.9-beta.1", root), actor);
    assert.equal(git(["rev-list", "-n", "1", "v0.2.9-beta.1"]), mainHead);
    assert.match(cutPushes.join("\n"), /refs\/heads\/release\/0\.2\.9 refs\/tags\/v0\.2\.9-beta\.1$/m);
    env.state.betaVersions.push(cut.version);

    const promote = [
      "promote",
      "--beta-version",
      cut.version,
      "--proof-ref",
      `https://github.com/dinkuskit/live-journeys/actions/runs/701 (${cut.version} @running pass)`,
    ];
    await runRevoked(promote);
    assert.deepEqual(env.state.openPrs, []);
    const { pushes: promotePushes } = await runAuthorized(promote);
    assert.equal(env.state.openPrs.length, 1);
    assert.match(promotePushes.join("\n"), /HEAD:refs\/heads\/changeset-release\/main$/m);

    squashMergeReleasePr(root);
    await runRevoked(["publish-merged-release"]);
    git(["checkout", "-q", "-f", "main"]);
    git(["branch", "-f", "release/0.2.9", cut.betaSha]);
    const { pushes: mergedPushes } = await runAuthorized(["publish-merged-release"]);
    assert.equal(resolveTagActor("v0.2.9", root), actor);
    assert.match(mergedPushes.join("\n"), /refs\/heads\/release\/0\.2\.9 refs\/tags\/v0\.2\.9$/m);

    await runRevoked(["verify-release-tag", "--ref", "refs/tags/v0.2.9", "--require-actor"]);
    assert.equal(env.state.githubReleases.has("v0.2.9"), false);
    await runAuthorized(["verify-release-tag", "--ref", "refs/tags/v0.2.9", "--require-actor"]);
    assert.equal(env.state.githubReleases.has("v0.2.9"), true);

    const fixSha = await commitOnMain(root, { "src/shipping.ts": "export const keepTotal = true;\n" }, "fix: keep the shipping total");
    const addFix = ["add-fix", "--release-version", "0.2.10", "--commit", fixSha];
    await runRevoked(addFix);
    git(["checkout", "-q", "-f", "main"]);
    git(["branch", "-D", "release/0.2.10"]);
    const { pushes: fixPushes } = await runAuthorized(addFix);
    assert.equal(resolveTagActor("v0.2.10-beta.1", root), actor);
    assert.match(fixPushes.join("\n"), /refs\/heads\/release\/0\.2\.10 refs\/tags\/v0\.2\.10-beta\.1$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release.yml and emdash-release.yml carry and re-verify human release authority through final Registry publish", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
  const emdashWorkflow = await readFile(join(repositoryRoot, ".github/workflows/emdash-release.yml"), "utf8");
  const contract = verifyEmDashWorkflowContract({
    emdashWorkflowText: emdashWorkflow,
    releaseWorkflowText: workflow,
  });
  assert.equal(contract.finalAuthorityRecheckBeforePublish, true);
  assert.equal(contract.emdashAppTokenReadOnly, true);

  const steps = workflow.split(/\n(?=      - name: )/);
  const expected = { "cut-beta": 2, "add-fix": 1, promote: 1, "publish-merged-release": 1, "verify-release-tag": 1 };
  for (const [command, count] of Object.entries(expected)) {
    const invocations = steps.flatMap((step) =>
      [...step.replace(/\\\n\s*/g, " ").matchAll(new RegExp(`node scripts/release-flow\\.mjs ${command}\\b[^\\n]*`, "g"))].map(
        (match) => ({ step, invocation: match[0] }),
      ),
    );
    assert.equal(invocations.length, count, `${command} invocations`);
    for (const { step, invocation } of invocations) {
      assert.match(invocation, /--actor "\$RELEASE_ACTOR"/, invocation);
      assert.match(step, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/, `${command} can read the actor's access`);
      if (command === "verify-release-tag") {
        assert.match(step, /RELEASE_ACTOR: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.triggering_actor \|\| '' \}\}/);
        assert.match(invocation, /--require-actor\b/);
        assert.match(invocation, /\$\{RELEASE_ACTOR:\+--actor "\$RELEASE_ACTOR"\}/);
      } else {
        assert.match(step, /RELEASE_ACTOR: \$\{\{ github\.triggering_actor \}\}/, `${command} names its pusher`);
      }
    }
  }

  // Contract guard rejects write-capable App tokens, missing --require-actor, secrets: inherit, or wrong verify-authority ordering.
  assert.throws(
    () =>
      verifyEmDashWorkflowContract({
        emdashWorkflowText: emdashWorkflow.replace("permission-contents: read", "permission-contents: write"),
        releaseWorkflowText: workflow,
      }),
    /permission-contents: read only/,
  );
  assert.throws(
    () =>
      verifyEmDashWorkflowContract({
        emdashWorkflowText: emdashWorkflow.replace(
          "          permission-contents: read",
          "          permission-contents: read\n          permission-pull-requests: read",
        ),
        releaseWorkflowText: workflow,
      }),
    /permission-contents: read only/,
  );
  assert.throws(
    () =>
      verifyEmDashWorkflowContract({
        emdashWorkflowText: emdashWorkflow,
        releaseWorkflowText: workflow.replace("--require-actor ", ""),
      }),
    /--require-actor/,
  );
  assert.throws(
    () =>
      verifyEmDashWorkflowContract({
        emdashWorkflowText: emdashWorkflow,
        releaseWorkflowText: `${workflow}\n    secrets: inherit\n`,
      }),
    /secrets: inherit/,
  );
  assert.throws(
    () =>
      verifyEmDashWorkflowContract({
        emdashWorkflowText: emdashWorkflow.replace(
          '          wait-for-approval: "false"',
          '          wait-for-approval: "true"',
        ),
        releaseWorkflowText: workflow,
      }),
    /wait-for-approval: "false"/,
  );
  assert.throws(
    () =>
      verifyEmDashWorkflowContract({
        emdashWorkflowText: emdashWorkflow.replace(
          '          timeout-minutes: "2"',
          '          timeout-minutes: "30"',
        ),
        releaseWorkflowText: workflow,
      }),
    /timeout-minutes <= 5/,
  );
  assert.throws(
    () =>
      verifyEmDashWorkflowContract({
        emdashWorkflowText: emdashWorkflow.replace(
          "      - name: Ensure EmDash workflow connection before final authority check\n",
          "      - name: Ensure EmDash workflow connection before final authority check\n        continue-on-error: true\n",
        ),
        releaseWorkflowText: workflow,
      }),
    /without continue-on-error/,
  );
  assert.throws(
    () =>
      verifyEmDashWorkflowContract({
        emdashWorkflowText: emdashWorkflow.replace(
          "node .github/scripts/ensure-emdash-workflow-connection.mjs",
          "# removed workflow-connection preflight",
        ),
        releaseWorkflowText: workflow,
      }),
    /EmDash workflow-connection preflight/,
  );
});

test("ensure-emdash-workflow-connection completes pending approval waits before verify-authority and blocks delegated ReleaseServiceClient publication when revoked during the wait", async () => {
  // Argument & OIDC validation fail-closed checks
  assert.throws(() => parseWorkflowConnectionArgs(["--slug"]), /Missing value for --slug/);
  assert.throws(() => parseWorkflowConnectionArgs(["--unknown", "x"]), /Unknown argument: --unknown/);
  await assert.rejects(
    () =>
      fetchGithubOidcToken("https://releases.emdashcms.com", {
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL: "http://insecure.example/oidc",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-tok",
        },
      }),
    /GitHub OIDC is unavailable/,
  );
  await assert.rejects(
    () =>
      fetchGithubOidcToken("https://releases.emdashcms.com", {
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://user:pass@oidc.example/oidc",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-tok",
        },
      }),
    /GitHub OIDC is unavailable/,
  );

  if (!existsSync(join(repositoryRoot, "dist/sandbox/plugin.mjs"))) {
    execFileSync("npm", ["run", "plugin:build"], { cwd: repositoryRoot, stdio: "inherit" });
  }

  const sandboxDir = await mkdtemp(join(tmpdir(), "payments-delegated-wait-"));
  let server = null;
  try {
    const keyPath = join(sandboxDir, "tls-key.pem");
    const certPath = join(sandboxDir, "tls-cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { stdio: "ignore" },
    );

    const preparedDir = join(sandboxDir, "prepared-beta");
    execFileSync(
      process.execPath,
      [
        join(repositoryRoot, ".github/scripts/prepare-emdash-release.mjs"),
        "--version",
        "0.2.9-beta.1",
        "--out-dir",
        preparedDir,
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
    const packageBytes = new Uint8Array(
      await readFile(join(preparedDir, "dinkus-payments-beta-0.2.9-beta.1.tar.gz")),
    );
    const packageChecksum = computePackageChecksum(packageBytes);
    const validatedBundle = await validatePluginBundle(packageBytes);
    assert.equal(validatedBundle.success, true);
    const provenanceBytes = new TextEncoder().encode(
      JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", subject: packageChecksum }),
    );
    const provenanceChecksum = computePackageChecksum(provenanceBytes);
    const publisherDid = "did:plc:ekk4pjmkh3k3ql2kfoex3qt4";
    const packageSlug = BETA_REGISTRY_SLUG;
    const version = "0.2.9-beta.1";

    const state = {
      collaborators: new Map([["alice", "write"]]),
      connectionPolls: 0,
      revokeDuringPendingWait: false,
      stagedArtifactUploads: [],
      submittedIntents: [],
      httpTrace: [],
    };

    const REQUEST_ID = "01JGWK9B7R3M2N4P5Q6R7S8T9V";
    const INTENT_ID = "01JGWK9C8S4N3P5Q6R7S8T9V0W";
    const WORKFLOW_ID = "01JGWK9D9T5P4Q6R7S8T9V0W1X";
    const OIDC_REQUEST_TOKEN = "actions-oidc-request-token";
    const OIDC_JWT = "oidc-workload-jwt-token";
    const READONLY_APP_TOKEN = "app-contents-read-token";

    let serviceOrigin = "";
    server = createHttpsServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyBuf = Buffer.concat(chunks);
        const url = new URL(req.url ?? "/", serviceOrigin);
        const auth = req.headers.authorization ?? "";
        const sendJson = (status, payload) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        if (req.method === "GET" && url.pathname === "/oidc") {
          if (auth !== `Bearer ${OIDC_REQUEST_TOKEN}` || url.searchParams.get("audience") !== serviceOrigin) {
            return sendJson(401, { error: "unauthorized_oidc" });
          }
          state.httpTrace.push(`GET /oidc?audience=${url.searchParams.get("audience")} -> 200`);
          return sendJson(200, { value: OIDC_JWT });
        }

        const collabMatch = /^\/repos\/dinkuskit\/payments\/collaborators\/([^/]+)\/permission$/.exec(
          url.pathname,
        );
        if (req.method === "GET" && collabMatch) {
          if (auth !== `Bearer ${READONLY_APP_TOKEN}`) {
            return sendJson(403, { message: "Forbidden" });
          }
          const permission = state.collaborators.get(collabMatch[1]) ?? "none";
          state.httpTrace.push(`GET ${url.pathname} -> 200 (${permission})`);
          return sendJson(200, { permission });
        }

        if (auth !== `Bearer ${OIDC_JWT}`) {
          return sendJson(401, {
            error: { code: "AUTH_INVALID", message: "Invalid workload token" },
            requestId: "req-unauth",
          });
        }

        if (req.method === "POST" && url.pathname === "/v1/workflow-connections") {
          state.connectionPolls += 1;
          const payload = JSON.parse(bodyBuf.toString("utf8"));
          if (state.connectionPolls === 1) {
            if (state.revokeDuringPendingWait) {
              state.collaborators.set("alice", "read");
              state.httpTrace.push("EVENT alice permission downgraded write -> read while workflow-connection is pending");
            }
            state.httpTrace.push(`POST /v1/workflow-connections [poll=${state.connectionPolls}] -> 200 (pending)`);
            return sendJson(200, {
              data: {
                status: "pending",
                replayed: false,
                approvalUrl: `${serviceOrigin}/publisher?connection=${REQUEST_ID}`,
                request: {
                  id: REQUEST_ID,
                  packageSlug: payload.packageSlug,
                  state: "pending",
                  refScope: null,
                  createdAt: 1793458000000,
                  expiresAt: 1793459800000,
                  confirmedAt: null,
                  claim: {
                    repository: "dinkuskit/payments",
                    repositoryId: "1351728314",
                    repositoryOwner: "dinkuskit",
                    repositoryOwnerId: "200000001",
                    repositoryVisibility: "public",
                    workflowRef: "dinkuskit/payments/.github/workflows/release.yml@refs/tags/v0.2.9-beta.1",
                    ref: "refs/tags/v0.2.9-beta.1",
                    environment: null,
                  },
                },
              },
            });
          }
          state.httpTrace.push(`POST /v1/workflow-connections [poll=${state.connectionPolls}] -> 200 (connected)`);
          return sendJson(200, {
            data: {
              status: "connected",
              policy: {
                packageSlug: payload.packageSlug,
                repository: "dinkuskit/payments",
                repositoryId: "1351728314",
                repositoryOwnerId: "200000001",
                workflowRef: "dinkuskit/payments/.github/workflows/release.yml",
                allowedRefs: ["refs/tags/v*"],
                allowedEnvironments: [],
                repositoryConnection: true,
                active: true,
                stateVersion: 1,
                authorizedBy: payload.publisherDid,
                createdAt: 1793458000000,
                updatedAt: 1793458001000,
              },
            },
          });
        }

        if (req.method === "POST" && url.pathname === "/v1/staged-artifacts") {
          const slot = String(req.headers["x-emdash-artifact-slot"] ?? "");
          const checksum = String(req.headers["x-emdash-checksum"] ?? "");
          const contentType = String(req.headers["content-type"] ?? "");
          const stagedPath =
            slot === "provenance"
              ? `/v1/provenance/${checksum}`
              : `/v1/staged-artifacts/${slot.replaceAll("[", "-").replaceAll("]", "")}/${checksum}`;
          state.stagedArtifactUploads.push({ slot, checksum, size: bodyBuf.byteLength });
          state.httpTrace.push(`POST /v1/staged-artifacts [slot=${slot}] -> 200`);
          return sendJson(200, {
            data: {
              replayed: false,
              artifact: {
                slot,
                checksum,
                contentType,
                size: bodyBuf.byteLength,
                sourceUrl: `${serviceOrigin}${stagedPath}`,
              },
            },
          });
        }

        if (req.method === "POST" && url.pathname === "/v1/release-intents") {
          const payload = JSON.parse(bodyBuf.toString("utf8"));
          state.submittedIntents.push(payload);
          state.httpTrace.push(`POST /v1/release-intents [${payload.packageSlug}@${payload.version}] -> 200`);
          return sendJson(200, {
            data: {
              replayed: false,
              intent: {
                id: INTENT_ID,
                publisherDid: payload.publisherDid,
                packageSlug: payload.packageSlug,
                version: payload.version,
                state: "publishing",
                stateGeneration: 1,
                reasonCode: null,
                reasonMessage: null,
                workflowId: WORKFLOW_ID,
                expiresAt: 1793459800000,
                createdAt: 1793458002000,
                updatedAt: 1793458002000,
                result: null,
                approvalUrl: null,
              },
            },
          });
        }

        if (req.method === "GET" && url.pathname === `/v1/release-intents/${INTENT_ID}`) {
          state.httpTrace.push(`GET ${url.pathname} -> 200 (published)`);
          return sendJson(200, {
            data: {
              intent: {
                id: INTENT_ID,
                publisherDid,
                packageSlug,
                version,
                state: "published",
                stateGeneration: 2,
                reasonCode: null,
                reasonMessage: null,
                workflowId: WORKFLOW_ID,
                expiresAt: 1793459800000,
                createdAt: 1793458002000,
                updatedAt: 1793458003000,
                result: {
                  uri: `at://${publisherDid}/com.emdashcms.experimental.package.release/${packageSlug}:${version}`,
                  cid: "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
                },
                approvalUrl: null,
              },
            },
          });
        }

        return sendJson(404, { error: { code: "NOT_FOUND", message: "Not found" }, requestId: "req-404" });
      },
    );

    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    serviceOrigin = `https://127.0.0.1:${server.address().port}`;

    // Executable gh shim exclusively for collaborator permission endpoint in unit test
    const binDir = join(sandboxDir, "bin");
    await mkdir(binDir, { recursive: true });
    const ghBin = join(binDir, "gh");
    await writeFile(
      ghBin,
      [
        `#!${process.execPath}`,
        `const args = process.argv.slice(2);`,
        `const endpoint = args[1];`,
        `const res = await fetch(\`\${process.env.TEST_HTTPS_ORIGIN}/\${endpoint}\`, {`,
        `  headers: { authorization: \`Bearer \${process.env.GH_TOKEN || ""}\` },`,
        `});`,
        `if (!res.ok) process.exit(1);`,
        `const data = await res.json();`,
        `process.stdout.write(String(data.permission ?? "") + "\\n");`,
      ].join("\n"),
      "utf8",
    );
    await chmod(ghBin, 0o755);

    const spawnNode = (scriptRelPath, args, extraEnv = {}) =>
      new Promise((resolveChild, rejectChild) => {
        const child = spawn(process.execPath, [join(repositoryRoot, scriptRelPath), ...args], {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
            NODE_EXTRA_CA_CERTS: certPath,
            TEST_HTTPS_ORIGIN: serviceOrigin,
            ACTIONS_ID_TOKEN_REQUEST_URL: `${serviceOrigin}/oidc`,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
            ...extraEnv,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", rejectChild);
        child.on("close", (code) => resolveChild({ status: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
      });

    const publishRunnerPath = join(sandboxDir, "delegated-publish-runner.mjs");
    const registryClientModuleUrl = new URL(
      "../node_modules/@emdash-cms/registry-client/dist/release-service/index.js",
      import.meta.url,
    ).href;
    const oidcHelperUrl = new URL(
      "../.github/scripts/ensure-emdash-workflow-connection.mjs",
      import.meta.url,
    ).href;
    await writeFile(
      publishRunnerPath,
      [
        `import { readFile } from "node:fs/promises";`,
        `import { ReleaseServiceClient } from ${JSON.stringify(registryClientModuleUrl)};`,
        `import { fetchGithubOidcToken } from ${JSON.stringify(oidcHelperUrl)};`,
        `const cfg = JSON.parse(process.argv[2]);`,
        `const packageBytes = new Uint8Array(await readFile(cfg.packageFile));`,
        `const provenanceBytes = new Uint8Array(Buffer.from(cfg.provenanceJson, "utf8"));`,
        `const client = new ReleaseServiceClient({`,
        `  serviceUrl: cfg.serviceOrigin,`,
        `  workloadToken: () => fetchGithubOidcToken(cfg.serviceOrigin),`,
        `});`,
        `await client.waitForWorkflowConnection(`,
        `  { publisherDid: cfg.publisherDid, packageSlug: cfg.packageSlug },`,
        `  { idempotencyKey: \`github-connection-\${cfg.runId}-\${cfg.packageSlug}\`, pollIntervalMs: 25, maxWaitMs: 120000 },`,
        `);`,
        `const pkgUploaded = await client.uploadReleaseArtifact(`,
        `  { publisherDid: cfg.publisherDid, packageSlug: cfg.packageSlug, version: cfg.version, slot: "package", checksum: cfg.packageChecksum, contentType: "application/gzip", bytes: packageBytes },`,
        `  { idempotencyKey: \`github-upload-\${cfg.runId}-\${cfg.packageSlug}-package\` },`,
        `);`,
        `const provUploaded = await client.uploadReleaseArtifact(`,
        `  { publisherDid: cfg.publisherDid, packageSlug: cfg.packageSlug, version: cfg.version, slot: "provenance", checksum: cfg.provenanceChecksum, contentType: "application/json", bytes: provenanceBytes },`,
        `  { idempotencyKey: \`github-upload-\${cfg.runId}-\${cfg.packageSlug}-provenance\` },`,
        `);`,
        `const submitted = await client.submitIntent(`,
        `  { publisherDid: cfg.publisherDid, packageSlug: cfg.packageSlug, version: cfg.version, release: {`,
        `      $type: cfg.nsidRelease,`,
        `      package: cfg.packageSlug,`,
        `      version: cfg.version,`,
        `      artifacts: { package: { url: pkgUploaded.artifact.sourceUrl, checksum: cfg.packageChecksum, contentType: "application/gzip" } },`,
        `      extensions: { [cfg.nsidExt]: { $type: cfg.nsidExt, declaredAccess: cfg.declaredAccess, provenance: { url: provUploaded.artifact.sourceUrl, checksum: cfg.provenanceChecksum, predicateType: "https://slsa.dev/provenance/v1", sourceRepository: "https://github.com/dinkuskit/payments", builderId: "https://github.com/dinkuskit/payments/.github/workflows/release.yml@refs/tags/v0.2.9-beta.1" } } },`,
        `    }`,
        `  },`,
        `  { idempotencyKey: \`github-run-\${cfg.runId}\` },`,
        `);`,
        `const finalIntent = await client.waitForIntent(cfg.publisherDid, submitted.intent.id, { pollIntervalMs: 25, maxWaitMs: 120000, stopOnApproval: true });`,
        `console.log(JSON.stringify(finalIntent));`,
      ].join("\n"),
      "utf8",
    );
    assert.equal(typeof ReleaseServiceClient, "function");

    // Case 1: Allowed actor across pending workflow-connection approval wait -> delegated ReleaseServiceClient publishes.
    const allowedOut = join(sandboxDir, "allowed-conn.out");
    const allowedSummary = join(sandboxDir, "allowed-conn.summary.md");
    const connAllowed = await spawnNode(
      ".github/scripts/ensure-emdash-workflow-connection.mjs",
      [
        "--service-url",
        serviceOrigin,
        "--publisher-did",
        publisherDid,
        "--slug",
        packageSlug,
        "--poll-interval-ms",
        "25",
        "--timeout-minutes",
        "1",
        "--github-output",
        allowedOut,
        "--step-summary",
        allowedSummary,
      ],
      { GITHUB_RUN_ID: "910001" },
    );
    assert.equal(connAllowed.status, 0, connAllowed.stderr);
    assert.match(connAllowed.stdout, /Approve this GitHub workflow to continue:/);
    assert.match(connAllowed.stdout, /EmDash workflow connection ready for dinkus-payments-beta/);
    assert.match(await readFile(allowedOut, "utf8"), /connection-url<</);
    assert.match(await readFile(allowedSummary, "utf8"), /## Approve this GitHub workflow/);

    const authAllowed = await spawnNode(
      "scripts/release-flow.mjs",
      [
        "verify-authority",
        "--actor",
        "alice",
        "--effect",
        `publish ${packageSlug}@${version} to EmDash Registry`,
      ],
      { GH_TOKEN: READONLY_APP_TOKEN },
    );
    assert.equal(authAllowed.status, 0, authAllowed.stderr);

    const publishAllowed = await new Promise((resolveChild, rejectChild) => {
      const child = spawn(
        process.execPath,
        [
          publishRunnerPath,
          JSON.stringify({
            serviceOrigin,
            publisherDid,
            packageSlug,
            version,
            runId: "910001",
            packageFile: join(preparedDir, "dinkus-payments-beta-0.2.9-beta.1.tar.gz"),
            packageChecksum,
            provenanceJson: new TextDecoder().decode(provenanceBytes),
            provenanceChecksum,
            nsidRelease: NSID.packageRelease,
            nsidExt: NSID.packageReleaseExtension,
            declaredAccess: validatedBundle.value.declaredAccess,
          }),
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: certPath,
            ACTIONS_ID_TOKEN_REQUEST_URL: `${serviceOrigin}/oidc`,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      child.stderr.on("data", (c) => {
        stderr += c;
      });
      child.on("error", rejectChild);
      child.on("close", (code) => resolveChild({ status: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    });
    assert.equal(publishAllowed.status, 0, publishAllowed.stderr);
    const publishedIntent = JSON.parse(publishAllowed.stdout);
    assert.equal(publishedIntent.state, "published");
    assert.equal(
      publishedIntent.result?.uri,
      `at://${publisherDid}/com.emdashcms.experimental.package.release/${packageSlug}:${version}`,
    );
    assert.equal(state.stagedArtifactUploads.length, 2);
    assert.equal(state.submittedIntents.length, 1);

    // Case 2: Actor starts with "write", enters workflow-connection pending wait, and is downgraded
    // to "read" DURING that wait before connection becomes "connected" -> verify-authority fails closed
    // before ReleaseServiceClient / release-action can upload any artifact or submit any release intent.
    state.collaborators.set("alice", "write");
    state.connectionPolls = 0;
    state.revokeDuringPendingWait = true;
    state.stagedArtifactUploads = [];
    state.submittedIntents = [];
    state.httpTrace = [];

    const revokedConnOut = join(sandboxDir, "revoked-conn.out");
    const connBeforeRevokeCheck = await spawnNode(
      ".github/scripts/ensure-emdash-workflow-connection.mjs",
      [
        "--service-url",
        serviceOrigin,
        "--publisher-did",
        publisherDid,
        "--slug",
        packageSlug,
        "--poll-interval-ms",
        "25",
        "--timeout-minutes",
        "1",
        "--github-output",
        revokedConnOut,
      ],
      { GITHUB_RUN_ID: "910002" },
    );
    assert.equal(connBeforeRevokeCheck.status, 0, connBeforeRevokeCheck.stderr);
    assert.equal(state.collaborators.get("alice"), "read");
    assert.ok(
      state.httpTrace.some((line) => line.includes("alice permission downgraded write -> read while workflow-connection is pending")),
    );

    const authAfterPendingRevoke = await spawnNode(
      "scripts/release-flow.mjs",
      [
        "verify-authority",
        "--actor",
        "alice",
        "--effect",
        `publish ${packageSlug}@${version} to EmDash Registry`,
      ],
      { GH_TOKEN: READONLY_APP_TOKEN },
    );
    assert.equal(authAfterPendingRevoke.status, 1);
    assert.match(
      authAfterPendingRevoke.stderr,
      /Refusing to publish dinkus-payments-beta@0\.2\.9-beta\.1 to EmDash Registry: alice no longer has write access to dinkuskit\/payments \(permission "read"\)\./,
    );
    assert.equal(state.stagedArtifactUploads.length, 0);
    assert.equal(state.submittedIntents.length, 0);
  } finally {
    if (server) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    await rm(sandboxDir, { recursive: true, force: true });
  }
});
