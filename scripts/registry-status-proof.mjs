#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(repositoryRoot, "emdash-plugin.jsonc"), "utf8"));

const usage = `Usage:
  node scripts/registry-status-proof.mjs prepare /absolute/new/run-dir [--port 4387]
  node scripts/registry-status-proof.mjs verify /absolute/run-dir

prepare requires a new, empty external directory. It creates all generated
host, bundle, and proof files there. Run npm start in the generated host
directory, then stop that foreground process with Ctrl-C.`;

function fail(message) {
  throw new Error(message);
}

function parsePort(value) {
  if (!/^\d+$/.test(value)) fail(`invalid port: ${value}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail("port must be an integer between 1024 and 65535");
  }
  return port;
}

async function safeNewRunDirectory(input) {
  if (!input || !isAbsolute(input)) fail("run directory must be an absolute path");
  const requested = resolve(input);
  const repo = await realpath(repositoryRoot);
  const parent = resolve(dirname(requested));
  if (!existsSync(parent)) fail("run directory parent must already exist");
  const parentReal = await realpath(parent);
  if (requested === repo || relative(repo, requested).split(sep)[0] !== "..") {
    fail("run directory must be outside the repository");
  }
  if (parentReal === repo || relative(repo, parentReal).split(sep)[0] !== "..") {
    fail("run directory parent must be outside the repository");
  }
  if (requested === "/" || requested === resolve(process.env.HOME ?? "/")) {
    fail("unsafe run directory");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested.split(sep).at(-1))) {
    fail("run directory name contains unsafe characters");
  }
  if (existsSync(requested)) fail("run directory must not already exist");
  await mkdir(requested);
  return requested;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function run(command, args, cwd) {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return `${stdout}${stderr}`;
}

function hostFiles(port) {
  return {
    "package.json": JSON.stringify({
      private: true,
      type: "module",
      scripts: { start: `astro dev --ignore-lock --host 127.0.0.1 --port ${port}` },
    }, null, 2) + "\n",
    "astro.config.mjs": `import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import emdash from "emdash/astro";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";

export default defineConfig({
  output: "server",
  vite: { server: { strictPort: true, fs: { allow: [process.cwd(), ${JSON.stringify(repositoryRoot)}] } } },
  adapter: cloudflare({ remoteBindings: false }),
  devToolbar: { enabled: false },
  integrations: [
    react(),
    emdash({
      database: d1({ binding: "DB" }),
      storage: r2({ binding: "MEDIA" }),
      sandboxRunner: sandbox(),
      registry: "http://127.0.0.1:9",
      fonts: false,
    }),
  ],
});
`,
    "wrangler.jsonc": JSON.stringify({
      name: "payments-local-proof",
      main: "./src/worker.ts",
      compatibility_date: "2026-08-20",
      compatibility_flags: ["nodejs_compat"],
      d1_databases: [{
        binding: "DB",
        database_name: "payments-proof",
        database_id: "00000000-0000-0000-0000-000000000001",
      }],
      r2_buckets: [{ binding: "MEDIA", bucket_name: "payments-proof" }],
      worker_loaders: [{ binding: "LOADER" }],
    }, null, 2) + "\n",
    "src/worker.ts": `export { default } from "@astrojs/cloudflare/entrypoints/server";
export { PluginBridge } from "@emdash-cms/cloudflare/sandbox";
`,
    "src/pages/fixture-init.ts": `import { withEmDashRuntime } from "emdash/middleware";
import manifest from "../../manifest.json";
import code from "../../backend.js?raw";

export const prerender = false;

export async function POST({ request }) {
  if (new URL(request.url).hostname !== "127.0.0.1") {
    return new Response("loopback only", { status: 403 });
  }
  return withEmDashRuntime(async (runtime) => {
    const db = runtime.db;
    for (const [name, value] of Object.entries({
      "emdash:setup_complete": true,
      "emdash:site_title": "Payments local proof",
      "emdash:site_url": "http://127.0.0.1:${port}",
      "emdash:locale": "en",
    })) {
      await db.insertInto("options").values({
        name, value: JSON.stringify(value), revision: crypto.randomUUID(),
      }).onConflict((oc) => oc.column("name").doNothing()).execute();
    }
    const now = new Date().toISOString();
    for (const [id, role] of [["admin", 50], ["subscriber", 10]]) {
      await db.insertInto("users").values({
        id: \`proof-\${id}\`, email: \`\${id}@example.invalid\`,
        name: \`Proof \${id}\`, role, email_verified: 1,
        created_at: now, updated_at: now,
        data: JSON.stringify({ welcomeDismissed: true }),
      }).onConflict((oc) => oc.column("id").doUpdateSet({ role })).execute();
    }
    for (const [file, text] of [["manifest.json", JSON.stringify(manifest)], ["backend.js", code]]) {
      await runtime.storage.upload({
        key: \`registry/\${manifest.id}/\${manifest.version}/\${file}\`,
        body: new TextEncoder().encode(text),
        contentType: file.endsWith(".json") ? "application/json" : "application/javascript",
      });
    }
    await db.insertInto("_plugin_state").values({
      plugin_id: manifest.id, version: manifest.version, status: "active",
      source: "registry", installed_at: now, activated_at: now,
      display_name: manifest.name, description: manifest.description,
    }).onConflict((oc) => oc.column("plugin_id").doNothing()).execute();
    await runtime.syncRegistryPlugins();
    return Response.json({
      mode: "SEEDED_POST_INSTALL_STATE",
      sandboxAvailable: runtime.getSandboxRunner()?.isAvailable(),
    });
  });
}
`,
    "src/pages/fixture-role.ts": `export async function GET({ url, session }) {
  if (url.hostname !== "127.0.0.1") return new Response("loopback only", { status: 403 });
  const role = url.searchParams.get("role");
  if (!["admin", "subscriber", "anonymous"].includes(role)) {
    return new Response("invalid role", { status: 400 });
  }
  if (role === "anonymous") await session.destroy();
  else session.set("user", { id: \`proof-\${role}\` });
  return new Response("<!doctype html><p>Local synthetic session selected.</p>", {
    headers: { "Content-Type": "text/html" },
  });
}
`,
    "src/pages/fixture-inspect.ts": `import { withEmDashRuntime } from "emdash/middleware";
import manifest from "../../manifest.json";
export async function GET({ url }) {
  if (url.hostname !== "127.0.0.1") return new Response("loopback only", { status: 403 });
  return withEmDashRuntime(async (runtime) => {
    const rows = await runtime.db.selectFrom("_plugin_state")
      .select(["plugin_id", "version", "status", "source"]).execute();
    const artifacts = {};
    for (const file of ["manifest.json", "backend.js"]) {
      const bytes = await new Response((await runtime.storage.download(
        \`registry/\${manifest.id}/\${manifest.version}/\${file}\`,
      )).body).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      artifacts[file] = {
        bytes: bytes.byteLength,
        sha256: [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join(""),
      };
    }
    return Response.json({
      mode: "SEEDED_POST_INSTALL_STATE",
      sandboxAvailable: runtime.getSandboxRunner()?.isAvailable(),
      loaded: [...runtime.sandboxedPlugins.keys()],
      rows, artifacts,
    });
  });
}
`,
  };
}

async function prepare(runDir, port) {
  const root = await safeNewRunDirectory(runDir);
  const bundleDir = join(root, "bundle");
  const hostDir = join(root, "host");
  await mkdir(bundleDir);
  await mkdir(join(hostDir, "src/pages"), { recursive: true });
  await run(join(repositoryRoot, "node_modules/.bin/emdash-plugin"), [ "validate", "--dir", repositoryRoot], repositoryRoot);
  await run(join(repositoryRoot, "node_modules/.bin/emdash-plugin"), [ "bundle", "--dir", repositoryRoot, "--out-dir", bundleDir], repositoryRoot);
  const entries = await readdir(bundleDir);
  const tarball = entries.find((name) => name.endsWith(".tar.gz"));
  if (!tarball) fail("official packager did not produce a tarball");
  await run("tar", ["-xzf", tarball, "-C", bundleDir], bundleDir);
  const packageRoot = bundleDir;
  const backend = await readFile(join(packageRoot, "backend.js"));
  const packagedManifest = await readFile(join(packageRoot, "manifest.json"));
  const tarballBytes = await readFile(join(bundleDir, tarball));
  await writeFile(join(root, "artifact.json"), JSON.stringify({
    mode: "SEEDED_POST_INSTALL_STATE",
    package: packageJson.name,
    version: packageJson.version,
    plugin: manifest.slug,
    port,
    tarball: { name: tarball, sha256: hash(tarballBytes) },
    backend: { sha256: hash(backend) },
    manifest: { sha256: hash(packagedManifest), storedSha256: hash(JSON.stringify(JSON.parse(packagedManifest))) },
  }, null, 2) + "\n");
  await writeFile(join(hostDir, "manifest.json"), packagedManifest);
  await writeFile(join(hostDir, "backend.js"), backend);
  for (const [path, content] of Object.entries(hostFiles(port))) {
    await writeFile(join(hostDir, path), content);
  }
  await symlink(join(repositoryRoot, "node_modules"), join(hostDir, "node_modules"), "dir");
  await writeFile(join(root, "README.txt"), `Start manually: cd ${hostDir} && npm start
Verify separately: node ${join(repositoryRoot, "scripts/registry-status-proof.mjs")} verify ${root}
Stop: Ctrl-C in the foreground host terminal.
`);
  console.log(JSON.stringify({ prepared: root, port, tarball: join(bundleDir, tarball) }));
}

async function fetchWithCookies(base, path, jar, init = {}) {
  const headers = new Headers(init.headers);
  if (jar.value) headers.set("cookie", jar.value);
  const response = await fetch(`${base}${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30000) });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jar.value = setCookie.split(";")[0];
  return response;
}

async function verify(runDir) {
  if (!runDir || !isAbsolute(runDir)) fail("run directory must be an absolute path");
  const root = await realpath(runDir);
  const artifact = JSON.parse(await readFile(join(root, "artifact.json"), "utf8"));
  if (artifact.mode !== "SEEDED_POST_INSTALL_STATE" || artifact.plugin !== manifest.slug) fail("invalid proof artifact");
  const port = parsePort(String(artifact.port));
  const base = `http://127.0.0.1:${port}`;
  const init = await fetch(`${base}/fixture-init`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!init.ok) fail(`fixture initialization failed: HTTP ${init.status}`);
  const state = await (await fetch(`${base}/fixture-inspect`, { redirect: "error", signal: AbortSignal.timeout(30000) })).json();
  if (state.mode !== "SEEDED_POST_INSTALL_STATE" || state.sandboxAvailable !== true) {
    fail("seeded state did not load through the local sandbox");
  }
  if (!state.loaded.includes(`${artifact.plugin}:${artifact.version}`)) fail("loaded plugin key missing");
  if (!state.rows.some((row) => row.plugin_id === artifact.plugin && row.version === artifact.version && row.status === "active" && row.source === "registry")) {
    fail("active Registry state missing");
  }
  const tarballBytes = await readFile(join(root, "bundle", artifact.tarball.name));
  if (hash(tarballBytes) !== artifact.tarball.sha256) fail("tarball changed since preparation");
  if (state.artifacts["manifest.json"].sha256 !== artifact.manifest.storedSha256) fail("stored manifest hash mismatch");
  if (state.artifacts["backend.js"].sha256 !== artifact.backend.sha256) {
    fail("stored backend hash does not match official tarball backend");
  }
  const results = [];
  for (const [role, expected] of [["admin", 200], ["subscriber", 403], ["anonymous", 401]]) {
    const jar = { value: "" };
    const selected = await fetchWithCookies(base, `/fixture-role?role=${role}`, jar);
    if (!selected.ok) fail(`${role} fixture selection failed: HTTP ${selected.status}`);
    const response = await fetchWithCookies(base, "/_emdash/api/plugins/dinkus-payments/admin", jar, {
      method: "POST",
      headers: { "content-type": "application/json", "x-emdash-request": "1" },
      body: JSON.stringify({ type: "page_load", page: "/status" }),
    });
    const body = await response.json();
    if (response.status !== expected) fail(`${role} expected ${expected}, got ${response.status}`);
    const text = JSON.stringify(body);
    if (role === "admin") {
      if (!text.includes("Payment setup") ||
          !text.includes("Connect payments") ||
          !text.includes("Place a test order") ||
          !text.includes("Not ready to sell") ||
          !text.includes("paid TEST order visible in Commerce admin has not been confirmed") ||
          text.includes('"action_id":"connect"')) {
        fail("admin response does not prove the bounded read-only setup screen");
      }
    }
    results.push({ role, status: response.status, body: role === "admin" ? body : undefined });
  }
  await writeFile(join(root, "installed-state.json"), JSON.stringify(state, null, 2) + "\n");
  await writeFile(join(root, "http-proof.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ verified: root, roles: results.map(({ role, status }) => ({ role, status })) }));
}

export { parsePort, prepare, safeNewRunDirectory };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, input, ...options] = process.argv.slice(2);
  try {
    if (!command || !input) fail(usage);
    if (command === "prepare") {
      const portIndex = options.indexOf("--port");
      const port = portIndex === -1 ? 4387 : parsePort(options[portIndex + 1] ?? "");
      await prepare(input, port);
    } else if (command === "verify") await verify(input);
    else fail(usage);
  } catch (error) {
    console.error(`registry-status-proof: ${error.message}`);
    process.exitCode = 64;
  }
}
