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
export const DEFAULT_PUBLISHER_DID = "did:plc:ekk4pjmkh3k3ql2kfoex3qt4";
export const DEFAULT_REGISTRY_URL = "https://registry.emdashcms.com";
export const DEFAULT_REGISTRY_TIMEOUT_MS = 15_000;
export const PKG_PR_NEW_NOT_INSTALLED_TEXT = "is not installed on or does not have access";

const DEFAULT_FETCH = globalThis.fetch;
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
  const tags = new Set();
  try {
    const out = execFileSync("git", ["tag", "--list"], {
      cwd: root,
      encoding: "utf8",
    });
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) tags.add(trimmed);
    }
  } catch {
    // Ignore local git tag lookup errors.
  }
  return [...tags];
}

export async function readPublisherDid(root = repositoryRoot) {
  const manifestPath = join(root, "emdash-plugin.jsonc");
  if (!existsSync(manifestPath)) return DEFAULT_PUBLISHER_DID;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    return typeof manifest.publisher === "string" && manifest.publisher.trim()
      ? manifest.publisher.trim()
      : DEFAULT_PUBLISHER_DID;
  } catch {
    return DEFAULT_PUBLISHER_DID;
  }
}

export function resolveRegistryUrl(registryUrl) {
  const raw =
    registryUrl ??
    process.env.EMDASH_REGISTRY_URL ??
    DEFAULT_REGISTRY_URL;
  return String(raw).replace(/\/+$/, "");
}

function formatRegistryLookupError(slug, version, reason) {
  const normalizedSlug = String(slug ?? "").trim() || PACKAGE_NAME;
  const normalizedVersion = String(version ?? "").trim().replace(/^v/, "") || "*";
  const detail = String(reason ?? "unknown error").trim() || "unknown error";
  return new Error(
    `Registry lookup failed for ${normalizedSlug}@${normalizedVersion}: ${detail}; refusing to publish with unknown state`,
  );
}

export async function fetchRegistryPackageVersions({
  publisherDid = DEFAULT_PUBLISHER_DID,
  slug,
  version = null,
  registryUrl = resolveRegistryUrl(),
  fetchImpl = globalThis.fetch,
  includeDirectPds,
  pdsClient = null,
  timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
} = {}) {
  if (!slug || !String(slug).trim()) {
    throw new Error("fetchRegistryPackageVersions requires a non-empty plugin slug");
  }
  const versions = new Set();
  const baseUrl = resolveRegistryUrl(registryUrl);
  const shouldQueryDirectPds =
    includeDirectPds !== undefined
      ? Boolean(includeDirectPds)
      : Boolean(pdsClient) ||
        (fetchImpl === DEFAULT_FETCH &&
          baseUrl === DEFAULT_REGISTRY_URL &&
          !process.env.NODE_TEST_CONTEXT);

  if (typeof fetchImpl !== "function" && !pdsClient) {
    throw formatRegistryLookupError(slug, version, "fetch implementation is unavailable");
  }

  if (typeof fetchImpl === "function") {
    let cursor = null;
    const seenCursors = new Set();
    for (let page = 0; page < 100; page += 1) {
      const url = new URL(
        "/xrpc/com.emdashcms.experimental.aggregator.listReleases",
        `${baseUrl}/`,
      );
      url.searchParams.set("did", publisherDid);
      url.searchParams.set("package", slug);
      url.searchParams.set("limit", "100");
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      let response;
      const controller = new AbortController();
      let timeoutId = null;
      let timedOut = false;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(`request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      try {
        response = await Promise.race([
          Promise.resolve().then(() =>
            fetchImpl(url.toString(), {
              headers: { Accept: "application/json" },
              signal: controller.signal,
            }),
          ),
          timeoutPromise,
        ]);
      } catch (error) {
        const reason =
          timedOut || error?.name === "AbortError" || error?.name === "TimeoutError"
            ? `request timed out (${error?.message || `after ${timeoutMs}ms`})`
            : error?.message || String(error);
        throw formatRegistryLookupError(slug, version, reason);
      } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
      }

      if (!response || typeof response !== "object") {
        throw formatRegistryLookupError(slug, version, "invalid empty response from registry");
      }

      const status = Number(response.status ?? (response.ok ? 200 : 0));
      const isOk =
        typeof response.ok === "boolean"
          ? response.ok && status >= 200 && status < 300
          : status >= 200 && status < 300;

      if (!isOk) {
        let errorBody = null;
        let bodyReadFailed = false;
        if (typeof response.json === "function") {
          try {
            errorBody = await response.json();
          } catch {
            bodyReadFailed = true;
          }
        } else if (typeof response.text === "function") {
          try {
            const raw = await response.text();
            errorBody = raw ? JSON.parse(raw) : null;
          } catch {
            bodyReadFailed = true;
          }
        }

        const isDefinitiveNotFound =
          (status === 404 &&
            (!errorBody?.error ||
              errorBody.error === "NotFound" ||
              errorBody.error === "PackageNotFound" ||
              errorBody.error === "RecordNotFound")) ||
          (status === 400 &&
            !bodyReadFailed &&
            (errorBody?.error === "NotFound" ||
              errorBody?.error === "PackageNotFound" ||
              errorBody?.error === "RecordNotFound"));

        if (isDefinitiveNotFound) {
          break;
        }

        const errorCode =
          typeof errorBody?.error === "string" && errorBody.error.trim()
            ? ` (${errorBody.error.trim()})`
            : "";
        throw formatRegistryLookupError(
          slug,
          version,
          `HTTP ${status || "error"}${errorCode}`,
        );
      }

      let data;
      try {
        if (typeof response.json === "function") {
          data = await response.json();
        } else if (typeof response.text === "function") {
          data = JSON.parse(await response.text());
        } else {
          throw new Error("response body reader is unavailable");
        }
      } catch (error) {
        throw formatRegistryLookupError(
          slug,
          version,
          `malformed response body (${error?.message || String(error)})`,
        );
      }

      if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.releases)) {
        throw formatRegistryLookupError(
          slug,
          version,
          "malformed response body (expected object with releases array)",
        );
      }

      if (
        data.cursor !== undefined &&
        data.cursor !== null &&
        typeof data.cursor !== "string"
      ) {
        throw formatRegistryLookupError(
          slug,
          version,
          "malformed response body (invalid cursor)",
        );
      }

      const releases = data.releases;
      for (const entry of releases) {
        const rawVer =
          typeof entry === "string"
            ? entry
            : entry && typeof entry === "object" && typeof entry.version === "string"
              ? entry.version
              : entry &&
                  typeof entry === "object" &&
                  entry.release &&
                  typeof entry.release === "object" &&
                  typeof entry.release.version === "string"
                ? entry.release.version
                : null;
        const normalizedVer = rawVer ? rawVer.trim().replace(/^v/, "") : "";
        if (!normalizedVer || !parseSemver(normalizedVer)) {
          throw formatRegistryLookupError(
            slug,
            version,
            "malformed response body (release entry missing valid semver version)",
          );
        }
        versions.add(normalizedVer);
      }

      const nextCursor =
        typeof data.cursor === "string" && data.cursor.length > 0 ? data.cursor : null;
      if (!nextCursor || releases.length === 0 || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  // Also check publisher PDS records directly so releases that were just published
  // (and may still be awaiting public aggregator indexing) are never missed.
  // Fails closed on network, timeout, non-404 HTTP, or malformed record errors.
  if (shouldQueryDirectPds) {
    try {
      let client = pdsClient;
      if (!client) {
        const { DirectPdsClient } = await import("@emdash-cms/registry-client");
        client = new DirectPdsClient({
          did: publisherDid,
          fetch: fetchImpl,
          requestTimeoutMs: timeoutMs,
        });
      }
      const repo = await client.getPackageRepository(slug);
      if (!repo || typeof repo !== "object" || !Array.isArray(repo.releases)) {
        throw new Error("malformed PDS repository response: missing releases array");
      }
      for (const rel of repo.releases) {
        const rawVer =
          typeof rel?.value?.version === "string"
            ? rel.value.version
            : typeof rel?.version === "string"
              ? rel.version
              : null;
        const normalizedVer = rawVer ? rawVer.trim().replace(/^v/, "") : "";
        if (!normalizedVer || !parseSemver(normalizedVer)) {
          throw new Error("malformed PDS release record: missing valid semver version");
        }
        versions.add(normalizedVer);
      }
    } catch (error) {
      const code = error?.code;
      const status = error?.status;
      if (
        code === "RECORD_NOT_FOUND" ||
        code === "REPOSITORY_NOT_FOUND" ||
        status === 404
      ) {
        // Definitive not-found on the publisher PDS counts as unpublished.
      } else {
        throw formatRegistryLookupError(
          slug,
          version,
          error?.message || String(error),
        );
      }
    }
  }

  return [...versions];
}

export async function hasRegistryVersion({
  publisherDid = DEFAULT_PUBLISHER_DID,
  slug,
  version,
  registryVersions = null,
  registryUrl = resolveRegistryUrl(),
  fetchImpl = globalThis.fetch,
  includeDirectPds,
  pdsClient = null,
  timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
} = {}) {
  const normalizedTarget = String(version ?? "").trim().replace(/^v/, "");
  if (!normalizedTarget || !parseSemver(normalizedTarget)) {
    throw formatRegistryLookupError(
      slug,
      version,
      `invalid target version "${version ?? ""}"`,
    );
  }
  const versions =
    registryVersions !== null
      ? Array.from(registryVersions, (v) => String(v).trim().replace(/^v/, ""))
      : await fetchRegistryPackageVersions({
          publisherDid,
          slug,
          version: normalizedTarget,
          registryUrl,
          fetchImpl,
          includeDirectPds,
          pdsClient,
          timeoutMs,
        });
  return versions.includes(normalizedTarget);
}

export async function hasGithubRelease(
  tag,
  {
    root = repositoryRoot,
    githubReleaseExists = null,
    existingGithubReleases = null,
    repo = process.env.GITHUB_REPOSITORY || "dinkuskit/payments",
    apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (typeof githubReleaseExists === "boolean") {
    return githubReleaseExists;
  }
  if (existingGithubReleases !== null) {
    const normalizedTag = String(tag ?? "").startsWith("v")
      ? String(tag)
      : `v${tag}`;
    const set = new Set(
      Array.from(existingGithubReleases, (item) =>
        String(item).startsWith("v") ? String(item) : `v${item}`,
      ),
    );
    return set.has(normalizedTag);
  }
  if (fetchImpl !== DEFAULT_FETCH && typeof fetchImpl === "function") {
    const headers = { Accept: "application/vnd.github+json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(
      `${String(apiUrl).replace(/\/+$/, "")}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { headers },
    );
    return Boolean(response?.ok);
  }
  try {
    execFileSync("gh", ["release", "view", tag], {
      cwd: root,
      stdio: "ignore",
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

export function computeNextBetaNumber(
  nextStableVersion,
  existingTags = [],
  registryVersions = [],
) {
  let tagsInput = existingTags;
  let registryInput = registryVersions;
  if (
    existingTags &&
    typeof existingTags === "object" &&
    !Array.isArray(existingTags) &&
    !(existingTags instanceof Set)
  ) {
    tagsInput = existingTags.existingTags ?? [];
    registryInput =
      existingTags.registryVersions ??
      existingTags.existingRegistryVersions ??
      existingTags.registryBetaVersions ??
      [];
  }

  const normalizedStable = String(nextStableVersion ?? "").trim().replace(/^v/, "");
  const prefix = `${normalizedStable}-beta.`;
  let maxBeta = -1;

  for (const candidate of [...(tagsInput ?? []), ...(registryInput ?? [])]) {
    const normalized = String(candidate ?? "").trim().replace(/^v/, "");
    if (!normalized.startsWith(prefix)) continue;
    const suffix = normalized.slice(prefix.length);
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
  githubReleaseExists = null,
  releaseExists = null,
  existingGithubReleases = null,
  registryPublished = null,
  registryReleaseExists = null,
  registryExists = null,
  registryStableVersions = null,
  registryBetaVersions = null,
  existingRegistryVersions = null,
  registryVersions = null,
  registryUrl = resolveRegistryUrl(),
  fetchImpl = globalThis.fetch,
  includeDirectPds,
  pdsClient = null,
  timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
} = {}) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const currentVersion = pkg.version;
  const parsedCurrent = parseSemver(currentVersion);
  if (!parsedCurrent) {
    throw new Error(`Invalid package.json version: ${currentVersion}`);
  }
  const publisherDid = await readPublisherDid(root);
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
    const preliminaryBeta = computeNextBetaNumber(nextVersion, tags, []);
    const providedBetaVersions =
      registryBetaVersions ?? existingRegistryVersions ?? registryVersions;
    const betaVersionsOnRegistry =
      providedBetaVersions !== null
        ? Array.from(providedBetaVersions)
        : await fetchRegistryPackageVersions({
            publisherDid,
            slug: BETA_PLUGIN_SLUG,
            version: `${nextVersion}-beta.${preliminaryBeta}`,
            registryUrl,
            fetchImpl,
            includeDirectPds,
            pdsClient,
            timeoutMs,
          });
    const betaNumber = computeNextBetaNumber(
      nextVersion,
      tags,
      betaVersionsOnRegistry,
    );
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
  const tagExists = tagSet.has(releaseTag) || tagSet.has(currentVersion);

  const explicitRegistryPublished =
    registryPublished ?? registryReleaseExists ?? registryExists;
  const providedStableRegistryVersions =
    registryStableVersions ?? existingRegistryVersions ?? registryVersions;
  const registryPresent =
    typeof explicitRegistryPublished === "boolean"
      ? explicitRegistryPublished
      : providedStableRegistryVersions !== null
        ? await hasRegistryVersion({
            publisherDid,
            slug: STABLE_PLUGIN_SLUG,
            version: currentVersion,
            registryVersions: providedStableRegistryVersions,
          })
        : await hasRegistryVersion({
            publisherDid,
            slug: STABLE_PLUGIN_SLUG,
            version: currentVersion,
            registryUrl,
            fetchImpl,
            includeDirectPds,
            pdsClient,
            timeoutMs,
          });

  const explicitGhRelease =
    githubReleaseExists ?? releaseExists;
  const ghReleasePresent =
    typeof explicitGhRelease === "boolean"
      ? explicitGhRelease
      : existingGithubReleases !== null
        ? await hasGithubRelease(releaseTag, { existingGithubReleases })
        : await hasGithubRelease(releaseTag, { root, fetchImpl });

  const missingSteps = [];
  if (!tagExists) missingSteps.push("tag");
  if (!ghReleasePresent) missingSteps.push("github-release");
  if (!registryPresent) missingSteps.push("registry");

  if (missingSteps.length === 0) {
    return {
      mode: "noop",
      reason: "release-complete",
      currentVersion,
      tag: releaseTag,
      pluginSlug: STABLE_PLUGIN_SLUG,
      tagExists: true,
      githubReleaseExists: true,
      releaseExists: true,
      registryPublished: true,
      registryExists: true,
      missingSteps: [],
      changesetCount: 0,
    };
  }

  const reason = !tagExists
    ? "release-pr-merged-untagged"
    : !ghReleasePresent
      ? "resume-after-tag"
      : "resume-after-github-release";

  return {
    mode: "publish",
    reason,
    currentVersion,
    tag: releaseTag,
    pluginSlug: STABLE_PLUGIN_SLUG,
    tagExists,
    githubReleaseExists: ghReleasePresent,
    releaseExists: ghReleasePresent,
    registryPublished: registryPresent,
    registryExists: registryPresent,
    missingSteps,
    changesetCount: 0,
  };
}

export async function prepareBetaBuild({
  root = repositoryRoot,
  betaSlug = BETA_PLUGIN_SLUG,
  betaName = BETA_PLUGIN_NAME,
  betaVersion = null,
  existingTags = null,
  registryBetaVersions = null,
  existingRegistryVersions = null,
  registryVersions = null,
  registryUrl = resolveRegistryUrl(),
  fetchImpl = globalThis.fetch,
  includeDirectPds,
  pdsClient = null,
  timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
} = {}) {
  if (!/^[a-z][a-z0-9_-]*$/.test(betaSlug) || betaSlug === STABLE_PLUGIN_SLUG) {
    throw new Error(
      `Beta plugin slug must be a valid distinct slug (not "${STABLE_PLUGIN_SLUG}"), got "${betaSlug}"`,
    );
  }
  const providedBetaVersions =
    registryBetaVersions ?? existingRegistryVersions ?? registryVersions;
  const resolvedBetaVersion =
    betaVersion ??
    (
      await inspectReleaseState({
        root,
        existingTags,
        registryBetaVersions: providedBetaVersions,
        registryUrl,
        fetchImpl,
        includeDirectPds,
        pdsClient,
        timeoutMs,
      })
    ).nextBetaVersion;
  const parsedBeta = parseSemver(resolvedBetaVersion);
  if (!parsedBeta || !parsedBeta.prerelease || !parsedBeta.prerelease.startsWith("beta.")) {
    throw new Error(
      `Beta build version must be an x.y.z-beta.N prerelease version, got "${resolvedBetaVersion}"`,
    );
  }

  const publisherDid = await readPublisherDid(root);
  if (betaVersion !== null && providedBetaVersions === null) {
    await hasRegistryVersion({
      publisherDid,
      slug: betaSlug,
      version: resolvedBetaVersion,
      registryUrl,
      fetchImpl,
      includeDirectPds,
      pdsClient,
      timeoutMs,
    });
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

export function classifyPreviewPublishResult({
  exitCode = 0,
  status = null,
  stdout = "",
  stderr = "",
  output = "",
} = {}) {
  const code = status !== null && status !== undefined ? Number(status) : Number(exitCode ?? 0);
  const combined = [output, stdout, stderr].filter(Boolean).join("\n");
  if (code === 0) {
    return {
      ok: true,
      skippedMissingApp: false,
      appInstalled: true,
      exitCode: 0,
      notice: null,
    };
  }
  if (combined.includes(PKG_PR_NEW_NOT_INSTALLED_TEXT)) {
    return {
      ok: true,
      skippedMissingApp: true,
      appInstalled: false,
      exitCode: 0,
      notice:
        "The pkg-pr-new GitHub App is not installed on or does not have access to this repository; install https://github.com/apps/pkg-pr-new to enable PR preview packages.",
    };
  }
  return {
    ok: false,
    skippedMissingApp: false,
    appInstalled: true,
    exitCode: code || 1,
    notice: null,
  };
}

export const evaluatePreviewPublish = classifyPreviewPublishResult;

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
      tag_exists: String(Boolean(state.tagExists)),
      github_release_exists: String(Boolean(state.githubReleaseExists)),
      registry_published: String(Boolean(state.registryPublished)),
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

  if (command === "check-registry") {
    const slugIdx = args.indexOf("--slug");
    const versionIdx = args.indexOf("--version");
    const slug = slugIdx !== -1 && args[slugIdx + 1] ? args[slugIdx + 1] : STABLE_PLUGIN_SLUG;
    const pkg = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    const version = versionIdx !== -1 && args[versionIdx + 1] ? args[versionIdx + 1] : pkg.version;
    const publisherDid = await readPublisherDid(repositoryRoot);
    const exists = await hasRegistryVersion({
      publisherDid,
      slug,
      version,
    });
    writeGithubOutputs({
      exists: String(exists),
      already_published: String(exists),
    });
    console.log(JSON.stringify({ slug, version, exists, alreadyPublished: exists }));
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

  if (command === "evaluate-preview") {
    const codeIdx = args.indexOf("--exit-code");
    const exitCode =
      codeIdx !== -1 && args[codeIdx + 1] !== undefined
        ? Number(args[codeIdx + 1])
        : Number(process.env.PREVIEW_EXIT_CODE ?? 0);
    const output = process.env.PREVIEW_OUTPUT ?? "";
    const evaluation = classifyPreviewPublishResult({ exitCode, output });
    if (evaluation.notice) {
      console.log(`::notice::${evaluation.notice}`);
    }
    process.exitCode = evaluation.exitCode;
    return;
  }

  console.error(
    "Usage: node scripts/release-flow.mjs <check-pr [--base <ref>] | inspect | prepare-beta [--slug <slug>] [--version <ver>] | check-registry [--slug <slug>] [--version <ver>] | release-notes [--version <ver>] [--out <file>] | evaluate-preview [--exit-code <code>]>",
  );
  process.exitCode = 64;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
