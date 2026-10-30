import { appendFile, copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_SCREENSHOTS = 8;
const SLUGS = { stable: "dinkus-payments", beta: "dinkus-payments-beta" };

async function boundedFile(root, path, maximum) {
  const base = await realpath(root);
  const file = await realpath(resolve(root, path));
  const rel = relative(base, file);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Artifact path leaves its allowed root");
  const size = (await stat(file)).size;
  if (size < 1 || size > maximum) throw new Error("Artifact size is outside the supported range");
  const bytes = await readFile(file);
  if (bytes.length !== size) throw new Error("Artifact changed during read");
  return { path: file, rel, bytes };
}

function checkImage(path, bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return;
  throw new Error(`Unsupported image bytes: ${path}`);
}

// The pinned release-action (emdash-cms/emdash#4467) uploads release.artifacts images named
// by emdash-plugin.jsonc in its plugin-directory, relative to that manifest. The prepared
// manifest in .emdash-release carries the gated slug and version, so its images are copied
// beside it at the same relative paths, after the same checks the Action applies.
export async function prepareListingMedia({ root = ROOT, manifestFile, ref, githubOutput }) {
  const manifestPath = resolve(root, manifestFile);
  const listingDirectory = dirname(manifestPath);
  const config = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = config.version;
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version) || ref !== `refs/tags/v${version}`) throw new Error("Release version does not match the gated tag");
  if (config.slug !== (version.includes("-beta.") ? SLUGS.beta : SLUGS.stable)) throw new Error("Unexpected Payments listing identity");
  const artifacts = config.release?.artifacts ?? {};
  const screenshots = artifacts.screenshots ?? [];
  if (!Array.isArray(screenshots) || screenshots.length > MAX_SCREENSHOTS) throw new Error("Too many listing screenshots");
  const entries = [artifacts.icon, artifacts.banner, ...screenshots].filter(Boolean);
  // Every image is read and checked before anything is copied.
  const images = [];
  for (const entry of entries) {
    const image = await boundedFile(root, entry.file, MAX_IMAGE_BYTES);
    checkImage(image.rel, image.bytes);
    if (relative(listingDirectory, resolve(listingDirectory, entry.file)).startsWith("..")) throw new Error("Listing image path leaves the manifest directory");
    images.push({ from: image.path, to: resolve(listingDirectory, entry.file) });
  }
  for (const { from, to } of images) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  const pluginDirectory = relative(root, listingDirectory);
  if (githubOutput) await appendFile(githubOutput, `plugin-directory=${pluginDirectory}\n`);
  return { pluginDirectory, images: images.map(({ to }) => relative(root, to)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareListingMedia({ manifestFile: ".emdash-release/emdash-plugin.jsonc", ref: process.env.GITHUB_REF, githubOutput: process.env.GITHUB_OUTPUT });
}
