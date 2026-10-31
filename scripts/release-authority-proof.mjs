#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BETA_REGISTRY_SLUG,
  EMDASH_PUBLISH_JOB_IF,
  computeTargetVersion,
  readPendingChangesets,
  PACKAGE_NAME,
  STABLE_REGISTRY_SLUG,
  repositoryRoot,
  runReleaseFlowCli,
  validateEmDashDispatchGate,
} from "./release-flow.mjs";

const GATE_SCRIPT_PATH = join(repositoryRoot, ".github/scripts/emdash-dispatch-gate.mjs");

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function verifyEmDashWorkflowContract({ emdashWorkflowText, releaseWorkflowText }) {
  const expectedIfLine = `if: ${EMDASH_PUBLISH_JOB_IF}`;
  if (!emdashWorkflowText.includes(expectedIfLine)) {
    throw new Error(
      `emdash-release.yml publish job if-condition does not match expected rule: ${expectedIfLine}`,
    );
  }

  const gateStepMatch =
    /- name: Enforce dispatch and caller gate before credential use or Registry I\/O[\s\S]*?run:\s*node \.github\/scripts\/emdash-dispatch-gate\.mjs --github-output "\$GITHUB_OUTPUT"/.exec(
      emdashWorkflowText,
    );
  if (!gateStepMatch) {
    throw new Error(
      "emdash-release.yml does not invoke node .github/scripts/emdash-dispatch-gate.mjs in its gate step",
    );
  }

  const gateIdx = emdashWorkflowText.indexOf("node .github/scripts/emdash-dispatch-gate.mjs");
  const prepareIdx = emdashWorkflowText.indexOf("node .github/scripts/prepare-emdash-release.mjs");
  const attestIdx = emdashWorkflowText.indexOf("actions/attest-build-provenance@");
  const mediaIdx = emdashWorkflowText.indexOf("node scripts/registry-release-media.mjs");
  const workflowConnectionIdx = emdashWorkflowText.indexOf(
    "node .github/scripts/ensure-emdash-workflow-connection.mjs",
  );
  const authorityTokenIdx = emdashWorkflowText.indexOf("actions/create-github-app-token@");
  const authorityIdx = emdashWorkflowText.indexOf("node scripts/release-flow.mjs verify-authority");
  const releaseActionIdx = emdashWorkflowText.indexOf("emdash-cms/emdash/apps/release-action@");
  const verifyIdx = emdashWorkflowText.indexOf("node .github/scripts/verify-registry-release.mjs");
  if (
    gateIdx === -1 ||
    prepareIdx === -1 ||
    attestIdx === -1 ||
    mediaIdx === -1 ||
    workflowConnectionIdx === -1 ||
    authorityTokenIdx === -1 ||
    authorityIdx === -1 ||
    releaseActionIdx === -1 ||
    verifyIdx === -1 ||
    !(
      gateIdx < prepareIdx &&
      prepareIdx < attestIdx &&
      attestIdx < mediaIdx &&
      mediaIdx < workflowConnectionIdx &&
      workflowConnectionIdx < authorityTokenIdx &&
      authorityTokenIdx < authorityIdx &&
      authorityIdx < releaseActionIdx &&
      releaseActionIdx < verifyIdx
    )
  ) {
    throw new Error(
      "emdash-release.yml must run .github/scripts/emdash-dispatch-gate.mjs before bundle preparation, build provenance attestation, listing media, EmDash workflow-connection preflight, final release-actor authority check, delegated release-action publish, and PDS verification",
    );
  }

  // emdash-release.yml never pushes branches, tags, PRs, or GitHub Releases; any GitHub App token
  // minted there is strictly permission-contents: read for collaborator permission verification.
  const emdashSteps = emdashWorkflowText.split(/\n(?=      - (?:name|uses): )/);
  const workflowConnectionStep = emdashSteps.find((step) =>
    step.includes("node .github/scripts/ensure-emdash-workflow-connection.mjs"),
  );
  if (
    !workflowConnectionStep ||
    !/--service-url\s+https:\/\/releases\.emdashcms\.com\b/.test(workflowConnectionStep) ||
    /continue-on-error:\s*true/m.test(workflowConnectionStep)
  ) {
    throw new Error(
      "emdash-release.yml workflow-connection step must run ensure-emdash-workflow-connection.mjs against https://releases.emdashcms.com without continue-on-error",
    );
  }
  const appTokenSteps = emdashSteps.filter((step) => step.includes("actions/create-github-app-token@"));
  if (appTokenSteps.length === 0) {
    throw new Error("emdash-release.yml must mint a read-only release App token before final authority verification");
  }
  for (const step of appTokenSteps) {
    if (
      !/^\s+permission-contents:\s*read\s*(?:#.*)?$/m.test(step) ||
      /:\s*write\b/m.test(step) ||
      /^\s+permission-(?!contents:\s*read\s*(?:#.*)?$)/m.test(step) ||
      /continue-on-error:\s*true/m.test(step)
    ) {
      throw new Error(
        "Any actions/create-github-app-token step in emdash-release.yml must set permission-contents: read only and never grant write permissions or continue-on-error",
      );
    }
  }
  const authorityStep = emdashSteps.find((step) => step.includes("node scripts/release-flow.mjs verify-authority"));
  if (
    !authorityStep ||
    !/GH_TOKEN:\s*\$\{\{\s*steps\.authority-token\.outputs\.token\s*\}\}/.test(authorityStep) ||
    !/RELEASE_ACTOR:\s*\$\{\{\s*inputs\.release_actor\s*\}\}/.test(authorityStep) ||
    !/--actor\s+"\$RELEASE_ACTOR"/.test(authorityStep) ||
    /continue-on-error:\s*true/m.test(authorityStep)
  ) {
    throw new Error(
      "emdash-release.yml verify-authority step must enforce inputs.release_actor via steps.authority-token.outputs.token without continue-on-error",
    );
  }
  const releaseActionStep = emdashSteps.find((step) =>
    step.includes("emdash-cms/emdash/apps/release-action@"),
  );
  const timeoutMatch = releaseActionStep
    ? /^\s+timeout-minutes:\s*["']?([1-9][0-9]*)["']?\s*(?:#.*)?$/m.exec(releaseActionStep)
    : null;
  const releaseActionTimeoutMinutes = timeoutMatch ? Number(timeoutMatch[1]) : Number.NaN;
  if (
    !releaseActionStep ||
    !/^\s+wait-for-approval:\s*["']?false["']?\s*(?:#.*)?$/m.test(releaseActionStep) ||
    !Number.isInteger(releaseActionTimeoutMinutes) ||
    releaseActionTimeoutMinutes < 1 ||
    releaseActionTimeoutMinutes > 5
  ) {
    throw new Error(
      "emdash-release.yml release-action step must set wait-for-approval: \"false\" and timeout-minutes <= 5 so no approval wait outlives verify-authority",
    );
  }
  if (/(?:contents|pull-requests|issues|actions):\s*write\b/.test(emdashWorkflowText)) {
    throw new Error("emdash-release.yml must never request write permissions on repository contents, PRs, issues, or actions");
  }

  if (
    emdashWorkflowText.includes("EMDASH_PDS_") ||
    releaseWorkflowText.includes("EMDASH_PDS_") ||
    releaseWorkflowText.includes("secrets: inherit")
  ) {
    throw new Error(
      "Release workflows must not reference legacy EMDASH_PDS_* secrets or secrets: inherit",
    );
  }

  if (
    !emdashWorkflowText.includes("id-token: write") ||
    !emdashWorkflowText.includes("attestations: write") ||
    !releaseWorkflowText.includes("id-token: write") ||
    !releaseWorkflowText.includes("attestations: write")
  ) {
    throw new Error(
      "Both release.yml and emdash-release.yml must grant id-token: write and attestations: write for OIDC delegated publishing",
    );
  }

  if (
    !releaseWorkflowText.includes("uses: ./.github/workflows/emdash-release.yml") ||
    !releaseWorkflowText.includes("release_mode: ${{ needs.release-tag.outputs.release_mode }}") ||
    !releaseWorkflowText.includes("release_actor: ${{ needs.release-tag.outputs.release_actor }}") ||
    !releaseWorkflowText.includes("release_actor: ${{ steps.tag.outputs.release_actor }}") ||
    !releaseWorkflowText.includes("RELEASE_APP_ID: ${{ secrets.RELEASE_APP_ID }}") ||
    !releaseWorkflowText.includes("RELEASE_APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}") ||
    !/^\s+tags: \["v\*\.\*\.\*"\]$/m.test(releaseWorkflowText) ||
    !releaseWorkflowText.includes("needs: release-tag")
  ) {
    throw new Error("release.yml must publish only from its version-tag run, delegating release_mode, release_actor, and explicit App secrets to emdash-release.yml");
  }

  // Cut beta is release.yml's button too: emdash-release.yml has none of its own, so the release
  // service connects both listings through release.yml.
  const emdashTriggers = /^on:\n([\s\S]*?)^\S/m.exec(emdashWorkflowText)?.[1] ?? "";
  if (
    !emdashTriggers.includes("workflow_call:") ||
    emdashTriggers.includes("workflow_dispatch") ||
    !emdashTriggers.includes("release_actor:") ||
    !emdashTriggers.includes("RELEASE_APP_ID:") ||
    !emdashTriggers.includes("RELEASE_APP_PRIVATE_KEY:")
  ) {
    throw new Error("emdash-release.yml must be workflow_call-only with required release_actor input and explicit RELEASE_APP_* secrets");
  }
  if (!/node scripts\/release-flow\.mjs verify-release-tag\b[^\n]*--require-actor\b/.test(releaseWorkflowText)) {
    throw new Error("release.yml's tag run must check the tag sits on its release branch and enforce --require-actor before the Registry job");
  }

  return {
    jobIfMatches: true,
    gateScriptInvokedBeforeCredentials: true,
    callerPassesStableReleaseMode: true,
    callerPassesBetaReleaseMode: true,
    delegatedOidcReleaseConfigured: true,
    finalAuthorityRecheckBeforePublish: true,
    emdashAppTokenReadOnly: true,
  };
}

export async function verifyShippedEmDashWorkflowGateBinding() {
  const emdashWorkflowText = await readFile(
    join(repositoryRoot, ".github/workflows/emdash-release.yml"),
    "utf8",
  );
  const releaseWorkflowText = await readFile(
    join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  return verifyEmDashWorkflowContract({ emdashWorkflowText, releaseWorkflowText });
}

export function runExtractedGateScriptProcess({
  eventName = "",
  ref = "",
  inputVersion = "",
  releaseMode = "",
} = {}) {
  const proc = spawnSync(
    process.execPath,
    [GATE_SCRIPT_PATH],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        GITHUB_EVENT_NAME: eventName,
        EVENT_NAME: eventName,
        GITHUB_REF: ref,
        TARGET_REF: ref,
        INPUT_VERSION: inputVersion,
        INPUT_RELEASE_MODE: releaseMode,
      },
    },
  );

  const stdout = (proc.stdout || "").trim();
  const stderr = (proc.stderr || "").trim();
  let parsed = null;
  if (proc.status === 0 && stdout) {
    try {
      parsed = JSON.parse(stdout.split("\n").at(-1));
    } catch {
      parsed = null;
    }
  }

  return {
    exitCode: proc.status ?? 1,
    stdout,
    stderr,
    parsed,
  };
}

export async function createSeededRepo(prefix, events) {
  const root = await mkdtemp(join(tmpdir(), `payments-release-proof-${prefix}-`));
  await mkdir(join(root, ".changeset"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });

  const initialPkg = {
    name: PACKAGE_NAME,
    version: "0.2.8",
    type: "module",
    scripts: {
      build: "wrangler deploy --dry-run --outdir dist && npm run plugin:build",
    },
    dependencies: {
      jose: "6.2.12",
      stripe: "23.0.0",
    },
  };
  const initialLock = {
    name: PACKAGE_NAME,
    version: "0.2.8",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: PACKAGE_NAME,
        version: "0.2.8",
        dependencies: {
          jose: "6.2.12",
          stripe: "23.0.0",
        },
      },
      "node_modules/stripe": {
        version: "23.0.0",
        resolved: "https://registry.npmjs.org/stripe/-/stripe-23.0.0.tgz",
        integrity: "sha512-stripe2300integrity==",
      },
    },
  };

  await writeFile(join(root, "emdash-plugin.jsonc"), JSON.stringify({ publisher: "did:plc:release-proof" }));
  await writeFile(join(root, "package.json"), `${JSON.stringify(initialPkg, null, 2)}\n`, "utf8");
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify(initialLock, null, 2)}\n`, "utf8");
  await writeFile(
    join(root, "CHANGELOG.md"),
    ["# @dinkuskit/payments", "", "## 0.2.8", "", "- Baseline release."].join("\n") + "\n",
    "utf8",
  );
  await writeFile(join(root, "src/plugin.ts"), `export const pluginVersion = "0.2.8";\n`, "utf8");
  await writeFile(join(root, ".changeset/README.md"), "# Changesets\n", "utf8");
  await writeFile(
    join(root, ".changeset/add-feature.md"),
    `---\n"${PACKAGE_NAME}": patch\n---\n\nFix checkout callback status handling.\n`,
    "utf8",
  );

  git(["init", "-b", "main"], root);
  git(["config", "user.name", "Proof Runner"], root);
  git(["config", "user.email", "proof@example.invalid"], root);
  git(["add", "-A"], root);
  git(["commit", "-m", "feat: baseline with pending changeset"], root);
  git(["tag", "v0.2.8"], root);

  const gitExec = (args, cwd = root) => {
    if (args[0] === "push") {
      events.push(`git:push:${args.slice(1).join(" ")}`);
      return "";
    }
    if (args[0] === "tag" && args[1] !== "--list") {
      const tagName = args.find((arg, i) => i > 0 && !arg.startsWith("-") && args[i - 1] !== "-m") ?? args[1];
      events.push(`git:tag:${tagName}`);
    }
    if (args[0] === "commit") {
      events.push(`git:commit:${args[2]?.split("\n")[0] || ""}`);
    }
    return git(args, cwd);
  };

  return { root, gitExec };
}

export function createStubEnvironment({
  events,
  betaVersions = [],
  stableVersions = [],
  githubReleases = new Set(),
  registryError = null,
  customRegistryResponse = null,
} = {}) {
  const state = {
    betaVersions: [...betaVersions],
    stableVersions: [...stableVersions],
    githubReleases: new Set(githubReleases),
    openPrs: [],
    mergedPrs: [],
  };

  const fetchImpl = async (url) => {
    if (String(url).startsWith("https://plc.directory/")) {
      return { ok: true, json: async () => ({ service: [{ id: "#atproto_pds", serviceEndpoint: "https://proof-pds.example" }] }) };
    }
    events.push("registry:get:release-inventory");
    if (typeof customRegistryResponse === "function") return customRegistryResponse();
    if (registryError) {
      if (registryError.type === "network") throw new Error(registryError.message || "socket hang up");
      return { ok: false, status: registryError.status || 503 };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        records: [
          ...state.betaVersions.map((version) => ({ version, package: BETA_REGISTRY_SLUG })),
          ...state.stableVersions.map((version) => ({ version, package: STABLE_REGISTRY_SLUG })),
        ].map((value) => ({
          uri: `at://did:plc:release-proof/com.emdashcms.experimental.package.release/${value.package}:${value.version}`,
          value,
        })),
      }),
    };
  };

  const ghExec = (args) => {
    if (args[0] === "release" && args[1] === "view") {
      const tag = args[2];
      events.push(`gh:release:view:${tag}`);
      if (!state.githubReleases.has(tag)) {
        throw new Error(`release ${tag} not found`);
      }
      return JSON.stringify({ tagName: tag });
    }
    if (args[0] === "release" && args[1] === "create") {
      const tag = args[2];
      events.push(`gh:release:create:${tag}`);
      state.githubReleases.add(tag);
      return "";
    }
    if (args[0] === "pr" && args[1] === "list") {
      events.push(`gh:pr:list`);
      if (args.includes("merged") && args.includes("title")) return state.mergedPrs.map((pr) => pr.title).join("\n");
      if (args.includes("title")) return state.openPrs[0]?.title ?? "";
      return state.openPrs[0]?.number ? String(state.openPrs[0].number) : "";
    }
    if (args[0] === "pr" && args[1] === "create") {
      const titleIdx = args.indexOf("--title");
      const title = titleIdx !== -1 ? args[titleIdx + 1] : "ci: release";
      events.push(`gh:pr:create:${title}`);
      state.openPrs.push({ number: 55, title });
      return "https://github.com/dinkuskit/payments/pull/55";
    }
    if (args[0] === "pr" && args[1] === "edit") {
      events.push(`gh:pr:edit:${args[2]}`);
      return "";
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };

  // Stands in for `npm run release:version` (changeset version plus the manifest sync): the version
  // pending changesets make, a CHANGELOG section listing them, and every changeset consumed.
  const npmExec = async (args, cwd) => {
    events.push(`npm:${args.join(" ")}`);
    if (args[0] === "run" && args[1] === "release:version") {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      const pending = await readPendingChangesets(cwd, { includeEmpty: true });
      const bumping = pending.filter((entry) => !entry.empty);
      const version = computeTargetVersion(pkg.version, bumping.map((entry) => entry.bump));
      for (const file of ["package.json", "package-lock.json", "emdash-plugin.jsonc"]) {
        const path = join(cwd, file);
        const value = JSON.parse(await readFile(path, "utf8"));
        // A manifest without a version (the Registry workspace stamps it) stays without one.
        if (file !== "emdash-plugin.jsonc" || "version" in value) value.version = version;
        if (value.packages?.[""]) value.packages[""].version = version;
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      }
      const changelogPath = join(cwd, "CHANGELOG.md");
      const changelog = await readFile(changelogPath, "utf8");
      const lines = bumping.map((entry) => `- ${entry.summary}`).join("\n");
      await writeFile(
        changelogPath,
        changelog.replace(/^## /m, `## ${version}\n\n### Changes\n\n${lines}\n\n## `),
        "utf8",
      );
      for (const entry of pending) {
        await rm(join(cwd, entry.filePath), { force: true });
      }
    }
  };

  return { state, fetchImpl, ghExec, npmExec };
}

// Runs emdash-release.yml's gate the way a version tag's run reaches it: the real extracted gate
// script as a child process, checked against the JS gate, then the publish when both allow it.
async function runRegistryJobSimulation({ eventName, ref, inputVersion = "", releaseMode = "", events, runPublish }) {
  events.push(
    `workflow:emdash-release:start:event=${eventName}:ref=${ref}:mode=${releaseMode || "(none)"}:version=${inputVersion || "(none)"}`,
  );

  const scriptResult = runExtractedGateScriptProcess({ eventName, ref, inputVersion, releaseMode });
  const jsGate = validateEmDashDispatchGate({ eventName, ref, inputVersion, releaseMode });

  if (Boolean(scriptResult.exitCode === 0) !== jsGate.ok) {
    throw new Error(
      `Gate script / JS mismatch for event=${eventName} ref=${ref} version=${inputVersion} mode=${releaseMode}: scriptExit=${scriptResult.exitCode}, jsOk=${jsGate.ok}`,
    );
  }

  if (!jsGate.ok) {
    events.push(`workflow:emdash-release:gate-script:exit=${scriptResult.exitCode}:code=${jsGate.code}`);
    return { ok: false, gate: jsGate, scriptResult };
  }

  events.push(`workflow:emdash-release:gate-script:exit=0:mode=${jsGate.mode}`);
  await runPublish(jsGate.slug, jsGate.requestedVersion);
  return { ok: true, gate: jsGate, scriptResult };
}

function cliDeps(root, gitExec, env, logs = []) {
  return {
    root,
    gitExec,
    ghExec: env.ghExec,
    fetchImpl: env.fetchImpl,
    npmExec: env.npmExec,
    log: (line) => logs.push(line),
  };
}

export async function commitOnMain(root, files, message) {
  git(["checkout", "-q", "-f", "main"], root);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(root, path), { force: true });
    } else {
      await writeFile(join(root, path), content, "utf8");
    }
  }
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", message], root);
  return git(["rev-parse", "HEAD"], root);
}

// Merges the ci: release PR into main with a merge commit, the other way GitHub merges it.
function mergeCommitReleasePr(root) {
  git(["checkout", "-q", "-f", "main"], root);
  git(["merge", "-q", "--no-ff", "-m", "Merge pull request #55 from dinkuskit/changeset-release/main", "changeset-release/main"], root);
  return git(["rev-parse", "HEAD"], root);
}

// Squash-merges the ci: release PR into main with the PR's message, the way the owner merges it.
export function squashMergeReleasePr(root) {
  const message = git(["log", "-1", "--format=%B", "changeset-release/main"], root);
  git(["checkout", "-q", "-f", "main"], root);
  git(["merge", "-q", "--squash", "changeset-release/main"], root);
  git(["commit", "-q", "-m", message], root);
  return git(["rev-parse", "HEAD"], root);
}

// A version tag's run: release.yml's tag job, then the Registry job with the tag's release_mode.
async function runTagRun({ root, gitExec, env, events, tag }) {
  const ref = `refs/tags/${tag}`;
  events.push(`workflow:release:push:${ref}`);
  const checked = await runReleaseFlowCli(["verify-release-tag", "--ref", ref], cliDeps(root, gitExec, env));
  const registry = await runRegistryJobSimulation({
    eventName: "push",
    ref,
    inputVersion: checked.version,
    releaseMode: checked.releaseMode,
    events,
    runPublish: async (slug, version) => {
      const check = await runReleaseFlowCli(
        ["check-registry-version", "--slug", slug, "--version", version],
        cliDeps(root, gitExec, env),
      );
      if (!check.alreadyPublished) {
        events.push("credential:oidc-attest-provenance");
        events.push(`registry:publish:${slug}@${version}`);
        (slug === BETA_REGISTRY_SLUG ? env.state.betaVersions : env.state.stableVersions).push(version);
      }
    },
  });
  return { checked, registry };
}

const SIDE_EFFECT = (e) =>
  e.startsWith("git:tag:") ||
  e.startsWith("git:push:") ||
  e.startsWith("gh:release:create:") ||
  e.startsWith("registry:publish:");

async function captureError(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function withSeededRepo(prefix, body) {
  const events = [];
  const { root, gitExec } = await createSeededRepo(prefix, events);
  try {
    return await body({ events, root, gitExec });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const FEATURE_CHANGESET = `---\n"${PACKAGE_NAME}": minor\n---\n\nAdd gift notes at checkout.\n`;
const FIX_CHANGESET = `---\n"${PACKAGE_NAME}": patch\n---\n\nKeep the shipping total after a refresh.\n`;

export async function runReleaseAuthorityProof() {
  const workflowBinding = await verifyShippedEmDashWorkflowGateBinding();
  const scenarios = [];

  // Scenario (a): the whole path. Cut beta makes release/0.2.9 and its beta, a feature merges to
  // main while the beta is on test, Promote opens the release PR, the merge tags v0.2.9 on the
  // branch, and the tag run publishes stable. Main keeps the feature's changeset for the next cut.
  await withSeededRepo("approved-path", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    const cut = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    const betaRun = await runTagRun({ root, gitExec, env, events, tag: cut.betaTag });

    const featureSha = await commitOnMain(root, { ".changeset/gift-notes.md": FEATURE_CHANGESET, "src/gift.ts": "export const gift = true;\n" }, "feat: gift notes");
    const promoted = await runReleaseFlowCli(
      ["promote", "--beta-version", cut.version, "--proof-ref", `https://github.com/dinkuskit/live-journeys/actions/runs/701 (${cut.version} @running pass)`],
      cliDeps(root, gitExec, env),
    );
    const prFiles = git(["diff", "--name-only", "main", "changeset-release/main"], root).split("\n").filter(Boolean);
    squashMergeReleasePr(root);
    events.push("workflow:release:push:refs/heads/main");
    const finished = await runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env));
    const stableRun = await runTagRun({ root, gitExec, env, events, tag: finished.tag });

    git(["checkout", "-q", "-f", "main"], root);
    const mainPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const mainPending = (await readPendingChangesets(root)).map((entry) => entry.filePath);
    const branchHasFeature = git(["branch", "--contains", featureSha], root).includes("release/0.2.9");
    const ok =
      cut.version === "0.2.9-beta.1" &&
      cut.releaseBranch === "release/0.2.9" &&
      betaRun.registry.ok &&
      env.state.betaVersions.includes("0.2.9-beta.1") &&
      promoted.releaseBranch === "release/0.2.9" &&
      prFiles.every((path) => ["package.json", "package-lock.json", "emdash-plugin.jsonc", "CHANGELOG.md", ".changeset/add-feature.md"].includes(path)) &&
      finished.tagPushed &&
      stableRun.checked.githubReleaseCreated &&
      env.state.stableVersions.includes("0.2.9") &&
      mainPkg.version === "0.2.9" &&
      mainPending.length === 1 &&
      mainPending[0] === ".changeset/gift-notes.md" &&
      !branchHasFeature;
    if (!ok) {
      throw new Error(
        `Scenario (a) failed: ${JSON.stringify({ cut, prFiles, finished, mainVersion: mainPkg.version, mainPending, branchHasFeature })}`,
      );
    }
    scenarios.push({
      id: "a",
      name: "release_branch_path_succeeds_while_main_keeps_merging",
      status: "PASS",
      outcome: {
        betaVersion: cut.version,
        releaseBranch: cut.releaseBranch,
        promotedTarget: promoted.targetVersion,
        releasePrFiles: prFiles,
        stableTag: finished.tag,
        githubReleaseCreated: stableRun.checked.githubReleaseCreated,
        mainStillPending: mainPending,
      },
      sideEffects: events,
    });
  });

  // Scenario (b): a Run workflow press on a branch never publishes, whatever version or mode it
  // names; only Retry the publish pressed on a version tag reaches the tag's own publish.
  {
    const events = [];
    const cases = [
      { inputVersion: "", releaseMode: "beta" },
      { inputVersion: "0.2.9-beta.1", releaseMode: "beta" },
      { inputVersion: "0.2.9", releaseMode: "stable" },
    ];
    const results = [];
    for (const item of cases) {
      results.push(
        await runRegistryJobSimulation({
          eventName: "workflow_dispatch",
          ref: "refs/heads/main",
          ...item,
          events,
          runPublish: async () => events.push("UNEXPECTED:publish"),
        }),
      );
    }
    const retry = await runRegistryJobSimulation({
      eventName: "workflow_dispatch",
      ref: "refs/tags/v0.2.9-beta.1",
      inputVersion: "0.2.9-beta.1",
      releaseMode: "beta",
      events,
      runPublish: async (slug, version) => events.push(`retry:${slug}@${version}`),
    });
    if (
      results.some((res) => res.ok || res.gate.code !== "dispatch_publish_forbidden") ||
      events.some((e) => e.startsWith("UNEXPECTED:")) ||
      !retry.ok ||
      !events.includes(`retry:${BETA_REGISTRY_SLUG}@0.2.9-beta.1`)
    ) {
      throw new Error("Scenario (b) failed: a workflow_dispatch reached the Registry publish");
    }
    scenarios.push({
      id: "b",
      name: "button_runs_on_branches_never_publish_retry_runs_on_the_tag",
      status: "PASS",
      outcome: { codes: results.map((res) => res.gate.code), scriptExitCodes: results.map((res) => res.scriptResult.exitCode) },
      sideEffects: events,
    });
  }

  // Scenario (c): a push to a branch (main or a release branch) never publishes; only a version tag does.
  {
    const events = [];
    const refs = ["refs/heads/main", "refs/heads/release/0.2.9", "refs/tags/release-0.2.9"];
    const results = [];
    for (const ref of refs) {
      results.push(
        await runRegistryJobSimulation({
          eventName: "push",
          ref,
          inputVersion: "0.2.9",
          releaseMode: "stable",
          events,
          runPublish: async () => events.push("UNEXPECTED:publish"),
        }),
      );
    }
    if (results.some((res) => res.ok || res.gate.code !== "forbidden_caller_ref") || events.some((e) => e.startsWith("UNEXPECTED:"))) {
      throw new Error("Scenario (c) failed: a branch push reached the Registry publish");
    }
    scenarios.push({
      id: "c",
      name: "branch_pushes_rejected_only_version_tags_publish",
      status: "PASS",
      outcome: { refs, codes: results.map((res) => res.gate.code) },
      sideEffects: events,
    });
  }

  // Scenario (d): a commit pushed onto the release branch after the beta (not through Add fix to
  // beta) stops Promote, and stops the merged release PR from tagging.
  await withSeededRepo("branch-moved", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    const cut = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(cut.version);
    const proofRef = `run-702 (${cut.version} @running pass)`;
    await runReleaseFlowCli(["promote", "--beta-version", cut.version, "--proof-ref", proofRef], cliDeps(root, gitExec, env));
    squashMergeReleasePr(root);

    git(["checkout", "-q", "-f", "release/0.2.9"], root);
    await writeFile(join(root, "src/plugin.ts"), `export const pluginVersion = "tampered";\n`, "utf8");
    git(["commit", "-q", "-am", "untested change"], root);
    git(["checkout", "-q", "-f", "main"], root);

    const promoteError = await captureError(() =>
      runReleaseFlowCli(["promote", "--beta-version", cut.version, "--proof-ref", proofRef], cliDeps(root, gitExec, env)),
    );
    git(["checkout", "-q", "-f", "main"], root);
    events.length = 0;
    const tagError = await captureError(() => runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env)));
    const sideEffects = events.filter(SIDE_EFFECT);
    if (!promoteError?.includes("has moved past") || !tagError?.includes("has moved past") || sideEffects.length > 0) {
      throw new Error(`Scenario (d) failed: ${JSON.stringify({ promoteError, tagError, sideEffects })}`);
    }
    scenarios.push({
      id: "d",
      name: "untested_change_on_release_branch_rejected_before_tagging",
      status: "PASS",
      outcome: { promoteError, tagError, stableSideEffectsCount: 0 },
      sideEffects: events,
    });
  });

  // Scenario (e): a merge run (here a merge commit, not a squash) that committed the release onto
  // the branch but stopped before the tag resumes from that commit; a run after the tag exists does nothing (the tag's own run publishes).
  await withSeededRepo("resume", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    const cut = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(cut.version);
    await runReleaseFlowCli(
      ["promote", "--beta-version", cut.version, "--proof-ref", `run-703 (${cut.version} @running pass)`],
      cliDeps(root, gitExec, env),
    );
    const mergeSha = mergeCommitReleasePr(root);
    const failingTag = (args, cwd) => {
      if (args[0] === "tag" && args[1] === "v0.2.9") throw new Error("simulated runner loss before tagging");
      return gitExec(args, cwd);
    };
    const firstError = await captureError(() => runReleaseFlowCli(["publish-merged-release"], { ...cliDeps(root, failingTag, env) }));
    git(["checkout", "-q", "-f", mergeSha], root);
    const resumed = await runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env));
    const again = await runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env));
    const stableRun = await runTagRun({ root, gitExec, env, events, tag: "v0.2.9" });
    if (!firstError || !resumed.tagPushed || !resumed.resumed || again.tagPushed || again.reason !== "tag_already_exists" || !env.state.stableVersions.includes("0.2.9") || !stableRun.checked.githubReleaseCreated) {
      throw new Error(`Scenario (e) failed: ${JSON.stringify({ firstError, resumed, again })}`);
    }
    scenarios.push({
      id: "e",
      name: "interrupted_merge_run_resumes_from_its_release_commit",
      status: "PASS",
      outcome: { firstError, resumed: resumed.resumed, secondRun: again.reason, stablePublished: true },
      sideEffects: events,
    });
  });

  // Scenario (f): a Registry lookup failure stops Cut beta before any branch or tag.
  await withSeededRepo("registry-failure", async ({ events, root, gitExec }) => {
    const errors = [];
    for (const registryError of [{ type: "network", message: "socket hang up" }, { status: 503 }]) {
      const env = createStubEnvironment({ events, registryError });
      errors.push(await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env))));
    }
    const branches = git(["branch", "--list", "release/*"], root);
    const sideEffects = events.filter(SIDE_EFFECT);
    if (errors.some((error) => !error) || branches || sideEffects.length > 0) {
      throw new Error(`Scenario (f) failed: ${JSON.stringify({ errors, branches, sideEffects })}`);
    }
    scenarios.push({
      id: "f",
      name: "registry_lookup_failure_aborts_cut_beta_before_branch_or_tag",
      status: "PASS",
      outcome: { errors, releaseBranchesCreated: 0 },
      sideEffects: events,
    });
  });

  // Scenario (g): an empty changeset passes the PR check and makes no bump; with only empty
  // changesets pending, Cut beta refuses (nothing to give a store).
  await withSeededRepo("empty-changeset", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    await commitOnMain(root, { ".changeset/add-feature.md": null, ".changeset/docs-only.md": "---\n---\n\nDocs only.\n" }, "docs: only");
    const emptyOnlyError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    await commitOnMain(root, { ".changeset/add-feature.md": FIX_CHANGESET }, "fix: shipping total");
    git(["checkout", "-q", "-b", "feat/docs-plus-fix", "HEAD~1"], root);
    await writeFile(join(root, ".changeset/empty-note.md"), "---\n---\n\nNotes only.\n", "utf8");
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", "docs: notes"], root);
    const prCheck = await runReleaseFlowCli(
      ["check-pr", "--base", "main", "--head", "feat/docs-plus-fix", "--title", "docs: notes"],
      {
        ...cliDeps(root, (args, cwd) => (args[0] === "diff" && String(args[3]).startsWith("origin/") ? gitExec([args[0], args[1], args[2], args[3].replace("origin/", "")], cwd) : gitExec(args, cwd)), env),
      },
    );
    git(["checkout", "-q", "-f", "main"], root);
    const cut = await runReleaseFlowCli(["plan-beta"], cliDeps(root, gitExec, env));
    if (!emptyOnlyError?.includes("nothing version-bumping") || prCheck.changesetFiles.length !== 1 || cut.version !== "0.2.9-beta.1" || cut.changesetCount !== 1) {
      throw new Error(`Scenario (g) failed: ${JSON.stringify({ emptyOnlyError, prCheck, cut })}`);
    }
    scenarios.push({
      id: "g",
      name: "empty_changesets_make_no_bump_and_no_beta",
      status: "PASS",
      outcome: { emptyOnlyError, prCheckFiles: prCheck.changesetFiles, plannedBeta: cut.version, versionBumpingChangesetCount: cut.changesetCount },
      sideEffects: events,
    });
  });

  // Scenario (h): Add fix to beta copies a merged main commit onto the branch and tags beta.2. A
  // commit that is not on main, one already on the branch, and one that does not copy cleanly are
  // refused with nothing pushed.
  await withSeededRepo("add-fix", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    const cut = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(cut.version);
    const fixSha = await commitOnMain(root, { ".changeset/shipping-total.md": FIX_CHANGESET, "src/plugin.ts": `export const pluginVersion = "0.2.9";\n` }, "fix: keep the shipping total");
    const added = await runReleaseFlowCli(["add-fix", "--release-version", "0.2.9", "--commit", fixSha], cliDeps(root, gitExec, env));

    git(["checkout", "-q", "-b", "unmerged", "main"], root);
    await writeFile(join(root, "src/unmerged.ts"), "export const x = 1;\n", "utf8");
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", "unmerged"], root);
    const unmergedSha = git(["rev-parse", "HEAD"], root);
    git(["checkout", "-q", "-f", "main"], root);
    const conflictSha = await commitOnMain(root, { "src/plugin.ts": `export const pluginVersion = "conflict";\n` }, "refactor: plugin version");
    git(["checkout", "-q", "-f", "release/0.2.9"], root);
    await writeFile(join(root, "src/plugin.ts"), `export const pluginVersion = "branch-only";\n`, "utf8");
    git(["commit", "-q", "-am", "branch-only edit"], root);
    git(["checkout", "-q", "-f", "main"], root);

    events.length = 0;
    const unmergedError = await captureError(() => runReleaseFlowCli(["add-fix", "--release-version", "0.2.9", "--commit", unmergedSha], cliDeps(root, gitExec, env)));
    const duplicateError = await captureError(() => runReleaseFlowCli(["add-fix", "--release-version", "0.2.9", "--commit", fixSha], cliDeps(root, gitExec, env)));
    const conflictError = await captureError(() => runReleaseFlowCli(["add-fix", "--release-version", "0.2.9", "--commit", conflictSha], cliDeps(root, gitExec, env)));
    const sideEffects = events.filter(SIDE_EFFECT);
    const pickedMessage = git(["log", "-1", "--format=%B", added.betaSha], root);
    if (
      added.version !== "0.2.9-beta.2" ||
      !pickedMessage.includes(`(cherry picked from commit ${fixSha})`) ||
      !unmergedError?.includes("is not a commit on main") ||
      !duplicateError?.includes("already on release/0.2.9") ||
      !conflictError?.includes("does not copy cleanly") ||
      sideEffects.length > 0
    ) {
      throw new Error(`Scenario (h) failed: ${JSON.stringify({ added, unmergedError, duplicateError, conflictError, sideEffects })}`);
    }
    scenarios.push({
      id: "h",
      name: "add_fix_copies_only_merged_main_commits_and_tags_next_beta",
      status: "PASS",
      outcome: { betaVersion: added.version, cherryPickRecorded: true, unmergedError, duplicateError, conflictError },
      sideEffects: events,
    });
  });

  // Scenario (i): a fix for a released version goes on a patch branch made from its tag; a patch
  // branch whose changesets would make a minor release is refused at Promote.
  await withSeededRepo("patch-branch", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    const cut = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(cut.version);
    await runReleaseFlowCli(["promote", "--beta-version", cut.version, "--proof-ref", `run-709 (${cut.version} @running pass)`], cliDeps(root, gitExec, env));
    squashMergeReleasePr(root);
    await runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env));

    const releasedError = await captureError(async () => {
      const sha = await commitOnMain(root, { ".changeset/late.md": FIX_CHANGESET, "src/late.ts": "export const late = 1;\n" }, "fix: late");
      await runReleaseFlowCli(["add-fix", "--release-version", "0.2.9", "--commit", sha], cliDeps(root, gitExec, env));
    });
    const lateSha = git(["rev-parse", "main"], root);
    const patch = await runReleaseFlowCli(["add-fix", "--release-version", "0.2.10", "--commit", lateSha], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(patch.version);
    const patchBaseSha = git(["rev-list", "-n", "1", "v0.2.9"], root);
    const branchParent = git(["rev-parse", `${patch.betaSha}^`], root);

    const minorSha = await commitOnMain(root, { ".changeset/minor.md": FEATURE_CHANGESET, "src/minor.ts": "export const minor = 1;\n" }, "feat: minor");
    const minorBeta = await runReleaseFlowCli(["add-fix", "--release-version", "0.2.10", "--commit", minorSha], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(minorBeta.version);
    const minorPromoteError = await captureError(() =>
      runReleaseFlowCli(["promote", "--beta-version", minorBeta.version, "--proof-ref", `run-710 (${minorBeta.version} @running pass)`], cliDeps(root, gitExec, env)),
    );
    if (
      !releasedError?.includes("already released") ||
      patch.version !== "0.2.10-beta.1" ||
      patch.patchBase !== "v0.2.9" ||
      branchParent !== patchBaseSha ||
      !minorPromoteError?.includes("make 0.3.0, not 0.2.10")
    ) {
      throw new Error(`Scenario (i) failed: ${JSON.stringify({ releasedError, patch, branchParent, patchBaseSha, minorPromoteError })}`);
    }
    scenarios.push({
      id: "i",
      name: "released_version_fix_uses_patch_branch_from_its_tag",
      status: "PASS",
      outcome: { releasedError, patchBeta: patch.version, patchBase: patch.patchBase, minorPromoteError },
      sideEffects: events,
    });
  });

  // Scenario (j): a version tag that is not on its release branch is refused before the Registry
  // job, and a tag run with the wrong release_mode or version never publishes.
  await withSeededRepo("stray-tag", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    git(["tag", "v0.2.9-beta.1", "main"], root);
    const strayError = await captureError(() => runReleaseFlowCli(["verify-release-tag", "--ref", "refs/tags/v0.2.9-beta.1"], cliDeps(root, gitExec, env)));
    const mismatches = [];
    for (const item of [
      { ref: "refs/tags/v0.2.9-beta.1", inputVersion: "0.2.9-beta.1", releaseMode: "stable" },
      { ref: "refs/tags/v0.2.9", inputVersion: "0.2.9", releaseMode: "beta" },
      { ref: "refs/tags/v0.2.9", inputVersion: "0.2.10", releaseMode: "stable" },
    ]) {
      mismatches.push(
        await runRegistryJobSimulation({ eventName: "push", ...item, events, runPublish: async () => events.push("UNEXPECTED:publish") }),
      );
    }
    if (!strayError?.includes("is not a commit on release/0.2.9") || mismatches.some((res) => res.ok) || events.some((e) => e.startsWith("UNEXPECTED:"))) {
      throw new Error(`Scenario (j) failed: ${JSON.stringify({ strayError, codes: mismatches.map((res) => res.gate.code) })}`);
    }
    scenarios.push({
      id: "j",
      name: "stray_tag_and_mismatched_tag_runs_rejected",
      status: "PASS",
      outcome: { strayError, codes: mismatches.map((res) => res.gate.code) },
      sideEffects: events,
    });
  });

  // Scenario (k): a stable tag whose commit changes a dependency, a script, or the lockfile beyond
  // the version is refused by the tag run before its GitHub Release. (Payments' manifest carries no
  // version, so any manifest change is outside the release files.)
  {
    const variants = {
      dependency: (pkg) => ({ ...pkg, dependencies: { ...pkg.dependencies, stripe: "24.0.0" } }),
      script: (pkg) => ({ ...pkg, scripts: { ...pkg.scripts, postinstall: "node steal.js" } }),
    };
    const errors = {};
    for (const [label, edit] of Object.entries({ ...variants, lockfile: null })) {
      await withSeededRepo(`tampered-${label}`, async ({ events, root, gitExec }) => {
        const env = createStubEnvironment({ events });
        const cut = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
        env.state.betaVersions.push(cut.version);
        await runReleaseFlowCli(["promote", "--beta-version", cut.version, "--proof-ref", `run-711 (${cut.version} @running pass)`], cliDeps(root, gitExec, env));
        squashMergeReleasePr(root);
        const done = await runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env));

        git(["checkout", "-q", "-f", "release/0.2.9"], root);
        if (edit) {
          const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
          await writeFile(join(root, "package.json"), `${JSON.stringify(edit(pkg), null, 2)}\n`, "utf8");
        } else if (label === "lockfile") {
          const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
          lock.packages["node_modules/stripe"].version = "24.0.0";
          await writeFile(join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
        } else {
          const manifest = JSON.parse(await readFile(join(root, "emdash-plugin.jsonc"), "utf8"));
          manifest.capabilities = [...manifest.capabilities, "email:send"];
          await writeFile(join(root, "emdash-plugin.jsonc"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        }
        const message = git(["log", "-1", "--format=%B"], root);
        git(["commit", "-q", "-a", "--amend", "-m", message], root);
        git(["tag", "-f", done.tag, "HEAD"], root);
        events.length = 0;
        errors[label] = await captureError(() => runTagRun({ root, gitExec, env, events, tag: done.tag }));
        if (events.filter(SIDE_EFFECT).length > 0) errors[label] = null;
      });
    }
    if (Object.values(errors).some((error) => !error)) {
      throw new Error(`Scenario (k) failed: ${JSON.stringify(errors)}`);
    }
    scenarios.push({
      id: "k",
      name: "dependency_script_and_lockfile_changes_on_stable_tag_rejected",
      status: "PASS",
      outcome: errors,
      sideEffects: [],
    });
  }

  // Scenario (l): a malformed Registry 200 (`{}`, an error-shaped object, a malformed entry) stops
  // Cut beta before any branch or tag.
  await withSeededRepo("malformed-registry", async ({ events, root, gitExec }) => {
    const errors = {};
    for (const item of [
      { label: "empty_object", body: {} },
      { label: "error_shaped_200", body: { error: "RateLimited", message: "try later" } },
      { label: "malformed_version_entry", body: { records: [{ bad: true }] } },
    ]) {
      const env = createStubEnvironment({
        events,
        customRegistryResponse: () => ({ ok: true, status: 200, json: async () => item.body }),
      });
      errors[item.label] = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    }
    const betaTags = git(["tag", "--list", "v0.2.9-beta.*"], root).split("\n").filter(Boolean);
    const branches = git(["branch", "--list", "release/*"], root);
    if (Object.values(errors).some((error) => !error) || betaTags.length > 0 || branches || events.some(SIDE_EFFECT)) {
      throw new Error(`Scenario (l) failed: ${JSON.stringify({ errors, betaTags, branches })}`);
    }
    scenarios.push({
      id: "l",
      name: "malformed_registry_200_responses_abort_cut_beta_before_branch_or_tag",
      status: "PASS",
      outcome: { ...errors, betaTagsCreated: 0 },
      sideEffects: events,
    });
  });

  // Scenario (m): a patch branch waits while another release is on test, and a fix whose changeset
  // a newer main release already used still releases on its patch branch. Every beta and stable
  // push sends the branch and its tag in one atomic push.
  await withSeededRepo("backport-after-newer-release", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    const first = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(first.version);
    await runReleaseFlowCli(["promote", "--beta-version", first.version, "--proof-ref", `run-720 (${first.version} @running pass)`], cliDeps(root, gitExec, env));
    squashMergeReleasePr(root);
    await runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env));

    const fixSha = await commitOnMain(root, { ".changeset/backport.md": FIX_CHANGESET, "src/backport.ts": "export const backport = 1;\n" }, "fix: backport");
    await commitOnMain(root, { ".changeset/minor.md": FEATURE_CHANGESET, "src/minor.ts": "export const minor = 1;\n" }, "feat: minor");
    const minor = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(minor.version);
    const onTestError = await captureError(() =>
      runReleaseFlowCli(["add-fix", "--release-version", "0.2.10", "--commit", fixSha], cliDeps(root, gitExec, env)),
    );
    await runReleaseFlowCli(["promote", "--beta-version", minor.version, "--proof-ref", `run-721 (${minor.version} @running pass)`], cliDeps(root, gitExec, env));
    squashMergeReleasePr(root);
    await runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env));
    const mainHadChangeset = existsSync(join(root, ".changeset/backport.md"));

    const patch = await runReleaseFlowCli(["add-fix", "--release-version", "0.2.10", "--commit", fixSha], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(patch.version);
    await runReleaseFlowCli(["promote", "--beta-version", patch.version, "--proof-ref", `run-722 (${patch.version} @running pass)`], cliDeps(root, gitExec, env));
    squashMergeReleasePr(root);
    const done = await runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env));
    const mainPkg = JSON.parse(git(["show", "main:package.json"], root));
    const pushes = events.filter((e) => e.startsWith("git:push:") && !e.includes("changeset-release/main"));

    if (
      !onTestError?.includes(`release/${minor.version.replace(/-beta\.\d+$/, "")} is still on test`) ||
      mainHadChangeset ||
      patch.version !== "0.2.10-beta.1" ||
      !done.tagPushed ||
      !done.consumedChangesets.includes(".changeset/backport.md") ||
      mainPkg.version !== minor.version.replace(/-beta\.\d+$/, "") ||
      pushes.length === 0 ||
      pushes.some((e) => !e.startsWith("git:push:--atomic origin "))
    ) {
      throw new Error(`Scenario (m) failed: ${JSON.stringify({ onTestError, mainHadChangeset, patch, done, mainVersion: mainPkg.version, pushes })}`);
    }
    scenarios.push({
      id: "m",
      name: "patch_branch_waits_for_release_on_test_and_backport_keeps_consumed_changesets",
      status: "PASS",
      outcome: { onTestError, stableTag: done.tag, consumedChangesets: done.consumedChangesets, mainVersion: mainPkg.version },
      sideEffects: events,
    });
  });

  // Scenario (n): Cut beta pressed while a beta is on test re-cuts it through the release App
  // (release-branch-recut-20261030). With nothing new on main it refuses. The same version moves
  // forward to main, Add fix copies included (even of lines main changed again), and tags the next
  // beta. A commit only on the branch, an Add fix copy amended with extra lines, another file mode,
  // other binary bytes or another last newline, or a ci: release PR for it that is open or merged
  // without its tag stops the run with nothing pushed. A new version drops the older branch (its
  // beta tags stay) in the same atomic push.
  await withSeededRepo("recut-on-test", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    const first = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(first.version);
    const target = first.version.replace(/-beta\.\d+$/, "");
    const branch = first.releaseBranch;
    const sameCodeError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));

    const fixSha = await commitOnMain(root, { ".changeset/fix-one.md": FIX_CHANGESET, "src/fix-one.ts": "export const one = 1;\n" }, "fix: one");
    const firstTip = git(["rev-parse", branch], root);
    events.length = 0;
    const moved = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(moved.version);
    const movedPush = events.find((e) => e.startsWith("git:push:")) ?? "";

    const copySha = await commitOnMain(root, { "src/fix-two.ts": "export const two = 2;\n" }, "fix: two");
    const copied = await runReleaseFlowCli(["add-fix", "--release-version", target, "--commit", copySha], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(copied.version);
    git(["checkout", "-q", "-f", "main"], root);
    const copiedSameCodeError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    await commitOnMain(root, { "src/fix-three.ts": "export const three = 3;\n" }, "fix: three");
    const overCopy = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(overCopy.version);

    // Two Add fix copies to the same line, then main edits that line again: both copies still count.
    const lineOnceSha = await commitOnMain(root, { "src/fix-one.ts": "export const one = 11;\n" }, "fix: one again");
    env.state.betaVersions.push((await runReleaseFlowCli(["add-fix", "--release-version", target, "--commit", lineOnceSha], cliDeps(root, gitExec, env))).version);
    const lineTwiceSha = await commitOnMain(root, { "src/fix-one.ts": "export const one = 111;\n" }, "fix: one once more");
    env.state.betaVersions.push((await runReleaseFlowCli(["add-fix", "--release-version", target, "--commit", lineTwiceSha], cliDeps(root, gitExec, env))).version);
    git(["checkout", "-q", "-f", "main"], root);
    const settledSha = await commitOnMain(root, { "src/fix-one.ts": "export const one = 1111;\n" }, "fix: one settled");
    const overEdits = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(overEdits.version);

    git(["checkout", "-q", "-f", branch], root);
    await writeFile(join(root, "src/branch-only.ts"), "export const stray = 1;\n", "utf8");
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", "branch-only edit"], root);
    const strayTip = git(["rev-parse", "HEAD"], root);
    await commitOnMain(root, { "src/fix-four.ts": "export const four = 4;\n" }, "fix: four");
    events.length = 0;
    const strayError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    const straySideEffects = events.filter(SIDE_EFFECT);
    git(["branch", "-f", branch, `${strayTip}^`], root);

    // An Add fix copy amended with extra changes keeps its trailer but is not a copy.
    git(["checkout", "-q", "-f", branch], root);
    await writeFile(join(root, "src/fix-two.ts"), "export const two = 2;\nexport const extra = true;\n", "utf8");
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", `fix: two\n\n(cherry picked from commit ${copySha})`], root);
    const amendedTip = git(["rev-parse", "HEAD"], root);
    git(["checkout", "-q", "-f", "main"], root);
    events.length = 0;
    const amendedError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    const amendedSideEffects = events.filter(SIDE_EFFECT);
    git(["branch", "-f", branch, `${amendedTip}^`], root);

    // The same copy with only its file mode changed, and a copy of a binary file with other bytes.
    git(["checkout", "-q", "-f", branch], root);
    await writeFile(join(root, "src/fix-two.ts"), "export const two = 2;\n", "utf8");
    git(["add", "-A"], root);
    git(["update-index", "--chmod=+x", "src/fix-two.ts"], root);
    git(["commit", "-q", "-m", `fix: two\n\n(cherry picked from commit ${copySha})`], root);
    const modeTip = git(["rev-parse", "HEAD"], root);
    git(["checkout", "-q", "-f", "main"], root);
    const modeError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    git(["branch", "-f", branch, `${modeTip}^`], root);

    // Bytes that decode to the same text (00 80 0a and 00 81 0a) still differ.
    const binarySha = await commitOnMain(root, { "src/logo.bin": Buffer.from([0x00, 0x80, 0x0a]) }, "chore: logo");
    git(["checkout", "-q", "-f", branch], root);
    await writeFile(join(root, "src/logo.bin"), Buffer.from([0x00, 0x81, 0x0a]));
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", `chore: logo\n\n(cherry picked from commit ${binarySha})`], root);
    const binaryTip = git(["rev-parse", "HEAD"], root);
    git(["checkout", "-q", "-f", "main"], root);
    events.length = 0;
    const binaryError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    const binarySideEffects = events.filter(SIDE_EFFECT);
    git(["branch", "-f", branch, `${binaryTip}^`], root);

    // A copy that differs only in the file's last newline.
    const newlineSha = await commitOnMain(root, { "src/note.txt": "note\n" }, "docs: note");
    git(["checkout", "-q", "-f", branch], root);
    await writeFile(join(root, "src/note.txt"), "note", "utf8");
    git(["add", "-A"], root);
    git(["commit", "-q", "-m", `docs: note\n\n(cherry picked from commit ${newlineSha})`], root);
    const newlineTip = git(["rev-parse", "HEAD"], root);
    git(["checkout", "-q", "-f", "main"], root);
    const newlineError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    git(["branch", "-f", branch, `${newlineTip}^`], root);

    await runReleaseFlowCli(["promote", "--beta-version", overEdits.version, "--proof-ref", `run-730 (${overEdits.version} @running pass)`], cliDeps(root, gitExec, env));
    git(["checkout", "-q", "-f", "main"], root);
    events.length = 0;
    const promotingError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    const promotingSideEffects = events.filter(SIDE_EFFECT);
    // Merged, with publish-merged-release still to tag it: the branch stays where it is.
    env.state.mergedPrs.push(...env.state.openPrs.splice(0));
    events.length = 0;
    const publishingError = await captureError(() => runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env)));
    const publishingSideEffects = events.filter(SIDE_EFFECT);
    env.state.mergedPrs.length = 0;

    await commitOnMain(root, { ".changeset/minor.md": FEATURE_CHANGESET, "src/minor.ts": "export const minor = 1;\n" }, "feat: minor");
    events.length = 0;
    const next = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    const nextPush = events.find((e) => e.startsWith("git:push:")) ?? "";
    const oldBranch = git(["branch", "--list", branch], root);
    const oldTags = git(["tag", "--list", `v${target}-beta.*`], root).split("\n").filter(Boolean);
    const mainSha = git(["rev-parse", "main"], root);

    if (
      !sameCodeError?.includes(`${branch} already has main's newest code`) ||
      moved.version !== `${target}-beta.2` ||
      moved.movedBranch !== branch ||
      moved.betaSha !== git(["rev-parse", fixSha], root) ||
      movedPush !== `git:push:--atomic --force-with-lease=refs/heads/${branch}:${firstTip} origin ${moved.betaSha}:refs/heads/${branch} refs/tags/v${target}-beta.2` ||
      copied.version !== `${target}-beta.3` ||
      !copiedSameCodeError?.includes(`${branch} already has main's newest code`) ||
      overCopy.version !== `${target}-beta.4` ||
      overCopy.movedBranch !== branch ||
      overEdits.version !== `${target}-beta.7` ||
      overEdits.movedBranch !== branch ||
      overEdits.betaSha !== git(["rev-parse", settledSha], root) ||
      !strayError?.includes("which is not on main or a copy of a main commit") ||
      straySideEffects.length > 0 ||
      !amendedError?.includes(`${amendedTip.slice(0, 7)}, which is not on main or a copy of a main commit`) ||
      amendedSideEffects.length > 0 ||
      !modeError?.includes(`${modeTip.slice(0, 7)}, which is not on main or a copy of a main commit`) ||
      !binaryError?.includes(`${binaryTip.slice(0, 7)}, which is not on main or a copy of a main commit`) ||
      binarySideEffects.length > 0 ||
      !newlineError?.includes(`${newlineTip.slice(0, 7)}, which is not on main or a copy of a main commit`) ||
      !promotingError?.includes(`"ci: release v${target}" is open to promote ${branch}`) ||
      promotingSideEffects.length > 0 ||
      !publishingError?.includes(`"ci: release v${target}" is merged and v${target} is not tagged yet`) ||
      publishingSideEffects.length > 0 ||
      next.targetVersion === target ||
      next.version !== `${next.targetVersion}-beta.1` ||
      next.releaseBranch !== `release/${next.targetVersion}` ||
      next.droppedBranches !== branch ||
      next.betaSha !== mainSha ||
      !nextPush.includes(` :refs/heads/${branch} `) ||
      !nextPush.startsWith(`git:push:--atomic --force-with-lease=refs/heads/${branch}:`) ||
      oldBranch !== "" ||
      oldTags.length !== 7
    ) {
      throw new Error(
        `Scenario (n) failed: ${JSON.stringify({ sameCodeError, moved, movedPush, copied, copiedSameCodeError, overCopy, overEdits, strayError, straySideEffects, amendedError, amendedSideEffects, modeError, binaryError, binarySideEffects, newlineError, promotingError, publishingError, next, nextPush, oldBranch, oldTags })}`,
      );
    }
    scenarios.push({
      id: "n",
      name: "cut_beta_recuts_the_beta_on_test_through_the_release_app",
      status: "PASS",
      outcome: { sameCodeError, moved: moved.version, overCopy: overCopy.version, overEdits: overEdits.version, strayError, amendedError, modeError, binaryError, newlineError, promotingError, publishingError, next: next.version, dropped: next.droppedBranches },
      sideEffects: events,
    });
  });

  // Scenario (o): a patch beta made by Add fix starts from the released tag, whose release commit
  // never reaches main. Cut beta still moves it forward when main makes that patch version.
  await withSeededRepo("recut-patch-beta", async ({ events, root, gitExec }) => {
    const env = createStubEnvironment({ events });
    const first = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(first.version);
    await runReleaseFlowCli(["promote", "--beta-version", first.version, "--proof-ref", `run-740 (${first.version} @running pass)`], cliDeps(root, gitExec, env));
    squashMergeReleasePr(root);
    await runReleaseFlowCli(["publish-merged-release"], cliDeps(root, gitExec, env));
    env.state.openPrs.length = 0;

    const released = first.version.replace(/-beta\.\d+$/, "");
    const patchVersion = released.replace(/\d+$/, (n) => String(Number(n) + 1));
    const fixSha = await commitOnMain(root, { ".changeset/patch-one.md": FIX_CHANGESET, "src/patch-one.ts": "export const one = 1;\n" }, "fix: patch one");
    const patch = await runReleaseFlowCli(["add-fix", "--release-version", patchVersion, "--commit", fixSha], cliDeps(root, gitExec, env));
    env.state.betaVersions.push(patch.version);
    await commitOnMain(root, { ".changeset/patch-two.md": FIX_CHANGESET.replace("shipping total", "tax line"), "src/patch-two.ts": "export const two = 2;\n" }, "fix: patch two");
    const recut = await runReleaseFlowCli(["cut-beta"], cliDeps(root, gitExec, env));
    const mainSha = git(["rev-parse", "main"], root);

    if (
      patch.version !== `${patchVersion}-beta.1` ||
      patch.patchBase !== `v${released}` ||
      recut.version !== `${patchVersion}-beta.2` ||
      recut.movedBranch !== `release/${patchVersion}` ||
      recut.betaSha !== mainSha
    ) {
      throw new Error(`Scenario (o) failed: ${JSON.stringify({ patch, recut, mainSha })}`);
    }
    scenarios.push({
      id: "o",
      name: "cut_beta_recuts_a_patch_beta_made_from_a_released_tag",
      status: "PASS",
      outcome: { patchBeta: patch.version, patchBase: patch.patchBase, recut: recut.version, moved: recut.movedBranch },
      sideEffects: events,
    });
  });

  return {
    proof: "release-authority-proof",
    workflowBinding,
    allPassed: scenarios.every((s) => s.status === "PASS"),
    scenarioCount: scenarios.length,
    scenarios,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runReleaseAuthorityProof();
  console.log(JSON.stringify(report, null, 2));
  if (!report.allPassed) {
    process.exitCode = 1;
  }
}
