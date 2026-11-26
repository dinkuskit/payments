#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryRoot } from "./repo-contract.mjs";

// Every external source this repository runs is pinned to a commit SHA: actions and reusable
// workflows in .github/workflows, and the agent skills scripts/agent-skills installs. A SHA says
// which bytes run, not that anyone read them. This audit fails unless each pinned SHA is listed in
// .github/reviewed-pins.json, so a new or moved pin needs a manifest line a reviewer can see, and
// `--fetch` resolves each pin at its source and writes the source diff for that reviewer to read.
export const REVIEWED_PINS_PATH = ".github/reviewed-pins.json";

// Entries recorded when the audit landed, for pins that were already on main. They pass, and the
// audit reports how many remain.
export const BASELINE_REVIEW_PREFIX = "baseline:";

const WORKFLOW_DIRECTORY = ".github/workflows";
const SKILL_PIN_FILES = ["scripts/agent-skills"];
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function pinKey(source, sha) {
  return `${source.toLowerCase()}@${sha}`;
}

function splitLines(content) {
  return String(content).replace(/\r\n/g, "\n").split("\n");
}

export function collectWorkflowPins(workflowContent, relPath = ".github/workflows/unknown.yml") {
  const pins = [];
  const findings = [];
  const lines = splitLines(workflowContent);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(lines[idx]);
    if (!match) continue;
    const usesTarget = match[1].trim().replace(/^["']|["']$/g, "");
    if (usesTarget.startsWith("./")) continue;
    const pinned = /^([^/@\s]+\/[^/@\s]+)(?:\/[^@\s]+)?@([0-9a-f]{40})$/.exec(usesTarget);
    if (!pinned || !SOURCE_PATTERN.test(pinned[1])) {
      findings.push(
        `pin does not name a source repository and commit SHA in ${relPath}:${idx + 1} (${usesTarget})`,
      );
      continue;
    }
    pins.push({ source: pinned[1], sha: pinned[2], where: `${relPath}:${idx + 1}` });
  }
  return { pins, findings };
}

// scripts/agent-skills names its sources as NAME_REPO="https://github.com/owner/repo.git" and its
// revisions as NAME_SHA="<sha>". A SHA belongs to the repository with the same NAME, or to the
// only repository the file names.
export function collectSkillPins(scriptContent, relPath = "scripts/agent-skills") {
  const pins = [];
  const findings = [];
  const lines = splitLines(scriptContent);
  const repositories = new Map();
  for (const line of lines) {
    const repo = /^\s*([A-Z][A-Z0-9_]*)_REPO="?https:\/\/github\.com\/([^\s"]+?)(?:\.git)?"?\s*$/.exec(line);
    if (repo) repositories.set(repo[1], repo[2]);
  }
  for (let idx = 0; idx < lines.length; idx += 1) {
    const assigned = /^\s*([A-Z][A-Z0-9_]*)_SHA="?([0-9a-f]{40})"?\s*$/.exec(lines[idx]);
    if (!assigned) {
      if (/\b[0-9a-f]{40}\b/.test(lines[idx])) {
        findings.push(`commit SHA outside a NAME_SHA assignment in ${relPath}:${idx + 1}`);
      }
      continue;
    }
    const source =
      repositories.get(assigned[1]) ??
      (repositories.size === 1 ? [...repositories.values()][0] : undefined);
    if (!source || !SOURCE_PATTERN.test(source)) {
      findings.push(
        `pin does not name a source repository in ${relPath}:${idx + 1} (${assigned[1]}_SHA)`,
      );
      continue;
    }
    pins.push({ source, sha: assigned[2], where: `${relPath}:${idx + 1}` });
  }
  return { pins, findings };
}

export function loadReviewedPins(manifestContent, relPath = REVIEWED_PINS_PATH) {
  const reviewed = new Map();
  const findings = [];
  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    return { reviewed, findings: [`${relPath} is not valid JSON`] };
  }
  if (!Array.isArray(manifest?.pins)) {
    return { reviewed, findings: [`${relPath} must contain a "pins" array`] };
  }
  manifest.pins.forEach((entry, idx) => {
    const label = `${relPath} pins[${idx}]`;
    if (typeof entry?.source !== "string" || !SOURCE_PATTERN.test(entry.source)) {
      findings.push(`${label} needs a "source" of the form owner/repo`);
      return;
    }
    if (typeof entry.sha !== "string" || !SHA_PATTERN.test(entry.sha)) {
      findings.push(`${label} needs a 40-char commit "sha"`);
      return;
    }
    if (typeof entry.review !== "string" || !entry.review.trim()) {
      findings.push(`${label} needs a "review" note saying who reviewed the source and where`);
      return;
    }
    const key = pinKey(entry.source, entry.sha);
    if (reviewed.has(key)) {
      findings.push(`${label} repeats ${entry.source}@${entry.sha}`);
      return;
    }
    reviewed.set(key, { source: entry.source, sha: entry.sha, review: entry.review.trim() });
  });
  return { reviewed, findings };
}

export function auditPins(pins, reviewed) {
  const findings = [];
  for (const pin of pins) {
    if (reviewed.has(pinKey(pin.source, pin.sha))) continue;
    findings.push(
      `unreviewed pin in ${pin.where} (${pin.source}@${pin.sha}): review the source, then list it in ${REVIEWED_PINS_PATH}`,
    );
  }
  return findings;
}

export async function auditRepositoryPins(root = repositoryRoot) {
  const pins = [];
  const findings = [];
  const workflows = (await readdir(join(root, WORKFLOW_DIRECTORY)))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  for (const name of workflows) {
    const relPath = `${WORKFLOW_DIRECTORY}/${name}`;
    const collected = collectWorkflowPins(await readFile(join(root, relPath), "utf8"), relPath);
    pins.push(...collected.pins);
    findings.push(...collected.findings);
  }
  for (const relPath of SKILL_PIN_FILES) {
    const collected = collectSkillPins(await readFile(join(root, relPath), "utf8"), relPath);
    pins.push(...collected.pins);
    findings.push(...collected.findings);
  }

  let manifestContent;
  try {
    manifestContent = await readFile(join(root, REVIEWED_PINS_PATH), "utf8");
  } catch {
    return { pins, reviewed: new Map(), findings: [...findings, `missing ${REVIEWED_PINS_PATH}`] };
  }
  const manifest = loadReviewedPins(manifestContent);
  findings.push(...manifest.findings, ...auditPins(pins, manifest.reviewed));
  return { pins, reviewed: manifest.reviewed, findings };
}

// One fetch per pinned commit. A pin the base manifest does not list gets a source diff against
// each SHA that manifest lists for the same repository, or its whole source when there is none.
export function planSourceFetches(pins, baseReviewed) {
  const plan = new Map();
  for (const pin of pins) {
    const key = pinKey(pin.source, pin.sha);
    const planned = plan.get(key);
    if (planned) {
      planned.where.push(pin.where);
      continue;
    }
    const previous = baseReviewed.has(key)
      ? null
      : [...baseReviewed.values()]
          .filter((entry) => entry.source.toLowerCase() === pin.source.toLowerCase())
          .map((entry) => entry.sha);
    plan.set(key, { source: pin.source, sha: pin.sha, where: [pin.where], previous });
  }
  return [...plan.values()];
}

function git(cwd, args, stdout = "pipe") {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", stdout, "pipe"],
  });
}

function fetchCommit(repoDir, remote, sha) {
  try {
    git(repoDir, ["-c", "protocol.version=2", "fetch", "--quiet", "--depth", "1", remote, sha]);
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function writeDiff(repoDir, from, to, file) {
  const out = openSync(file, "w");
  try {
    git(repoDir, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", from, to], out);
  } finally {
    closeSync(out);
  }
}

function githubRemote(source) {
  return `https://github.com/${source}.git`;
}

// Resolves every planned pin at its source repository and writes the planned diffs plus an
// index.json into outDir. A pin whose commit cannot be fetched is a finding.
export async function fetchPinSources(plan, { outDir, remoteFor = githubRemote }) {
  const findings = [];
  const index = [];
  await mkdir(outDir, { recursive: true });
  const workDir = await mkdtemp(join(tmpdir(), "payments-pin-audit-"));
  try {
    for (const [idx, pin] of plan.entries()) {
      const repoDir = join(workDir, String(idx));
      const remote = remoteFor(pin.source);
      const record = { source: pin.source, sha: pin.sha, where: pin.where, resolved: false, diffs: [] };
      index.push(record);
      git(workDir, ["init", "--quiet", "--bare", repoDir]);
      if (!fetchCommit(repoDir, remote, pin.sha)) {
        findings.push(
          `pin cannot be resolved at its source in ${pin.where.join(", ")} (${pin.source}@${pin.sha})`,
        );
        continue;
      }
      record.resolved = true;
      if (!pin.previous) continue;
      const bases = pin.previous.filter((sha) => fetchCommit(repoDir, remote, sha));
      const name = pin.source.replace("/", "__");
      if (bases.length === 0) {
        const file = `${name}.new..${pin.sha.slice(0, 12)}.diff`;
        writeDiff(repoDir, EMPTY_TREE, pin.sha, join(outDir, file));
        record.diffs.push(file);
      }
      for (const base of bases) {
        const file = `${name}.${base.slice(0, 12)}..${pin.sha.slice(0, 12)}.diff`;
        writeDiff(repoDir, base, pin.sha, join(outDir, file));
        record.diffs.push(file);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  await writeFile(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return findings;
}

function parseArgs(args) {
  const options = { fetchDir: null, baseManifest: null };
  for (let idx = 0; idx < args.length; idx += 1) {
    if (args[idx] === "--fetch" && args[idx + 1]) options.fetchDir = args[(idx += 1)];
    else if (args[idx] === "--base-manifest" && args[idx + 1]) options.baseManifest = args[(idx += 1)];
    else {
      console.error("Usage: scripts/pin-audit.mjs [--fetch <out-dir> [--base-manifest <file>]]");
      process.exit(64);
    }
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const { pins, reviewed, findings } = await auditRepositoryPins();
  if (options.fetchDir) {
    // Without a base manifest nothing is new, so the pins are resolved and no diff is written.
    const base = options.baseManifest
      ? loadReviewedPins(await readFile(options.baseManifest, "utf8"), options.baseManifest).reviewed
      : reviewed;
    findings.push(
      ...(await fetchPinSources(planSourceFetches(pins, base), { outDir: options.fetchDir })),
    );
  }
  if (findings.length) {
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
  } else {
    const baseline = [...reviewed.values()].filter((entry) =>
      entry.review.startsWith(BASELINE_REVIEW_PREFIX),
    ).length;
    console.log(`pin_audit=clean pins=${pins.length} baseline_entries=${baseline}`);
  }
}
