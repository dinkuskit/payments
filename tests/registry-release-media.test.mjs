import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createSourceRelease, ensureReleaseAsset, ensureGithubRelease, prepareMediaRelease } from "../scripts/registry-release-media.mjs";
import { computePackageChecksum, recordMatches } from "../.github/scripts/verify-registry-release.mjs";

const repository = "dinkuskit/payments";
const tag = "v0.5.0-beta.1";
const bytes = Buffer.from("verified artifact");
const checksum = computePackageChecksum(bytes);
const asset = { id: 42, name: "package.tar.gz", browser_download_url: `https://github.com/${repository}/releases/download/${tag}/package.tar.gz` };

test("matching existing release asset is downloaded and reused without upload", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return args[1].includes("/assets/") ? bytes : Buffer.from(JSON.stringify({ assets: [asset] }));
  };
  const result = await ensureReleaseAsset({ repository, tag, name: asset.name, bytes, gh });
  assert.equal(result.checksum, checksum);
  assert.equal(calls.length, 2);
  assert.equal(calls.some((args) => args.includes("upload")), false);
});

test("existing different bytes fail closed and are never replaced", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return args[1].includes("/assets/") ? Buffer.from("different") : Buffer.from(JSON.stringify({ assets: [asset] }));
  };
  await assert.rejects(ensureReleaseAsset({ repository, tag, name: asset.name, bytes, gh }), /conflict/);
  assert.equal(calls.some((args) => args.includes("upload")), false);
});

test("new artifact upload uses verified bytes and exact basename without clobber", async () => {
  let uploaded = false;
  const gh = (args) => {
    assert.equal(args.includes("--clobber"), false);
    if (args[1] === "upload") {
      assert.equal(basename(args[3]), asset.name);
      assert.deepEqual(readFileSync(args[3]), bytes);
      uploaded = true;
      return Buffer.alloc(0);
    }
    return args[1].includes("/assets/") ? bytes : Buffer.from(JSON.stringify({ assets: uploaded ? [asset] : [] }));
  };
  await ensureReleaseAsset({ repository, tag, name: asset.name, bytes, gh });
  assert.equal(uploaded, true);
});

test("concurrent matching upload may be reused but a conflicting upload fails", async () => {
  for (const same of [true, false]) {
    let raced = false;
    const gh = (args) => {
      if (args[1] === "upload") { raced = true; throw new Error("duplicate upload"); }
      return args[1].includes("/assets/") ? (same ? bytes : Buffer.from("other")) : Buffer.from(JSON.stringify({ assets: raced ? [asset] : [] }));
    };
    const attempt = ensureReleaseAsset({ repository, tag, name: asset.name, bytes, gh });
    if (same) await attempt;
    else await assert.rejects(attempt, /conflict/);
  }
});

test("missing beta release is created as prerelease; stable absence or non-404 fails", () => {
  let created = false;
  const gh = (args) => {
    if (args[1] === "create") { assert.ok(args.includes("--prerelease")); assert.ok(args.includes("--verify-tag")); created = true; return Buffer.alloc(0); }
    if (!created) throw Object.assign(new Error("missing"), { stderr: Buffer.from("HTTP 404") });
    return Buffer.from("{}");
  };
  ensureGithubRelease({ repository, tag, beta: true, gh });
  assert.equal(created, true);
  assert.throws(() => ensureGithubRelease({ repository, tag: "v0.5.0", beta: false, gh: () => { throw Object.assign(new Error(), { stderr: "HTTP 404" }); } }), /must exist/);
  assert.throws(() => ensureGithubRelease({ repository, tag, beta: true, gh: () => { throw Object.assign(new Error(), { stderr: "HTTP 403" }); } }), /Could not read/);
});

test("source release parser retains media and mandatory provenance", () => {
  const result = createSourceRelease({
    slug: "dinkus-payments", version: "0.5.0", repository,
    workflowRef: `${repository}/.github/workflows/release.yml@refs/tags/v0.5.0`,
    packageArtifact: { url: "https://example.com/plugin.tar.gz", checksum, contentType: "application/gzip" },
    provenanceArtifact: { url: "https://example.com/provenance.json", checksum },
    declaredAccess: { network: { request: { allowedHosts: ["dinkuskit.com", "payments.dinkuskit.com"] } } },
    images: { icon: { url: "https://example.com/icon.webp", checksum, contentType: "image/webp" }, screenshots: [{ url: "https://example.com/screen.jpg", checksum, contentType: "image/jpeg", lang: "en" }] },
  });
  assert.equal(result.artifacts.screenshots.length, 1);
  assert.equal(result.extensions["com.emdashcms.experimental.package.releaseExtension"].provenance.predicateType, "https://slsa.dev/provenance/v1");
  assert.throws(() => createSourceRelease({ slug: "dinkus-payments", version: "0.5.0", repository, workflowRef: "bad", packageArtifact: {}, provenanceArtifact: {}, declaredAccess: {}, images: {} }), /Invalid delegated/);
});

test("PDS verification rejects missing or changed listing images", () => {
  const expected = { slug: "dinkus-payments", version: "0.5.0", checksum, size: bytes.length, media: { icon: [{ checksum, size: bytes.length, contentType: "image/webp" }], screenshots: [], banner: [] } };
  const record = { package: expected.slug, version: expected.version, artifacts: { package: { checksum, blob: { size: bytes.length, mimeType: "application/gzip" } } } };
  assert.equal(recordMatches(record, expected).ok, false);
  record.artifacts.icon = { checksum, blob: { size: bytes.length, mimeType: "image/webp" } };
  assert.equal(recordMatches(record, expected).ok, true);
  record.artifacts.icon.checksum = computePackageChecksum(Buffer.from("changed"));
  assert.equal(recordMatches(record, expected).ok, false);
});

test("preparation binds all media to the source commit and checks input before uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "payments-media-preparation-"));
  try {
    await mkdir(join(root, "out"));
    await writeFile(join(root, "bundle.tar.gz"), bytes);
    await writeFile(join(root, "provenance.json"), "{}");
    const image = Buffer.from([255, 216, 255, 0]);
    await writeFile(join(root, "demo.jpg"), image);
    const config = { slug: "dinkus-payments", version: "0.5.0", repo: `https://github.com/${repository}`, release: { artifacts: { icon: { file: "demo.jpg" }, screenshots: [{ file: "demo.jpg", lang: "en" }] } } };
    await writeFile(join(root, "manifest.json"), JSON.stringify(config));
    const assets = [];
    const uploaded = new Map();
    let calls = 0;
    const gh = (args) => {
      calls += 1;
      if (args[1] === "upload") {
        const name = basename(args[3]);
        const id = assets.length + 1;
        uploaded.set(id, readFileSync(args[3]));
        assets.push({ id, name, browser_download_url: `https://github.com/${repository}/releases/download/v0.5.0/${name}` });
        return Buffer.alloc(0);
      }
      if (args[1].includes("/assets/")) return uploaded.get(Number(args[1].split("/").at(-1)));
      return Buffer.from(JSON.stringify({ assets }));
    };
    const options = { root, bundleFile: "bundle.tar.gz", provenanceFile: "provenance.json", runnerTemp: root, manifestFile: "manifest.json", repository, sha: "a".repeat(40), ref: "refs/tags/v0.5.0", workflowRef: `${repository}/.github/workflows/release.yml@refs/tags/v0.5.0`, outputFile: "out/release.json", gh, validateBundle: async () => ({ success: true, value: { manifest: { id: "dinkus-payments", version: "0.5.0" }, declaredAccess: {} } }) };
    const record = await prepareMediaRelease(options);
    assert.equal(record.artifacts.icon.url, `https://raw.githubusercontent.com/${repository}/${options.sha}/demo.jpg`);
    assert.equal(record.artifacts.screenshots[0].lang, "en");
    assert.equal(assets.length, 2);
    assert.match(assets[1].name, /provenance-[a-f0-9]{64}\.json$/);
    assert.deepEqual(JSON.parse(await readFile(join(root, options.outputFile))), record);
    calls = 0;
    await assert.rejects(prepareMediaRelease({ ...options, ref: "refs/heads/main" }), /workflow identity|gated tag/);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
