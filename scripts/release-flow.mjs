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
export const RELEASE_PR_TITLE_PREFIX = "ci: release";
export const BETA_PROOF_TRAILER = "Release-Beta-Proof";
const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";

export const ALLOWED_RELEASE_TREE_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "CHANGELOG.md",
]);

export const EMDASH_PUBLISH_JOB_IF =
  "github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && inputs.release_mode == 'stable' && inputs.version != ''))";

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

  if (normalizedEvent === "workflow_dispatch") {
    if (normalizedRef !== "refs/heads/main") {
      return {
        ok: false,
        code: "forbidden_dispatch_ref",
        message: `Manual workflow_dispatch for emdash-release.yml is only allowed on refs/heads/main (got "${normalizedRef || "(empty)"}").`,
      };
    }

    if (normalizedMode !== "" && normalizedMode !== "beta") {
      return {
        ok: false,
        code: "manual_stable_dispatch_forbidden",
        message: `Manual workflow_dispatch cannot set release_mode="${normalizedMode}"; only beta cuts on refs/heads/main are allowed via workflow_dispatch.`,
      };
    }

    if (normalizedVersion !== "") {
      let parsed;
      try {
        parsed = parseSemver(normalizedVersion);
      } catch {
        return {
          ok: false,
          code: "invalid_dispatch_version",
          message: `Invalid manual workflow_dispatch version "${normalizedVersion}": expected blank or X.Y.Z-beta.N.`,
        };
      }
      if (parsed.beta === null) {
        return {
          ok: false,
          code: "manual_stable_dispatch_forbidden",
          message: `Manual workflow_dispatch cannot publish stable version "${normalizedVersion}" (${STABLE_REGISTRY_SLUG}); stable releases may only publish via a merged "${RELEASE_PR_TITLE_PREFIX}" PR.`,
        };
      }
    }

    return {
      ok: true,
      mode: "cut-beta",
      slug: BETA_REGISTRY_SLUG,
      requestedVersion: normalizedVersion || null,
    };
  }

  if (normalizedEvent === "push") {
    if (normalizedRef !== "refs/heads/main") {
      return {
        ok: false,
        code: "forbidden_caller_ref",
        message: `Delegated push call to emdash-release.yml is only allowed on refs/heads/main (got "${normalizedRef || "(empty)"}").`,
      };
    }

    if (normalizedMode !== "stable") {
      return {
        ok: false,
        code: "missing_stable_caller_input",
        message: `Push event on emdash-release.yml requires workflow_call input release_mode="stable" from release.yml (got "${normalizedMode || "(empty)"}").`,
      };
    }

    if (!normalizedVersion) {
      return {
        ok: false,
        code: "missing_workflow_call_version",
        message: "Delegated stable workflow_call to emdash-release.yml requires a non-empty inputs.version.",
      };
    }

    let parsed;
    try {
      parsed = parseSemver(normalizedVersion);
    } catch {
      return {
        ok: false,
        code: "invalid_workflow_call_version",
        message: `Invalid delegated stable workflow_call version "${normalizedVersion}".`,
      };
    }

    if (parsed.beta !== null) {
      return {
        ok: false,
        code: "invalid_stable_caller_version",
        message: `Delegated stable workflow_call cannot publish beta version "${normalizedVersion}"; expected stable X.Y.Z.`,
      };
    }

    return {
      ok: true,
      mode: "stable-call",
      slug: STABLE_REGISTRY_SLUG,
      requestedVersion: normalizedVersion,
    };
  }

  return {
    ok: false,
    code: "unsupported_event",
    message: `Unsupported event "${normalizedEvent || "(empty)"}" for emdash-release.yml.`,
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
  const manifest = JSON.parse(await readFile(join(root, "emdash-plugin.jsonc"), "utf8"));
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
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const pending = await readPendingChangesets(root);
    if (pending.length === 0 && !flags.version) {
      throw new Error(
        "Cannot cut beta: no pending version-bumping `.changeset/*.md` files on main.",
      );
    }

    let version = flags.version?.trim();
    let targetVersion = computeTargetVersion(
      pkg.version,
      pending.map((entry) => entry.bump),
    );

    if (version) {
      const parsed = parseSemver(version);
      if (parsed.beta === null) {
        throw new Error(
          `Cannot cut beta with non-beta version "${version}": expected X.Y.Z-beta.N.`,
        );
      }
      targetVersion = version.replace(/-beta\.\d+$/, "");
      await fetchRegistryVersions(BETA_REGISTRY_SLUG, { root, fetchImpl });
    } else {
      const gitTags = listGitTags(`v${targetVersion}-beta.*`, root, gitExec);
      const registryVersions = await fetchRegistryVersions(BETA_REGISTRY_SLUG, {
        root, fetchImpl,
      });
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
      const existingTagSha = resolveTagCommitSha(tag, root, gitExec);
      const headSha = gitExec(["rev-parse", "HEAD"], root);
      if (!existingTagSha) {
        gitExec(["tag", tag, headSha], root);
        if (flags["no-push"] !== "true") {
          gitExec(["push", "origin", `refs/tags/${tag}`], root);
        }
      } else if (existingTagSha !== headSha) {
        throw new Error(`Tag ${tag} already exists at ${existingTagSha} (HEAD is ${headSha}).`);
      }
    }

    await writeGithubOutputs(flags["github-output"], result);
    log(JSON.stringify(result));
    return result;
  }

  if (command === "promote") {
    const betaVersion = flags["beta-version"] || process.env.BETA_VERSION || "";
    const proofRef = flags["proof-ref"] || process.env.PROOF_REF || "";

    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const pending = await readPendingChangesets(root);
    const targetVersion = computeTargetVersion(
      pkg.version,
      pending.map((entry) => entry.bump),
    );

    const betaTag = `v${betaVersion}`;
    const betaTagSha = resolveTagCommitSha(betaTag, root, gitExec);
    const currentMainSha = gitExec(["rev-parse", "HEAD"], root);
    const changedFilesSinceBeta =
      betaTagSha && betaTagSha !== currentMainSha
        ? gitExec(["diff", "--name-only", `${betaTagSha}..${currentMainSha}`], root)
            .split("\n")
            .filter(Boolean)
        : [];
    const registryVersions =
      flags["skip-registry-check"] === "true"
        ? []
        : await fetchRegistryVersions(BETA_REGISTRY_SLUG, { root, fetchImpl });
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

    await npmExec(["run", "release:version"], root);
    gitExec(["checkout", "-B", RELEASE_PR_BRANCH], root);
    gitExec(["add", "-A"], root);
    const prTitle = `${RELEASE_PR_TITLE_PREFIX} v${targetVersion}`;
    const commitBody = [
      prTitle,
      "",
      `Promotes verified beta \`${BETA_REGISTRY_SLUG}@${betaVersion}\` (\`${betaTagSha}\`) to stable \`${STABLE_REGISTRY_SLUG}@${targetVersion}\`.`,
      "",
      gate.trailer,
    ].join("\n");
    gitExec(["commit", "-m", commitBody], root);

    if (flags["no-push"] !== "true") {
      gitExec(["push", "--force-with-lease", "origin", `HEAD:refs/heads/${RELEASE_PR_BRANCH}`], root);
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

    await writeGithubOutputs(flags["github-output"], gate);
    log(JSON.stringify(gate));
    return gate;
  }

  if (command === "publish-merged-release") {
    const pending = await readPendingChangesets(root);
    const releasePackageJsonText = await readFile(join(root, "package.json"), "utf8");
    const pkg = JSON.parse(releasePackageJsonText);
    const version = pkg.version;
    const tag = `v${version}`;

    if (pending.length > 0) {
      const skipped = {
        published: false,
        registryNeeded: false,
        version,
        reason: "pending_changesets_present",
      };
      await writeGithubOutputs(flags["github-output"], {
        published: false,
        registry_needed: false,
        version,
        reason: skipped.reason,
      });
      log(JSON.stringify(skipped));
      return skipped;
    }

    const headSha = gitExec(["rev-parse", "HEAD"], root);
    const existingTagSha = resolveTagCommitSha(tag, root, gitExec);
    if (existingTagSha && existingTagSha !== headSha) {
      const skipped = {
        published: false,
        registryNeeded: false,
        version,
        tag,
        reason: "tag_already_exists_at_prior_commit",
      };
      await writeGithubOutputs(flags["github-output"], {
        published: false,
        registry_needed: false,
        version,
        reason: skipped.reason,
      });
      log(JSON.stringify(skipped));
      return skipped;
    }

    const headMessage = gitExec(["log", "-1", "--format=%B"], root);
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

    if (!proof || !proof.betaVersion.startsWith(`${version}-beta.`)) {
      if (!existingTagSha && version === BASELINE_VERSION) {
        const skipped = {
          published: false,
          registryNeeded: false,
          version,
          reason: "baseline_version_no_release_commit",
        };
        await writeGithubOutputs(flags["github-output"], {
          published: false,
          registry_needed: false,
          version,
          reason: skipped.reason,
        });
        log(JSON.stringify(skipped));
        return skipped;
      }
      throw new Error(
        `Refusing to tag ${tag}: merged release commit is missing a valid ${BETA_PROOF_TRAILER} record for ${version}-beta.<N>.`,
      );
    }

    const betaTag = `v${proof.betaVersion}`;
    const betaTagSha = resolveTagCommitSha(betaTag, root, gitExec);
    const changedPathsSinceBeta = betaTagSha
      ? gitExec(["diff", "--name-only", betaTagSha, headSha], root)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];

    let betaPackageJsonText;
    let betaPackageLockText;
    let releasePackageLockText;
    if (betaTagSha) {
      try {
        betaPackageJsonText = gitExec(["show", `${betaTagSha}:package.json`], root);
      } catch {
        betaPackageJsonText = "";
      }
      if (existsSync(join(root, "package-lock.json")) || changedPathsSinceBeta.includes("package-lock.json")) {
        try {
          betaPackageLockText = gitExec(["show", `${betaTagSha}:package-lock.json`], root);
        } catch {
          betaPackageLockText = "";
        }
        try {
          releasePackageLockText = await readFile(join(root, "package-lock.json"), "utf8");
        } catch {
          releasePackageLockText = "";
        }
      }
    }

    const sourceCheck = verifyApprovedBetaSourceTree({
      version,
      proof,
      betaTagSha,
      changedPathsSinceBeta,
      betaPackageJsonText,
      releasePackageJsonText,
      betaPackageLockText,
      releasePackageLockText,
    });
    if (!sourceCheck.ok) {
      throw new Error(sourceCheck.message);
    }

    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    const notes = extractChangelogSection(changelog, version) || `Release ${PACKAGE_NAME} ${version}`;

    let tagCreated = false;
    if (!existingTagSha) {
      gitExec(["tag", tag, headSha], root);
      tagCreated = true;
      if (flags["no-push"] !== "true") {
        gitExec(["push", "origin", `refs/tags/${tag}`], root);
      }
    } else if (flags["no-push"] !== "true") {
      gitExec(["push", "origin", `refs/tags/${tag}`], root);
    }

    let githubReleaseCreated = false;
    if (flags["no-push"] !== "true") {
      const releaseAlreadyExists = checkGithubReleaseExists(tag, root, ghExec);
      if (!releaseAlreadyExists) {
        ghExec(["release", "create", tag, "--title", tag, "--notes", notes, "--verify-tag"], root);
        githubReleaseCreated = true;
      }
    }

    let registryAlreadyPublished = false;
    if (flags["skip-registry-check"] !== "true") {
      const stableRegistryVersions = await fetchRegistryVersions(STABLE_REGISTRY_SLUG, {
        root, fetchImpl,
      });
      registryAlreadyPublished = stableRegistryVersions.includes(version);
    }

    const registryNeeded = !registryAlreadyPublished;
    const published = {
      published: registryNeeded,
      registryNeeded,
      registryAlreadyPublished,
      tagCreated,
      githubReleaseCreated,
      resumedFromExistingTag: Boolean(existingTagSha),
      version,
      tag,
      betaVersion: proof.betaVersion,
      betaSha: betaTagSha,
    };
    await writeGithubOutputs(flags["github-output"], {
      published: published.published,
      registry_needed: published.registryNeeded,
      registry_already_published: published.registryAlreadyPublished,
      tag_created: published.tagCreated,
      github_release_created: published.githubReleaseCreated,
      resumed_from_existing_tag: published.resumedFromExistingTag,
      version: published.version,
      tag: published.tag,
      beta_version: published.betaVersion,
      beta_sha: published.betaSha,
    });
    log(JSON.stringify(published));
    return published;
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
