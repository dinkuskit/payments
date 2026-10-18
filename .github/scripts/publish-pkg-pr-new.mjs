#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const APP_NOT_INSTALLED_PATTERNS = Object.freeze([
  /https:\/\/github\.com\/apps\/pkg-pr-new is not installed on or does not have access to/i,
  /"url"\s*:\s*"\/check"[\s\S]*?"statusCode"\s*:\s*404[\s\S]*?pkg-pr-new is not installed/i,
]);

export function classifyPkgPrNewOutput({ status = 0, stdout = "", stderr = "" } = {}) {
  const combined = `${stdout}\n${stderr}`;
  if (status === 0) {
    return {
      outcome: "published",
      exitCode: 0,
      notice: null,
    };
  }

  const isAppNotInstalled = APP_NOT_INSTALLED_PATTERNS.some((pattern) => pattern.test(combined));
  if (isAppNotInstalled) {
    return {
      outcome: "skipped_app_not_installed",
      exitCode: 0,
      notice:
        "Skipping pkg.pr.new preview publish: the pkg-pr-new GitHub App is not installed on or does not have access to this repository (HTTP 404 on /check).",
    };
  }

  return {
    outcome: "failed",
    exitCode: typeof status === "number" && status !== 0 ? status : 1,
    notice: null,
  };
}

export function runPkgPrNewPreview({
  jsonPath = "preview.json",
  spawnImpl = spawnSync,
  writeStdout = (text) => process.stdout.write(text),
  writeStderr = (text) => process.stderr.write(text),
  logNotice = (msg) => console.log(`::notice::${msg}`),
} = {}) {
  const result = spawnImpl(
    "npx",
    ["--no-install", "pkg-pr-new", "publish", "--json", jsonPath],
    { encoding: "utf8" },
  );

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) writeStdout(stdout);
  if (stderr) writeStderr(stderr);

  if (result.error) {
    writeStderr(`${result.error.message}\n`);
    return {
      outcome: "failed",
      exitCode: 1,
      notice: null,
    };
  }

  const classified = classifyPkgPrNewOutput({
    status: result.status ?? 1,
    stdout,
    stderr,
  });

  if (classified.outcome === "skipped_app_not_installed" && classified.notice) {
    logNotice(classified.notice);
  }

  return classified;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const jsonArgIndex = process.argv.indexOf("--json");
  const jsonPath =
    jsonArgIndex !== -1 && process.argv[jsonArgIndex + 1]
      ? process.argv[jsonArgIndex + 1]
      : "preview.json";
  const result = runPkgPrNewPreview({ jsonPath });
  process.exitCode = result.exitCode;
}
