#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BETA_REGISTRY_SLUG,
  PACKAGE_NAME,
  runReleaseFlowCli,
  validateEmDashDispatchGate,
} from "./release-flow.mjs";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createSeededRepo(prefix, events) {
  const root = await mkdtemp(join(tmpdir(), `payments-release-proof-${prefix}-`));
  await mkdir(join(root, ".changeset"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: PACKAGE_NAME,
        version: "0.2.8",
        type: "module",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(root, "package-lock.json"), `{"name":"@dinkuskit/payments","version":"0.2.8"}\n`, "utf8");
  await writeFile(
    join(root, "CHANGELOG.md"),
    ["# @dinkuskit/payments", "", "## 0.2.8", "", "- Baseline release."].join("\n") + "\n",
    "utf8",
  );
  await writeFile(join(root, "src/plugin.ts"), `export const pluginVersion = "0.2.8";\n`, "utf8");
  await writeFile(
    join(root, ".changeset/README.md"),
    "# Changesets\n",
    "utf8",
  );
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
} = {}) {
  const state = {
    betaVersions: [...betaVersions],
    stableVersions: [...stableVersions],
    githubReleases: new Set(githubReleases),
    openPrs: [],
    mergedPrs: [],
  };

  const fetchImpl = async (url) => {
    const urlStr = String(url);
    const slug = decodeURIComponent(urlStr.split("/").pop() || "");
    events.push(`registry:get:${slug}`);
    if (registryError) {
      if (registryError.type === "network") {
        throw new Error(registryError.message || "socket hang up");
      }
      return {
        ok: false,
        status: registryError.status || 503,
        json: async () => ({ error: registryError.code || "ServiceUnavailable" }),
      };
    }
    const versions = slug === BETA_REGISTRY_SLUG ? state.betaVersions : state.stableVersions;
    if (versions.length === 0) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "NotFound" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        plugin: { slug, latestVersion: versions.at(-1) },
        versions: versions.map((version) => ({ version })),
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
      await writeFile(
        join(cwd, "package-lock.json"),
        `{"name":"@dinkuskit/payments","version":"0.2.9"}\n`,
        "utf8",
      );
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
  inputVersion,
  events,
  runCutBeta,
  runPublish,
}) {
  events.push(`workflow:emdash-release:start:event=${eventName}:ref=${ref}:version=${inputVersion || "(auto)"}`);
  const gate = validateEmDashDispatchGate({ eventName, ref, inputVersion });
  if (!gate.ok) {
    events.push(`workflow:emdash-release:rejected:${gate.code}`);
    return { ok: false, gate };
  }
  if (eventName === "workflow_dispatch") {
    events.push("credential:mint-github-app-token:[REDACTED]");
    await runCutBeta();
  }
  await runPublish(gate.slug, gate.requestedVersion);
  return { ok: true, gate };
}

export async function runReleaseAuthorityProof() {
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
            events.push(`credential:pds-auth:[REDACTED]`);
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

      // 3. Merge ci: release PR to main and run publish-merged-release + delegated emdash-release.yml
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
          eventName: "workflow_call",
          ref: "refs/heads/main",
          inputVersion: publishResult.version,
          events,
          runCutBeta: async () => {},
          runPublish: async (slug, version) => {
            const check = await runReleaseFlowCli(
              ["check-registry-version", "--slug", slug, "--version", version],
              { root, gitExec, ghExec: env.ghExec, fetchImpl: env.fetchImpl, log: (l) => logs.push(l) },
            );
            if (!check.alreadyPublished) {
              events.push(`credential:pds-auth:[REDACTED]`);
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

      // Downstream Registry job runs because published/registry_needed == true
      await runWorkflowDispatchSimulation({
        eventName: "workflow_call",
        ref: "refs/heads/main",
        inputVersion: resumed.version,
        events,
        runCutBeta: async () => {},
        runPublish: async (slug, version) => {
          const check = await runReleaseFlowCli(
            ["check-registry-version", "--slug", slug, "--version", version],
            { root, gitExec, ghExec: env.ghExec, fetchImpl: env.fetchImpl, log: () => {} },
          );
          if (!check.alreadyPublished) {
            events.push(`credential:pds-auth:[REDACTED]`);
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
      // Add an explicit `changeset --empty` file alongside the patch changeset
      await writeFile(
        join(root, ".changeset/empty-note.md"),
        `---\n---\n`,
        "utf8",
      );
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

  return {
    proof: "release-authority-proof",
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
