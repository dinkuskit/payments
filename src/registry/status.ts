import { businessCountry as listedCountry } from "../business-country.js";
import type { PaidTwiceNotice } from "../paid-twice.js";

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

export const TEST_ORDER_STATES = ["awaiting_notice", "awaiting_commerce", "recorded"] as const;
/** A provider-confirmed paid TEST checkout; `recorded` once Commerce confirmed it saved the order. */
export type TestOrderEvidence = {
  provider: "stripe" | "authorize_net";
  total: { currency: "USD"; minor: string };
  paidAt: number;
  state: (typeof TEST_ORDER_STATES)[number];
};

export interface PaymentsStatus {
  state: StatusState;
  mode: StatusMode;
  bindingRef?: string;
  connectionEvidence?: ConnectionEvidence;
  testOrder?: TestOrderEvidence;
  /** Stripe's business country: saved, or null while Stripe still needs one. Absent when not asked for or not Stripe. */
  businessCountry?: string | null;
  /** Authorize.net checkouts paid more than once, newest first. Absent when not asked for or there are none. */
  paidTwice?: PaidTwiceNotice[];
}

export interface StatusProjection {
  availability: "unavailable" | "available";
  status: PaymentsStatus | null;
  message: string;
}

const statusKeys = new Set(["state", "mode", "bindingRef", "connectionEvidence", "testOrder", "businessCountry", "paidTwice"]);
const evidenceKeys = new Set(["provider", "mode", "result", "accountRef"]);
// Latest instant a JavaScript Date can show.
const MAX_DATE_MS = 8_640_000_000_000_000;

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

function decodeTestOrder(
  value: unknown,
  status: { mode: StatusMode; bindingRef?: unknown; connectionEvidence?: ConnectionEvidence },
): TestOrderEvidence {
  if (!isRecord(value) || Object.keys(value).sort().join() !== "paidAt,provider,state,total") throw new Error("invalid_status");
  const { provider, total, paidAt, state } = value;
  if ((provider !== "stripe" && provider !== "authorize_net") ||
      !isRecord(total) || Object.keys(total).sort().join() !== "currency,minor" || total.currency !== "USD" ||
      typeof total.minor !== "string" || !/^[1-9][0-9]{0,15}$/.test(total.minor) || !Number.isSafeInteger(Number(total.minor)) ||
      typeof paidAt !== "number" || !Number.isSafeInteger(paidAt) || paidAt <= 0 || paidAt > MAX_DATE_MS ||
      typeof state !== "string" || !(TEST_ORDER_STATES as readonly string[]).includes(state) ||
      // TEST orders exist only for a TEST connection with a binding, from its own provider.
      status.mode !== "test" || status.bindingRef === undefined ||
      (status.connectionEvidence !== undefined && status.connectionEvidence.provider !== provider)) {
    throw new Error("invalid_status");
  }
  return { provider, total: { currency: "USD", minor: total.minor }, paidAt, state: state as TestOrderEvidence["state"] };
}

function decodePaidTwice(value: unknown, connectionEvidence?: ConnectionEvidence): PaidTwiceNotice[] {
  // Only Authorize.net can take a second payment for one checkout.
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 ||
      (connectionEvidence !== undefined && connectionEvidence.provider !== "authorize_net")) throw new Error("invalid_status");
  return value.map(item => {
    if (!isRecord(item) || Object.keys(item).sort().join() !== "at,total,transactionIds") throw new Error("invalid_status");
    const { transactionIds, total, at } = item;
    if (!Array.isArray(transactionIds) || transactionIds.length < 2 || transactionIds.length > 21 ||
        transactionIds.some(id => typeof id !== "string" || !/^[0-9]{1,20}$/.test(id)) || new Set(transactionIds).size !== transactionIds.length ||
        !isRecord(total) || Object.keys(total).sort().join() !== "currency,minor" || total.currency !== "USD" ||
        typeof total.minor !== "string" || !/^[1-9][0-9]{0,15}$/.test(total.minor) || !Number.isSafeInteger(Number(total.minor)) ||
        typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0 || at > MAX_DATE_MS) throw new Error("invalid_status");
    return { transactionIds: [...transactionIds] as string[], total: { currency: "USD" as const, minor: total.minor }, at };
  });
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
  if (value.businessCountry !== undefined && value.businessCountry !== null && !listedCountry(value.businessCountry)) throw new Error("invalid_status");
  // Only Stripe asks, so the field never sits beside Authorize.net evidence.
  if (value.businessCountry !== undefined && connectionEvidence?.provider === "authorize_net") throw new Error("invalid_status");
  const testOrder = value.testOrder === undefined
    ? undefined
    : decodeTestOrder(value.testOrder, { mode: value.mode, bindingRef: value.bindingRef, connectionEvidence });
  const paidTwice = value.paidTwice === undefined ? undefined : decodePaidTwice(value.paidTwice, connectionEvidence);
  return {
    state: value.state as StatusState,
    mode: value.mode,
    ...(value.bindingRef === undefined ? {} : { bindingRef: value.bindingRef }),
    ...(connectionEvidence === undefined ? {} : { connectionEvidence }),
    ...(testOrder === undefined ? {} : { testOrder }),
    ...(value.businessCountry === undefined ? {} : { businessCountry: value.businessCountry as string | null }),
    ...(paidTwice === undefined ? {} : { paidTwice }),
  };
}

export function unavailableStatusProjection(): StatusProjection {
  return {
    availability: "unavailable",
    status: null,
    message: "Connect your DinkusKit account to check payment setup. Account connection is not available in this build.",
  };
}
