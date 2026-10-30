import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY_URL = "https://emdash-registry.pages.dev";
const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function computePackageChecksum(bytes) {
  const digest = createHash("sha256").update(bytes).digest();
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), digest]);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of multihash) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return `b${out}`;
}

export function parseSelector(selector) {
  const at = selector?.lastIndexOf("@") ?? -1;
  if (at <= 0 || at === selector.length - 1) return null;
  return { slug: selector.slice(0, at), version: selector.slice(at + 1) };
}

export function recordMatches(value, expected) {
  const reasons = [];
  if (!value || typeof value !== "object") return { ok: false, reasons: ["record is not an object"] };
  if (value.package !== expected.slug) reasons.push(`package is ${JSON.stringify(value.package)}`);
  if (value.version !== expected.version) reasons.push(`version is ${JSON.stringify(value.version)}`);
  const artifact = value.artifacts?.package;
  if (!artifact || typeof artifact !== "object") {
    reasons.push("artifacts.package is missing");
  } else {
    if (artifact.checksum !== expected.checksum) reasons.push("package checksum differs");
    if (artifact.blob?.size !== expected.size) reasons.push("package blob size differs");
    if (artifact.blob?.mimeType !== "application/gzip") reasons.push("package blob is not gzip");
  }
  if (expected.media) {
    for (const [slot, images] of Object.entries(expected.media)) {
      const published = slot === "screenshots" ? value.artifacts?.screenshots ?? [] : value.artifacts?.[slot] ? [value.artifacts[slot]] : [];
      if (published.length !== images.length) reasons.push(`${slot} count differs`);
      for (let index = 0; index < images.length; index += 1) {
        const actual = published[index];
        const image = images[index];
        if (!actual || actual.checksum !== image.checksum || actual.blob?.size !== image.size || actual.blob?.mimeType !== image.contentType) {
          reasons.push(`${slot}[${index}] media differs`);
        }
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export async function expectedListingMedia(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const media = {};
  for (const slot of ["icon", "banner", "screenshots"]) {
    const entries = slot === "screenshots" ? manifest.release?.artifacts?.screenshots ?? [] : manifest.release?.artifacts?.[slot] ? [manifest.release.artifacts[slot]] : [];
    media[slot] = await Promise.all(entries.map(async ({ file }) => {
      const bytes = await readFile(file);
      const contentType = /\.webp$/i.test(file) ? "image/webp" : /\.png$/i.test(file) ? "image/png" : "image/jpeg";
      return { checksum: computePackageChecksum(bytes), size: bytes.length, contentType };
    }));
  }
  return media;
}

export async function resolvePdsEndpoint(publisherDid, fetchImpl = fetch) {
  const url = publisherDid.startsWith("did:plc:")
    ? `https://plc.directory/${publisherDid}`
    : publisherDid.startsWith("did:web:")
      ? `https://${publisherDid.slice("did:web:".length).split(":").join("/")}/.well-known/did.json`
      : null;
  if (!url) throw new Error(`unsupported publisher DID method: ${publisherDid}`);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`DID resolution failed with HTTP ${response.status}`);
  const document = await response.json();
  const service = document?.service?.find(
    (entry) => entry?.id === "#atproto_pds" || entry?.id === `${publisherDid}#atproto_pds`,
  );
  if (!service?.serviceEndpoint) throw new Error("publisher DID has no #atproto_pds service");
  return service.serviceEndpoint;
}

export async function fetchReleaseRecord(pds, publisherDid, slug, version, fetchImpl = fetch) {
  const url = new URL(`${pds.replace(/\/$/, "")}/xrpc/com.atproto.repo.getRecord`);
  url.searchParams.set("repo", publisherDid);
  url.searchParams.set("collection", RELEASE_COLLECTION);
  url.searchParams.set("rkey", `${slug}:${version}`);
  const response = await fetchImpl(url);
  if (response.status === 400) {
    const body = await response.json().catch(() => null);
    if (body?.error === "RecordNotFound") return null;
  }
  if (!response.ok) throw new Error(`getRecord failed with HTTP ${response.status}`);
  const record = await response.json();
  const expectedUri = `at://${publisherDid}/${RELEASE_COLLECTION}/${slug}:${version}`;
  if (record?.uri !== expectedUri) throw new Error("getRecord returned an unexpected record URI");
  return record;
}

function parseArgs(argv) {
  const options = {
    registryUrl: process.env.EMDASH_REGISTRY_URL || DEFAULT_REGISTRY_URL,
    slug: process.env.EMDASH_PLUGIN_SLUG || undefined,
    version: process.env.RELEASE_VERSION || undefined,
    publisherDid: process.env.PUBLISHER_DID || undefined,
    selector: process.env.EMDASH_RELEASE_SELECTOR || undefined,
    bundleFile: process.env.BUNDLE_FILE || undefined,
    mediaManifest: undefined,
    attempts: Number.parseInt(process.env.VERIFY_ATTEMPTS || "20", 10),
    delayMs: Number.parseInt(process.env.VERIFY_DELAY_MS || "15000", 10),
  };

  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--registry-url") {
      options.registryUrl = argv[index + 1] ?? options.registryUrl;
      index += 1;
    } else if (arg.startsWith("--registry-url=")) {
      options.registryUrl = arg.slice("--registry-url=".length);
    } else if (arg === "--slug") {
      options.slug = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--slug=")) {
      options.slug = arg.slice("--slug=".length);
    } else if (arg === "--version") {
      options.version = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--publisher-did") {
      options.publisherDid = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--publisher-did=")) {
      options.publisherDid = arg.slice("--publisher-did=".length);
    } else if (arg === "--selector") {
      options.selector = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--selector=")) {
      options.selector = arg.slice("--selector=".length);
    } else if (arg === "--bundle-file") {
      options.bundleFile = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--bundle-file=")) {
      options.bundleFile = arg.slice("--bundle-file=".length);
    } else if (arg === "--attempts") {
      options.attempts = Number.parseInt(argv[index + 1] ?? "20", 10);
      index += 1;
    } else if (arg === "--media-manifest") {
      options.mediaManifest = argv[++index];
    } else if (arg.startsWith("--attempts=")) {
      options.attempts = Number.parseInt(arg.slice("--attempts=".length), 10);
    } else if (arg === "--delay-ms") {
      options.delayMs = Number.parseInt(argv[index + 1] ?? "15000", 10);
      index += 1;
    } else if (arg.startsWith("--delay-ms=")) {
      options.delayMs = Number.parseInt(arg.slice("--delay-ms=".length), 10);
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (positionals.length === 3) {
    [options.publisherDid, options.selector, options.bundleFile] = positionals;
  } else if (positionals.length > 0) {
    throw new Error(
      "Usage: verify-registry-release.mjs <publisher-did> <slug@version> <bundle-file> (or --slug <slug> --version <version>)",
    );
  }

  if (options.selector) {
    const parsed = parseSelector(options.selector);
    if (!parsed) {
      throw new Error(`Invalid release selector "${options.selector}". Expected <slug>@<version>.`);
    }
    options.slug = options.slug ?? parsed.slug;
    options.version = options.version ?? parsed.version;
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasPublishedVersion(payload, version) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const root = payload.plugin && typeof payload.plugin === "object" ? payload.plugin : payload;
  if (root.version === version || root.latestVersion === version || root.latest_version === version) {
    return true;
  }

  const candidates = [root.versions, root.releases, payload.versions, payload.releases];
  for (const list of candidates) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      if (typeof entry === "string" && entry === version) {
        return true;
      }
      if (entry && typeof entry === "object" && entry.version === version) {
        return true;
      }
    }
  }

  return false;
}

async function verifyPdsRelease({
  publisherDid,
  slug,
  version,
  bundleFile,
  mediaManifest,
  attempts,
  delayMs,
  fetchImpl = fetch,
}) {
  const bytes = await readFile(bundleFile);
  const expected = {
    slug,
    version,
    checksum: computePackageChecksum(bytes),
    size: bytes.byteLength,
    ...(mediaManifest ? { media: await expectedListingMedia(mediaManifest) } : {}),
  };
  const pds = await resolvePdsEndpoint(publisherDid, fetchImpl);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const record = await fetchReleaseRecord(pds, publisherDid, slug, version, fetchImpl);
    if (record) {
      const result = recordMatches(record.value, expected);
      if (result.ok) {
        console.log(
          `registry_release_verified=${slug}@${version} uri=${record.uri} cid=${record.cid} checksum=${expected.checksum}`,
        );
        return;
      }
      console.error(
        `::error::Registry record for ${slug}@${version} does not match the prepared bundle: ${result.reasons.join("; ")}`,
      );
      process.exit(1);
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  console.error(
    `::error::Registry record for ${slug}@${version} did not appear within ${attempts} attempts.`,
  );
  process.exit(1);
}

async function verifyRegistryHttp({ registryUrl, slug, version, attempts, delayMs, fetchImpl = fetch }) {
  const normalizedBaseUrl = registryUrl.replace(/\/+$/, "");
  const pluginUrl = `${normalizedBaseUrl}/api/v1/plugins/${encodeURIComponent(slug)}`;

  let lastStatus = "no-response";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(pluginUrl, {
        headers: { accept: "application/json" },
      });
      lastStatus = `HTTP ${response.status}`;

      if (response.ok) {
        const payload = await response.json();
        if (hasPublishedVersion(payload, version)) {
          console.log(`Verified ${slug}@${version} in EmDash Registry (${pluginUrl}) on attempt ${attempt}.`);
          return;
        }
        lastStatus = `HTTP 200 (version ${version} not yet listed)`;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    if (attempt < attempts) {
      console.log(
        `Attempt ${attempt}/${attempts}: ${slug}@${version} not yet indexed (${lastStatus}); retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(
    `Timed out waiting for ${slug}@${version} to appear at ${pluginUrl} after ${attempts} attempts (last status: ${lastStatus}).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { registryUrl, slug, version, publisherDid, bundleFile, mediaManifest, attempts, delayMs } = parseArgs(
    process.argv.slice(2),
  );

  if (!slug || !version) {
    throw new Error("Both --slug and --version (or <publisher-did> <slug@version> <bundle-file>) are required.");
  }

  if (publisherDid && bundleFile) {
    await verifyPdsRelease({ publisherDid, slug, version, bundleFile, mediaManifest, attempts, delayMs });
  } else {
    await verifyRegistryHttp({ registryUrl, slug, version, attempts, delayMs });
  }
}
