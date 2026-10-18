import { execFileSync } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PLUGIN_BYTES = 131_072;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const STABLE_SLUG = "dinkus-payments";
const STABLE_NAME = "DinkusKit Payments";
const BETA_SLUG = "dinkus-payments-beta";
const BETA_NAME = "DinkusKit Payments (Beta)";

function parseArgs(argv) {
  const options = {
    outDir: ".emdash-release",
    version: undefined,
    slug: undefined,
    name: undefined,
    selector: undefined,
    githubOutput: process.env.GITHUB_OUTPUT,
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
    } else if (arg === "--github-output") {
      options.githubOutput = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--github-output=")) {
      options.githubOutput = arg.slice("--github-output=".length);
    } else if (!arg.startsWith("-") && !options.selector) {
      options.selector = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.selector) {
    const separator = options.selector.lastIndexOf("@");
    if (separator <= 0 || separator === options.selector.length - 1) {
      throw new Error(`Invalid release selector "${options.selector}". Expected <slug>@<version>.`);
    }
    options.slug = options.slug ?? options.selector.slice(0, separator);
    options.version = options.version ?? options.selector.slice(separator + 1);
  }

  return options;
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const {
  outDir,
  version: requestedVersion,
  slug: requestedSlug,
  name: requestedName,
  githubOutput,
} = parseArgs(process.argv.slice(2));
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
const expectedSlug = isBeta ? BETA_SLUG : STABLE_SLUG;
const releaseSlug = requestedSlug?.trim() || expectedSlug;
if (releaseSlug !== expectedSlug) {
  throw new Error(
    `Release slug "${releaseSlug}" does not match version "${releaseVersion}" (expected "${expectedSlug}").`,
  );
}
const releaseName = requestedName?.trim() || (isBeta ? BETA_NAME : STABLE_NAME);
const selector = `${releaseSlug}@${releaseVersion}`;

const stagedPluginConfig = {
  ...pluginConfig,
  slug: releaseSlug,
  name: releaseName,
  version: releaseVersion,
};

const stagedPackageJson = {
  name: rootPackage.name,
  version: releaseVersion,
  description: rootPackage.description,
  type: "module",
  license: rootPackage.license,
  repository: rootPackage.repository,
};

const tempDir = await mkdtemp(join(tmpdir(), "payments-release-"));
try {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await copyFile(builtPluginPath, join(tempDir, "src/plugin.ts"));

  for (const filename of ["README.md", "LICENSE"]) {
    const sourcePath = resolve(rootDir, filename);
    const stats = await stat(sourcePath).catch(() => null);
    if (stats?.isFile()) {
      await copyFile(sourcePath, join(tempDir, filename));
    }
  }

  await writeFile(
    join(tempDir, "emdash-plugin.jsonc"),
    `${JSON.stringify(stagedPluginConfig, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(tempDir, "package.json"),
    `${JSON.stringify(stagedPackageJson, null, 2)}\n`,
    "utf8",
  );

  const receiptPath = join(tempDir, "github-output");
  const cliPath = resolve(rootDir, "node_modules/@emdash-cms/plugin-cli/dist/index.mjs");
  execFileSync(
    process.execPath,
    [cliPath, "release", "prepare", selector, "--dir", tempDir, "--out-dir", ".emdash-release"],
    {
      cwd: tempDir,
      env: { ...process.env, GITHUB_OUTPUT: receiptPath },
      stdio: "inherit",
    },
  );

  const receiptLines = (await readFile(receiptPath, "utf8")).trim().split("\n").filter(Boolean);
  const fields = Object.fromEntries(
    receiptLines.map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );

  const expectedBundle = `.emdash-release/${releaseSlug}-${releaseVersion}.tar.gz`;
  if (
    fields["package-slug"] !== releaseSlug ||
    fields.version !== releaseVersion ||
    fields["publisher-did"] !== pluginConfig.publisher ||
    fields["plugin-directory"] !== "." ||
    fields["bundle-file"] !== expectedBundle
  ) {
    throw new Error("Official release preparation returned unexpected metadata.");
  }

  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  const bundleFilename = basename(expectedBundle);
  const outputBundlePath = resolve(releaseDir, bundleFilename);
  await copyFile(join(tempDir, expectedBundle), outputBundlePath);
  await writeFile(
    resolve(releaseDir, "emdash-plugin.jsonc"),
    `${JSON.stringify(stagedPluginConfig, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(releaseDir, "package.json"),
    `${JSON.stringify(stagedPackageJson, null, 2)}\n`,
    "utf8",
  );

  fields["bundle-file"] = outputBundlePath;
  fields.selector = selector;
  if (Object.values(fields).some((value) => /[\r\n]/.test(String(value)))) {
    throw new Error("Invalid release output metadata.");
  }

  if (githubOutput) {
    await appendFile(
      githubOutput,
      Object.entries(fields)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      "utf8",
    );
  }

  console.log(
    `Prepared EmDash Registry release bundle at ${outputBundlePath} for ${selector} (sandbox prebundle: ${pluginStats.size} bytes).`,
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
