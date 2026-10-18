import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PLUGIN_BYTES = 131_072;
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryDir = resolve(rootDir, "dist", "registry");
const sandboxDir = resolve(rootDir, "dist", "sandbox");

await mkdir(sandboxDir, { recursive: true });

for (const filename of ["plugin.mjs", "index.mjs", "manifest.json"]) {
  await copyFile(resolve(registryDir, filename), resolve(sandboxDir, filename));
}

const { size } = await stat(resolve(sandboxDir, "plugin.mjs"));
if (size >= MAX_PLUGIN_BYTES) {
  throw new Error(
    `dist/sandbox/plugin.mjs is ${size} bytes, which exceeds the ${MAX_PLUGIN_BYTES}-byte EmDash Registry limit`,
  );
}
