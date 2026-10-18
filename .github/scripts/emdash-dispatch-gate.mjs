#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateEmDashDispatchGate } from "../../scripts/release-flow.mjs";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

export async function runEmDashDispatchGateCli(argv = process.argv.slice(2), env = process.env) {
  const flags = parseArgs(argv);
  const eventName = flags["event-name"] ?? env.EVENT_NAME ?? env.GITHUB_EVENT_NAME ?? "";
  const ref = flags.ref ?? env.TARGET_REF ?? env.GITHUB_REF ?? "";
  const inputVersion = flags.version ?? env.INPUT_VERSION ?? "";
  const releaseMode = flags["release-mode"] ?? env.INPUT_RELEASE_MODE ?? env.RELEASE_MODE ?? "";
  const githubOutput = flags["github-output"] ?? env.GITHUB_OUTPUT ?? "";

  const gate = validateEmDashDispatchGate({
    eventName,
    ref,
    inputVersion,
    releaseMode,
  });

  if (!gate.ok) {
    console.error(`::error::${gate.message}`);
    return gate;
  }

  if (githubOutput) {
    const lines = [
      `mode=${gate.mode}`,
      `slug=${gate.slug}`,
      `requested_version=${gate.requestedVersion ?? ""}`,
    ];
    await appendFile(githubOutput, `${lines.join("\n")}\n`, "utf8");
  }

  console.log(JSON.stringify(gate));
  return gate;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gate = await runEmDashDispatchGateCli();
  if (!gate.ok) {
    process.exitCode = 1;
  }
}
