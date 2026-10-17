import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseRef = process.env.CHANGESET_BASE_REF?.trim() || "origin/main";
const prTitle = process.env.PR_TITLE?.trim() || "";
const prUser = process.env.PR_USER?.trim() || "";

const RELEASE_SUBJECT_PATTERN = /^(ci: release\b|chore(?:\(release\))?: version packages\b)/i;
const ALLOWED_BOT_AUTHORS = new Set(["github-actions[bot]", "dependabot[bot]"]);

function listPendingChangesets() {
  return readdirSync(resolve(rootDir, ".changeset"))
    .filter((entry) => entry.endsWith(".md") && entry.toLowerCase() !== "readme.md")
    .map((entry) => `.changeset/${entry}`)
    .sort();
}

function readHeadSubject() {
  try {
    return execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function listChangedChangesets(base) {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`, "--", ".changeset"],
      { cwd: rootDir, encoding: "utf8" },
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(".changeset/") && line.endsWith(".md") && !line.toLowerCase().endsWith("/readme.md"));
  } catch {
    return listPendingChangesets();
  }
}

const headSubject = readHeadSubject();
if (RELEASE_SUBJECT_PATTERN.test(prTitle) || RELEASE_SUBJECT_PATTERN.test(headSubject)) {
  console.log("Skipping changeset requirement for automated release PR/commit.");
  process.exit(0);
}

if (ALLOWED_BOT_AUTHORS.has(prUser)) {
  console.log(`Skipping changeset requirement for automated actor ${prUser}.`);
  process.exit(0);
}

const changedChangesets = listChangedChangesets(baseRef);
if (changedChangesets.length > 0) {
  console.log(`Found changeset(s) in diff against ${baseRef}: ${changedChangesets.join(", ")}`);
  process.exit(0);
}

const pendingChangesets = listPendingChangesets();
if (pendingChangesets.length > 0 && !process.env.GITHUB_BASE_REF) {
  console.log(`Found pending changeset(s) in worktree: ${pendingChangesets.join(", ")}`);
  process.exit(0);
}

console.error(
  [
    "Missing changeset file in `.changeset/*.md`.",
    "Every pull request must include a changeset describing its user-facing or internal impact.",
    "Run `npm run changeset` (or add a `.changeset/<name>.md` file) and commit it to this branch.",
  ].join("\n"),
);
process.exit(1);
