import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PLUGIN_BYTES = 131_072;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const STABLE_SLUG = "dinkus-payments";
const STABLE_NAME = "DinkusKit Payments";
const BETA_SLUG = "dinkus-payments-beta";
const BETA_NAME = "DinkusKit Payments (Beta)";

function parseArgs(argv) {
  const options = {
    outDir: "dist/emdash-release",
    version: undefined,
    slug: undefined,
    name: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      options.outDir = argv[index + 1] ?? options.outDir;
      index += 1;
    } else if (arg.startsWith("--out-dir=")) {
      options.outDir = arg.slice("--out-dir=".length);
    } else if (arg === "--version") {
      options.version = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--slug") {
      options.slug = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--slug=")) {
      options.slug = arg.slice("--slug=".length);
    } else if (arg === "--name") {
      options.name = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--name=")) {
      options.name = arg.slice("--name=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { outDir, version: requestedVersion, slug: requestedSlug, name: requestedName } = parseArgs(process.argv.slice(2));
const releaseDir = resolve(rootDir, outDir);

const rootPackage = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
const pluginConfig = JSON.parse(await readFile(resolve(rootDir, "emdash-plugin.jsonc"), "utf8"));

const builtPluginPath = resolve(rootDir, "dist/sandbox/plugin.mjs");
const builtManifestPath = resolve(rootDir, "dist/sandbox/manifest.json");

const pluginStats = await stat(builtPluginPath).catch(() => null);
if (!pluginStats?.isFile()) {
  throw new Error(
    "Missing dist/sandbox/plugin.mjs. Run `npm run build` before preparing the EmDash Registry release package.",
  );
}
if (pluginStats.size >= MAX_PLUGIN_BYTES) {
  throw new Error(
    `dist/sandbox/plugin.mjs is ${pluginStats.size} bytes, which exceeds the ${MAX_PLUGIN_BYTES}-byte EmDash Registry limit.`,
  );
}

const builtManifest = JSON.parse(await readFile(builtManifestPath, "utf8"));
const releaseVersion = requestedVersion?.trim() || rootPackage.version;
if (!SEMVER_PATTERN.test(releaseVersion)) {
  throw new Error(`Invalid release version "${releaseVersion}". Expected semver X.Y.Z or X.Y.Z-beta.N.`);
}
if (builtManifest.version !== rootPackage.version) {
  throw new Error(
    `Built manifest version (${builtManifest.version}) does not match package.json (${rootPackage.version}). Run \`npm run build\` again.`,
  );
}

const isBeta = releaseVersion.includes("-beta.");
const releaseSlug = requestedSlug?.trim() || (isBeta ? BETA_SLUG : STABLE_SLUG);
const releaseName = requestedName?.trim() || (isBeta ? BETA_NAME : STABLE_NAME);

await rm(releaseDir, { recursive: true, force: true });
await mkdir(resolve(releaseDir, "src"), { recursive: true });

await copyFile(builtPluginPath, resolve(releaseDir, "src/plugin.ts"));

for (const filename of ["README.md", "LICENSE"]) {
  const sourcePath = resolve(rootDir, filename);
  const stats = await stat(sourcePath).catch(() => null);
  if (stats?.isFile()) {
    await copyFile(sourcePath, resolve(releaseDir, filename));
  }
}

const stagedPluginConfig = {
  ...pluginConfig,
  slug: releaseSlug,
  name: releaseName,
  version: releaseVersion,
};

await writeFile(
  resolve(releaseDir, "emdash-plugin.jsonc"),
  `${JSON.stringify(stagedPluginConfig, null, 2)}\n`,
  "utf8",
);

const stagedPackageJson = {
  name: rootPackage.name,
  version: releaseVersion,
  description: rootPackage.description,
  type: "module",
  license: rootPackage.license,
  repository: rootPackage.repository,
};

await writeFile(
  resolve(releaseDir, "package.json"),
  `${JSON.stringify(stagedPackageJson, null, 2)}\n`,
  "utf8",
);

console.log(
  `Prepared EmDash Registry release dir at ${releaseDir} for ${stagedPluginConfig.slug}@${releaseVersion} (bundle: ${pluginStats.size} bytes).`,
);
