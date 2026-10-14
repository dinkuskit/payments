#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "..");

export const PACKAGE_NAME = "@dinkuskit/payments";
export const STABLE_PLUGIN_SLUG = "dinkus-payments";
export const BETA_PLUGIN_SLUG = "dinkus-payments-beta";
export const BETA_PLUGIN_NAME = "DinkusKit Payments (Beta)";
export const MIN_TAGGED_VERSION = "0.2.0";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export async function deriveRegistryPluginId(publisherDid, slug) {
  const did = String(publisherDid ?? "").trim();
  const s = String(slug ?? "").trim();
  if (!did || !s) {
    throw new Error("deriveRegistryPluginId requires non-empty publisherDid and slug");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${did}\n${s}`),
  );
  return `r_${base32Encode(new Uint8Array(digest)).slice(0, 16)}`;
}

export function parseSemver(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/.exec(
      String(version ?? ""),
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function compareCoreSemver(a, b) {
  const parsedA = typeof a === "string" ? parseSemver(a) : a;
  const parsedB = typeof b === "string" ? parseSemver(b) : b;
  if (!parsedA || !parsedB) {
    throw new Error("compareCoreSemver requires valid semver strings");
  }
  if (parsedA.major !== parsedB.major) return parsedA.major - parsedB.major;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor - parsedB.minor;
  return parsedA.patch - parsedB.patch;
}

export function computeNextStableVersion(currentVersion, bump) {
  const parsed = parseSemver(currentVersion);
  if (!parsed) {
    throw new Error(`Invalid current version in package.json: ${currentVersion}`);
  }
  if (bump === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  if (bump === "patch") {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
  if (bump === "major") {
    if (parsed.major === 0) {
      throw new Error("0.x release policy forbids major bumps (fixes = patch, everything else = minor)");
    }
    return `${parsed.major + 1}.0.0`;
  }
  throw new Error(`Unsupported version bump: ${bump}`);
}

export function parseChangesetFile(content, filename = ".changeset/unknown.md") {
  const normalized = String(content ?? "").replace(/\r\n/g, "\n");
  const match = /^---\n(?:([\s\S]*?)\n)?---\s*(?:\n([\s\S]*))?$/.exec(normalized);
  if (!match) {
    throw new Error(`${filename}: missing valid YAML frontmatter delimited by ---`);
  }
  const frontmatter = (match[1] ?? "").trim();
  const summary = (match[2] ?? "").trim();
  if (!frontmatter) {
    return { empty: true, bumps: {}, summary };
  }
  const bumps = {};
  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const entryMatch = /^["']?([^"':]+)["']?\s*:\s*["']?(patch|minor|major)["']?$/.exec(line);
    if (!entryMatch) {
      throw new Error(
        `${filename}: invalid changeset frontmatter line "${line}" (expected '"${PACKAGE_NAME}": patch | minor')`,
      );
    }
    const [, pkg, bump] = entryMatch;
    bumps[pkg] = bump;
  }
  if (Object.keys(bumps).length === 0) {
    return { empty: true, bumps: {}, summary };
  }
  return { empty: false, bumps, summary };
}

export async function listChangesetFiles(root = repositoryRoot) {
  const dir = join(root, ".changeset");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => `.changeset/${entry.name}`)
    .sort();
}

export async function validatePrChangesets({
  root = repositoryRoot,
  changedFiles = null,
  headRef = process.env.GITHUB_HEAD_REF ?? "",
} = {}) {
  // Automated Changesets release PRs consume .changeset/*.md files into CHANGELOG.md and package.json.
  if (headRef.startsWith("changeset-release/")) {
    return { ok: true, skippedReleasePr: true, files: [], errors: [] };
  }

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const parsedVersion = parseSemver(pkg.version);
  const errors = [];
  if (!parsedVersion) {
    errors.push(`package.json version "${pkg.version}" is not valid semver`);
  }

  const candidateFiles =
    changedFiles !== null
      ? changedFiles
          .map((file) => file.replace(/\\/g, "/"))
          .filter(
            (file) =>
              file.startsWith(".changeset/") &&
              file.endsWith(".md") &&
              file !== ".changeset/README.md" &&
              existsSync(join(root, file)),
          )
          .sort()
      : await listChangesetFiles(root);

  if (candidateFiles.length === 0) {
    errors.push(
      "Missing changeset: every PR must add a .changeset/*.md file declaring patch (fixes) or minor (everything else), or an explicit empty changeset (`npx changeset --empty`).",
    );
    return { ok: false, skippedReleasePr: false, files: [], errors };
  }

  for (const relPath of candidateFiles) {
    const content = await readFile(join(root, relPath), "utf8");
    let parsed;
    try {
      parsed = parseChangesetFile(content, relPath);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (parsed.empty) {
      continue;
    }
    const packages = Object.keys(parsed.bumps);
    for (const name of packages) {
      if (name !== PACKAGE_NAME) {
        errors.push(`${relPath}: unexpected package "${name}" (expected "${PACKAGE_NAME}")`);
      }
    }
    const bump = parsed.bumps[PACKAGE_NAME];
    if (!bump) {
      errors.push(`${relPath}: non-empty changeset must declare a bump for "${PACKAGE_NAME}"`);
      continue;
    }
    if (parsedVersion && parsedVersion.major === 0 && bump === "major") {
      errors.push(
        `${relPath}: "major" bump is not allowed while ${PACKAGE_NAME} is in 0.x (policy: fixes = patch, everything else = minor)`,
      );
    }
    if (!parsed.summary) {
      errors.push(`${relPath}: changeset must include a non-empty summary description`);
    }
  }

  return {
    ok: errors.length === 0,
    skippedReleasePr: false,
    files: candidateFiles,
    errors,
  };
}

export function listGitTags(root = repositoryRoot) {
  try {
    const out = execFileSync("git", ["tag", "--list"], {
      cwd: root,
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function computeNextBetaNumber(nextStableVersion, existingTags = []) {
  const prefix = `v${nextStableVersion}-beta.`;
  let maxBeta = -1;
  for (const tag of existingTags) {
    if (!tag.startsWith(prefix)) continue;
    const suffix = tag.slice(prefix.length);
    if (/^(0|[1-9]\d*)$/.test(suffix)) {
      const n = Number(suffix);
      if (n > maxBeta) maxBeta = n;
    }
  }
  return maxBeta + 1;
}

export async function inspectReleaseState({
  root = repositoryRoot,
  existingTags = null,
} = {}) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const currentVersion = pkg.version;
  const parsedCurrent = parseSemver(currentVersion);
  if (!parsedCurrent) {
    throw new Error(`Invalid package.json version: ${currentVersion}`);
  }
  const tags = existingTags ?? listGitTags(root);
  const tagSet = new Set(tags);
  const changesetFiles = await listChangesetFiles(root);

  let highestBump = null;
  for (const relPath of changesetFiles) {
    const content = await readFile(join(root, relPath), "utf8");
    const parsed = parseChangesetFile(content, relPath);
    if (parsed.empty) continue;
    const bump = parsed.bumps[PACKAGE_NAME];
    if (!bump) continue;
    if (parsedCurrent.major === 0 && bump === "major") {
      throw new Error(
        `${relPath}: major bump is forbidden in 0.x (fixes = patch, everything else = minor)`,
      );
    }
    if (bump === "major") {
      highestBump = "major";
    } else if (bump === "minor" && highestBump !== "major") {
      highestBump = "minor";
    } else if (bump === "patch" && !highestBump) {
      highestBump = "patch";
    }
  }

  if (highestBump) {
    const nextVersion = computeNextStableVersion(currentVersion, highestBump);
    const betaNumber = computeNextBetaNumber(nextVersion, tags);
    const nextBetaVersion = `${nextVersion}-beta.${betaNumber}`;
    return {
      mode: "beta_and_pr",
      reason: "pending-changesets",
      currentVersion,
      bump: highestBump,
      nextVersion,
      betaNumber,
      nextBetaVersion,
      betaTag: `v${nextBetaVersion}`,
      betaPluginSlug: BETA_PLUGIN_SLUG,
      changesetCount: changesetFiles.length,
    };
  }

  if (changesetFiles.length > 0) {
    return {
      mode: "noop",
      reason: "empty-changesets-only",
      currentVersion,
      tag: `v${currentVersion}`,
      changesetCount: changesetFiles.length,
    };
  }

  if (parsedCurrent.prerelease) {
    return {
      mode: "noop",
      reason: "prerelease-version-in-package-json",
      currentVersion,
      tag: `v${currentVersion}`,
      changesetCount: 0,
    };
  }

  if (compareCoreSemver(currentVersion, MIN_TAGGED_VERSION) < 0) {
    return {
      mode: "noop",
      reason: "pre-0.2.0-untagged",
      currentVersion,
      tag: `v${currentVersion}`,
      changesetCount: 0,
    };
  }

  const releaseTag = `v${currentVersion}`;
  if (tagSet.has(releaseTag)) {
    return {
      mode: "noop",
      reason: "tag-already-exists",
      currentVersion,
      tag: releaseTag,
      changesetCount: 0,
    };
  }

  return {
    mode: "publish",
    reason: "release-pr-merged-untagged",
    currentVersion,
    tag: releaseTag,
    pluginSlug: STABLE_PLUGIN_SLUG,
    changesetCount: 0,
  };
}

export async function prepareBetaBuild({
  root = repositoryRoot,
  betaSlug = BETA_PLUGIN_SLUG,
  betaName = BETA_PLUGIN_NAME,
  betaVersion = null,
  existingTags = null,
} = {}) {
  if (!/^[a-z][a-z0-9_-]*$/.test(betaSlug) || betaSlug === STABLE_PLUGIN_SLUG) {
    throw new Error(
      `Beta plugin slug must be a valid distinct slug (not "${STABLE_PLUGIN_SLUG}"), got "${betaSlug}"`,
    );
  }
  const resolvedBetaVersion =
    betaVersion ?? (await inspectReleaseState({ root, existingTags })).nextBetaVersion;
  const parsedBeta = parseSemver(resolvedBetaVersion);
  if (!parsedBeta || !parsedBeta.prerelease || !parsedBeta.prerelease.startsWith("beta.")) {
    throw new Error(
      `Beta build version must be an x.y.z-beta.N prerelease version, got "${resolvedBetaVersion}"`,
    );
  }

  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  if (pkg.dinkuskit?.pluginId !== STABLE_PLUGIN_SLUG) {
    throw new Error(
      `package.json dinkuskit.pluginId must remain "${STABLE_PLUGIN_SLUG}" (got "${pkg.dinkuskit?.pluginId}")`,
    );
  }
  // Set package.json version in the ephemeral build tree so emdash-plugin resolves the beta version,
  // while keeping package.json#dinkuskit.pluginId untouched as the stable id.
  pkg.version = resolvedBetaVersion;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const manifestPath = join(root, "emdash-plugin.jsonc");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.slug = betaSlug;
  manifest.name = betaName;
  delete manifest.version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const installedPluginId = await deriveRegistryPluginId(manifest.publisher, betaSlug);
  const identityPath = join(root, "src/registry/identity.ts");
  if (existsSync(identityPath)) {
    const identitySource = `export const registryInstallationIdentity = Object.freeze({\n  publisherDid: ${JSON.stringify(manifest.publisher)},\n  slug: ${JSON.stringify(betaSlug)},\n  installedPluginId: ${JSON.stringify(installedPluginId)},\n});\n\n`;
    await writeFile(identityPath, identitySource, "utf8");
  }

  return {
    betaSlug,
    betaName,
    betaVersion: resolvedBetaVersion,
    betaTag: `v${resolvedBetaVersion}`,
    installedPluginId,
    stablePackagePluginId: pkg.dinkuskit.pluginId,
  };
}

export function extractChangelogSection(changelogContent, version) {
  const normalized = String(changelogContent ?? "").replace(/\r\n/g, "\n");
  const escapedVersion = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^##\\s+v?${escapedVersion}\\b.*$`, "m");
  const match = headingRe.exec(normalized);
  if (!match) {
    return `Release v${version} of ${PACKAGE_NAME}.`;
  }
  const start = match.index + match[0].length;
  const rest = normalized.slice(start);
  const nextHeading = /^##\s+/m.exec(rest);
  const body = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
  return body || `Release v${version} of ${PACKAGE_NAME}.`;
}

function writeGithubOutputs(outputs, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value ?? ""}`);
  execFileSync("sh", ["-c", "cat >> \"$1\"", "--", outputPath], {
    input: `${lines.join("\n")}\n`,
  });
}

async function runCli(argv) {
  const [command, ...args] = argv;
  if (command === "check-pr") {
    let changedFiles = null;
    const baseIndex = args.indexOf("--base");
    if (baseIndex !== -1 && args[baseIndex + 1]) {
      const baseRef = args[baseIndex + 1];
      const diffOut = execFileSync(
        "git",
        ["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      changedFiles = diffOut
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    }
    const result = await validatePrChangesets({ root: repositoryRoot, changedFiles });
    if (!result.ok) {
      for (const err of result.errors) console.error(err);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result));
    return;
  }

  if (command === "inspect") {
    const state = await inspectReleaseState({ root: repositoryRoot });
    writeGithubOutputs({
      mode: state.mode,
      reason: state.reason,
      current_version: state.currentVersion,
      next_version: state.nextVersion ?? "",
      next_beta_version: state.nextBetaVersion ?? "",
      beta_tag: state.betaTag ?? "",
      beta_plugin_slug: state.betaPluginSlug ?? "",
      tag: state.tag ?? "",
    });
    console.log(JSON.stringify(state));
    return;
  }

  if (command === "prepare-beta") {
    const slugIdx = args.indexOf("--slug");
    const versionIdx = args.indexOf("--version");
    const betaSlug = slugIdx !== -1 && args[slugIdx + 1] ? args[slugIdx + 1] : BETA_PLUGIN_SLUG;
    const betaVersion = versionIdx !== -1 && args[versionIdx + 1] ? args[versionIdx + 1] : null;
    const prepared = await prepareBetaBuild({
      root: repositoryRoot,
      betaSlug,
      betaVersion,
    });
    writeGithubOutputs({
      beta_slug: prepared.betaSlug,
      beta_version: prepared.betaVersion,
      beta_tag: prepared.betaTag,
      installed_plugin_id: prepared.installedPluginId,
    });
    console.log(JSON.stringify(prepared));
    return;
  }

  if (command === "release-notes") {
    const versionIdx = args.indexOf("--version");
    const outIdx = args.indexOf("--out");
    const pkg = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    const version = versionIdx !== -1 && args[versionIdx + 1] ? args[versionIdx + 1] : pkg.version;
    const changelogPath = join(repositoryRoot, "CHANGELOG.md");
    const changelogContent = existsSync(changelogPath)
      ? await readFile(changelogPath, "utf8")
      : "";
    const notes = extractChangelogSection(changelogContent, version);
    if (outIdx !== -1 && args[outIdx + 1]) {
      await writeFile(resolve(repositoryRoot, args[outIdx + 1]), `${notes}\n`, "utf8");
    } else {
      process.stdout.write(`${notes}\n`);
    }
    return;
  }

  console.error(
    "Usage: node scripts/release-flow.mjs <check-pr [--base <ref>] | inspect | prepare-beta [--slug <slug>] [--version <ver>] | release-notes [--version <ver>] [--out <file>]>",
  );
  process.exitCode = 64;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2));
}
