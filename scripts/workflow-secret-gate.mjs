import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { repositoryRoot } from "./repo-contract.mjs";

// Events whose runs can be started by someone without write access while the
// workflow still runs from the base branch with the repository's secrets.
export const UNTRUSTED_TRIGGERS = ["pull_request_target", "issue_comment"];

// A gate step must check the actor against repository permission: either the
// collaborator permission API or an author_association allowlist.
const PERMISSION_CHECKS = [
  /collaborators\/[^\s'"]+\/permission/,
  /getCollaboratorPermissionLevel/,
  /author_association[\s\S]*\b(?:OWNER|MEMBER|COLLABORATOR)\b/,
  /\b(?:OWNER|MEMBER|COLLABORATOR)\b[\s\S]*author_association/,
];

function triggerNames(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

function needsOf(job) {
  if (typeof job?.needs === "string") return [job.needs];
  if (Array.isArray(job?.needs)) return job.needs.map(String);
  return [];
}

function passesSecrets(job) {
  if (job?.secrets === "inherit") return true;
  return Boolean(job?.secrets && typeof job.secrets === "object" && Object.keys(job.secrets).length);
}

function isPermissionCheck(text) {
  return PERMISSION_CHECKS.some((pattern) => pattern.test(String(text ?? "")));
}

function ancestors(jobs, jobId, seen = new Set()) {
  for (const parent of needsOf(jobs[jobId])) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    ancestors(jobs, parent, seen);
  }
  return seen;
}

// Returns the gate job, its permission-check step, and the output the
// secret-bearing call consumes, or the reason no such gate exists.
export function findPermissionGate(jobs, jobId) {
  const job = jobs[jobId];
  const callerIf = String(job?.if ?? "");
  const upstream = [...ancestors(jobs, jobId)];
  if (!upstream.length) return { reason: "no job in needs runs a permission gate first" };

  let missingOutput = null;
  for (const gateId of upstream) {
    const gate = jobs[gateId];
    if (!gate || !Array.isArray(gate.steps)) continue;
    const steps = gate.steps.filter((step) => step?.id && isPermissionCheck(step.run));
    if (!steps.length) continue;
    for (const [outputName, expression] of Object.entries(gate.outputs ?? {})) {
      const step = steps.find((candidate) =>
        String(expression).includes(`steps.${candidate.id}.outputs.`),
      );
      if (!step) continue;
      if (callerIf.includes(`needs.${gateId}.outputs.${outputName}`)) {
        return { gateId, stepId: step.id, outputName };
      }
      missingOutput ??= `if: does not consume needs.${gateId}.outputs.${outputName}`;
    }
    missingOutput ??= `${gateId} checks permission but exposes no output from that step`;
  }
  return { reason: missingOutput ?? "no job in needs runs a permission gate first" };
}

export function auditWorkflowSecretGate(workflowContent, relPath = ".github/workflows/unknown.yml") {
  let workflow;
  try {
    workflow = parse(String(workflowContent));
  } catch (error) {
    return [`workflow is not valid YAML in ${relPath}: ${error.message.split("\n")[0]}`];
  }
  const triggers = triggerNames(workflow?.on).filter((name) => UNTRUSTED_TRIGGERS.includes(name));
  if (!triggers.length) return [];

  const jobs = workflow?.jobs ?? {};
  const findings = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    if (typeof job?.uses !== "string" || !passesSecrets(job)) continue;
    const gate = findPermissionGate(jobs, jobId);
    if (gate.reason) {
      findings.push(
        `${triggers.join("/")} job passes secrets to ${job.uses} without a preceding permission gate in ${relPath} (jobs.${jobId}: ${gate.reason})`,
      );
    }
  }
  return findings;
}

export async function auditWorkflowSecretGates(root = repositoryRoot) {
  const directory = join(root, ".github/workflows");
  const findings = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const relPath = `.github/workflows/${name}`;
    findings.push(...auditWorkflowSecretGate(await readFile(join(root, relPath), "utf8"), relPath));
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const findings = await auditWorkflowSecretGates();
  if (findings.length) {
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
  } else {
    console.log("workflow_secret_gate=clean");
  }
}
