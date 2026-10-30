import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareListingMedia } from "../scripts/registry-release-media.mjs";
import { computePackageChecksum, recordMatches } from "../.github/scripts/verify-registry-release.mjs";

const bytes = Buffer.from("verified artifact");
const checksum = computePackageChecksum(bytes);
const jpeg = Buffer.from([255, 216, 255, 0]);

async function fixture(config) {
  const root = await mkdtemp(join(tmpdir(), "payments-listing-media-"));
  await mkdir(join(root, ".emdash-release"));
  await mkdir(join(root, "assets/registry"), { recursive: true });
  await writeFile(join(root, "assets/registry/demo.jpg"), jpeg);
  await writeFile(join(root, ".emdash-release/emdash-plugin.jsonc"), JSON.stringify(config));
  return root;
}

const beta = { slug: "dinkus-payments-beta", version: "0.5.0-beta.6", release: { artifacts: { icon: { file: "./assets/registry/demo.jpg" }, screenshots: [{ file: "./assets/registry/demo.jpg", lang: "en" }] } } };

test("PDS verification rejects missing or changed listing images", () => {
  const expected = { slug: "dinkus-payments", version: "0.5.0", checksum, size: bytes.length, media: { icon: [{ checksum, size: bytes.length, contentType: "image/webp" }], screenshots: [], banner: [] } };
  const record = { package: expected.slug, version: expected.version, artifacts: { package: { checksum, blob: { size: bytes.length, mimeType: "application/gzip" } } } };
  assert.equal(recordMatches(record, expected).ok, false);
  record.artifacts.icon = { checksum, blob: { size: bytes.length, mimeType: "image/webp" } };
  assert.equal(recordMatches(record, expected).ok, true);
  record.artifacts.icon.checksum = computePackageChecksum(Buffer.from("changed"));
  assert.equal(recordMatches(record, expected).ok, false);
});

test("listing images are copied beside the prepared manifest for the release-action", async () => {
  const root = await fixture(beta);
  try {
    const output = join(root, "github-output");
    const result = await prepareListingMedia({ root, manifestFile: ".emdash-release/emdash-plugin.jsonc", ref: "refs/tags/v0.5.0-beta.6", githubOutput: output });
    assert.equal(result.pluginDirectory, ".emdash-release");
    assert.deepEqual(await readFile(join(root, ".emdash-release/assets/registry/demo.jpg")), jpeg);
    assert.equal(await readFile(output, "utf8"), "plugin-directory=.emdash-release\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listing preparation refuses another tag, slug, unsafe path or non-image before copying", async () => {
  const root = await fixture(beta);
  try {
    await writeFile(join(root, "notes.txt"), "not an image");
    const manifestFile = ".emdash-release/emdash-plugin.jsonc";
    await assert.rejects(prepareListingMedia({ root, manifestFile, ref: "refs/heads/main" }), /gated tag/);
    for (const [config, error] of [
      [{ ...beta, slug: "dinkus-payments" }, /listing identity/],
      [{ ...beta, release: { artifacts: { icon: { file: "../outside.jpg" } } } }, /ENOENT|leaves/],
      [{ ...beta, release: { artifacts: { icon: { file: "./assets/registry/demo.jpg" }, banner: { file: "./notes.txt" } } } }, /Unsupported image/],
    ]) {
      await writeFile(join(root, manifestFile), JSON.stringify(config));
      await assert.rejects(prepareListingMedia({ root, manifestFile, ref: "refs/tags/v0.5.0-beta.6" }), error);
    }
    await assert.rejects(readFile(join(root, ".emdash-release/assets/registry/demo.jpg")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
