import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BETA_PLUGIN_SLUG,
  PKG_PR_NEW_NOT_INSTALLED_TEXT,
  STABLE_PLUGIN_SLUG,
  classifyPreviewPublishResult,
  computeNextBetaNumber,
  computeNextStableVersion,
  deriveRegistryPluginId,
  evaluatePreviewPublish,
  extractChangelogSection,
  fetchRegistryPackageVersions,
  hasRegistryVersion,
  inspectReleaseState,
  parseChangesetFile,
  prepareBetaBuild,
  repositoryRoot,
  validatePrChangesets,
} from "../scripts/release-flow.mjs";

async function makeSyntheticRepo({
  version = "0.2.8",
  changesets = {},
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "payments-release-flow-"));
  await mkdir(join(dir, ".changeset"), { recursive: true });
  await mkdir(join(dir, "src/registry"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "@dinkuskit/payments",
        version,
        dinkuskit: {
          pluginId: "dinkus-payments",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(dir, "emdash-plugin.jsonc"),
    JSON.stringify(
      {
        slug: "dinkus-payments",
        license: "MIT",
        publisher: "did:plc:ekk4pjmkh3k3ql2kfoex3qt4",
        capabilities: ["network:request"],
        allowedHosts: ["dinkuskit.com", "payments.dinkuskit.com"],
        name: "DinkusKit Payments",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(dir, "src/registry/identity.ts"),
    'export const registryInstallationIdentity = Object.freeze({\n  publisherDid: "did:plc:ekk4pjmkh3k3ql2kfoex3qt4",\n  slug: "dinkus-payments",\n  installedPluginId: "r_3brsc2on3bu673rn",\n});\n',
    "utf8",
  );
  await writeFile(join(dir, ".changeset/README.md"), "# Changesets\n", "utf8");
  for (const [name, content] of Object.entries(changesets)) {
    await writeFile(join(dir, ".changeset", name), content, "utf8");
  }
  return dir;
}

test("parseChangesetFile parses empty, patch, and minor changesets", () => {
  const empty = parseChangesetFile("---\n---\n\nNo release needed.\n", ".changeset/empty.md");
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.bumps, {});

  const minor = parseChangesetFile(
    '---\n"@dinkuskit/payments": minor\n---\n\nAdd locked release flow.\n',
    ".changeset/minor.md",
  );
  assert.equal(minor.empty, false);
  assert.deepEqual(minor.bumps, { "@dinkuskit/payments": "minor" });
  assert.equal(minor.summary, "Add locked release flow.");
});

test("validatePrChangesets enforces PR changeset requirement and 0.x bump policy", async () => {
  const noChangesetDir = await makeSyntheticRepo();
  try {
    const missing = await validatePrChangesets({ root: noChangesetDir, changedFiles: ["README.md"] });
    assert.equal(missing.ok, false);
    assert.match(missing.errors[0], /Missing changeset/);

    const releasePr = await validatePrChangesets({
      root: noChangesetDir,
      changedFiles: ["CHANGELOG.md", "package.json"],
      headRef: "changeset-release/main",
    });
    assert.equal(releasePr.ok, true);
    assert.equal(releasePr.skippedReleasePr, true);
  } finally {
    await rm(noChangesetDir, { recursive: true, force: true });
  }

  const emptyChangesetDir = await makeSyntheticRepo({
    changesets: {
      "empty.md": "---\n---\n",
    },
  });
  try {
    const emptyOk = await validatePrChangesets({
      root: emptyChangesetDir,
      changedFiles: [".changeset/empty.md"],
    });
    assert.equal(emptyOk.ok, true);
  } finally {
    await rm(emptyChangesetDir, { recursive: true, force: true });
  }

  const majorChangesetDir = await makeSyntheticRepo({
    changesets: {
      "major.md": '---\n"@dinkuskit/payments": major\n---\n\nDisallowed major in 0.x.\n',
    },
  });
  try {
    const majorRejected = await validatePrChangesets({
      root: majorChangesetDir,
      changedFiles: [".changeset/major.md"],
    });
    assert.equal(majorRejected.ok, false);
    assert.match(majorRejected.errors[0], /"major" bump is not allowed while @dinkuskit\/payments is in 0\.x/);
  } finally {
    await rm(majorChangesetDir, { recursive: true, force: true });
  }
});

test("inspectReleaseState resumes partial stable release states (untagged, tag only, tag+release, all done)", async () => {
  const mergedReleaseDir = await makeSyntheticRepo({
    version: "0.3.0",
    changesets: {},
  });
  try {
    // 1. Untagged (nothing done yet)
    const untagged = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.0"],
    });
    assert.equal(untagged.mode, "publish");
    assert.equal(untagged.reason, "release-pr-merged-untagged");
    assert.equal(untagged.currentVersion, "0.3.0");
    assert.equal(untagged.tag, "v0.3.0");
    assert.equal(untagged.pluginSlug, STABLE_PLUGIN_SLUG);
    assert.equal(untagged.tagExists, false);
    assert.equal(untagged.githubReleaseExists, false);
    assert.equal(untagged.registryPublished, false);
    assert.deepEqual(untagged.missingSteps, ["tag", "github-release", "registry"]);

    // 2. Partial state: tag exists ONLY (GitHub Release and Registry publish still missing)
    const tagOnly = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0"],
      githubReleaseExists: false,
      registryPublished: false,
    });
    assert.equal(tagOnly.mode, "publish");
    assert.equal(tagOnly.reason, "resume-after-tag");
    assert.equal(tagOnly.tagExists, true);
    assert.equal(tagOnly.githubReleaseExists, false);
    assert.equal(tagOnly.registryPublished, false);
    assert.deepEqual(tagOnly.missingSteps, ["github-release", "registry"]);

    // 3. Partial state: tag + GitHub Release exist, Registry publish still missing
    const tagAndRelease = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0"],
      githubReleaseExists: true,
      registryPublished: false,
    });
    assert.equal(tagAndRelease.mode, "publish");
    assert.equal(tagAndRelease.reason, "resume-after-github-release");
    assert.equal(tagAndRelease.tagExists, true);
    assert.equal(tagAndRelease.githubReleaseExists, true);
    assert.equal(tagAndRelease.registryPublished, false);
    assert.deepEqual(tagAndRelease.missingSteps, ["registry"]);

    // 4. All done: tag + GitHub Release + Registry version all exist -> noop
    const allDone = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0"],
      githubReleaseExists: true,
      registryPublished: true,
    });
    assert.equal(allDone.mode, "noop");
    assert.equal(allDone.reason, "release-complete");
    assert.equal(allDone.tagExists, true);
    assert.equal(allDone.githubReleaseExists, true);
    assert.equal(allDone.registryPublished, true);
    assert.deepEqual(allDone.missingSteps, []);

    // Also verify live fetchImpl integration for GitHub Release + EmDash Registry checks
    const allDoneViaFetch = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0"],
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes("/releases/tags/v0.3.0")) {
          return { ok: true, status: 200, json: async () => ({ tag_name: "v0.3.0" }) };
        }
        if (href.includes("com.emdashcms.experimental.aggregator.listReleases")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ releases: [{ version: "0.2.8" }, { version: "0.3.0" }] }),
          };
        }
        return { ok: false, status: 404, json: async () => ({ error: "NotFound" }) };
      },
    });
    assert.equal(allDoneViaFetch.mode, "noop");
    assert.equal(allDoneViaFetch.reason, "release-complete");
  } finally {
    await rm(mergedReleaseDir, { recursive: true, force: true });
  }

  const pre020Dir = await makeSyntheticRepo({
    version: "0.1.9",
    changesets: {},
  });
  try {
    const untaggedPre020 = await inspectReleaseState({
      root: pre020Dir,
      existingTags: [],
    });
    assert.equal(untaggedPre020.mode, "noop");
    assert.equal(untaggedPre020.reason, "pre-0.2.0-untagged");
  } finally {
    await rm(pre020Dir, { recursive: true, force: true });
  }
});

test("beta N derivation combines existing git tags and EmDash Registry beta versions without reuse", async () => {
  // Registry ahead of git tags
  assert.equal(
    computeNextBetaNumber(
      "0.3.0",
      ["v0.3.0-beta.0", "v0.3.0-beta.1"],
      ["0.3.0-beta.0", "0.3.0-beta.3"],
    ),
    4,
  );
  // Git tags ahead of Registry
  assert.equal(
    computeNextBetaNumber(
      "0.3.0",
      ["v0.3.0-beta.4"],
      ["0.3.0-beta.1", "0.3.0-beta.2"],
    ),
    5,
  );
  // Only Registry has beta.0 (e.g. previous run published before tag or tag was missing)
  assert.equal(computeNextBetaNumber("0.3.0", ["v0.2.8"], ["0.3.0-beta.0"]), 1);
  // Neither has any beta for 0.3.0
  assert.equal(computeNextBetaNumber("0.3.0", ["v0.2.8", "v0.2.9-beta.5"], ["0.2.9-beta.7"]), 0);

  const pendingDir = await makeSyntheticRepo({
    version: "0.2.8",
    changesets: {
      "fix.md": '---\n"@dinkuskit/payments": patch\n---\n\nFix webhook retry.\n',
      "feat.md": '---\n"@dinkuskit/payments": minor\n---\n\nAdd release flow.\n',
    },
  });
  try {
    const state = await inspectReleaseState({
      root: pendingDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.0"],
      registryBetaVersions: ["0.3.0-beta.0", "0.3.0-beta.2"],
    });
    assert.equal(state.mode, "beta_and_pr");
    assert.equal(state.nextVersion, "0.3.0");
    assert.equal(state.betaNumber, 3);
    assert.equal(state.nextBetaVersion, "0.3.0-beta.3");
    assert.equal(state.betaTag, "v0.3.0-beta.3");
    assert.equal(state.betaPluginSlug, BETA_PLUGIN_SLUG);

    // Also test via fetchImpl querying EmDash Registry XRPC listReleases for dinkus-payments-beta
    const prepared = await prepareBetaBuild({
      root: pendingDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.1"],
      fetchImpl: async (url) => {
        const href = String(url);
        assert.match(href, /package=dinkus-payments-beta/);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            releases: [{ version: "0.3.0-beta.0" }, { version: "0.3.0-beta.4" }],
          }),
        };
      },
    });
    assert.equal(prepared.betaVersion, "0.3.0-beta.5");
    assert.equal(prepared.betaTag, "v0.3.0-beta.5");

    const versions = await fetchRegistryPackageVersions({
      slug: BETA_PLUGIN_SLUG,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ releases: [{ version: "0.3.0-beta.5" }] }),
      }),
    });
    assert.deepEqual(versions, ["0.3.0-beta.5"]);
    assert.equal(
      await hasRegistryVersion({
        slug: BETA_PLUGIN_SLUG,
        version: "0.3.0-beta.5",
        registryVersions: versions,
      }),
      true,
    );
  } finally {
    await rm(pendingDir, { recursive: true, force: true });
  }
});

test("prepareBetaBuild overrides build-time manifest slug to dinkus-payments-beta without editing stable package.json pluginId", async () => {
  const dir = await makeSyntheticRepo({
    version: "0.2.8",
    changesets: {
      "feat.md": '---\n"@dinkuskit/payments": minor\n---\n\nBeta candidate.\n',
    },
  });
  try {
    const prepared = await prepareBetaBuild({
      root: dir,
      existingTags: ["v0.2.8"],
    });
    assert.equal(prepared.betaSlug, "dinkus-payments-beta");
    assert.equal(prepared.betaVersion, "0.3.0-beta.0");
    assert.equal(prepared.stablePackagePluginId, "dinkus-payments");

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.dinkuskit.pluginId, "dinkus-payments");
    assert.equal(pkg.version, "0.3.0-beta.0");

    const manifest = JSON.parse(await readFile(join(dir, "emdash-plugin.jsonc"), "utf8"));
    assert.equal(manifest.slug, "dinkus-payments-beta");
    assert.equal("version" in manifest, false);

    const expectedBetaPluginId = await deriveRegistryPluginId(
      "did:plc:ekk4pjmkh3k3ql2kfoex3qt4",
      "dinkus-payments-beta",
    );
    assert.equal(prepared.installedPluginId, expectedBetaPluginId);
    const identitySource = await readFile(join(dir, "src/registry/identity.ts"), "utf8");
    assert.match(identitySource, /"dinkus-payments-beta"/);
    assert.ok(identitySource.includes(expectedBetaPluginId));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preview publish classification detects missing pkg-pr-new GitHub App and fails on other errors", () => {
  const success = classifyPreviewPublishResult({
    exitCode: 0,
    stdout: "Published https://pkg.pr.new/@dinkuskit/payments@51",
  });
  assert.equal(success.ok, true);
  assert.equal(success.skippedMissingApp, false);
  assert.equal(success.exitCode, 0);
  assert.equal(success.notice, null);

  const missingApp = evaluatePreviewPublish({
    exitCode: 1,
    stderr: `Error: The pkg-pr-new app ${PKG_PR_NEW_NOT_INSTALLED_TEXT} to dinkuskit/payments.`,
  });
  assert.equal(missingApp.ok, true);
  assert.equal(missingApp.skippedMissingApp, true);
  assert.equal(missingApp.appInstalled, false);
  assert.equal(missingApp.exitCode, 0);
  assert.match(missingApp.notice, /pkg-pr-new GitHub App is not installed/);

  const otherFailure = classifyPreviewPublishResult({
    exitCode: 2,
    stderr: "Error: Failed to upload tarball (HTTP 502 Bad Gateway)",
  });
  assert.equal(otherFailure.ok, false);
  assert.equal(otherFailure.skippedMissingApp, false);
  assert.equal(otherFailure.exitCode, 2);
  assert.equal(otherFailure.notice, null);
});

test("extractChangelogSection extracts the matching version notes from CHANGELOG.md", () => {
  const changelog = [
    "# @dinkuskit/payments",
    "",
    "## 0.3.0",
    "",
    "### Minor Changes",
    "",
    "- abc1234: Implement the locked Changesets release flow.",
    "",
    "## 0.2.8",
    "",
    "### Patch Changes",
    "",
    "- def5678: Prior fix.",
    "",
  ].join("\n");

  const notes = extractChangelogSection(changelog, "0.3.0");
  assert.equal(
    notes,
    "### Minor Changes\n\n- abc1234: Implement the locked Changesets release flow.",
  );
  assert.equal(computeNextBetaNumber("0.3.0", ["v0.3.0-beta.0", "v0.3.0-beta.2"]), 3);
  assert.equal(computeNextStableVersion("0.2.8", "patch"), "0.2.9");
  assert.equal(computeNextStableVersion("0.2.8", "minor"), "0.3.0");
});

test("repository workflows and docs wire the locked Changesets release flow and SHA pins", async () => {
  const emdashManifest = JSON.parse(
    await readFile(join(repositoryRoot, "emdash-plugin.jsonc"), "utf8"),
  );
  assert.equal(emdashManifest.slug, "dinkus-payments");
  assert.equal("version" in emdashManifest, false);

  const changesetConfig = JSON.parse(
    await readFile(join(repositoryRoot, ".changeset/config.json"), "utf8"),
  );
  assert.deepEqual(changesetConfig.changelog, [
    "@changesets/changelog-github",
    { repo: "dinkuskit/payments" },
  ]);
  assert.equal(changesetConfig.baseBranch, "main");

  const releaseYml = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
  assert.match(
    releaseYml,
    /actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3\.3\.0/,
  );
  assert.match(
    releaseYml,
    /changesets\/action@ae32849d5ba541f9ae29e40e22a623bc13562f51 # v2\.1\.2/,
  );
  assert.match(releaseYml, /version-script:\s*npm run release:version/);
  assert.match(releaseYml, /commit-message:\s*"chore\(release\): version packages"/);
  assert.match(releaseYml, /pr-title:\s*"chore\(release\): version packages"/);
  assert.match(releaseYml, /secrets\.RELEASE_APP_ID/);
  assert.match(releaseYml, /secrets\.RELEASE_APP_PRIVATE_KEY/);
  assert.match(releaseYml, /secrets\.EMDASH_REGISTRY_TOKEN/);
  assert.match(releaseYml, /release-beta\.yml/);
  assert.doesNotMatch(releaseYml, /environment:/);

  // Verify stable release step ordering: tag -> GitHub Release -> Registry check -> Registry publish
  const tagStepIdx = releaseYml.indexOf("Ensure git tag vX.Y.Z");
  const ghReleaseStepIdx = releaseYml.indexOf("Ensure GitHub Release vX.Y.Z from CHANGELOG.md");
  const registryCheckIdx = releaseYml.indexOf("Check EmDash Registry for dinkus-payments@X.Y.Z");
  const registryPublishIdx = releaseYml.indexOf(
    "Build, bundle, and publish stable plugin to EmDash Registry",
  );
  assert.ok(tagStepIdx > 0 && ghReleaseStepIdx > tagStepIdx);
  assert.ok(registryCheckIdx > ghReleaseStepIdx && registryPublishIdx > registryCheckIdx);

  const releaseBetaYml = await readFile(
    join(repositoryRoot, ".github/workflows/release-beta.yml"),
    "utf8",
  );
  assert.match(
    releaseBetaYml,
    /actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3\.3\.0/,
  );
  assert.match(releaseBetaYml, /dinkus-payments-beta/);
  assert.match(releaseBetaYml, /vars\.DEMO_STORE_URL/);
  assert.match(releaseBetaYml, /secrets\.DEMO_STORE_E2E_TOKEN/);
  assert.match(releaseBetaYml, /e2e-gate/);
  const betaTagStepIdx = releaseBetaYml.indexOf("Reserve and push beta git tag before publishing");
  const betaRegistryCheckIdx = releaseBetaYml.indexOf(
    "Check EmDash Registry for dinkus-payments-beta@x.y.z-beta.N",
  );
  const betaPublishIdx = releaseBetaYml.indexOf(
    "Build, bundle, and publish beta plugin to EmDash Registry",
  );
  assert.ok(betaTagStepIdx > 0 && betaRegistryCheckIdx > betaTagStepIdx);
  assert.ok(betaPublishIdx > betaRegistryCheckIdx);

  const previewYml = await readFile(join(repositoryRoot, ".github/workflows/preview.yml"), "utf8");
  assert.match(previewYml, /npx pkg-pr-new publish/);
  assert.match(previewYml, /is not installed on or does not have access/);
  assert.match(previewYml, /::notice::/);

  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  assert.match(readme, /\[RELEASING\.md\]\(RELEASING\.md\)/);

  const releasing = await readFile(join(repositoryRoot, "RELEASING.md"), "utf8");
  assert.match(releasing, /RELEASE_APP_ID/);
  assert.match(releasing, /RELEASE_APP_PRIVATE_KEY/);
  assert.match(releasing, /EMDASH_REGISTRY_TOKEN/);
  assert.match(releasing, /DEMO_STORE_URL/);
  assert.match(releasing, /v0\.2\.0/);
  assert.match(releasing, /Retry safety & resumability/);
});
