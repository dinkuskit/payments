import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BETA_PLUGIN_SLUG,
  STABLE_PLUGIN_SLUG,
  computeNextBetaNumber,
  computeNextStableVersion,
  deriveRegistryPluginId,
  extractChangelogSection,
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

test("inspectReleaseState distinguishes pending beta_and_pr, untagged publish, and idempotent noop", async () => {
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
    });
    assert.equal(state.mode, "beta_and_pr");
    assert.equal(state.nextVersion, "0.3.0");
    assert.equal(state.nextBetaVersion, "0.3.0-beta.1");
    assert.equal(state.betaTag, "v0.3.0-beta.1");
    assert.equal(state.betaPluginSlug, BETA_PLUGIN_SLUG);
  } finally {
    await rm(pendingDir, { recursive: true, force: true });
  }

  const mergedReleaseDir = await makeSyntheticRepo({
    version: "0.3.0",
    changesets: {},
  });
  try {
    const untagged = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.0"],
    });
    assert.equal(untagged.mode, "publish");
    assert.equal(untagged.currentVersion, "0.3.0");
    assert.equal(untagged.tag, "v0.3.0");
    assert.equal(untagged.pluginSlug, STABLE_PLUGIN_SLUG);

    const alreadyTagged = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0"],
    });
    assert.equal(alreadyTagged.mode, "noop");
    assert.equal(alreadyTagged.reason, "tag-already-exists");
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

test("repository workflows and docs wire the locked Changesets release flow", async () => {
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
  assert.match(releaseYml, /actions\/create-github-app-token/);
  assert.match(releaseYml, /secrets\.RELEASE_APP_ID/);
  assert.match(releaseYml, /secrets\.RELEASE_APP_PRIVATE_KEY/);
  assert.match(releaseYml, /secrets\.EMDASH_REGISTRY_TOKEN/);
  assert.match(releaseYml, /changesets\/action/);
  assert.match(releaseYml, /release-beta\.yml/);
  assert.doesNotMatch(releaseYml, /environment:/);

  const releaseBetaYml = await readFile(
    join(repositoryRoot, ".github/workflows/release-beta.yml"),
    "utf8",
  );
  assert.match(releaseBetaYml, /dinkus-payments-beta/);
  assert.match(releaseBetaYml, /vars\.DEMO_STORE_URL/);
  assert.match(releaseBetaYml, /secrets\.DEMO_STORE_E2E_TOKEN/);
  assert.match(releaseBetaYml, /e2e-gate/);

  const previewYml = await readFile(join(repositoryRoot, ".github/workflows/preview.yml"), "utf8");
  assert.match(previewYml, /npx pkg-pr-new publish/);

  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  assert.match(readme, /\[RELEASING\.md\]\(RELEASING\.md\)/);

  const releasing = await readFile(join(repositoryRoot, "RELEASING.md"), "utf8");
  assert.match(releasing, /RELEASE_APP_ID/);
  assert.match(releasing, /RELEASE_APP_PRIVATE_KEY/);
  assert.match(releasing, /EMDASH_REGISTRY_TOKEN/);
  assert.match(releasing, /DEMO_STORE_URL/);
  assert.match(releasing, /v0\.2\.0/);
});
