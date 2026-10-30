import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile, appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDelegatedReleaseSourceRecord } from "@emdash-cms/registry-client/release-service";
import { validatePluginBundle } from "@emdash-cms/registry-verification/bundle";
import { computePackageChecksum } from "../.github/scripts/verify-registry-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = "com.emdashcms.experimental.package.releaseExtension";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function runGh(args) {
  return execFileSync("gh", args, { maxBuffer: 6 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function createSourceRelease({ slug, version, repository, workflowRef, packageArtifact, provenanceArtifact, declaredAccess, images, requires }) {
  const release = {
    $type: "com.emdashcms.experimental.package.release",
    package: slug,
    version,
    repo: `https://github.com/${repository}`,
    ...(requires ? { requires } : {}),
    artifacts: { package: packageArtifact, ...images },
    extensions: {
      [EXTENSION]: {
        $type: EXTENSION,
        declaredAccess,
        provenance: {
          url: provenanceArtifact.url,
          checksum: provenanceArtifact.checksum,
          predicateType: "https://slsa.dev/provenance/v1",
          sourceRepository: `https://github.com/${repository}`,
          builderId: `https://github.com/${workflowRef}`,
        },
      },
    },
  };
  if (!parseDelegatedReleaseSourceRecord(release, { packageSlug: slug, version })) {
    throw new Error("Invalid delegated media release record");
  }
  return release;
}

export async function ensureReleaseAsset({ repository, tag, name, path, bytes, gh = runGh }) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Invalid release asset name");
  const find = () => {
    const release = JSON.parse(gh(["api", `repos/${repository}/releases/tags/${tag}`]).toString());
    const assets = (release.assets ?? []).filter((asset) => asset.name === name);
    if (assets.length > 1) throw new Error("Duplicate release asset names");
    return assets[0];
  };
  const verify = (asset) => {
    if (!Number.isSafeInteger(asset?.id) || !String(asset.browser_download_url).startsWith(`https://github.com/${repository}/releases/download/${tag}/`)) {
      throw new Error("Unexpected release asset identity");
    }
    const remote = gh(["api", `repos/${repository}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"]);
    if (remote.length !== bytes.length || sha256(remote) !== sha256(bytes)) {
      throw new Error(`Release asset conflict: ${name}; existing bytes are never replaced`);
    }
    return { url: asset.browser_download_url, checksum: computePackageChecksum(bytes), releaseAsset: true };
  };
  const existing = find();
  if (existing) return verify(existing);
  const uploadDirectory = await mkdtemp(join(tmpdir(), "payments-release-asset-"));
  try {
    // Use the verified bytes and the desired basename, not gh's #label syntax.
    const uploadPath = join(uploadDirectory, name);
    await writeFile(uploadPath, bytes);
    // No --clobber: a competing upload cannot replace an existing artifact.
    gh(["release", "upload", tag, uploadPath, "--repo", repository]);
  } catch {
    const raced = find();
    if (raced) return verify(raced);
    throw new Error(`Release asset upload failed: ${name}`);
  } finally {
    await rm(uploadDirectory, { recursive: true, force: true });
  }
  const uploaded = find();
  if (!uploaded) throw new Error("Uploaded release asset not found");
  return verify(uploaded);
}

export function ensureGithubRelease({ repository, tag, beta, gh = runGh }) {
  try {
    gh(["api", `repos/${repository}/releases/tags/${tag}`]);
    return;
  } catch (error) {
    if (!String(error.stderr ?? error.message).includes("HTTP 404")) {
      throw new Error("Could not read the GitHub release");
    }
  }
  if (!beta) throw new Error("Stable GitHub release must exist after the release-tag gate");
  try {
    gh(["release", "create", tag, "--repo", repository, "--verify-tag", "--prerelease", "--latest=false", "--title", tag, "--notes", "Prerelease artifacts for the EmDash Registry."]);
  } catch {
    // A concurrent same-tag run may have created it. Do not alter it.
    try { gh(["api", `repos/${repository}/releases/tags/${tag}`]); }
    catch { throw new Error("Could not create the beta GitHub release"); }
  }
}

async function boundedFile(root, path, maximum) {
  const base = await realpath(root);
  const file = await realpath(resolve(root, path));
  const rel = relative(base, file);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Artifact path leaves its allowed root");
  const size = (await stat(file)).size;
  if (size < 1 || size > maximum) throw new Error("Artifact size is outside the supported range");
  const bytes = await readFile(file);
  if (bytes.length !== size) throw new Error("Artifact changed during read");
  return { path: file, bytes };
}

function imageType(path, bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error(`Unsupported image bytes: ${basename(path)}`);
}

export async function prepareMediaRelease({ root = ROOT, bundleFile, provenanceFile, runnerTemp, manifestFile, repository, sha, ref, workflowRef, outputFile, githubOutput, gh = runGh, validateBundle = validatePluginBundle }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("Invalid source repository or commit");
  if (!workflowRef?.startsWith(`${repository}/.github/workflows/`) || !workflowRef.endsWith(`@${ref}`)) throw new Error("Unexpected attested workflow identity");
  const config = JSON.parse((await boundedFile(root, manifestFile, 128 * 1024)).bytes);
  const version = config.version;
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version) || ref !== `refs/tags/v${version}`) throw new Error("Release version does not match the gated tag");
  const beta = version.includes("-beta.");
  if (config.slug !== (beta ? "dinkus-payments-beta" : "dinkus-payments")) throw new Error("Unexpected Payments listing identity");
  if (config.repo !== `https://github.com/${repository}`) throw new Error("Manifest repository differs from the workflow");
  const bundle = await boundedFile(root, bundleFile, 256 * 1024);
  const provenance = await boundedFile(runnerTemp, provenanceFile, 5 * 1024 * 1024);
  const checked = await validateBundle(new Uint8Array(bundle.bytes));
  if (!checked.success || checked.value.manifest.id !== config.slug || checked.value.manifest.version !== version) throw new Error("Prepared bundle identity is invalid");
  const images = {};
  for (const kind of ["icon", "banner", "screenshots"]) {
    const entries = kind === "screenshots" ? (config.release?.artifacts?.screenshots ?? []) : (config.release?.artifacts?.[kind] ? [config.release.artifacts[kind]] : []);
    const resolved = [];
    for (const entry of entries) {
      const image = await boundedFile(root, entry.file, 1024 * 1024);
      const path = relative(await realpath(root), image.path).split("/").map(encodeURIComponent).join("/");
      resolved.push({ url: `https://raw.githubusercontent.com/${repository}/${sha}/${path}`, checksum: computePackageChecksum(image.bytes), contentType: imageType(image.path, image.bytes), ...(entry.lang ? { lang: entry.lang } : {}) });
    }
    if (resolved.length) images[kind] = kind === "screenshots" ? resolved : resolved[0];
  }
  // All local inputs are validated before any GitHub mutation.
  const template = { slug: config.slug, version, repository, workflowRef, declaredAccess: checked.value.declaredAccess, images, requires: config.release?.requires };
  createSourceRelease({ ...template, packageArtifact: { url: `https://github.com/${repository}/releases/download/v${version}/bundle.tar.gz`, checksum: computePackageChecksum(bundle.bytes), contentType: "application/gzip" }, provenanceArtifact: { url: `https://github.com/${repository}/releases/download/v${version}/provenance.json`, checksum: computePackageChecksum(provenance.bytes) } });
  const tag = `v${version}`;
  ensureGithubRelease({ repository, tag, beta, gh });
  const packageArtifact = await ensureReleaseAsset({ repository, tag, name: `${config.slug}-${version}.tar.gz`, ...bundle, gh });
  const provenanceArtifact = await ensureReleaseAsset({ repository, tag, name: `${config.slug}-${version}-provenance-${sha256(provenance.bytes)}.json`, ...provenance, gh });
  const release = createSourceRelease({ ...template, packageArtifact: { ...packageArtifact, contentType: "application/gzip" }, provenanceArtifact });
  await writeFile(resolve(root, outputFile), `${JSON.stringify(release, null, 2)}\n`);
  if (githubOutput) await appendFile(githubOutput, `release-file=${outputFile}\n`);
  return release;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    if (!key?.startsWith("--") || !process.argv[i + 1]) throw new Error("Expected named arguments");
    options[key.slice(2)] = process.argv[i + 1];
  }
  await prepareMediaRelease({ bundleFile: options["bundle-file"], provenanceFile: options["provenance-file"], manifestFile: ".emdash-release/emdash-plugin.jsonc", runnerTemp: process.env.RUNNER_TEMP, repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF, workflowRef: process.env.GITHUB_WORKFLOW_REF, outputFile: ".emdash-release/release.json", githubOutput: process.env.GITHUB_OUTPUT });
}
