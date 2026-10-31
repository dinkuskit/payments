#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReleaseServiceClient, ReleaseServiceError } from "@emdash-cms/registry-client/release-service";

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const OUTPUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_OIDC_TOKEN_CHARS = 16 * 1024;

function commandValue(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function parsePositiveInteger(value, name, maximum) {
  const text = String(value ?? "").trim();
  if (!POSITIVE_INTEGER_PATTERN.test(text)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} is outside the supported range`);
  }
  return parsed;
}

export function parseWorkflowConnectionArgs(argv, env = process.env) {
  const options = {
    serviceUrl: "",
    publisherDid: "",
    packageSlug: "",
    connectionInvitation: "",
    pollIntervalSeconds: "5",
    pollIntervalMs: "",
    timeoutMinutes: "30",
    runId: env.GITHUB_RUN_ID ?? "",
    githubOutput: env.GITHUB_OUTPUT ?? "",
    stepSummary: env.GITHUB_STEP_SUMMARY ?? "",
  };

  const assignFlag = (key, rawValue, rawArg) => {
    if (rawValue === undefined || rawValue.startsWith("--")) {
      throw new Error(`Missing value for ${rawArg}`);
    }
    switch (key) {
      case "service-url":
        options.serviceUrl = rawValue;
        break;
      case "publisher-did":
        options.publisherDid = rawValue;
        break;
      case "slug":
        options.packageSlug = rawValue;
        break;
      case "connection-invitation":
        options.connectionInvitation = rawValue;
        break;
      case "poll-interval-seconds":
        options.pollIntervalSeconds = rawValue;
        break;
      case "poll-interval-ms":
        options.pollIntervalMs = rawValue;
        break;
      case "timeout-minutes":
        options.timeoutMinutes = rawValue;
        break;
      case "run-id":
        options.runId = rawValue;
        break;
      case "github-output":
        options.githubOutput = rawValue;
        break;
      case "step-summary":
        options.stepSummary = rawValue;
        break;
      default:
        throw new Error(`Unknown argument: ${rawArg}`);
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const eqIndex = arg.indexOf("=");
    if (eqIndex !== -1) {
      assignFlag(arg.slice(2, eqIndex), arg.slice(eqIndex + 1), arg.slice(0, eqIndex));
    } else {
      assignFlag(arg.slice(2), argv[index + 1], arg);
      index += 1;
    }
  }

  return options;
}

export async function fetchGithubOidcToken(
  audience,
  { env = process.env, fetchImpl = globalThis.fetch } = {},
) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub OIDC is unavailable");
  }

  let url;
  try {
    url = new URL(requestUrl);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new Error("invalid OIDC URL");
    }
    url.searchParams.set("audience", audience);
  } catch {
    throw new Error("GitHub OIDC is unavailable");
  }

  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error("GitHub OIDC request failed");
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error("GitHub OIDC response is invalid");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("GitHub OIDC response is invalid");
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("value" in payload) ||
    typeof payload.value !== "string" ||
    payload.value.length === 0 ||
    payload.value.length > MAX_OIDC_TOKEN_CHARS
  ) {
    throw new Error("GitHub OIDC response is invalid");
  }

  return payload.value;
}

async function appendGithubOutput(outputFile, name, value) {
  if (!OUTPUT_NAME_PATTERN.test(name)) {
    throw new Error("Action output name is invalid");
  }
  const delimiter = `emdash_${crypto.randomUUID()}`;
  await appendFile(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

export async function ensureEmDashWorkflowConnection(
  rawOptions,
  { env = process.env, fetchImpl = globalThis.fetch, log = console.log, signal } = {},
) {
  const serviceUrl = String(rawOptions.serviceUrl ?? "").trim();
  if (!serviceUrl) {
    throw new Error("Required option is missing: --service-url");
  }
  const publisherDid = String(rawOptions.publisherDid ?? "").trim();
  if (!DID_PATTERN.test(publisherDid)) {
    throw new Error("publisher-did must be a valid DID");
  }
  const packageSlug = String(rawOptions.packageSlug ?? "").trim();
  if (!PACKAGE_SLUG_PATTERN.test(packageSlug)) {
    throw new Error("slug must be a valid EmDash package slug");
  }
  const runId = String(rawOptions.runId ?? env.GITHUB_RUN_ID ?? "").trim();
  if (!runId || !POSITIVE_INTEGER_PATTERN.test(runId)) {
    throw new Error("GitHub run identity is unavailable");
  }

  const pollIntervalMs = rawOptions.pollIntervalMs
    ? parsePositiveInteger(rawOptions.pollIntervalMs, "poll-interval-ms", 300_000)
    : parsePositiveInteger(rawOptions.pollIntervalSeconds ?? "5", "poll-interval-seconds", 300) * 1000;
  const timeoutMinutes = parsePositiveInteger(
    rawOptions.timeoutMinutes ?? "30",
    "timeout-minutes",
    360,
  );
  const connectionInvitation = String(rawOptions.connectionInvitation ?? "").trim();
  const githubOutput = String(rawOptions.githubOutput ?? "").trim();
  const stepSummary = String(rawOptions.stepSummary ?? "").trim();

  if (connectionInvitation) {
    log(`::add-mask::${commandValue(connectionInvitation)}`);
  }

  const client = new ReleaseServiceClient({
    serviceUrl,
    fetch: fetchImpl,
    workloadToken: async () => {
      const token = await fetchGithubOidcToken(serviceUrl, { env, fetchImpl });
      log(`::add-mask::${commandValue(token)}`);
      return token;
    },
  });

  if (githubOutput) {
    await appendGithubOutput(githubOutput, "connection-url", "");
  }

  let connectionRequestId = null;
  let approvalUrl = "";
  const policy = await client.waitForWorkflowConnection(
    {
      publisherDid,
      packageSlug,
      ...(connectionInvitation ? { invitationToken: connectionInvitation } : {}),
    },
    {
      idempotencyKey: `github-connection-${runId}-${packageSlug}`,
      pollIntervalMs,
      maxWaitMs: timeoutMinutes * 60_000,
      signal,
      onUpdate: async (current) => {
        if (current.status !== "pending" || current.request.id === connectionRequestId) {
          return;
        }
        connectionRequestId = current.request.id;
        approvalUrl = current.approvalUrl;
        if (githubOutput) {
          await appendGithubOutput(githubOutput, "connection-url", current.approvalUrl);
        }
        log(`Approve this GitHub workflow to continue: ${current.approvalUrl}`);
        if (stepSummary) {
          await appendFile(
            stepSummary,
            `## Approve this GitHub workflow\n\n[Open EmDash to review and approve the workflow](${current.approvalUrl})\n`,
            "utf8",
          );
        }
      },
    },
  );

  log(`EmDash workflow connection ready for ${packageSlug} (${policy.workflowRef}).`);
  return {
    status: "connected",
    packageSlug,
    publisherDid,
    approvalUrl,
    policy,
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  try {
    const parsed = parseWorkflowConnectionArgs(process.argv.slice(2), process.env);
    await ensureEmDashWorkflowConnection(parsed);
  } catch (error) {
    const message =
      error instanceof ReleaseServiceError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "EmDash workflow connection check failed";
    console.error(`::error::${commandValue(message)}`);
    process.exitCode = 1;
  }
}
