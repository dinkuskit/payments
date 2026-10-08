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

export interface PaymentsStatus {
  state: StatusState;
  mode: StatusMode;
  bindingRef?: string;
}

export interface StatusProjection {
  availability: "unavailable" | "available";
  status: PaymentsStatus | null;
  message: string;
}

const statusKeys = new Set(["state", "mode", "bindingRef"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return {
    state: value.state as StatusState,
    mode: value.mode,
    ...(value.bindingRef === undefined ? {} : { bindingRef: value.bindingRef }),
  };
}

export function unavailableStatusProjection(): StatusProjection {
  return {
    availability: "unavailable",
    status: null,
    message: "Connect your DinkusKit account to check payment setup. Account connection is not available in this build.",
  };
}

