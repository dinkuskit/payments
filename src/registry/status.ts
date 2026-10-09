export const STATUS_STATES = [
  "disconnected",
  "connecting",
  "setup_required",
  "ready",
  "checking",
  "action_required",
  "recovery_required",
] as const;

export type StatusState = (typeof STATUS_STATES)[number];
export type StatusMode = "test" | "live";
export type ConnectionEvidence = {
  provider: "stripe" | "authorize_net";
  mode: StatusMode;
  result: "verified" | "action_required" | "unknown" | "unsupported";
  accountRef?: string;
};

export interface PaymentsStatus {
  state: StatusState;
  mode: StatusMode;
  bindingRef?: string;
  connectionEvidence?: ConnectionEvidence;
}

export interface StatusProjection {
  availability: "unavailable" | "available";
  status: PaymentsStatus | null;
  message: string;
}

const statusKeys = new Set(["state", "mode", "bindingRef", "connectionEvidence"]);
const evidenceKeys = new Set(["provider", "mode", "result", "accountRef"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeConnectionEvidence(value: unknown, status: { state: StatusState; mode: StatusMode }): ConnectionEvidence {
  if (!isRecord(value)) throw new Error("invalid_status");
  for (const key of Object.keys(value)) {
    if (!evidenceKeys.has(key)) throw new Error("invalid_status");
  }
  const provider = value.provider;
  const mode = value.mode;
  const result = value.result;
  const accountRef = value.accountRef;
  if ((provider !== "stripe" && provider !== "authorize_net") ||
      (mode !== "test" && mode !== "live") ||
      (result !== "verified" && result !== "action_required" && result !== "unknown" && result !== "unsupported") ||
      mode !== status.mode) {
    throw new Error("invalid_status");
  }
  if (provider === "authorize_net") {
    if (result !== "unsupported" || accountRef !== undefined || status.state !== "ready") throw new Error("invalid_status");
  } else {
    if (result === "unsupported" || typeof accountRef !== "string" || accountRef.length > 200 || !/^acct_[A-Za-z0-9]+$/.test(accountRef)) {
      throw new Error("invalid_status");
    }
    if ((result === "verified" || result === "action_required") &&
        (typeof accountRef !== "string" || status.state !== (result === "verified" ? "ready" : "action_required"))) {
      throw new Error("invalid_status");
    }
    if (result === "unknown" && status.state !== "setup_required" && status.state !== "checking") {
      throw new Error("invalid_status");
    }
  }
  return {
    provider,
    mode,
    result,
    ...(accountRef === undefined ? {} : { accountRef }),
  };
}

export function decodeStatus(value: unknown): PaymentsStatus {
  if (!isRecord(value)) throw new Error("invalid_status");
  for (const key of Object.keys(value)) {
    if (!statusKeys.has(key)) throw new Error("invalid_status");
  }
  if (
    typeof value.state !== "string" ||
    !(STATUS_STATES as readonly string[]).includes(value.state) ||
    (value.mode !== "test" && value.mode !== "live") ||
    (value.bindingRef !== undefined &&
      (typeof value.bindingRef !== "string" || value.bindingRef.length < 1 || value.bindingRef.length > 200))
  ) {
    throw new Error("invalid_status");
  }
  const connectionEvidence = value.connectionEvidence === undefined
    ? undefined
    : decodeConnectionEvidence(value.connectionEvidence, { state: value.state as StatusState, mode: value.mode });
  return {
    state: value.state as StatusState,
    mode: value.mode,
    ...(value.bindingRef === undefined ? {} : { bindingRef: value.bindingRef }),
    ...(connectionEvidence === undefined ? {} : { connectionEvidence }),
  };
}

export function unavailableStatusProjection(): StatusProjection {
  return {
    availability: "unavailable",
    status: null,
    message: "Connect your DinkusKit account to check payment setup. Account connection is not available in this build.",
  };
}
