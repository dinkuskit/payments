import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BETA_PLUGIN_NAME,
  BETA_PLUGIN_SLUG,
  classifyPreviewPublishResult,
  computeNextBetaNumber,
  computeNextStableVersion,
  deriveRegistryPluginId,
  extractChangelogSection,
  fetchRegistryPackageVersions,
  hasRegistryVersion,
  inspectReleaseState,
  PACKAGE_NAME,
  parseChangesetFile,
  prepareBetaBuild,
  repositoryRoot,
  STABLE_PLUGIN_SLUG,
  validatePrChangesets,
} from "../scripts/release-flow.mjs";

async function createSyntheticRepo({
  version = "0.2.8",
  changesets = {},
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "payments-release-flow-"));
  await mkdir(join(dir, ".changeset"), { recursive: true });
  await mkdir(join(dir, "src", "registry"), { recursive: true });

  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: PACKAGE_NAME,
        version,
        dinkuskit: {
          pluginId: STABLE_PLUGIN_SLUG,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    join(dir, "emdash-plugin.jsonc"),
    `${JSON.stringify(
      {
        $schema: "https://emdashcms.com/schemas/plugin/v1.json",
        publisher: "did:plc:ekk4pjmkh3k3ql2kfoex3qt4",
        slug: STABLE_PLUGIN_SLUG,
        name: "DinkusKit Payments",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const stableInstalledId = await deriveRegistryPluginId(
    "did:plc:ekk4pjmkh3k3ql2kfoex3qt4",
    STABLE_PLUGIN_SLUG,
  );
  await writeFile(
    join(dir, "src", "registry", "identity.ts"),
    `export const registryInstallationIdentity = Object.freeze({\n  publisherDid: "did:plc:ekk4pjmkh3k3ql2kfoex3qt4",\n  slug: "${STABLE_PLUGIN_SLUG}",\n  installedPluginId: "${stableInstalledId}",\n});\n`,
    "utf8",
  );

  await writeFile(
    join(dir, ".changeset", "README.md"),
    "# Changesets\n",
    "utf8",
  );

  for (const [filename, content] of Object.entries(changesets)) {
    await writeFile(join(dir, ".changeset", filename), content, "utf8");
  }

  return dir;
}

test("parseChangesetFile and 0.x bump rules enforce patch/minor only and allow empty changesets", async () => {
  const patchCs = parseChangesetFile(
    `---\n"${PACKAGE_NAME}": patch\n---\n\nFix Stripe webhook signature edge case.\n`,
    ".changeset/fix-webhook.md",
  );
  assert.equal(patchCs.empty, false);
  assert.equal(patchCs.bumps[PACKAGE_NAME], "patch");
  assert.equal(computeNextStableVersion("0.2.8", "patch"), "0.2.9");

  const minorCs = parseChangesetFile(
    `---\n"${PACKAGE_NAME}": minor\n---\n\nAdd Authorize.Net refund reconciliation.\n`,
    ".changeset/add-reconcile.md",
  );
  assert.equal(minorCs.empty, false);
  assert.equal(minorCs.bumps[PACKAGE_NAME], "minor");
  assert.equal(computeNextStableVersion("0.2.8", "minor"), "0.3.0");

  const emptyCs = parseChangesetFile(`---\n---\n`, ".changeset/empty.md");
  assert.equal(emptyCs.empty, true);

  assert.throws(
    () => computeNextStableVersion("0.2.8", "major"),
    /forbids major bumps/,
  );
});

test("validatePrChangesets requires a valid changeset on normal PRs and skips changeset-release/* PRs", async () => {
  const repoWithoutCs = await createSyntheticRepo();
  const repoWithMajorCs = await createSyntheticRepo({
    changesets: {
      "bad-major.md": `---\n"${PACKAGE_NAME}": major\n---\n\nBreaking change in 0.x.\n`,
    },
  });
  const repoWithMinorCs = await createSyntheticRepo({
    changesets: {
      "feature.md": `---\n"${PACKAGE_NAME}": minor\n---\n\nNew feature.\n`,
    },
  });

  try {
    const missingResult = await validatePrChangesets({
      root: repoWithoutCs,
      changedFiles: ["src/index.ts"],
      headRef: "feat/no-changeset",
    });
    assert.equal(missingResult.ok, false);
    assert.match(missingResult.errors[0], /Missing changeset/);

    const releasePrBypass = await validatePrChangesets({
      root: repoWithoutCs,
      changedFiles: ["package.json", "CHANGELOG.md"],
      headRef: "changeset-release/main",
    });
    assert.equal(releasePrBypass.ok, true);
    assert.equal(releasePrBypass.skippedReleasePr, true);

    const majorResult = await validatePrChangesets({
      root: repoWithMajorCs,
      changedFiles: [".changeset/bad-major.md"],
      headRef: "feat/major",
    });
    assert.equal(majorResult.ok, false);
    assert.match(majorResult.errors[0], /"major" bump is not allowed/);

    const minorResult = await validatePrChangesets({
      root: repoWithMinorCs,
      changedFiles: [".changeset/feature.md"],
      headRef: "feat/minor",
    });
    assert.equal(minorResult.ok, true);
  } finally {
    await rm(repoWithoutCs, { recursive: true, force: true });
    await rm(repoWithMajorCs, { recursive: true, force: true });
    await rm(repoWithMinorCs, { recursive: true, force: true });
  }
});

test("inspectReleaseState checks git tag, GitHub Release, and Registry separately for retry-safe stable releases", async () => {
  const mergedReleaseDir = await createSyntheticRepo({
    version: "0.3.0",
    changesets: {},
  });
  const pre020Dir = await createSyntheticRepo({
    version: "0.1.9",
    changesets: {},
  });

  try {
    // 1. Untagged (nothing done yet, 404 on Registry and GitHub Release)
    const untagged = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.0"],
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: "NotFound" }),
      }),
    });
    assert.equal(untagged.mode, "publish");
    assert.equal(untagged.reason, "release-pr-merged-untagged");
    assert.equal(untagged.tag, "v0.3.0");
    assert.equal(untagged.pluginSlug, STABLE_PLUGIN_SLUG);
    assert.equal(untagged.tagExists, false);
    assert.equal(untagged.githubReleaseExists, false);
    assert.equal(untagged.registryPublished, false);
    assert.deepEqual(untagged.missingSteps, ["tag", "github-release", "registry"]);

    // 2. Tagged only (previous run created tag v0.3.0, then failed before GitHub Release & Registry publish)
    const taggedOnly = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.0", "v0.3.0"],
      githubReleaseExists: false,
      registryPublished: false,
    });
    assert.equal(taggedOnly.mode, "publish");
    assert.equal(taggedOnly.reason, "resume-after-tag");
    assert.equal(taggedOnly.tagExists, true);
    assert.equal(taggedOnly.githubReleaseExists, false);
    assert.equal(taggedOnly.registryPublished, false);
    assert.deepEqual(taggedOnly.missingSteps, ["github-release", "registry"]);

    // 3. Tagged + GitHub Release exist, Registry publish still missing
    const taggedAndReleased = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.0", "v0.3.0"],
      githubReleaseExists: true,
      registryPublished: false,
    });
    assert.equal(taggedAndReleased.mode, "publish");
    assert.equal(taggedAndReleased.reason, "resume-after-github-release");
    assert.equal(taggedAndReleased.tagExists, true);
    assert.equal(taggedAndReleased.githubReleaseExists, true);
    assert.equal(taggedAndReleased.registryPublished, false);
    assert.deepEqual(taggedAndReleased.missingSteps, ["registry"]);

    // 4. All three exist (tag + GitHub Release + Registry release) -> noop
    const complete = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.0", "v0.3.0"],
      githubReleaseExists: true,
      registryPublished: true,
    });
    assert.equal(complete.mode, "noop");
    assert.equal(complete.reason, "release-complete");
    assert.equal(complete.tagExists, true);
    assert.equal(complete.githubReleaseExists, true);
    assert.equal(complete.registryPublished, true);
    assert.deepEqual(complete.missingSteps, []);

    // 5. Verify inspectReleaseState can also derive GitHub Release & Registry presence via fetchImpl
    const viaFetchComplete = await inspectReleaseState({
      root: mergedReleaseDir,
      existingTags: ["v0.2.8", "v0.3.0"],
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("/releases/tags/v0.3.0")) {
          return { ok: true, status: 200, json: async () => ({ tag_name: "v0.3.0" }) };
        }
        if (u.includes("com.emdashcms.experimental.aggregator.listReleases")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ releases: [{ version: "0.3.0" }, { version: "0.2.8" }] }),
          };
        }
        return { ok: false, status: 404, json: async () => ({ error: "NotFound" }) };
      },
    });
    assert.equal(viaFetchComplete.mode, "noop");
    assert.equal(viaFetchComplete.reason, "release-complete");

    const pre020 = await inspectReleaseState({
      root: pre020Dir,
      existingTags: [],
    });
    assert.equal(pre020.mode, "noop");
    assert.equal(pre020.reason, "pre-0.2.0-untagged");
  } finally {
    await rm(mergedReleaseDir, { recursive: true, force: true });
    await rm(pre020Dir, { recursive: true, force: true });
  }
});

test("computeNextBetaNumber and inspectReleaseState derive beta N from max(git tags, Registry beta versions) + 1", async () => {
  // Neither git tags nor Registry have 0.3.0-beta.* -> 0
  assert.equal(computeNextBetaNumber("0.3.0", ["v0.2.8"], []), 0);

  // Git tags have up to beta.1, Registry has up to beta.0 -> 2
  assert.equal(
    computeNextBetaNumber("0.3.0", ["v0.2.8", "v0.3.0-beta.0", "v0.3.0-beta.1"], ["0.3.0-beta.0"]),
    2,
  );

  // Git tags only have beta.0, but Registry already has 0.3.0-beta.2 -> 3 (never reuses beta.1 or beta.2)
  assert.equal(
    computeNextBetaNumber("0.3.0", ["v0.2.8", "v0.3.0-beta.0"], ["0.3.0-beta.0", "0.3.0-beta.2"]),
    3,
  );

  // Supports options-object form as well
  assert.equal(
    computeNextBetaNumber("0.3.0", {
      existingTags: ["v0.3.0-beta.1"],
      registryVersions: ["v0.3.0-beta.4"],
    }),
    5,
  );

  const pendingDir = await createSyntheticRepo({
    version: "0.2.8",
    changesets: {
      "one.md": `---\n"${PACKAGE_NAME}": patch\n---\n\nBug fix.\n`,
      "two.md": `---\n"${PACKAGE_NAME}": minor\n---\n\nFeature.\n`,
    },
  });

  try {
    const pendingState = await inspectReleaseState({
      root: pendingDir,
      existingTags: ["v0.2.0", "v0.2.8", "v0.3.0-beta.0"],
      registryBetaVersions: ["0.3.0-beta.0", "0.3.0-beta.2"],
    });
    assert.equal(pendingState.mode, "beta_and_pr");
    assert.equal(pendingState.bump, "minor");
    assert.equal(pendingState.nextVersion, "0.3.0");
    assert.equal(pendingState.betaNumber, 3);
    assert.equal(pendingState.nextBetaVersion, "0.3.0-beta.3");
    assert.equal(pendingState.betaTag, "v0.3.0-beta.3");
    assert.equal(pendingState.betaPluginSlug, BETA_PLUGIN_SLUG);

    // Also verify prepareBetaBuild queries Registry via fetchImpl when deriving nextBetaVersion
    const prepared = await prepareBetaBuild({
      root: pendingDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.1"],
      fetchImpl: async (url) => {
        assert.match(String(url), /package=dinkus-payments-beta/);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            releases: [{ version: "0.3.0-beta.1" }, { version: "0.3.0-beta.3" }],
          }),
        };
      },
    });
    assert.equal(prepared.betaVersion, "0.3.0-beta.4");
    assert.equal(prepared.betaTag, "v0.3.0-beta.4");
  } finally {
    await rm(pendingDir, { recursive: true, force: true });
  }
});

test("Registry/PDS lookup fails closed on network error, timeout, 500, and malformed body; treats 404 as unpublished and found as published", async () => {
  const expectedErrorPattern =
    /Registry lookup failed for [^\s:]+@[^\s:]+: .+; refusing to publish with unknown state/;

  // 1. Direct fetchRegistryPackageVersions & hasRegistryVersion checks:
  // (a) network error -> throws
  await assert.rejects(
    () =>
      fetchRegistryPackageVersions({
        slug: STABLE_PLUGIN_SLUG,
        version: "0.3.0",
        fetchImpl: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:443");
        },
      }),
    expectedErrorPattern,
  );
  await assert.rejects(
    () =>
      hasRegistryVersion({
        slug: STABLE_PLUGIN_SLUG,
        version: "0.3.0",
        fetchImpl: async () => {
          throw new Error("socket hang up");
        },
      }),
    /Registry lookup failed for dinkus-payments@0\.3\.0: socket hang up; refusing to publish with unknown state/,
  );

  // (b) timeout -> throws
  await assert.rejects(
    () =>
      hasRegistryVersion({
        slug: STABLE_PLUGIN_SLUG,
        version: "0.3.0",
        timeoutMs: 15,
        fetchImpl: async () => new Promise(() => {}),
      }),
    /Registry lookup failed for dinkus-payments@0\.3\.0: request timed out .* refusing to publish with unknown state/,
  );

  // (c) 500 (and non-2xx other than definitive 404/NotFound) -> throws
  await assert.rejects(
    () =>
      hasRegistryVersion({
        slug: STABLE_PLUGIN_SLUG,
        version: "0.3.0",
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          json: async () => ({ error: "InternalServerError" }),
        }),
      }),
    /Registry lookup failed for dinkus-payments@0\.3\.0: HTTP 500 \(InternalServerError\); refusing to publish with unknown state/,
  );
  await assert.rejects(
    () =>
      hasRegistryVersion({
        slug: STABLE_PLUGIN_SLUG,
        version: "0.3.0",
        fetchImpl: async () => ({
          ok: false,
          status: 400,
          json: async () => ({ error: "ListingUnavailable" }),
        }),
      }),
    /Registry lookup failed for dinkus-payments@0\.3\.0: HTTP 400 \(ListingUnavailable\); refusing to publish with unknown state/,
  );

  // (d) malformed body -> throws (invalid JSON, missing releases array, release entry missing valid semver)
  await assert.rejects(
    () =>
      hasRegistryVersion({
        slug: STABLE_PLUGIN_SLUG,
        version: "0.3.0",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
          },
        }),
      }),
    /Registry lookup failed for dinkus-payments@0\.3\.0: malformed response body .* refusing to publish with unknown state/,
  );
  await assert.rejects(
    () =>
      hasRegistryVersion({
        slug: STABLE_PLUGIN_SLUG,
        version: "0.3.0",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ unexpected: true }),
        }),
      }),
    /Registry lookup failed for dinkus-payments@0\.3\.0: malformed response body \(expected object with releases array\); refusing to publish with unknown state/,
  );
  await assert.rejects(
    () =>
      hasRegistryVersion({
        slug: STABLE_PLUGIN_SLUG,
        version: "0.3.0",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ releases: [{ version: "not-a-semver" }] }),
        }),
      }),
    /Registry lookup failed for dinkus-payments@0\.3\.0: malformed response body \(release entry missing valid semver version\); refusing to publish with unknown state/,
  );

  // (e) 404 -> unpublished
  const notFoundVersions = await fetchRegistryPackageVersions({
    slug: BETA_PLUGIN_SLUG,
    version: "0.3.0-beta.0",
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "NotFound" }),
    }),
  });
  assert.deepEqual(notFoundVersions, []);
  const notFoundExists = await hasRegistryVersion({
    slug: STABLE_PLUGIN_SLUG,
    version: "0.3.0",
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "NotFound" }),
    }),
  });
  assert.equal(notFoundExists, false);

  // (f) found -> published
  const foundExists = await hasRegistryVersion({
    slug: STABLE_PLUGIN_SLUG,
    version: "0.3.0",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        releases: [{ version: "0.2.8" }, { version: "0.3.0" }],
      }),
    }),
  });
  assert.equal(foundExists, true);

  // (g) Direct PDS lookup also fails closed on error and treats RECORD_NOT_FOUND as unpublished
  await assert.rejects(
    () =>
      hasRegistryVersion({
        slug: STABLE_PLUGIN_SLUG,
        version: "0.3.0",
        includeDirectPds: true,
        pdsClient: {
          getPackageRepository: async () => {
            const err = new Error("PDS request timed out");
            err.code = "PDS_REQUEST_TIMEOUT";
            throw err;
          },
        },
        fetchImpl: async () => ({
          ok: false,
          status: 404,
          json: async () => ({ error: "NotFound" }),
        }),
      }),
    /Registry lookup failed for dinkus-payments@0\.3\.0: PDS request timed out; refusing to publish with unknown state/,
  );
  const pdsNotFound = await hasRegistryVersion({
    slug: STABLE_PLUGIN_SLUG,
    version: "0.3.0",
    includeDirectPds: true,
    pdsClient: {
      getPackageRepository: async () => {
        const err = new Error("Record not found");
        err.code = "RECORD_NOT_FOUND";
        throw err;
      },
    },
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "NotFound" }),
    }),
  });
  assert.equal(pdsNotFound, false);

  // 2. Beta N derivation (inspectReleaseState & prepareBetaBuild) fail-closed and 404/found behavior:
  const betaDir = await createSyntheticRepo({
    version: "0.2.8",
    changesets: {
      "feature.md": `---\n"${PACKAGE_NAME}": minor\n---\n\nAdd beta feature.\n`,
    },
  });
  // 3. Stable state (inspectReleaseState) fail-closed and 404/found behavior:
  const stableDir = await createSyntheticRepo({
    version: "0.3.0",
    changesets: {},
  });

  try {
    // Beta N derivation: network error -> throws
    await assert.rejects(
      () =>
        inspectReleaseState({
          root: betaDir,
          existingTags: ["v0.2.8", "v0.3.0-beta.0"],
          fetchImpl: async () => {
            throw new Error("DNS lookup failed");
          },
        }),
      /Registry lookup failed for dinkus-payments-beta@0\.3\.0-beta\.1: DNS lookup failed; refusing to publish with unknown state/,
    );

    // Beta N derivation: 500 -> throws
    await assert.rejects(
      () =>
        inspectReleaseState({
          root: betaDir,
          existingTags: ["v0.2.8", "v0.3.0-beta.0"],
          fetchImpl: async () => ({
            ok: false,
            status: 500,
            json: async () => ({ error: "InternalServerError" }),
          }),
        }),
      /Registry lookup failed for dinkus-payments-beta@0\.3\.0-beta\.1: HTTP 500 \(InternalServerError\); refusing to publish with unknown state/,
    );

    // Beta N derivation: malformed body -> throws
    await assert.rejects(
      () =>
        inspectReleaseState({
          root: betaDir,
          existingTags: ["v0.2.8", "v0.3.0-beta.0"],
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ releases: "not-an-array" }),
          }),
        }),
      /Registry lookup failed for dinkus-payments-beta@0\.3\.0-beta\.1: malformed response body .*; refusing to publish with unknown state/,
    );

    // Beta N derivation: 404 -> unpublished (derives N from git tags)
    const betaOn404 = await inspectReleaseState({
      root: betaDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.0"],
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: "NotFound" }),
      }),
    });
    assert.equal(betaOn404.mode, "beta_and_pr");
    assert.equal(betaOn404.betaNumber, 1);
    assert.equal(betaOn404.nextBetaVersion, "0.3.0-beta.1");

    // Beta N derivation: found -> published (advances N past published Registry beta versions)
    const betaOnFound = await inspectReleaseState({
      root: betaDir,
      existingTags: ["v0.2.8", "v0.3.0-beta.0"],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          releases: [{ version: "0.3.0-beta.0" }, { version: "0.3.0-beta.2" }],
        }),
      }),
    });
    assert.equal(betaOnFound.mode, "beta_and_pr");
    assert.equal(betaOnFound.betaNumber, 3);
    assert.equal(betaOnFound.nextBetaVersion, "0.3.0-beta.3");

    // Stable state: network error -> throws
    await assert.rejects(
      () =>
        inspectReleaseState({
          root: stableDir,
          existingTags: ["v0.2.8", "v0.3.0"],
          githubReleaseExists: true,
          fetchImpl: async () => {
            throw new Error("network unreachable");
          },
        }),
      /Registry lookup failed for dinkus-payments@0\.3\.0: network unreachable; refusing to publish with unknown state/,
    );

    // Stable state: 500 -> throws
    await assert.rejects(
      () =>
        inspectReleaseState({
          root: stableDir,
          existingTags: ["v0.2.8", "v0.3.0"],
          githubReleaseExists: true,
          fetchImpl: async () => ({
            ok: false,
            status: 500,
            json: async () => ({ error: "ServerError" }),
          }),
        }),
      /Registry lookup failed for dinkus-payments@0\.3\.0: HTTP 500 \(ServerError\); refusing to publish with unknown state/,
    );

    // Stable state: malformed body -> throws
    await assert.rejects(
      () =>
        inspectReleaseState({
          root: stableDir,
          existingTags: ["v0.2.8", "v0.3.0"],
          githubReleaseExists: true,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError("Unexpected end of JSON input");
            },
          }),
        }),
      /Registry lookup failed for dinkus-payments@0\.3\.0: malformed response body .*; refusing to publish with unknown state/,
    );

    // Stable state: 404 -> unpublished (mode=publish, missingSteps includes "registry")
    const stableOn404 = await inspectReleaseState({
      root: stableDir,
      existingTags: ["v0.2.8", "v0.3.0"],
      githubReleaseExists: true,
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: "NotFound" }),
      }),
    });
    assert.equal(stableOn404.mode, "publish");
    assert.equal(stableOn404.reason, "resume-after-github-release");
    assert.equal(stableOn404.registryPublished, false);
    assert.deepEqual(stableOn404.missingSteps, ["registry"]);

    // Stable state: found -> published (mode=noop, reason=release-complete)
    const stableOnFound = await inspectReleaseState({
      root: stableDir,
      existingTags: ["v0.2.8", "v0.3.0"],
      githubReleaseExists: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          releases: [{ version: "0.2.8" }, { version: "0.3.0" }],
        }),
      }),
    });
    assert.equal(stableOnFound.mode, "noop");
    assert.equal(stableOnFound.reason, "release-complete");
    assert.equal(stableOnFound.registryPublished, true);
    assert.deepEqual(stableOnFound.missingSteps, []);

    // CLI check-registry exits non-zero when Registry lookup fails
    const cliResult = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "scripts", "release-flow.mjs"),
        "check-registry",
        "--slug",
        STABLE_PLUGIN_SLUG,
        "--version",
        "0.3.0",
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          EMDASH_REGISTRY_URL: "http://127.0.0.1:1",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(cliResult.status, 0);
    assert.match(
      cliResult.stderr,
      /Registry lookup failed for dinkus-payments@0\.3\.0: .*; refusing to publish with unknown state/,
    );
  } finally {
    await rm(betaDir, { recursive: true, force: true });
    await rm(stableDir, { recursive: true, force: true });
  }
});

test("prepareBetaBuild rewrites only build-time manifest/identity to dinkus-payments-beta and preserves package.json#dinkuskit.pluginId", async () => {
  const dir = await createSyntheticRepo({
    version: "0.2.8",
    changesets: {
      "feature.md": `---\n"${PACKAGE_NAME}": minor\n---\n\nAdd beta feature.\n`,
    },
  });

  try {
    const prepared = await prepareBetaBuild({
      root: dir,
      existingTags: ["v0.2.8"],
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: "NotFound" }),
      }),
    });
    assert.equal(prepared.betaSlug, BETA_PLUGIN_SLUG);
    assert.equal(prepared.betaName, BETA_PLUGIN_NAME);
    assert.equal(prepared.betaVersion, "0.3.0-beta.0");
    assert.equal(prepared.betaTag, "v0.3.0-beta.0");
    assert.equal(prepared.stablePackagePluginId, STABLE_PLUGIN_SLUG);

    const updatedPkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(updatedPkg.version, "0.3.0-beta.0");
    assert.equal(updatedPkg.dinkuskit.pluginId, STABLE_PLUGIN_SLUG);

    const updatedManifest = JSON.parse(
      await readFile(join(dir, "emdash-plugin.jsonc"), "utf8"),
    );
    assert.equal(updatedManifest.slug, BETA_PLUGIN_SLUG);
    assert.equal(updatedManifest.name, BETA_PLUGIN_NAME);
    assert.equal("version" in updatedManifest, false);

    const updatedIdentity = await readFile(
      join(dir, "src", "registry", "identity.ts"),
      "utf8",
    );
    assert.match(updatedIdentity, new RegExp(`slug: "${BETA_PLUGIN_SLUG}"`));
    assert.match(
      updatedIdentity,
      new RegExp(`installedPluginId: "${prepared.installedPluginId}"`),
    );

    await assert.rejects(
      () =>
        prepareBetaBuild({
          root: dir,
          betaSlug: STABLE_PLUGIN_SLUG,
          betaVersion: "0.3.0-beta.0",
        }),
      /must be a valid distinct slug/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractChangelogSection extracts release notes for the target version", () => {
  const changelog = `# @dinkuskit/payments\n\n## 0.3.0\n\n### Minor Changes\n\n- abc1234: Add Authorize.Net refund reconciliation.\n\n## 0.2.8\n\n### Patch Changes\n\n- def5678: Fix webhook verification.\n`;
  assert.equal(
    extractChangelogSection(changelog, "0.3.0"),
    "### Minor Changes\n\n- abc1234: Add Authorize.Net refund reconciliation.",
  );
  assert.equal(
    extractChangelogSection(changelog, "0.9.9"),
    `Release v0.9.9 of ${PACKAGE_NAME}.`,
  );
});

test("classifyPreviewPublishResult passes with notice when pkg-pr-new GitHub App is not installed and fails on other errors", () => {
  const success = classifyPreviewPublishResult({
    exitCode: 0,
    output: "Published https://pkg.pr.new/@dinkuskit/payments@123",
  });
  assert.equal(success.ok, true);
  assert.equal(success.skippedMissingApp, false);
  assert.equal(success.exitCode, 0);
  assert.equal(success.notice, null);

  const missingApp = classifyPreviewPublishResult({
    exitCode: 1,
    stderr:
      "Error: The pkg-pr-new GitHub App is not installed on or does not have access to dinkuskit/payments.",
  });
  assert.equal(missingApp.ok, true);
  assert.equal(missingApp.skippedMissingApp, true);
  assert.equal(missingApp.appInstalled, false);
  assert.equal(missingApp.exitCode, 0);
  assert.match(missingApp.notice, /https:\/\/github\.com\/apps\/pkg-pr-new/);

  const realFailure = classifyPreviewPublishResult({
    exitCode: 2,
    stderr: "Error: ENOENT package.json not found",
  });
  assert.equal(realFailure.ok, false);
  assert.equal(realFailure.skippedMissingApp, false);
  assert.equal(realFailure.exitCode, 2);
});

test("release workflows pin all third-party actions to full 40-char commit SHAs and enforce retry-safe step ordering", async () => {
  const workflowFiles = [
    ".github/workflows/changeset-check.yml",
    ".github/workflows/preview.yml",
    ".github/workflows/release.yml",
    ".github/workflows/release-beta.yml",
  ];

  for (const relPath of workflowFiles) {
    const content = await readFile(join(repositoryRoot, relPath), "utf8");
    const usesLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("uses:") || line.startsWith("- uses:"));

    assert.ok(usesLines.length > 0, `${relPath} must contain at least one uses: line`);
    for (const line of usesLines) {
      const ref = line.replace(/^-?\s*uses:\s*/, "").trim();
      if (ref.startsWith("./")) continue;
      assert.match(
        ref,
        /^[^@\s]+@[0-9a-f]{40}(?:\s+#.*)?$/,
        `${relPath} must pin external action to a 40-char SHA, got: ${line}`,
      );
    }
  }

  const releaseYml = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
  const releaseBetaYml = await readFile(
    join(repositoryRoot, ".github/workflows/release-beta.yml"),
    "utf8",
  );
  const previewYml = await readFile(join(repositoryRoot, ".github/workflows/preview.yml"), "utf8");
  const pkgJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));

  // Verify stable release step ordering: tag -> GitHub Release -> Registry check -> Registry publish
  const tagStepIdx = releaseYml.indexOf("Ensure git tag vX.Y.Z");
  const ghReleaseStepIdx = releaseYml.indexOf("Ensure GitHub Release vX.Y.Z from CHANGELOG.md");
  const registryCheckIdx = releaseYml.indexOf("Check EmDash Registry for dinkus-payments@X.Y.Z");
  const registryPublishIdx = releaseYml.indexOf(
    "Build, bundle, and publish stable plugin to EmDash Registry",
  );
  assert.ok(tagStepIdx > 0 && ghReleaseStepIdx > tagStepIdx);
  assert.ok(registryCheckIdx > ghReleaseStepIdx && registryPublishIdx > registryCheckIdx);

  // Verify beta release step ordering: reserve/push beta git tag BEFORE Registry check & publish,
  // and install on demo store ONLY (never production)
  assert.match(releaseBetaYml, /dinkus-payments-beta/);
  assert.match(releaseBetaYml, /vars\.DEMO_STORE_URL/);
  const betaPrepareStepIdx = releaseBetaYml.indexOf(
    "Prepare x.y.z-beta.N build with build-time beta plugin slug",
  );
  const betaTagStepIdx = releaseBetaYml.indexOf("Reserve and push beta git tag before publishing");
  const betaRegistryCheckIdx = releaseBetaYml.indexOf(
    "Check EmDash Registry for dinkus-payments-beta@x.y.z-beta.N",
  );
  const betaPublishIdx = releaseBetaYml.indexOf(
    "Build, bundle, and publish beta plugin to EmDash Registry",
  );
  assert.ok(betaPrepareStepIdx > 0 && betaTagStepIdx > betaPrepareStepIdx);
  assert.ok(betaRegistryCheckIdx > betaTagStepIdx);
  assert.ok(betaPublishIdx > betaRegistryCheckIdx);

  // Verify pkg-pr-new is exact-pinned in devDependencies and preview.yml runs the locked local binary
  assert.equal(pkgJson.devDependencies["pkg-pr-new"], "0.0.91");
  assert.match(
    previewYml,
    /(?:npx --no-install pkg-pr-new publish|npm exec --no -- pkg-pr-new publish)/,
  );
  assert.match(previewYml, /is not installed on or does not have access/);
  assert.match(previewYml, /::notice::/);

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

  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  assert.match(readme, /\[RELEASING\.md\]\(RELEASING\.md\)/);

  const releasing = await readFile(join(repositoryRoot, "RELEASING.md"), "utf8");
  assert.match(releasing, /RELEASE_APP_ID/);
  assert.match(releasing, /RELEASE_APP_PRIVATE_KEY/);
  assert.match(releasing, /EMDASH_REGISTRY_TOKEN/);
  assert.match(releasing, /DEMO_STORE_URL/);
  assert.match(releasing, /v0\.2\.0/);
  assert.match(releasing, /dinkus-payments-beta/);
});
