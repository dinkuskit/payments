import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const manifest = JSON.parse(await readFile(new URL("dist/registry/manifest.json", root), "utf8"));
const files = {};
for (const file of ["plugin.mjs", "manifest.json"]) {
  const bytes = await readFile(new URL(`dist/registry/${file}`, root));
  files[file] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
const toolchain = {};
for (const name of ["emdash", "@emdash-cms/plugin-cli", "@emdash-cms/plugin-test", "@emdash-cms/cloudflare", "vitest", "wrangler"]) {
  const dependency = JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root), "utf8"));
  toolchain[name] = dependency.version;
}
console.log(JSON.stringify({ kind: "local-compiled-registry-build", package: pkg.name, version: pkg.version,
  plugin: manifest.id, node: process.version, toolchain, files }));
