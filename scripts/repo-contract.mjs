import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = join(here, "..");

const requiredFiles = [
  ".gitattributes",
  ".gitignore",
  ".grilltrack/.gitignore",
  ".grilltrack/events.jsonl",
  ".grilltrack/ledger.json",
  ".nvmrc",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "FEATURE_MAP.md",
  "LICENSE",
  "README.md",
  "REPO_HYGIENE.md",
  "SECURITY.md",
  "VISION.md",
  "bin/verify-payments",
  "docs/CHARTER.md",
  "docs/README.md",
  "package-lock.json",
  "package.json",
];

const forbiddenSegments = new Set([
  ".env",
  ".npmrc",
  ".pi",
  "data",
  "node_modules",
  "plans",
  "runs",
]);

const forbiddenExtensions = new Set([
  ".db",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
  ".sql",
  ".sqlite",
]);

async function walk(root, directory = root) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(root, absolute)));
    else paths.push(relative(root, absolute));
  }
  return paths;
}

export async function auditRepository(root = repositoryRoot) {
  const findings = [];
  const files = await walk(root);

  for (const required of requiredFiles) {
    if (!files.includes(required)) findings.push(`missing required file: ${required}`);
  }

  for (const path of files) {
    const segments = path.split("/");
    if (segments.some((segment) => forbiddenSegments.has(segment))) {
      findings.push(`forbidden public path: ${path}`);
    }
    if (segments.some((segment) => segment.startsWith(".env."))) {
      findings.push(`forbidden environment path: ${path}`);
    }
    const extension = path.includes(".") ? `.${path.split(".").at(-1)}` : "";
    if (forbiddenExtensions.has(extension)) {
      findings.push(`forbidden sensitive-data path: ${path}`);
    }
    if (path.startsWith("src/")) {
      findings.push(`implementation is outside the scaffold boundary: ${path}`);
    }
  }

  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.name !== "@dinkuskit/payments") {
    findings.push("package name must be @dinkuskit/payments");
  }
  if (manifest.version !== "0.0.0") findings.push("package version must start at 0.0.0");
  if (manifest.private !== true) findings.push("package must remain private at scaffold stage");
  if (manifest.license !== "MIT") findings.push("package license must be MIT");
  if (manifest.repository?.url !== "git+https://github.com/dinkuskit/payments.git") {
    findings.push("package repository must be dinkuskit/payments");
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(["dist"])) {
    findings.push("package files must contain only dist");
  }
  if (manifest.dependencies || manifest.devDependencies || manifest.peerDependencies) {
    findings.push("scaffold must not declare implementation dependencies");
  }

  const expectedDinkusKit = {
    pluginId: "dinkus-payments",
    providerSelection: "one-active-per-store",
    demoProviders: ["stripe"],
    demoCurrencies: ["USD"],
    providerFallback: false,
    currencyConversion: false,
  };
  if (JSON.stringify(manifest.dinkuskit) !== JSON.stringify(expectedDinkusKit)) {
    findings.push("manifest must retain the confirmed provider and currency scaffold contract");
  }

  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const findings = await auditRepository();
  if (findings.length) {
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
  } else {
    console.log("public_repository_contract=clean");
  }
}
