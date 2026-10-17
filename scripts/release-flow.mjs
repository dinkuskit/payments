import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "..");

export const PACKAGE_NAME = "@dinkuskit/payments";
export const STABLE_REGISTRY_SLUG = "dinkus-payments";
export const BETA_REGISTRY_SLUG = "dinkus-payments-beta";
export const STABLE_INSTALLED_PLUGIN_ID = "r_3brsc2on3bu673rn";
export const BETA_INSTALLED_PLUGIN_ID = "r_sffx6l4z6mpqliki";
export const STABLE_PLUGIN_NAME = "DinkusKit Payments";
export const BETA_PLUGIN_NAME = "DinkusKit Payments (Beta)";
export const BASELINE_VERSION = "0.2.8";
export const BASELINE_TAG = "v0.2.8";
export const MAX_PLUGIN_BUNDLE_BYTES = 131_072;
export const RELEASE_PR_BRANCH = "changeset-release/main";
export const RELEASE_PR_TITLE_PREFIX = "ci: release";
export const BETA_PROOF_TRAILER = "Release-Beta-Proof";
export const DEFAULT_REGISTRY_URL = "https://emdash-registry.pages.dev";

const BUMP_RANK = Object.freeze({
  patch: 1,
  minor: 2,
  major: 3,
});

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(String(version).trim());
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
  };
}

export function parseChangesetFrontmatter(markdown, filePath = ".changeset/unknown.md") {
  const normalized = String(markdown).replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new Error(`Changeset ${filePath} is missing YAML frontmatter delimited by ---`);
  }

  const [, frontmatter, body] = match;
  const entries = [];
  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const entryMatch = /^["']?([^"':]+)["']?\s*:\s*(patch|minor|major)\s*$/.exec(line);
    if (!entryMatch) {
      throw new Error(`Changeset ${filePath} has invalid frontmatter line: ${rawLine}`);
    }
    entries.push({ pkg: entryMatch[1].trim(), bump: entryMatch[2] });
  }

  const summary = body.trim();
  if (!summary) {
    throw new Error(`Changeset ${filePath} must include a non-empty summary body`);
  }

  const packageEntry = entries.find((entry) => entry.pkg === PACKAGE_NAME);
  if (!packageEntry) {
    throw new Error(`Changeset ${filePath} must target "${PACKAGE_NAME}"`);
  }

  return {
    filePath,
    bump: packageEntry.bump,
    summary,
    entries,
  };
}

export function highestBumpType(bumpTypes) {
  let highest = null;
  for (const bump of bumpTypes) {
    if (!(bump in BUMP_RANK)) {
      throw new Error(`Unsupported changeset bump type: ${bump}`);
    }
    if (!highest || BUMP_RANK[bump] > BUMP_RANK[highest]) {
      highest = bump;
    }
  }
  return highest;
}

export function computeTargetVersion(currentVersion, bumpTypes) {
  const parsed = parseSemver(currentVersion);
  const bump = highestBumpType(bumpTypes);
  if (!bump) return null;

  if (bump === "major") {
    return `${parsed.major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export async function listChangesetFiles(root = repositoryRoot) {
  const changesetDir = join(root, ".changeset");
  const entries = await readdir(changesetDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name.toLowerCase() !== "readme.md",
    )
    .map((entry) => `.changeset/${entry.name}`)
    .sort();
}

export async function readPendingChangesets(root = repositoryRoot) {
  const files = await listChangesetFiles(root);
  const changesets = [];
  for (const relPath of files) {
    const content = await readFile(join(root, relPath), "utf8");
    changesets.push(parseChangesetFrontmatter(content, relPath));
  }
  return changesets;
}

export function isChangesetMarkdownPath(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  return (
    normalized.startsWith(".changeset/") &&
    normalized.endsWith(".md") &&
    normalized.toLowerCase() !== ".changeset/readme.md" &&
    !normalized.slice(".changeset/".length).includes("/")
  );
}

export function findMissingChangesets({
  changedFiles,
  isReleasePr = false,
  headRef = "",
  title = "",
}) {
  const normalizedTitle = String(title).trim();
  const normalizedHead = String(headRef).trim();
  if (
    isReleasePr ||
    normalizedHead === RELEASE_PR_BRANCH ||
    normalizedTitle === RELEASE_PR_TITLE_PREFIX ||
    normalizedTitle.startsWith(`${RELEASE_PR_TITLE_PREFIX} `) ||
    normalizedTitle.startsWith("chore: version packages")
  ) {
    return { ok: true, exempted: true, changesetFiles: [] };
  }

  const changesetFiles = changedFiles.filter(isChangesetMarkdownPath).sort();
  if (changesetFiles.length === 0) {
    return {
      ok: false,
      exempted: false,
      changesetFiles: [],
      message:
        "Every PR must include at least one changeset in `.changeset/*.md` (run `npx changeset` or add a `.changeset/<name>.md` entry).",
    };
  }

  return { ok: true, exempted: false, changesetFiles };
}

export function computeNextBetaVersion({
  targetVersion,
  gitTags = [],
  registryVersions = [],
}) {
  parseSemver(targetVersion);
  const escaped = targetVersion.replace(/\./g, "\\.");
  const tagPattern = new RegExp(`^v?${escaped}-beta\\.(\\d+)$`);
  let maxBeta = 0;

  for (const candidate of [...gitTags, ...registryVersions]) {
    const match = tagPattern.exec(String(candidate).trim());
    if (match) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n > maxBeta) {
        maxBeta = n;
      }
    }
  }

  const nextBeta = maxBeta + 1;
  const version = `${targetVersion}-beta.${nextBeta}`;
  return {
    targetVersion,
    betaNumber: nextBeta,
    version,
    tag: `v${version}`,
    slug: BETA_REGISTRY_SLUG,
  };
}

export function formatBetaProofRecord({ betaVersion, betaSha, proofRef }) {
  return `${BETA_PROOF_TRAILER}: ${betaVersion} sha=${betaSha} proof=${String(proofRef).trim()}`;
}

export function parseBetaProofRecord(text) {
  const match = new RegExp(
    `^${BETA_PROOF_TRAILER}:\\s*(\\d+\\.\\d+\\.\\d+-beta\\.\\d+)\\s+sha=([0-9a-f]{7,40})\\s+proof=(.+)$`,
    "m",
  ).exec(String(text));
  if (!match) return null;
  return {
    betaVersion: match[1],
    betaSha: match[2],
    proofRef: match[3].trim(),
  };
}

export function validateBetaPromotionGate({
  targetVersion,
  betaVersion,
  betaTagSha,
  currentMainSha,
  changedFilesSinceBeta = [],
  registryHasBetaVersion = true,
  proofRef = "",
}) {
  if (!targetVersion) {
    return {
      ok: false,
      code: "no_pending_changesets",
      message: "Cannot promote a release PR when no pending `.changeset/*.md` files exist on `main`.",
    };
  }

  const expectedPrefix = `${targetVersion}-beta.`;
  if (!String(betaVersion).startsWith(expectedPrefix) || parseSemver(betaVersion).beta === null) {
    return {
      ok: false,
      code: "beta_version_mismatch",
      message: `Beta version "${betaVersion}" does not match pending changesets target "${targetVersion}-beta.<N>".`,
    };
  }

  if (!betaTagSha) {
    return {
      ok: false,
      code: "missing_beta_tag",
      message: `Git tag "v${betaVersion}" does not exist on main. Cut the beta first via emdash-release.yml.`,
    };
  }

  const newChangesets = changedFilesSinceBeta.filter(isChangesetMarkdownPath);
  if (newChangesets.length > 0 || (currentMainSha && betaTagSha !== currentMainSha)) {
    return {
      ok: false,
      code: "main_advanced_since_beta",
      message:
        newChangesets.length > 0
          ? `main gained new changeset(s) (${newChangesets.join(", ")}) after v${betaVersion}; cut and verify the next beta before promoting.`
          : `main (${currentMainSha}) has advanced since v${betaVersion} (${betaTagSha}); cut and verify the next beta before promoting.`,
    };
  }

  if (!registryHasBetaVersion) {
    return {
      ok: false,
      code: "beta_not_in_registry",
      message: `${BETA_REGISTRY_SLUG}@${betaVersion} was not found in the EmDash Registry.`,
    };
  }

  const trimmedProof = String(proofRef).trim();
  if (!trimmedProof || !trimmedProof.includes(betaVersion)) {
    return {
      ok: false,
      code: "missing_beta_proof",
      message: `Promotion requires a recorded beta-store @running journey pass proof naming "${betaVersion}".`,
    };
  }

  return {
    ok: true,
    targetVersion,
    betaVersion,
    betaTag: `v${betaVersion}`,
    betaTagSha,
    proofRef: trimmedProof,
    trailer: formatBetaProofRecord({
      betaVersion,
      betaSha: betaTagSha,
      proofRef: trimmedProof,
    }),
  };
}

export function extractChangelogSection(changelogMarkdown, version) {
  const normalized = String(changelogMarkdown).replace(/\r\n/g, "\n");
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRegex = new RegExp(`^##\\s+v?${escaped}\\s*$`, "m");
  const match = headingRegex.exec(normalized);
  if (!match) {
    return null;
  }

  const start = match.index + match[0].length;
  const rest = normalized.slice(start);
  const nextHeading = /^##\s+/m.exec(rest);
  const section = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
  return section || null;
}

export async function verifyBuiltPluginBundleSize(
  root = repositoryRoot,
  bundleRelativePath = "dist/sandbox/plugin.mjs",
) {
  const bundlePath = join(root, bundleRelativePath);
  const info = await stat(bundlePath);
  if (info.size >= MAX_PLUGIN_BUNDLE_BYTES) {
    throw new Error(
      `Built plugin bundle ${bundleRelativePath} is ${info.size} bytes, exceeding the ${MAX_PLUGIN_BUNDLE_BYTES}-byte limit`,
    );
  }
  return {
    bundlePath,
    bytes: info.size,
    maxBytes: MAX_PLUGIN_BUNDLE_BYTES,
  };
}

export async function prepareRegistryWorkspace({
  root = repositoryRoot,
  outDir,
  version,
  slug,
  name,
}) {
  if (!outDir) {
    throw new Error("prepareRegistryWorkspace requires an explicit outDir");
  }
  parseSemver(version);

  const isBeta = String(version).includes("-beta.");
  const resolvedSlug = slug || (isBeta ? BETA_REGISTRY_SLUG : STABLE_REGISTRY_SLUG);
  const resolvedName = name || (isBeta ? BETA_PLUGIN_NAME : STABLE_PLUGIN_NAME);
  const workspaceDir = resolve(root, outDir);

  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });

  for (const entry of ["src", "README.md", "LICENSE", "tsconfig.json", "tsconfig.plugin.json"]) {
    await cp(join(root, entry), join(workspaceDir, entry), { recursive: true });
  }

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  pkg.version = version;
  await writeFile(join(workspaceDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const pluginManifest = JSON.parse(await readFile(join(root, "emdash-plugin.jsonc"), "utf8"));
  pluginManifest.slug = resolvedSlug;
  pluginManifest.name = resolvedName;
  pluginManifest.version = version;
  await writeFile(
    join(workspaceDir, "emdash-plugin.jsonc"),
    `${JSON.stringify(pluginManifest, null, 2)}\n`,
    "utf8",
  );

  return {
    workspaceDir,
    slug: resolvedSlug,
    name: resolvedName,
    version,
  };
}

function git(args, root = repositoryRoot) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function listGitTags(pattern, root = repositoryRoot) {
  const out = git(["tag", "--list", pattern], root);
  return out ? out.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

async function fetchRegistryVersions(slug, registryUrl = DEFAULT_REGISTRY_URL) {
  const endpoint = `${registryUrl.replace(/\/+$/, "")}/api/registry/plugins/${encodeURIComponent(slug)}`;
  try {
    const response = await fetch(endpoint, { headers: { accept: "application/json" } });
    if (!response.ok) return [];
    const payload = await response.json();
    const versions = Array.isArray(payload?.versions)
      ? payload.versions.map((entry) => entry?.version).filter(Boolean)
      : [];
    if (payload?.plugin?.latestVersion && !versions.includes(payload.plugin.latestVersion)) {
      versions.push(payload.plugin.latestVersion);
    }
    return versions;
  } catch {
    return [];
  }
}

async function writeGithubOutputs(outputFile, values) {
  if (!outputFile) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? "")}`);
  await appendFile(outputFile, `${lines.join("\n")}\n`, "utf8");
}

function parseCliFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  const flags = parseCliFlags(rest);
  const root = flags.root ? resolve(flags.root) : repositoryRoot;

  if (command === "check-pr") {
    const baseRef = flags.base || process.env.GITHUB_BASE_REF || "main";
    const headRef = flags.head || process.env.GITHUB_HEAD_REF || "";
    const title = flags.title || process.env.PR_TITLE || "";
    const diffRange = baseRef.startsWith("origin/") ? `${baseRef}...HEAD` : `origin/${baseRef}...HEAD`;
    const diffOutput = git(["diff", "--name-only", "--diff-filter=ACMR", diffRange], root);
    const changedFiles = diffOutput ? diffOutput.split("\n").filter(Boolean) : [];
    const result = findMissingChangesets({ changedFiles, headRef, title });
    if (!result.ok) {
      console.error(result.message);
      process.exitCode = 1;
      return;
    }
    for (const relPath of result.changesetFiles) {
      const content = await readFile(join(root, relPath), "utf8");
      parseChangesetFrontmatter(content, relPath);
    }
    console.log(
      result.exempted
        ? "changeset_check=exempt_release_pr"
        : `changeset_check=passed (${result.changesetFiles.join(", ")})`,
    );
    return;
  }

  if (command === "plan-beta" || command === "cut-beta") {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const pending = await readPendingChangesets(root);
    if (pending.length === 0 && !flags.version) {
      throw new Error("Cannot cut beta: no pending `.changeset/*.md` files on main.");
    }

    const registryUrl = flags["registry-url"] || process.env.EMDASH_REGISTRY_URL || DEFAULT_REGISTRY_URL;
    let version = flags.version?.trim();
    let targetVersion = computeTargetVersion(
      pkg.version,
      pending.map((entry) => entry.bump),
    );

    if (version) {
      parseSemver(version);
      targetVersion = version.replace(/-beta\.\d+$/, "");
    } else {
      const gitTags = listGitTags(`v${targetVersion}-beta.*`, root);
      const registryVersions = await fetchRegistryVersions(BETA_REGISTRY_SLUG, registryUrl);
      const next = computeNextBetaVersion({ targetVersion, gitTags, registryVersions });
      version = next.version;
    }

    const tag = `v${version}`;
    const result = {
      shouldCut: true,
      currentVersion: pkg.version,
      targetVersion,
      version,
      betaVersion: version,
      betaTag: tag,
      slug: BETA_REGISTRY_SLUG,
      changesetCount: pending.length,
    };

    if (command === "cut-beta") {
      const existingTagSha = listGitTags(tag, root).length > 0 ? git(["rev-list", "-n", "1", tag], root) : "";
      const headSha = git(["rev-parse", "HEAD"], root);
      if (!existingTagSha) {
        git(["tag", tag, headSha], root);
        if (flags["no-push"] !== "true") {
          git(["push", "origin", `refs/tags/${tag}`], root);
        }
      } else if (existingTagSha !== headSha) {
        throw new Error(`Tag ${tag} already exists at ${existingTagSha} (HEAD is ${headSha}).`);
      }
    }

    await writeGithubOutputs(flags["github-output"], result);
    console.log(JSON.stringify(result));
    return;
  }

  if (command === "promote") {
    const betaVersion = flags["beta-version"] || process.env.BETA_VERSION || "";
    const proofRef = flags["proof-ref"] || process.env.PROOF_REF || "";
    const registryUrl = flags["registry-url"] || process.env.EMDASH_REGISTRY_URL || DEFAULT_REGISTRY_URL;

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const pending = await readPendingChangesets(root);
    const targetVersion = computeTargetVersion(
      pkg.version,
      pending.map((entry) => entry.bump),
    );

    const betaTag = `v${betaVersion}`;
    const hasTag = listGitTags(betaTag, root).length > 0;
    const betaTagSha = hasTag ? git(["rev-list", "-n", "1", betaTag], root) : "";
    const currentMainSha = git(["rev-parse", "HEAD"], root);
    const changedFilesSinceBeta =
      betaTagSha && betaTagSha !== currentMainSha
        ? git(["diff", "--name-only", `${betaTagSha}..${currentMainSha}`], root)
            .split("\n")
            .filter(Boolean)
        : [];
    const registryVersions = await fetchRegistryVersions(BETA_REGISTRY_SLUG, registryUrl);
    const registryHasBetaVersion =
      flags["skip-registry-check"] === "true" || registryVersions.includes(betaVersion);

    const gate = validateBetaPromotionGate({
      targetVersion,
      betaVersion,
      betaTagSha,
      currentMainSha,
      changedFilesSinceBeta,
      registryHasBetaVersion,
      proofRef,
    });
    if (!gate.ok) {
      throw new Error(gate.message);
    }

    execFileSync("npm", ["run", "release:version"], { cwd: root, stdio: "inherit" });
    git(["checkout", "-B", RELEASE_PR_BRANCH], root);
    git(["add", "-A"], root);
    const prTitle = `${RELEASE_PR_TITLE_PREFIX} v${targetVersion}`;
    const commitBody = [
      prTitle,
      "",
      `Promotes verified beta \`${BETA_REGISTRY_SLUG}@${betaVersion}\` (\`${betaTagSha}\`) to stable \`${STABLE_REGISTRY_SLUG}@${targetVersion}\`.`,
      "",
      gate.trailer,
    ].join("\n");
    git(["commit", "-m", commitBody], root);

    if (flags["no-push"] !== "true") {
      git(["push", "--force-with-lease", "origin", `HEAD:refs/heads/${RELEASE_PR_BRANCH}`], root);
      const prBody = [
        `## Release \`${PACKAGE_NAME}@${targetVersion}\``,
        "",
        `- **Promoted beta**: \`${BETA_REGISTRY_SLUG}@${betaVersion}\` (tag \`v${betaVersion}\` at \`${betaTagSha}\`)`,
        `- **Beta-store @running proof**: ${gate.proofRef}`,
        `- **Stable target**: \`${STABLE_REGISTRY_SLUG}@${targetVersion}\` (\`${STABLE_INSTALLED_PLUGIN_ID}\`)`,
        "",
        "Run `@clawsweeper review` on this PR before merging.",
        "",
        gate.trailer,
      ].join("\n");

      const existingPr = execFileSync(
        "gh",
        ["pr", "list", "--head", RELEASE_PR_BRANCH, "--base", "main", "--state", "open", "--json", "number", "--jq", ".[0].number // empty"],
        { cwd: root, encoding: "utf8" },
      ).trim();

      if (existingPr) {
        execFileSync("gh", ["pr", "edit", existingPr, "--title", prTitle, "--body", prBody], {
          cwd: root,
          stdio: "inherit",
        });
      } else {
        execFileSync(
          "gh",
          ["pr", "create", "--base", "main", "--head", RELEASE_PR_BRANCH, "--title", prTitle, "--body", prBody],
          { cwd: root, stdio: "inherit" },
        );
      }
    }

    await writeGithubOutputs(flags["github-output"], gate);
    console.log(JSON.stringify(gate));
    return;
  }

  if (command === "publish-merged-release") {
    const pending = await readPendingChangesets(root);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const version = pkg.version;
    const tag = `v${version}`;
    const existingTags = listGitTags(tag, root);

    if (pending.length > 0 || existingTags.length > 0) {
      const skipped = {
        published: false,
        version,
        reason: pending.length > 0 ? "pending_changesets_present" : "tag_already_exists",
      };
      await writeGithubOutputs(flags["github-output"], skipped);
      console.log(JSON.stringify(skipped));
      return;
    }

    const headMessage = git(["log", "-1", "--format=%B"], root);
    let proof = parseBetaProofRecord(headMessage);
    if (!proof && flags["no-gh"] !== "true") {
      try {
        const headSha = git(["rev-parse", "HEAD"], root);
        const prBody = execFileSync(
          "gh",
          ["pr", "list", "--state", "merged", "--search", headSha, "--json", "body", "--jq", ".[0].body // empty"],
          { cwd: root, encoding: "utf8" },
        ).trim();
        proof = parseBetaProofRecord(prBody);
      } catch {
        proof = null;
      }
    }

    if (!proof || !proof.betaVersion.startsWith(`${version}-beta.`)) {
      throw new Error(
        `Refusing to tag ${tag}: merged release commit is missing a valid ${BETA_PROOF_TRAILER} record for ${version}-beta.<N>.`,
      );
    }

    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    const notes = extractChangelogSection(changelog, version) || `Release ${PACKAGE_NAME} ${version}`;

    git(["tag", tag, "HEAD"], root);
    if (flags["no-push"] !== "true") {
      git(["push", "origin", `refs/tags/${tag}`], root);
      execFileSync(
        "gh",
        ["release", "create", tag, "--title", tag, "--notes", notes, "--verify-tag"],
        { cwd: root, stdio: "inherit" },
      );
    }

    const published = {
      published: true,
      version,
      tag,
      betaVersion: proof.betaVersion,
    };
    await writeGithubOutputs(flags["github-output"], published);
    console.log(JSON.stringify(published));
    return;
  }

  if (command === "check-bundle-size") {
    const relPath = flags.bundle || "dist/sandbox/plugin.mjs";
    const info = await verifyBuiltPluginBundleSize(root, relPath);
    await writeGithubOutputs(flags["github-output"], info);
    console.log(JSON.stringify(info));
    return;
  }

  throw new Error(`Unknown release-flow command: ${command ?? "(none)"}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2));
}
