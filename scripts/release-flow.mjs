import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePdsEndpoint } from "../.github/scripts/verify-registry-release.mjs";

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
export const RELEASE_BRANCH_PREFIX = "release/";
export const RELEASE_PR_TITLE_PREFIX = "ci: release";
export const BETA_PROOF_TRAILER = "Release-Beta-Proof";
const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";

export const ALLOWED_RELEASE_TREE_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "CHANGELOG.md",
]);

export const EMDASH_PUBLISH_JOB_IF =
  "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && inputs.version != '' && github.ref == format('refs/tags/v{0}', inputs.version) && ((inputs.release_mode == 'beta' && contains(inputs.version, '-beta.')) || (inputs.release_mode == 'stable' && !contains(inputs.version, '-beta.')))";

const BUMP_RANK = Object.freeze({
  patch: 1,
  minor: 2,
  major: 3,
});

export function parseSemver(version) {
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

export function releaseBranchFor(version) {
  const parsed = parseSemver(version);
  return `${RELEASE_BRANCH_PREFIX}${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function parseReleaseTagRef(ref) {
  const match = /^refs\/tags\/v(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/.exec(String(ref).trim());
  return match ? match[1] : null;
}

// emdash-release.yml publishes only from a version tag that release.yml's tag run hands it: a
// vX.Y.Z-beta.N tag with release_mode beta, or a vX.Y.Z tag with release_mode stable. Both tags sit
// on a release/X.Y.Z branch (GrillTrack release-branches-079, dinkuskit/dinkuskit). The tag run
// starts when the tag is pushed, or from "Retry the publish" pressed on the tag itself; the buttons
// on main never publish, they only push the tag.
export function validateEmDashDispatchGate({
  eventName = process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || "",
  ref = process.env.TARGET_REF || process.env.GITHUB_REF || "",
  inputVersion = process.env.INPUT_VERSION || "",
  releaseMode = process.env.INPUT_RELEASE_MODE || process.env.RELEASE_MODE || "",
} = {}) {
  const normalizedEvent = String(eventName).trim();
  const normalizedRef = String(ref).trim();
  const normalizedVersion = String(inputVersion).trim();
  const normalizedMode = String(releaseMode).trim();

  if (normalizedEvent === "workflow_dispatch" && !parseReleaseTagRef(normalizedRef)) {
    return {
      ok: false,
      code: "dispatch_publish_forbidden",
      message:
        "A Run workflow press on a branch never publishes. Cut beta, Add fix to beta and a merged release PR push a version tag, and that tag's run publishes; Retry the publish is pressed on the tag itself.",
    };
  }

  if (normalizedEvent !== "push" && normalizedEvent !== "workflow_dispatch") {
    return {
      ok: false,
      code: "unsupported_event",
      message: `Unsupported event "${normalizedEvent || "(empty)"}" for emdash-release.yml.`,
    };
  }

  const tagVersion = parseReleaseTagRef(normalizedRef);
  if (!tagVersion) {
    return {
      ok: false,
      code: "forbidden_caller_ref",
      message: `emdash-release.yml publishes only from a vX.Y.Z or vX.Y.Z-beta.N tag (got "${normalizedRef || "(empty)"}").`,
    };
  }

  if (normalizedVersion !== tagVersion) {
    return {
      ok: false,
      code: "version_tag_mismatch",
      message: `emdash-release.yml version "${normalizedVersion || "(empty)"}" must equal the pushed tag's version "${tagVersion}".`,
    };
  }

  const isBeta = parseSemver(tagVersion).beta !== null;
  const expectedMode = isBeta ? "beta" : "stable";
  if (normalizedMode !== expectedMode) {
    return {
      ok: false,
      code: isBeta ? "missing_beta_caller_input" : "missing_stable_caller_input",
      message: `Tag v${tagVersion} publishes with release_mode="${expectedMode}" (got "${normalizedMode || "(empty)"}").`,
    };
  }

  return {
    ok: true,
    mode: isBeta ? "beta-tag" : "stable-tag",
    slug: isBeta ? BETA_REGISTRY_SLUG : STABLE_REGISTRY_SLUG,
    requestedVersion: tagVersion,
  };
}

export function parseChangesetFrontmatter(markdown, filePath = ".changeset/unknown.md") {
  const normalized = String(markdown).replace(/\r\n/g, "\n");
  const match = /^---\n(?:([\s\S]*?)\n)?---(?:\n([\s\S]*))?$/.exec(normalized);
  if (!match) {
    throw new Error(`Changeset ${filePath} is missing YAML frontmatter delimited by ---`);
  }

  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";
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
  if (entries.length === 0) {
    return {
      filePath,
      empty: true,
      bump: null,
      summary,
      entries: [],
    };
  }

  if (!summary) {
    throw new Error(`Changeset ${filePath} must include a non-empty summary body`);
  }

  const packageEntry = entries.find((entry) => entry.pkg === PACKAGE_NAME);
  if (!packageEntry) {
    throw new Error(`Changeset ${filePath} must target "${PACKAGE_NAME}"`);
  }

  return {
    filePath,
    empty: false,
    bump: packageEntry.bump,
    summary,
    entries,
  };
}

export function highestBumpType(bumpTypes) {
  let highest = null;
  for (const bump of bumpTypes) {
    if (bump === null || bump === undefined) continue;
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
  if (!existsSync(changesetDir)) return [];
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

export async function readPendingChangesets(root = repositoryRoot, { includeEmpty = false } = {}) {
  const files = await listChangesetFiles(root);
  const changesets = [];
  for (const relPath of files) {
    const content = await readFile(join(root, relPath), "utf8");
    const parsed = parseChangesetFrontmatter(content, relPath);
    if (!parsed.empty || includeEmpty) {
      changesets.push(parsed);
    }
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

export function isAllowedReleaseTreePath(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (ALLOWED_RELEASE_TREE_PATHS.includes(normalized)) {
    return true;
  }
  return isChangesetMarkdownPath(normalized);
}

function canonicalizeJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
}

function parsePlainJsonObject(rawText, label) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawText));
  } catch (error) {
    return {
      ok: false,
      message: `${label} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      message: `${label} must be a JSON object.`,
    };
  }
  return { ok: true, value: parsed };
}

function diffTopLevelObjectKeys(beforeObj, afterObj) {
  const allKeys = [...new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])].sort();
  return allKeys.filter((key) => canonicalizeJson(beforeObj[key]) !== canonicalizeJson(afterObj[key]));
}

export function verifyVersionOnlyPackageMetadata({
  version,
  betaPackageJsonText,
  releasePackageJsonText,
  betaPackageLockText,
  releasePackageLockText,
}) {
  const betaPkgRes = parsePlainJsonObject(betaPackageJsonText, "beta package.json");
  if (!betaPkgRes.ok) {
    return {
      ok: false,
      code: "unapproved_package_metadata_change",
      message: `Refusing to tag v${version}: ${betaPkgRes.message}`,
    };
  }
  const releasePkgRes = parsePlainJsonObject(releasePackageJsonText, "release package.json");
  if (!releasePkgRes.ok) {
    return {
      ok: false,
      code: "unapproved_package_metadata_change",
      message: `Refusing to tag v${version}: ${releasePkgRes.message}`,
    };
  }

  const betaPkg = betaPkgRes.value;
  const releasePkg = releasePkgRes.value;
  if (releasePkg.version !== version) {
    return {
      ok: false,
      code: "unapproved_package_metadata_change",
      message: `Refusing to tag v${version}: release package.json version is "${releasePkg.version ?? ""}" (expected "${version}").`,
    };
  }

  const normalizedBetaPkg = { ...betaPkg, version };
  if (canonicalizeJson(normalizedBetaPkg) !== canonicalizeJson(releasePkg)) {
    const changedKeys = diffTopLevelObjectKeys(normalizedBetaPkg, releasePkg);
    return {
      ok: false,
      code: "unapproved_package_metadata_change",
      message: `Refusing to tag v${version}: package.json modified non-version fields since approved beta (${changedKeys.join(", ")}).`,
      changedKeys,
    };
  }

  if (betaPackageLockText !== undefined || releasePackageLockText !== undefined) {
    const betaLockRes = parsePlainJsonObject(betaPackageLockText, "beta package-lock.json");
    if (!betaLockRes.ok) {
      return {
        ok: false,
        code: "unapproved_package_metadata_change",
        message: `Refusing to tag v${version}: ${betaLockRes.message}`,
      };
    }
    const releaseLockRes = parsePlainJsonObject(releasePackageLockText, "release package-lock.json");
    if (!releaseLockRes.ok) {
      return {
        ok: false,
        code: "unapproved_package_metadata_change",
        message: `Refusing to tag v${version}: ${releaseLockRes.message}`,
      };
    }

    const betaLock = betaLockRes.value;
    const releaseLock = releaseLockRes.value;
    if (releaseLock.version !== version) {
      return {
        ok: false,
        code: "unapproved_package_metadata_change",
        message: `Refusing to tag v${version}: release package-lock.json version is "${releaseLock.version ?? ""}" (expected "${version}").`,
      };
    }

    const normalizedBetaLock = structuredClone(betaLock);
    normalizedBetaLock.version = version;
    if (
      normalizedBetaLock.packages &&
      typeof normalizedBetaLock.packages === "object" &&
      !Array.isArray(normalizedBetaLock.packages) &&
      normalizedBetaLock.packages[""] &&
      typeof normalizedBetaLock.packages[""] === "object" &&
      !Array.isArray(normalizedBetaLock.packages[""])
    ) {
      if (releaseLock.packages?.[""]?.version !== version) {
        return {
          ok: false,
          code: "unapproved_package_metadata_change",
          message: `Refusing to tag v${version}: release package-lock.json packages[""].version is "${releaseLock.packages?.[""]?.version ?? ""}" (expected "${version}").`,
        };
      }
      normalizedBetaLock.packages[""].version = version;
    }

    if (canonicalizeJson(normalizedBetaLock) !== canonicalizeJson(releaseLock)) {
      const changedKeys = diffTopLevelObjectKeys(normalizedBetaLock, releaseLock);
      return {
        ok: false,
        code: "unapproved_package_metadata_change",
        message: `Refusing to tag v${version}: package-lock.json modified non-version fields since approved beta (${changedKeys.join(", ")}).`,
        changedKeys,
      };
    }
  }

  return { ok: true };
}

export function verifyApprovedBetaSourceTree({
  version,
  proof,
  betaTagSha,
  changedPathsSinceBeta = [],
  betaPackageJsonText,
  releasePackageJsonText,
  betaPackageLockText,
  releasePackageLockText,
}) {
  if (!proof || !proof.betaVersion || !proof.betaSha) {
    return {
      ok: false,
      code: "missing_beta_proof_record",
      message: `Refusing to tag v${version}: merged release commit is missing a valid ${BETA_PROOF_TRAILER} record for ${version}-beta.<N>.`,
    };
  }

  if (!String(proof.betaVersion).startsWith(`${version}-beta.`) || parseSemver(proof.betaVersion).beta === null) {
    return {
      ok: false,
      code: "beta_version_mismatch",
      message: `Refusing to tag v${version}: ${BETA_PROOF_TRAILER} beta "${proof.betaVersion}" does not match target "${version}-beta.<N>".`,
    };
  }

  const normalizedProofSha = String(proof.betaSha).trim().toLowerCase();
  const normalizedTagSha = String(betaTagSha || "").trim().toLowerCase();
  if (!normalizedTagSha) {
    return {
      ok: false,
      code: "missing_beta_tag",
      message: `Refusing to tag v${version}: approved beta tag "v${proof.betaVersion}" does not exist.`,
    };
  }

  const shaMatches =
    normalizedTagSha === normalizedProofSha ||
    (normalizedProofSha.length >= 7 && normalizedTagSha.startsWith(normalizedProofSha));
  if (!shaMatches) {
    return {
      ok: false,
      code: "beta_tag_sha_mismatch",
      message: `Refusing to tag v${version}: tag v${proof.betaVersion} points to ${betaTagSha}, which does not match approved ${BETA_PROOF_TRAILER} sha=${proof.betaSha}.`,
    };
  }

  const disallowedPaths = changedPathsSinceBeta
    .map((entry) => String(entry).replace(/\\/g, "/").trim())
    .filter(Boolean)
    .filter((entry) => !isAllowedReleaseTreePath(entry));

  if (disallowedPaths.length > 0) {
    return {
      ok: false,
      code: "unapproved_source_changes_since_beta",
      message: `Refusing to tag v${version}: release tree differs from approved beta v${proof.betaVersion} (${betaTagSha}) outside allowlisted release files (${disallowedPaths.join(", ")}).`,
      disallowedPaths,
    };
  }

  if (
    betaPackageJsonText !== undefined ||
    releasePackageJsonText !== undefined ||
    betaPackageLockText !== undefined ||
    releasePackageLockText !== undefined
  ) {
    const metadataCheck = verifyVersionOnlyPackageMetadata({
      version,
      betaPackageJsonText,
      releasePackageJsonText,
      betaPackageLockText,
      releasePackageLockText,
    });
    if (!metadataCheck.ok) {
      return metadataCheck;
    }
  }

  return {
    ok: true,
    betaTag: `v${proof.betaVersion}`,
    betaTagSha,
    allowedChangedPaths: changedPathsSinceBeta,
  };
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
  branchTipSha,
  stableTagSha = "",
  registryHasBetaVersion = true,
  proofRef = "",
}) {
  if (!targetVersion) {
    return {
      ok: false,
      code: "missing_beta_version",
      message: "Promote needs beta_version, the X.Y.Z-beta.N whose journeys passed.",
    };
  }

  const expectedPrefix = `${targetVersion}-beta.`;
  if (!String(betaVersion).startsWith(expectedPrefix) || parseSemver(betaVersion).beta === null) {
    return {
      ok: false,
      code: "beta_version_mismatch",
      message: `Beta version "${betaVersion}" does not match release/${targetVersion}'s "${targetVersion}-beta.<N>".`,
    };
  }

  const branch = releaseBranchFor(targetVersion);
  if (!branchTipSha) {
    return {
      ok: false,
      code: "missing_release_branch",
      message: `${branch} does not exist. Cut beta creates it.`,
    };
  }

  if (!betaTagSha) {
    return {
      ok: false,
      code: "missing_beta_tag",
      message: `Git tag "v${betaVersion}" does not exist. Cut beta or Add fix to beta makes it.`,
    };
  }

  if (stableTagSha) {
    return {
      ok: false,
      code: "already_released",
      message: `v${targetVersion} is already released. A fix for it goes on ${releaseBranchFor(bumpPatch(targetVersion))} with Add fix to beta.`,
    };
  }

  if (betaTagSha !== branchTipSha) {
    return {
      ok: false,
      code: "release_branch_advanced_since_beta",
      message: `${branch} (${branchTipSha}) has moved past v${betaVersion} (${betaTagSha}); promote the newest beta on it once its journeys pass.`,
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
    releaseBranch: branch,
    proofRef: trimmedProof,
    trailer: formatBetaProofRecord({
      betaVersion,
      betaSha: betaTagSha,
      proofRef: trimmedProof,
    }),
  };
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.beta === right.beta) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return left.beta < right.beta ? -1 : 1;
}

export function bumpPatch(version) {
  const parsed = parseSemver(version);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

// Puts one version's notes into a CHANGELOG.md above its newest section, the way Changesets writes
// them. A CHANGELOG that already carries the version is returned unchanged.
export function insertChangelogSection(changelogMarkdown, version, section) {
  const normalized = String(changelogMarkdown).replace(/\r\n/g, "\n");
  if (extractChangelogSection(normalized, version) !== null) return normalized;
  const block = `## ${version}\n\n${String(section).trim()}\n\n`;
  const firstSection = /^##\s+/m.exec(normalized);
  if (firstSection) {
    return `${normalized.slice(0, firstSection.index)}${block}${normalized.slice(firstSection.index)}`;
  }
  return `${normalized.replace(/\n*$/, "\n\n")}${block}`.replace(/\n+$/, "\n");
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
  for (const entry of ["docs/registry", "assets/registry"]) {
    if (existsSync(join(root, entry))) {
      await cp(join(root, entry), join(workspaceDir, entry), { recursive: true });
    }
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

function defaultGit(args, root = repositoryRoot) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function defaultGh(args, root = repositoryRoot) {
  return execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function listGitTags(pattern, root = repositoryRoot, gitExec = defaultGit) {
  const out = gitExec(["tag", "--list", pattern], root);
  return out ? out.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function resolveTagCommitSha(tag, root = repositoryRoot, gitExec = defaultGit) {
  if (listGitTags(tag, root, gitExec).length === 0) return "";
  return gitExec(["rev-list", "-n", "1", tag], root);
}

function resolveCommitSha(ref, root = repositoryRoot, gitExec = defaultGit) {
  try {
    return gitExec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  } catch {
    return "";
  }
}

// In a workflow checkout branches are origin's remote-tracking refs; in a local repository (the
// release-authority proof) they are plain branches.
function resolveBranchSha(branch, root = repositoryRoot, gitExec = defaultGit) {
  return (
    resolveCommitSha(`refs/remotes/origin/${branch}`, root, gitExec) ||
    resolveCommitSha(`refs/heads/${branch}`, root, gitExec)
  );
}

function listReleaseBranches(root = repositoryRoot, gitExec = defaultGit) {
  const out = gitExec(
    ["for-each-ref", "--format=%(refname)", `refs/remotes/origin/${RELEASE_BRANCH_PREFIX}`, `refs/heads/${RELEASE_BRANCH_PREFIX}`],
    root,
  );
  const names = new Set();
  for (const line of out.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const name = line.replace(/^refs\/remotes\/origin\//, "").replace(/^refs\/heads\//, "");
    if (/^release\/\d+\.\d+\.\d+$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

// Cut beta over unpromoted release branches (GrillTrack release-branch-recut-20261030). Returns
// each one with the commit this run read, after checking it holds nothing main lacks: every commit
// on it is on main or an exact Add fix copy (cherry-pick -x) of a main commit. It also refuses while a
// ci: release PR for one of them is open, since merging it would release a beta this run replaces,
// or is merged with its stable tag still to come.
function planReleaseBranchRecut({ releaseBranch, headSha, root = repositoryRoot, gitExec = defaultGit, ghExec = defaultGh }) {
  const unreleased = listReleaseBranches(root, gitExec).filter(
    (branch) => !resolveTagCommitSha(`v${branch.slice(RELEASE_BRANCH_PREFIX.length)}`, root, gitExec),
  );
  if (unreleased.length === 0) return [];

  const treeOf = (commit) => gitExec(["rev-parse", `${commit}^{tree}`], root);
  // A commit is an exact copy of its source when replaying the source's change onto the copy's
  // parent (a three-way merge with the source's parent as base) gives the copy's files. Git compares
  // whole files, modes and bytes, so an amended copy never passes, and later main edits to the same
  // lines do not matter.
  const isExactCopy = (commit, source) => {
    try {
      const replayed = gitExec(["merge-tree", "--write-tree", `--merge-base=${source}^`, `${commit}^`, source], root);
      return replayed.split("\n")[0].trim() === treeOf(commit);
    } catch {
      return false; // a conflict: the copy's parent differs where the source changes
    }
  };
  // Released versions are already kept by their tags: a patch branch starts from one, so its
  // history includes that release commit, which never reaches main.
  const releasedTags = listGitTags("v*", root, gitExec).filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const replaced = [];
  for (const branch of unreleased) {
    const sha = resolveBranchSha(branch, root, gitExec);
    // Same files as main (main's tip itself, or Add fix copies of everything new) would be a
    // same-code beta.
    if (branch === releaseBranch && treeOf(sha) === treeOf(headSha)) {
      throw new Error(`${releaseBranch} already has main's newest code; nothing new has merged to cut a beta from.`);
    }
    const extra = gitExec(["rev-list", sha, "--not", headSha, ...releasedTags], root).split("\n").filter(Boolean);
    for (const commit of extra) {
      const message = gitExec(["log", "-1", "--format=%B", commit], root);
      const copied = [...message.matchAll(/\(cherry picked from commit ([0-9a-f]{7,40})\)/g)].map((match) => match[1]);
      const isCopy = copied.some(
        (source) =>
          resolveCommitSha(source, root, gitExec) &&
          isAncestor(source, headSha, root, gitExec) &&
          isExactCopy(commit, source),
      );
      if (!isCopy) {
        throw new Error(
          `Cannot cut ${releaseBranch}: ${branch} has ${commit.slice(0, 7)}, which is not on main or a copy of a main commit; nothing was pushed.`,
        );
      }
    }
    replaced.push({ branch, sha });
  }

  const releasePrTitle = (entry) => `${RELEASE_PR_TITLE_PREFIX} v${entry.branch.slice(RELEASE_BRANCH_PREFIX.length)}`;
  const openReleasePr = ghExec(
    ["pr", "list", "--head", RELEASE_PR_BRANCH, "--base", "main", "--state", "open", "--json", "title", "--jq", ".[0].title // empty"],
    root,
  ).trim();
  const promoting = replaced.find((entry) => openReleasePr === releasePrTitle(entry));
  if (promoting) {
    throw new Error(
      `Cannot cut ${releaseBranch}: "${openReleasePr}" is open to promote ${promoting.branch}. Merge it, or close it to drop that release, then press Cut beta again.`,
    );
  }
  // A merged ci: release PR whose stable tag is not out yet (publish-merged-release still queued
  // or failed) needs its branch exactly where the approved beta left it.
  const mergedReleasePrs = ghExec(
    ["pr", "list", "--head", RELEASE_PR_BRANCH, "--base", "main", "--state", "merged", "--limit", "30", "--json", "title", "--jq", ".[].title"],
    root,
  )
    .split("\n")
    .map((title) => title.trim());
  const publishing = replaced.find((entry) => mergedReleasePrs.includes(releasePrTitle(entry)));
  if (publishing) {
    const version = publishing.branch.slice(RELEASE_BRANCH_PREFIX.length);
    throw new Error(
      `Cannot cut ${releaseBranch}: "${releasePrTitle(publishing)}" is merged and v${version} is not tagged yet. Wait for that stable release to publish, then press Cut beta again.`,
    );
  }
  return replaced;
}

function isAncestor(ancestor, descendant, root = repositoryRoot, gitExec = defaultGit) {
  try {
    gitExec(["merge-base", "--is-ancestor", ancestor, descendant], root);
    return true;
  } catch {
    return false;
  }
}

function setPackageVersions(packageJsonText, packageLockText, version) {
  const pkg = JSON.parse(packageJsonText);
  pkg.version = version;
  let lockText = packageLockText;
  if (packageLockText !== undefined) {
    const lock = JSON.parse(packageLockText);
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    lockText = `${JSON.stringify(lock, null, 2)}\n`;
  }
  return { packageJsonText: `${JSON.stringify(pkg, null, 2)}\n`, packageLockText: lockText };
}

async function writeReleaseVersionFiles(root, version) {
  const pkgPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const hasLock = existsSync(lockPath);
  const next = setPackageVersions(
    await readFile(pkgPath, "utf8"),
    hasLock ? await readFile(lockPath, "utf8") : undefined,
    version,
  );
  await writeFile(pkgPath, next.packageJsonText, "utf8");
  if (hasLock) await writeFile(lockPath, next.packageLockText, "utf8");
  // Payments' emdash-plugin.jsonc carries no version (the Registry workspace stamps it), so only a
  // manifest that has one is synced.
  const manifestPath = join(root, "emdash-plugin.jsonc");
  if (existsSync(manifestPath)) {
    const manifestText = await readFile(manifestPath, "utf8");
    const pattern = /"version":\s*"[^"]*"/;
    if (pattern.test(manifestText)) {
      await writeFile(manifestPath, manifestText.replace(pattern, `"version": "${version}"`), "utf8");
    }
  }
}

async function nextBetaFor(targetVersion, { root, gitExec, fetchImpl }) {
  const gitTags = listGitTags(`v${targetVersion}-beta.*`, root, gitExec);
  const registryVersions = await fetchRegistryVersions(BETA_REGISTRY_SLUG, { root, fetchImpl });
  return computeNextBetaVersion({ targetVersion, gitTags, registryVersions });
}

// Reads the published-version record a release check compares: the beta tag's files against the
// release commit's.
async function readReleaseComparison(root, gitExec, betaTagSha, changedPathsSinceBeta) {
  const show = (path) => {
    try {
      return gitExec(["show", `${betaTagSha}:${path}`], root);
    } catch {
      return "";
    }
  };
  const readOrEmpty = async (path) => {
    try {
      return await readFile(join(root, path), "utf8");
    } catch {
      return "";
    }
  };
  const comparison = {
    betaPackageJsonText: show("package.json"),
    releasePackageJsonText: await readOrEmpty("package.json"),
    betaManifestText: show("emdash-plugin.jsonc"),
    releaseManifestText: await readOrEmpty("emdash-plugin.jsonc"),
  };
  if (existsSync(join(root, "package-lock.json")) || changedPathsSinceBeta.includes("package-lock.json")) {
    comparison.betaPackageLockText = show("package-lock.json");
    comparison.releasePackageLockText = await readOrEmpty("package-lock.json");
  }
  return comparison;
}

// Release allocation must include every occupied version, including records that
// discovery hides until approval. The publisher PDS is authoritative for this
// inventory; an unavailable catalog is never evidence of an empty history.
export async function fetchRegistryVersions(
  slug,
  { root = repositoryRoot, fetchImpl = globalThis.fetch } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error(`Registry lookup failed for ${slug}: fetch implementation is unavailable.`);
  }
  // Changeset checks import this module before npm ci; load the parser only
  // for release inventory calls, which run after dependency installation.
  const { parse: parseJsonc } = await import("jsonc-parser");
  const parseErrors = [];
  const manifest = parseJsonc(await readFile(join(root, "emdash-plugin.jsonc"), "utf8"), parseErrors, {
    allowTrailingComma: true,
  });
  if (parseErrors.length || !manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid JSONC in emdash-plugin.jsonc.");
  }
  const publisherDid = manifest.publisher;
  if (typeof publisherDid !== "string" || !/^did:(?:plc|web):[^\s/?#]+$/.test(publisherDid)) {
    throw new Error("Release inventory requires a publisher DID in emdash-plugin.jsonc.");
  }
  const request = (url) => fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const pds = new URL(await resolvePdsEndpoint(publisherDid, request));
  if (pds.protocol !== "https:" || pds.username || pds.password || pds.search || pds.hash) {
    throw new Error("Publisher PDS must be an HTTPS endpoint without credentials, query, or fragment.");
  }
  const endpoint = new URL("/xrpc/com.atproto.repo.listRecords", pds);
  endpoint.searchParams.set("repo", publisherDid);
  endpoint.searchParams.set("collection", RELEASE_COLLECTION);
  endpoint.searchParams.set("limit", "100");
  const prefix = `at://${publisherDid}/${RELEASE_COLLECTION}/`;
  const versions = new Set();
  const cursors = new Set();
  for (let page = 0; page < 1000; page += 1) {
    const response = await request(endpoint.href);
    if (!response.ok) throw new Error(`Release inventory failed for ${slug}: HTTP ${response.status}.`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.records)) {
      throw new Error('Release inventory expected "records" to be an array.');
    }
    for (const record of payload.records) {
      const value = record?.value;
      if (!value || Array.isArray(value) || typeof value.package !== "string" || typeof value.version !== "string") {
        throw new Error("Release inventory contains a malformed record.");
      }
      if (record.uri !== `${prefix}${value.package}:${value.version}`) {
        throw new Error("Release inventory record URI does not match its publisher, package, and version.");
      }
      if (value.package === slug) {
        parseSemver(value.version);
        versions.add(value.version);
      }
    }
    if (payload.cursor === undefined) return [...versions];
    if (typeof payload.cursor !== "string" || !payload.cursor || cursors.has(payload.cursor)) {
      throw new Error("Release inventory returned an invalid or repeated cursor.");
    }
    cursors.add(payload.cursor);
    endpoint.searchParams.set("cursor", payload.cursor);
  }
  throw new Error("Release inventory pagination exceeded 1000 pages; refusing an incomplete history.");
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

function checkGithubReleaseExists(tag, root = repositoryRoot, ghExec = defaultGh) {
  try {
    ghExec(["release", "view", tag, "--json", "tagName"], root);
    return true;
  } catch {
    return false;
  }
}

export async function runReleaseFlowCli(argv, deps = {}) {
  const [command, ...rest] = argv;
  const flags = parseCliFlags(rest);
  const root = flags.root ? resolve(flags.root) : deps.root ? resolve(deps.root) : repositoryRoot;
  const gitExec = deps.gitExec || defaultGit;
  const ghExec = deps.ghExec || defaultGh;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const npmExec =
    deps.npmExec ||
    ((args, cwd) => execFileSync("npm", args, { cwd, stdio: "inherit" }));
  const log = deps.log || ((line) => console.log(line));

  if (command === "validate-emdash-dispatch") {
    const eventName = flags["event-name"] ?? process.env.EVENT_NAME ?? process.env.GITHUB_EVENT_NAME ?? "";
    const ref = flags.ref ?? process.env.TARGET_REF ?? process.env.GITHUB_REF ?? "";
    const inputVersion = flags.version ?? process.env.INPUT_VERSION ?? "";
    const releaseMode =
      flags["release-mode"] ?? process.env.INPUT_RELEASE_MODE ?? process.env.RELEASE_MODE ?? "";
    const gate = validateEmDashDispatchGate({ eventName, ref, inputVersion, releaseMode });
    if (!gate.ok) {
      throw new Error(gate.message);
    }
    await writeGithubOutputs(flags["github-output"], {
      mode: gate.mode,
      slug: gate.slug,
      requested_version: gate.requestedVersion ?? "",
    });
    log(JSON.stringify(gate));
    return gate;
  }

  if (command === "check-pr") {
    const baseRef = flags.base || process.env.GITHUB_BASE_REF || "main";
    const headRef = flags.head || process.env.GITHUB_HEAD_REF || "";
    const title = flags.title || process.env.PR_TITLE || "";
    const diffRange = baseRef.startsWith("origin/") ? `${baseRef}...HEAD` : `origin/${baseRef}...HEAD`;
    const diffOutput = gitExec(["diff", "--name-only", "--diff-filter=ACMR", diffRange], root);
    const changedFiles = diffOutput ? diffOutput.split("\n").filter(Boolean) : [];
    const result = findMissingChangesets({ changedFiles, headRef, title });
    if (!result.ok) {
      throw new Error(result.message);
    }
    for (const relPath of result.changesetFiles) {
      const content = await readFile(join(root, relPath), "utf8");
      parseChangesetFrontmatter(content, relPath);
    }
    const outputText = result.exempted
      ? "changeset_check=exempt_release_pr"
      : `changeset_check=passed (${result.changesetFiles.join(", ")})`;
    log(outputText);
    return result;
  }

  if (command === "plan-beta" || command === "cut-beta") {
    // Cut beta: a new release/X.Y.Z branch from main's newest commit, and its first beta tag. The
    // tag's own run publishes the beta and starts the journeys.
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const pending = await readPendingChangesets(root);
    if (pending.length === 0) {
      throw new Error(
        "Cannot cut beta: nothing version-bumping has merged to main since the last release (no pending `.changeset/*.md`).",
      );
    }

    const targetVersion = computeTargetVersion(
      pkg.version,
      pending.map((entry) => entry.bump),
    );
    const releaseBranch = releaseBranchFor(targetVersion);
    if (resolveTagCommitSha(`v${targetVersion}`, root, gitExec)) {
      throw new Error(
        `v${targetVersion} is already released. A fix for it goes on ${releaseBranchFor(bumpPatch(targetVersion))} with Add fix to beta.`,
      );
    }
    // One release on test at a time: the beta store runs the newest beta. An unpromoted release
    // branch is the beta on test, and pressing Cut beta again re-cuts it (GrillTrack
    // release-branch-recut-20261030): the same version moves forward to main, an older version is
    // dropped (its tags stay). The release App does both, so nobody deletes a release branch by hand.
    const headSha = gitExec(["rev-parse", "HEAD"], root);
    const replaced = planReleaseBranchRecut({ releaseBranch, headSha, root, gitExec, ghExec });

    let version = flags.version?.trim();
    if (version) {
      const parsed = parseSemver(version);
      if (parsed.beta === null || !version.startsWith(`${targetVersion}-beta.`)) {
        throw new Error(
          `Cannot cut beta with version "${version}": main's pending changesets make ${targetVersion}-beta.N.`,
        );
      }
      await fetchRegistryVersions(BETA_REGISTRY_SLUG, { root, fetchImpl });
    } else {
      version = (await nextBetaFor(targetVersion, { root, gitExec, fetchImpl })).version;
    }

    const tag = `v${version}`;
    const result = {
      shouldCut: true,
      currentVersion: pkg.version,
      targetVersion,
      version,
      betaVersion: version,
      betaTag: tag,
      releaseBranch,
      slug: BETA_REGISTRY_SLUG,
      changesetCount: pending.length,
      movedBranch: replaced.find((entry) => entry.branch === releaseBranch)?.branch ?? "",
      droppedBranches: replaced.filter((entry) => entry.branch !== releaseBranch).map((entry) => entry.branch).join(","),
    };

    if (command === "cut-beta") {
      const existingTagSha = resolveTagCommitSha(tag, root, gitExec);
      if (existingTagSha && existingTagSha !== headSha) {
        throw new Error(`Tag ${tag} already exists at ${existingTagSha} (HEAD is ${headSha}).`);
      }
      if (!existingTagSha) gitExec(["tag", tag, headSha], root);
      if (flags["no-push"] !== "true") {
        // One atomic push: the moved or dropped branches, the new branch and its beta tag land
        // together or not at all, so a failed push leaves nothing behind and the button can simply
        // be pressed again. Each lease refuses if a branch changed since this run read it.
        const leases = replaced.map((entry) => `--force-with-lease=refs/heads/${entry.branch}:${entry.sha}`);
        const drops = replaced.filter((entry) => entry.branch !== releaseBranch).map((entry) => `:refs/heads/${entry.branch}`);
        gitExec(
          ["push", "--atomic", ...leases, "origin", `${headSha}:refs/heads/${releaseBranch}`, ...drops, `refs/tags/${tag}`],
          root,
        );
      }
      gitExec(["branch", "-f", releaseBranch, headSha], root);
      for (const entry of replaced) {
        if (entry.branch !== releaseBranch && resolveCommitSha(`refs/heads/${entry.branch}`, root, gitExec)) {
          gitExec(["branch", "-D", entry.branch], root);
        }
      }
      result.betaSha = headSha;
    }

    await writeGithubOutputs(flags["github-output"], result);
    log(JSON.stringify(result));
    return result;
  }

  if (command === "add-fix") {
    // Add fix to beta: copy one commit already merged (and reviewed) on main onto release/X.Y.Z and
    // tag the next beta there. A release/X.Y.Z that doesn't exist yet is a patch branch for a
    // released X.Y.(Z-1), made from its tag.
    const targetVersion = String(flags["release-version"] ?? process.env.RELEASE_VERSION ?? "").trim();
    const fixRef = String(flags.commit ?? process.env.FIX_COMMIT ?? "").trim();
    let parsedTarget;
    try {
      parsedTarget = parseSemver(targetVersion);
    } catch {
      parsedTarget = null;
    }
    if (!parsedTarget || parsedTarget.beta !== null) {
      throw new Error(`Add fix to beta needs release_version X.Y.Z (got "${targetVersion || "(empty)"}").`);
    }
    if (!fixRef) {
      throw new Error("Add fix to beta needs fix_commit, the merged commit on main to copy.");
    }

    const releaseBranch = releaseBranchFor(targetVersion);
    const mainSha = resolveBranchSha("main", root, gitExec);
    const fixSha = resolveCommitSha(fixRef, root, gitExec);
    if (!fixSha || !mainSha || !isAncestor(fixSha, mainSha, root, gitExec)) {
      throw new Error(
        `${fixRef} is not a commit on main. Merge the fix to main through its reviewed PR first, then copy that commit.`,
      );
    }
    if (resolveTagCommitSha(`v${targetVersion}`, root, gitExec)) {
      throw new Error(
        `v${targetVersion} is already released. A fix for it goes on ${releaseBranchFor(bumpPatch(targetVersion))}.`,
      );
    }

    let branchSha = resolveBranchSha(releaseBranch, root, gitExec);
    let patchBase = null;
    if (!branchSha) {
      if (parsedTarget.patch === 0) {
        throw new Error(`${releaseBranch} is not cut. Cut beta makes it from main.`);
      }
      // One release on test at a time, for a patch branch as for Cut beta.
      const unreleased = listReleaseBranches(root, gitExec).filter(
        (branch) => !resolveTagCommitSha(`v${branch.slice(RELEASE_BRANCH_PREFIX.length)}`, root, gitExec),
      );
      if (unreleased.length > 0) {
        throw new Error(
          `${unreleased.join(", ")} is still on test. Promote it before starting ${releaseBranch}.`,
        );
      }
      patchBase = `v${parsedTarget.major}.${parsedTarget.minor}.${parsedTarget.patch - 1}`;
      branchSha = resolveTagCommitSha(patchBase, root, gitExec);
      if (!branchSha) {
        throw new Error(
          `${releaseBranch} is not cut, and there is no released ${patchBase} to make a patch branch from.`,
        );
      }
    }
    const alreadyCopied = gitExec(
      ["log", "-n", "1", "--format=%H", "--fixed-strings", `--grep=(cherry picked from commit ${fixSha})`, branchSha],
      root,
    );
    if (isAncestor(fixSha, branchSha, root, gitExec) || alreadyCopied) {
      throw new Error(`${fixSha} is already on ${releaseBranch}.`);
    }

    gitExec(["checkout", "-B", releaseBranch, branchSha], root);
    const parents = gitExec(["rev-list", "--parents", "-n", "1", fixSha], root).split(/\s+/).filter(Boolean);
    const pickArgs = parents.length > 2 ? ["cherry-pick", "-x", "-m", "1", fixSha] : ["cherry-pick", "-x", fixSha];
    try {
      gitExec(pickArgs, root);
    } catch (error) {
      try {
        gitExec(["cherry-pick", "--abort"], root);
      } catch {
        // Nothing to abort.
      }
      throw new Error(
        `${fixSha} does not copy cleanly onto ${releaseBranch}; nothing was pushed. (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
      );
    }
    const headSha = gitExec(["rev-parse", "HEAD"], root);
    const next = await nextBetaFor(targetVersion, { root, gitExec, fetchImpl });
    const tag = next.tag;
    gitExec(["tag", tag, headSha], root);
    if (flags["no-push"] !== "true") {
      gitExec(["push", "--atomic", "origin", `${headSha}:refs/heads/${releaseBranch}`, `refs/tags/${tag}`], root);
    }

    const result = {
      releaseBranch,
      patchBase,
      fixSha,
      betaSha: headSha,
      version: next.version,
      betaVersion: next.version,
      betaTag: tag,
      slug: BETA_REGISTRY_SLUG,
    };
    await writeGithubOutputs(flags["github-output"], result);
    log(JSON.stringify(result));
    return result;
  }

  if (command === "promote") {
    // Promote: work out the version and changelog on release/X.Y.Z, then open the one ci: release
    // PR to main carrying only those. Merging it is the stable yes; that push's run writes the same
    // files onto the branch and tags it.
    const betaVersion = String(flags["beta-version"] || process.env.BETA_VERSION || "").trim();
    const proofRef = flags["proof-ref"] || process.env.PROOF_REF || "";
    let targetVersion = "";
    try {
      targetVersion = parseSemver(betaVersion).beta === null ? "" : betaVersion.replace(/-beta\.\d+$/, "");
    } catch {
      targetVersion = "";
    }

    const releaseBranch = targetVersion ? releaseBranchFor(targetVersion) : "";
    const betaTag = `v${betaVersion}`;
    const betaTagSha = betaVersion ? resolveTagCommitSha(betaTag, root, gitExec) : "";
    const branchTipSha = releaseBranch ? resolveBranchSha(releaseBranch, root, gitExec) : "";
    const stableTagSha = targetVersion ? resolveTagCommitSha(`v${targetVersion}`, root, gitExec) : "";
    const registryVersions =
      flags["skip-registry-check"] === "true" || !targetVersion
        ? []
        : await fetchRegistryVersions(BETA_REGISTRY_SLUG, { root, fetchImpl });
    const registryHasBetaVersion =
      flags["skip-registry-check"] === "true" || registryVersions.includes(betaVersion);

    const gate = validateBetaPromotionGate({
      targetVersion,
      betaVersion,
      betaTagSha,
      branchTipSha,
      stableTagSha,
      registryHasBetaVersion,
      proofRef,
    });
    if (!gate.ok) {
      throw new Error(gate.message);
    }

    const mainSha = resolveBranchSha("main", root, gitExec);
    gitExec(["checkout", "-f", "--detach", betaTagSha], root);
    await npmExec(["run", "release:version"], root);
    const branchPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (branchPkg.version !== targetVersion) {
      gitExec(["checkout", "-f", mainSha], root);
      throw new Error(
        `The changesets on ${releaseBranch} make ${branchPkg.version}, not ${targetVersion}. A patch branch takes only patch changesets.`,
      );
    }
    const notes = extractChangelogSection(await readFile(join(root, "CHANGELOG.md"), "utf8"), targetVersion);
    if (!notes) {
      gitExec(["checkout", "-f", mainSha], root);
      throw new Error(`release:version wrote no CHANGELOG.md section for ${targetVersion}.`);
    }
    const consumedChangesets = gitExec(["diff", "--name-only", "--diff-filter=D", "HEAD", "--", ".changeset"], root)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && isChangesetMarkdownPath(line));

    gitExec(["checkout", "-f", "-B", RELEASE_PR_BRANCH, mainSha], root);
    const mainPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (compareSemver(targetVersion, mainPkg.version) > 0) {
      await writeReleaseVersionFiles(root, targetVersion);
    }
    const changelogPath = join(root, "CHANGELOG.md");
    const mainChangelog = existsSync(changelogPath) ? await readFile(changelogPath, "utf8") : `# ${PACKAGE_NAME}\n`;
    await writeFile(changelogPath, insertChangelogSection(mainChangelog, targetVersion, notes), "utf8");
    for (const relPath of consumedChangesets) {
      if (existsSync(join(root, relPath))) gitExec(["rm", "-q", "--", relPath], root);
    }
    gitExec(["add", "-A"], root);
    const prTitle = `${RELEASE_PR_TITLE_PREFIX} v${targetVersion}`;
    const commitBody = [
      prTitle,
      "",
      `Promotes verified beta \`${BETA_REGISTRY_SLUG}@${betaVersion}\` (\`${betaTagSha}\` on \`${releaseBranch}\`) to stable \`${STABLE_REGISTRY_SLUG}@${targetVersion}\`.`,
      "",
      gate.trailer,
    ].join("\n");
    gitExec(["commit", "-m", commitBody], root);

    if (flags["no-push"] !== "true") {
      gitExec(["push", "--force-with-lease", "origin", `HEAD:refs/heads/${RELEASE_PR_BRANCH}`], root);
      const prBody = [
        `## Release \`${PACKAGE_NAME}@${targetVersion}\``,
        "",
        `- **Promoted beta**: \`${BETA_REGISTRY_SLUG}@${betaVersion}\` (tag \`v${betaVersion}\` at \`${betaTagSha}\` on \`${releaseBranch}\`)`,
        `- **Beta-store @running proof**: ${gate.proofRef}`,
        `- **Stable target**: \`${STABLE_REGISTRY_SLUG}@${targetVersion}\` (\`${STABLE_INSTALLED_PLUGIN_ID}\`)`,
        `- **This PR changes only** the version, the ${targetVersion} CHANGELOG section, and the removal of the changesets that release used (${consumedChangesets.length}).`,
        "",
        `Run \`@clawsweeper review\` on this PR before merging. Merging it writes the same files onto \`${releaseBranch}\`, tags \`v${targetVersion}\` there, and publishes stable from that tag.`,
        "",
        gate.trailer,
      ].join("\n");

      const existingPr = ghExec(
        [
          "pr",
          "list",
          "--head",
          RELEASE_PR_BRANCH,
          "--base",
          "main",
          "--state",
          "open",
          "--json",
          "number",
          "--jq",
          ".[0].number // empty",
        ],
        root,
      );

      if (existingPr) {
        ghExec(["pr", "edit", existingPr, "--title", prTitle, "--body", prBody], root);
      } else {
        ghExec(
          ["pr", "create", "--base", "main", "--head", RELEASE_PR_BRANCH, "--title", prTitle, "--body", prBody],
          root,
        );
      }
    }

    const result = { ...gate, consumedChangesets };
    await writeGithubOutputs(flags["github-output"], gate);
    log(JSON.stringify(result));
    return result;
  }

  if (command === "publish-merged-release") {
    // A push to main. Only a merged ci: release PR (its Release-Beta-Proof trailer) does anything:
    // the same version files go onto release/X.Y.Z, the branch is checked against the approved beta,
    // and vX.Y.Z is tagged there. That tag's run creates the GitHub Release and publishes stable.
    const skip = async (reason, extra = {}) => {
      const skipped = { tagPushed: false, reason, ...extra };
      await writeGithubOutputs(flags["github-output"], {
        tag_pushed: false,
        version: extra.version ?? "",
        reason,
      });
      log(JSON.stringify(skipped));
      return skipped;
    };

    const headSha = gitExec(["rev-parse", "HEAD"], root);
    // A squash merge carries the release PR's message itself; a merge commit carries it on its
    // second parent, the PR's head.
    let headMessage = gitExec(["log", "-1", "--format=%B"], root);
    if (!headMessage.startsWith(`${RELEASE_PR_TITLE_PREFIX} v`)) {
      const parents = gitExec(["rev-list", "--parents", "-n", "1", headSha], root).split(/\s+/).filter(Boolean);
      const prHeadMessage = parents.length > 2 ? gitExec(["log", "-1", "--format=%B", parents[2]], root) : "";
      if (!prHeadMessage.startsWith(`${RELEASE_PR_TITLE_PREFIX} v`)) {
        return skip("not_a_release_commit");
      }
      headMessage = prHeadMessage;
    }
    let proof = parseBetaProofRecord(headMessage);
    if (!proof && flags["no-gh"] !== "true") {
      try {
        const prBody = ghExec(
          ["pr", "list", "--state", "merged", "--search", headSha, "--json", "body", "--jq", ".[0].body // empty"],
          root,
        );
        proof = parseBetaProofRecord(prBody);
      } catch {
        proof = null;
      }
    }
    const titleVersion = /^ci: release v(\d+\.\d+\.\d+)\b/.exec(headMessage)?.[1] ?? "";
    if (!proof || !titleVersion || !proof.betaVersion.startsWith(`${titleVersion}-beta.`)) {
      throw new Error(
        `Refusing to tag v${titleVersion || "?"}: merged release commit is missing a valid ${BETA_PROOF_TRAILER} record for ${titleVersion || "X.Y.Z"}-beta.<N>.`,
      );
    }

    const version = titleVersion;
    const tag = `v${version}`;
    const releaseBranch = releaseBranchFor(version);
    if (resolveTagCommitSha(tag, root, gitExec)) {
      return skip("tag_already_exists", { version, tag });
    }

    const betaTagSha = resolveTagCommitSha(`v${proof.betaVersion}`, root, gitExec);
    const branchTipSha = resolveBranchSha(releaseBranch, root, gitExec);
    if (!branchTipSha) {
      throw new Error(`Refusing to tag ${tag}: ${releaseBranch} does not exist.`);
    }

    const mainChangelog = gitExec(["show", `${headSha}:CHANGELOG.md`], root);
    const notes = extractChangelogSection(mainChangelog, version);
    if (!notes) {
      throw new Error(`Refusing to tag ${tag}: the merged CHANGELOG.md has no ${version} section.`);
    }
    // Promote's release:version used every changeset on the approved beta, so those are the ones
    // the branch drops, whether or not main still had them to delete.
    const consumedChangesets = (betaTagSha ? gitExec(["ls-tree", "--name-only", betaTagSha, ".changeset/"], root) : "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && isChangesetMarkdownPath(line));

    // A run that already committed the release onto the branch but failed before tagging resumes
    // from that commit.
    const tipMessage = gitExec(["log", "-1", "--format=%B", branchTipSha], root);
    const resumed = branchTipSha !== betaTagSha && tipMessage.startsWith(`${RELEASE_PR_TITLE_PREFIX} ${tag}\n`);
    if (branchTipSha !== betaTagSha && !resumed) {
      throw new Error(
        `Refusing to tag ${tag}: ${releaseBranch} (${branchTipSha}) has moved past the approved beta v${proof.betaVersion} (${betaTagSha || "missing"}).`,
      );
    }

    gitExec(["checkout", "-f", "-B", releaseBranch, branchTipSha], root);
    if (!resumed) {
      await writeReleaseVersionFiles(root, version);
      const changelogPath = join(root, "CHANGELOG.md");
      const branchChangelog = existsSync(changelogPath) ? await readFile(changelogPath, "utf8") : `# ${PACKAGE_NAME}\n`;
      await writeFile(changelogPath, insertChangelogSection(branchChangelog, version, notes), "utf8");
      for (const relPath of consumedChangesets) {
        if (existsSync(join(root, relPath))) gitExec(["rm", "-q", "--", relPath], root);
      }
      const leftover = await readPendingChangesets(root, { includeEmpty: true });
      if (leftover.length > 0) {
        throw new Error(
          `Refusing to tag ${tag}: ${releaseBranch} still has changesets the release PR did not use (${leftover.map((entry) => entry.filePath).join(", ")}).`,
        );
      }
      gitExec(["add", "-A"], root);
      gitExec(
        ["commit", "-m", [`${RELEASE_PR_TITLE_PREFIX} ${tag}`, "", `Merged on main as ${headSha}.`, "", formatBetaProofRecord(proof)].join("\n")],
        root,
      );
    }
    const releaseSha = gitExec(["rev-parse", "HEAD"], root);

    const changedPathsSinceBeta = betaTagSha
      ? gitExec(["diff", "--name-only", betaTagSha, releaseSha], root)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
    const sourceCheck = verifyApprovedBetaSourceTree({
      version,
      proof,
      betaTagSha,
      changedPathsSinceBeta,
      ...(betaTagSha ? await readReleaseComparison(root, gitExec, betaTagSha, changedPathsSinceBeta) : {}),
    });
    if (!sourceCheck.ok) {
      throw new Error(sourceCheck.message);
    }

    gitExec(["tag", tag, releaseSha], root);
    if (flags["no-push"] !== "true") {
      gitExec(["push", "--atomic", "origin", `${releaseSha}:refs/heads/${releaseBranch}`, `refs/tags/${tag}`], root);
    }

    const result = {
      tagPushed: true,
      resumed,
      version,
      tag,
      releaseBranch,
      releaseSha,
      betaVersion: proof.betaVersion,
      betaSha: betaTagSha,
      consumedChangesets,
    };
    await writeGithubOutputs(flags["github-output"], {
      tag_pushed: true,
      version,
      tag,
      release_branch: releaseBranch,
      release_sha: releaseSha,
      beta_version: proof.betaVersion,
    });
    log(JSON.stringify(result));
    return result;
  }

  if (command === "verify-release-tag") {
    // A pushed version tag's run: the tag must sit on its release/X.Y.Z branch. A stable tag is
    // checked against its approved beta again and gets its GitHub Release; then the Registry job runs.
    const ref = String(flags.ref ?? process.env.GITHUB_REF ?? "").trim();
    const version = parseReleaseTagRef(ref);
    if (!version) {
      throw new Error(`verify-release-tag needs a vX.Y.Z or vX.Y.Z-beta.N tag ref (got "${ref || "(empty)"}").`);
    }
    const tag = `v${version}`;
    const releaseBranch = releaseBranchFor(version);
    const tagSha = resolveTagCommitSha(tag, root, gitExec);
    const branchTipSha = resolveBranchSha(releaseBranch, root, gitExec);
    if (!tagSha || !branchTipSha || !isAncestor(tagSha, branchTipSha, root, gitExec)) {
      throw new Error(`Refusing to publish ${tag}: it is not a commit on ${releaseBranch}.`);
    }
    const isBeta = parseSemver(version).beta !== null;
    const result = {
      version,
      tag,
      tagSha,
      releaseBranch,
      releaseMode: isBeta ? "beta" : "stable",
      slug: isBeta ? BETA_REGISTRY_SLUG : STABLE_REGISTRY_SLUG,
      githubReleaseCreated: false,
    };

    if (!isBeta) {
      const proof = parseBetaProofRecord(gitExec(["log", "-1", "--format=%B", tagSha], root));
      const betaTagSha = proof ? resolveTagCommitSha(`v${proof.betaVersion}`, root, gitExec) : "";
      const changedPathsSinceBeta = betaTagSha
        ? gitExec(["diff", "--name-only", betaTagSha, tagSha], root)
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
      const sourceCheck = verifyApprovedBetaSourceTree({
        version,
        proof,
        betaTagSha,
        changedPathsSinceBeta,
        ...(betaTagSha ? await readReleaseComparison(root, gitExec, betaTagSha, changedPathsSinceBeta) : {}),
      });
      if (!sourceCheck.ok) {
        throw new Error(sourceCheck.message);
      }
      result.betaVersion = proof.betaVersion;
      if (flags["no-gh"] !== "true" && !checkGithubReleaseExists(tag, root, ghExec)) {
        const notes =
          extractChangelogSection(gitExec(["show", `${tagSha}:CHANGELOG.md`], root), version) ||
          `Release ${PACKAGE_NAME} ${version}`;
        ghExec(["release", "create", tag, "--title", tag, "--notes", notes, "--verify-tag"], root);
        result.githubReleaseCreated = true;
      }
    }

    await writeGithubOutputs(flags["github-output"], {
      version,
      tag,
      release_mode: result.releaseMode,
      slug: result.slug,
      github_release_created: result.githubReleaseCreated,
    });
    log(JSON.stringify(result));
    return result;
  }

  if (command === "check-registry-version") {
    const slug = flags.slug || process.env.EMDASH_PLUGIN_SLUG || STABLE_REGISTRY_SLUG;
    const version = flags.version || process.env.RELEASE_VERSION || "";
    if (!version) {
      throw new Error("check-registry-version requires --version <version>.");
    }
    parseSemver(version);
    const versions = await fetchRegistryVersions(slug, { root, fetchImpl });
    const alreadyPublished = versions.includes(version);
    const result = {
      slug,
      version,
      alreadyPublished,
    };
    await writeGithubOutputs(flags["github-output"], {
      already_published: alreadyPublished,
      slug,
      version,
    });
    log(JSON.stringify(result));
    return result;
  }

  if (command === "check-bundle-size") {
    const relPath = flags.bundle || "dist/sandbox/plugin.mjs";
    const info = await verifyBuiltPluginBundleSize(root, relPath);
    await writeGithubOutputs(flags["github-output"], info);
    log(JSON.stringify(info));
    return info;
  }

  throw new Error(`Unknown release-flow command: ${command ?? "(none)"}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runReleaseFlowCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
