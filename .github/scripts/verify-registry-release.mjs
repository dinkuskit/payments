const DEFAULT_REGISTRY_URL = "https://emdash-registry.pages.dev";
const STABLE_SLUG = "dinkus-payments";
const BETA_SLUG = "dinkus-payments-beta";

function parseArgs(argv) {
  const options = {
    registryUrl: process.env.EMDASH_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL,
    slug: process.env.EMDASH_PLUGIN_SLUG?.trim() || undefined,
    version: process.env.RELEASE_VERSION?.trim() || undefined,
    attempts: Number.parseInt(process.env.VERIFY_ATTEMPTS || "12", 10),
    delayMs: Number.parseInt(process.env.VERIFY_DELAY_MS || "5000", 10),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--registry-url") {
      options.registryUrl = argv[index + 1] ?? options.registryUrl;
      index += 1;
    } else if (arg.startsWith("--registry-url=")) {
      options.registryUrl = arg.slice("--registry-url=".length);
    } else if (arg === "--slug") {
      options.slug = argv[index + 1] ?? options.slug;
      index += 1;
    } else if (arg.startsWith("--slug=")) {
      options.slug = arg.slice("--slug=".length);
    } else if (arg === "--version") {
      options.version = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--attempts") {
      options.attempts = Number.parseInt(argv[index + 1] ?? "12", 10);
      index += 1;
    } else if (arg.startsWith("--attempts=")) {
      options.attempts = Number.parseInt(arg.slice("--attempts=".length), 10);
    } else if (arg === "--delay-ms") {
      options.delayMs = Number.parseInt(argv[index + 1] ?? "5000", 10);
      index += 1;
    } else if (arg.startsWith("--delay-ms=")) {
      options.delayMs = Number.parseInt(arg.slice("--delay-ms=".length), 10);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

const { registryUrl, slug: requestedSlug, version, attempts, delayMs } = parseArgs(process.argv.slice(2));

if (!version) {
  throw new Error("Missing required `--version <x.y.z>` (or `RELEASE_VERSION` env var).");
}

const slug = requestedSlug || (version.includes("-beta.") ? BETA_SLUG : STABLE_SLUG);
const endpoint = `${registryUrl.replace(/\/+$/, "")}/api/registry/plugins/${encodeURIComponent(slug)}`;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
    });

    if (response.ok) {
      const payload = await response.json();
      const versions = Array.isArray(payload?.versions) ? payload.versions : [];
      const matchingRelease = versions.find((entry) => entry?.version === version);
      const latestVersion = payload?.plugin?.latestVersion;

      if (matchingRelease || latestVersion === version) {
        console.log(
          `Verified ${slug}@${version} in EmDash Registry (latestVersion=${latestVersion ?? "unknown"}, indexedVersions=${versions.length}).`,
        );
        process.exit(0);
      }

      console.log(
        `Attempt ${attempt}/${attempts}: ${slug} found (latestVersion=${latestVersion ?? "none"}), waiting for ${version}...`,
      );
    } else {
      console.log(`Attempt ${attempt}/${attempts}: GET ${endpoint} returned HTTP ${response.status}.`);
    }
  } catch (error) {
    console.log(
      `Attempt ${attempt}/${attempts}: request to ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (attempt < attempts) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
  }
}

console.error(`Timed out waiting for ${slug}@${version} to appear at ${endpoint}.`);
process.exit(1);
